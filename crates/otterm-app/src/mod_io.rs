//! Streams for mods (docs/05 §5.2): file watches (`ctx.fs.watch`) and child processes that run while the mod works
//! (`ctx.process.spawn`). Each stream belongs to one mod, runs under that mod's broker grant, and is keyed by the
//! mod's id and a token from the mod's Worker. `mod_release` stops everything a mod started, when the mod stops,
//! is suspended, or crashes. Events reach the mod through a Tauri `Channel`; host.ts hands them to the Worker.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::mods::{ModsState, grant_for};
use crate::{AppState, CmdResult, err};

/// Changes within this window are sent together, and each distinct change once.
const DEBOUNCE: Duration = Duration::from_millis(100);
/// How often a spawned child is checked for exit.
const POLL: Duration = Duration::from_millis(50);
/// Most watches and processes one mod may hold at once.
const MAX_WATCHES: usize = 32;
const MAX_PROCESSES: usize = 8;
/// Most bytes read from an output pipe at once.
const CHUNK: usize = 8192;

/// (mod id, token). The token is the callback id in the mod's Worker, so it is unique within the mod.
type Key = (String, u64);

/// One watch. Dropping it stops the watcher, which ends its debounce thread.
struct Watch {
    _watcher: RecommendedWatcher,
}

/// One running child. `child` is shared with the thread that waits for it, `stdin` with writes.
struct Proc {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// Every watch and process the app holds for mods (managed by Tauri).
#[derive(Default)]
pub struct ModStreams {
    watches: Mutex<HashMap<Key, Watch>>,
    /// Shared with the thread that waits for each child, which removes its entry when the child exits.
    processes: Arc<Mutex<HashMap<Key, Proc>>>,
}

/// One change, as `ctx.fs.watch` reports it (`kind` is `create`, `modify`, or `remove`).
#[derive(Serialize, PartialEq)]
pub struct WatchEvent {
    kind: &'static str,
    path: String,
}

/// Output and exit of a spawned child, as `ctx.process.spawn` reports them.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProcEvent {
    Stdout { data: String },
    Stderr { data: String },
    Exit { code: i32 },
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnOptions {
    cwd: Option<String>,
    env: BTreeMap<String, String>,
}

/// `ctx.fs.watch`: report changes to `path` (a file, or the entries of a folder). The path must be readable.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mod_watch(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    streams: State<'_, ModStreams>,
    id: String,
    cwd: Option<String>,
    path: String,
    token: u64,
    events: Channel<WatchEvent>,
) -> CmdResult<()> {
    let grant = grant_for(&mods, state.config, &id, cwd.as_deref())?;
    let root = grant.check_read(&PathBuf::from(path)).map_err(err)?;
    let key = (id.clone(), token);
    let mut watches = streams.watches.lock().unwrap();
    if !watches.contains_key(&key) && watches.keys().filter(|k| k.0 == id).count() >= MAX_WATCHES {
        return Err(format!("too many watches for {id} (at most {MAX_WATCHES})"));
    }
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = tx.send(res);
    })
    .map_err(err)?;
    watcher.watch(&root, RecursiveMode::NonRecursive).map_err(err)?;
    thread::spawn(move || debounce(rx, events));
    // Replacing an old watch with the same token drops it, which stops it.
    watches.insert(key, Watch { _watcher: watcher });
    Ok(())
}

/// `ctx.fs.watch`'s dispose: stop one watch.
#[tauri::command]
pub async fn mod_unwatch(streams: State<'_, ModStreams>, id: String, token: u64) -> CmdResult<()> {
    streams.watches.lock().unwrap().remove(&(id, token));
    Ok(())
}

/// Collects the changes of one window of `DEBOUNCE`, then sends each distinct one. Ends when the watch is dropped.
fn debounce(rx: mpsc::Receiver<notify::Result<notify::Event>>, events: Channel<WatchEvent>) {
    while let Ok(first) = rx.recv() {
        let mut batch = Vec::new();
        collect(&mut batch, first);
        let until = Instant::now() + DEBOUNCE;
        loop {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(next) => collect(&mut batch, next),
                // Timed out ends the window; a dropped watch ends the loop on the next receive.
                Err(_) => break,
            }
        }
        for event in batch {
            if events.send(event).is_err() {
                return;
            }
        }
    }
}

fn collect(batch: &mut Vec<WatchEvent>, res: notify::Result<notify::Event>) {
    let Ok(event) = res else { return };
    let Some(kind) = watch_kind(&event.kind) else { return };
    for path in event.paths {
        let change = WatchEvent { kind, path: path.to_string_lossy().into_owned() };
        if !batch.contains(&change) {
            batch.push(change);
        }
    }
}

/// The kind a mod sees for a notify event. Reads and other events are not reported.
fn watch_kind(kind: &EventKind) -> Option<&'static str> {
    Some(match kind {
        EventKind::Create(_) => "create",
        EventKind::Remove(_) => "remove",
        // A rename is a removal of the old name and a creation of the new one.
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => "remove",
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Access(_) | EventKind::Any | EventKind::Other => return None,
    })
}

/// `ctx.process.spawn`: start a child (not a PTY) from the manifest's allow-list. Output and exit come through
/// `events`, keyed by `token`. Returns once the child has started.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mod_process_spawn(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    streams: State<'_, ModStreams>,
    id: String,
    cwd: Option<String>,
    cmd: String,
    args: Vec<String>,
    opts: SpawnOptions,
    token: u64,
    events: Channel<ProcEvent>,
) -> CmdResult<()> {
    let grant = grant_for(&mods, state.config, &id, cwd.as_deref())?;
    // An empty cwd means "none", as in `process.run`.
    let dir = opts.cwd.filter(|c| !c.is_empty()).map(PathBuf::from);
    let key = (id.clone(), token);
    let mut processes = streams.processes.lock().unwrap();
    if processes.keys().filter(|k| k.0 == id).count() >= MAX_PROCESSES {
        return Err(format!("too many processes for {id} (at most {MAX_PROCESSES})"));
    }
    let mut child = grant.spawn_process(&cmd, &args, dir, &opts.env).map_err(err)?;
    let readers = [pump(child.stdout.take(), events.clone(), false), pump(child.stderr.take(), events.clone(), true)];
    let proc = Proc { stdin: Arc::new(Mutex::new(child.stdin.take())), child: Arc::new(Mutex::new(child)) };
    let waiting = proc.child.clone();
    // Inserted before the waiter starts, so it cannot remove the entry before it exists.
    processes.insert(key.clone(), proc);
    drop(processes);
    let table = streams.processes.clone();
    thread::spawn(move || {
        let code = loop {
            let status = waiting.lock().unwrap().try_wait();
            match status {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => thread::sleep(POLL),
                Err(_) => break -1,
            }
        };
        // The output is sent before the exit, so the mod sees every line first.
        for reader in readers.into_iter().flatten() {
            let _ = reader.join();
        }
        table.lock().unwrap().remove(&key);
        let _ = events.send(ProcEvent::Exit { code });
    });
    Ok(())
}

/// Reads one output pipe and sends its text in chunks until the pipe closes. A UTF-8 character split across reads
/// waits for the next read, so the mod never gets a broken character.
fn pump<R: Read + Send + 'static>(pipe: Option<R>, events: Channel<ProcEvent>, stderr: bool) -> Option<JoinHandle<()>> {
    let mut pipe = pipe?;
    Some(thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        let mut carry: Vec<u8> = Vec::new();
        let send = |bytes: &[u8]| {
            let data = String::from_utf8_lossy(bytes).into_owned();
            if stderr { ProcEvent::Stderr { data } } else { ProcEvent::Stdout { data } }
        };
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let cut = match std::str::from_utf8(&carry) {
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                _ => carry.len(),
            };
            if cut > 0 && events.send(send(&carry[..cut])).is_err() {
                return;
            }
            carry.drain(..cut);
        }
        if !carry.is_empty() {
            let _ = events.send(send(&carry));
        }
    }))
}

/// `ctx.process.spawn`'s write: send text to the child's stdin.
#[tauri::command]
pub async fn mod_process_write(streams: State<'_, ModStreams>, id: String, token: u64, data: String) -> CmdResult<()> {
    let stdin =
        streams.processes.lock().unwrap().get(&(id, token)).map(|p| p.stdin.clone()).ok_or("no such process")?;
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        let mut slot = stdin.lock().unwrap();
        let input = slot.as_mut().ok_or("the process has no stdin")?;
        input.write_all(data.as_bytes()).map_err(err)
    })
    .await
    .map_err(err)?
}

/// `ctx.process.spawn`'s kill. Killing a child that already exited does nothing.
#[tauri::command]
pub async fn mod_process_kill(streams: State<'_, ModStreams>, id: String, token: u64) -> CmdResult<()> {
    let child = streams.processes.lock().unwrap().get(&(id, token)).map(|p| p.child.clone());
    if let Some(child) = child {
        let _ = child.lock().unwrap().kill();
    }
    Ok(())
}

/// Stops everything a mod started: its watches are dropped and its processes killed. The host calls this when the
/// mod stops, is suspended, or crashes.
#[tauri::command]
pub async fn mod_release(streams: State<'_, ModStreams>, id: String) -> CmdResult<()> {
    streams.watches.lock().unwrap().retain(|k, _| k.0 != id);
    for (key, proc) in streams.processes.lock().unwrap().iter() {
        if key.0 == id {
            let _ = proc.child.lock().unwrap().kill();
        }
    }
    Ok(())
}
