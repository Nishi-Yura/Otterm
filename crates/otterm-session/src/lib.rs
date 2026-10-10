//! Sessions: one shell process and its PTY.
//!
//! [`SessionManager`] is the boundary the UI talks to. v1.0 runs sessions in-process
//! ([`LocalSessionManager`]); v1.x moves them into the `ottermd` daemon behind the same trait
//! (decision C14, docs/02-architecture.md §2.1).

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Result, anyhow};
use otterm_pty::{Pty, Spawned};
pub use otterm_pty::{PtySize, SpawnOptions};

pub type SessionId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    /// Raw bytes from the PTY, in order.
    Output(Vec<u8>),
    /// The process exited. Always the last event for a session. `None` if the exit code was unavailable.
    Exited { code: Option<u32> },
}

/// Receives a session's events. Called from a background thread.
pub type EventSink = Box<dyn Fn(SessionEvent) + Send + Sync>;

pub trait SessionManager: Send + Sync {
    /// Start a session. `opts.session_id` is overwritten with the new id.
    fn create(&self, opts: SpawnOptions, sink: EventSink) -> Result<SessionId>;
    fn write(&self, id: SessionId, data: &[u8]) -> Result<()>;
    fn resize(&self, id: SessionId, size: PtySize) -> Result<()>;
    /// Kill the process. [`SessionEvent::Exited`] follows.
    fn close(&self, id: SessionId) -> Result<()>;
}

/// Runs every session inside the current process.
#[derive(Default)]
pub struct LocalSessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Arc<Mutex<Pty>>>>>,
    next_id: AtomicU64,
}

impl LocalSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, id: SessionId) -> Result<Arc<Mutex<Pty>>> {
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| anyhow!("no session {id}"))
    }
}

impl SessionManager for LocalSessionManager {
    fn create(&self, mut opts: SpawnOptions, sink: EventSink) -> Result<SessionId> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        opts.session_id = id.to_string();
        let Spawned { pty, mut reader, child } = Pty::spawn(opts)?;
        self.sessions.lock().unwrap().insert(id, Arc::new(Mutex::new(pty)));

        // Waiter: when the child exits, drop the PTY. Closing the master is what ends the
        // reader on Windows (ConPTY does not report EOF while the master is open).
        let sessions = Arc::clone(&self.sessions);
        let waiter = thread::Builder::new().name(format!("session-{id}-wait")).spawn(move || {
            let code = child.wait().ok();
            sessions.lock().unwrap().remove(&id);
            code
        })?;

        // Reader: forward output, then report the exit once the stream ends so that
        // `Exited` always comes after the last `Output`.
        thread::Builder::new().name(format!("session-{id}-read")).spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => sink(SessionEvent::Output(buf[..n].to_vec())),
                }
            }
            let code = waiter.join().ok().flatten();
            sink(SessionEvent::Exited { code });
        })?;

        Ok(id)
    }

    fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        self.get(id)?.lock().unwrap().write(data)
    }

    fn resize(&self, id: SessionId, size: PtySize) -> Result<()> {
        self.get(id)?.lock().unwrap().resize(size)
    }

    fn close(&self, id: SessionId) -> Result<()> {
        self.get(id)?.lock().unwrap().kill()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn shell() -> (String, Vec<String>) {
        if cfg!(windows) { ("cmd.exe".into(), vec!["/q".into()]) } else { ("/bin/sh".into(), vec![]) }
    }

    #[test]
    fn input_is_echoed_and_exit_is_the_last_event() {
        let mgr = LocalSessionManager::new();
        let (tx, rx) = mpsc::channel();
        let (program, args) = shell();
        let id = mgr
            .create(
                SpawnOptions { program: Some(program), args, ..Default::default() },
                Box::new(move |ev| {
                    let _ = tx.send(ev);
                }),
            )
            .unwrap();

        // Only the expanded variable proves the shell ran the line; the echoed input still reads `$OTTERM`.
        let line: &[u8] = if cfg!(windows) { b"echo otterm-%OTTERM%\r" } else { b"echo otterm-$OTTERM\r" };
        mgr.write(id, line).unwrap();
        mgr.write(id, b"exit\r").unwrap();

        let mut out = Vec::new();
        let code = loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("session did not exit within 10 s") {
                SessionEvent::Output(bytes) => {
                    // ConPTY holds output until its cursor position query (DSR) is answered.
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        mgr.write(id, b"\x1b[1;1R").unwrap();
                    }
                    out.extend(bytes);
                }
                SessionEvent::Exited { code } => break code,
            }
        };
        assert!(String::from_utf8_lossy(&out).contains("otterm-1"), "output: {:?}", String::from_utf8_lossy(&out));
        assert_eq!(code, Some(0));
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "no events after Exited");
        assert!(mgr.write(id, b"x").is_err(), "session is removed after exit");
    }

    #[test]
    fn close_kills_the_process_and_reports_exit() {
        let mgr = LocalSessionManager::new();
        let (tx, rx) = mpsc::channel();
        let (program, args) = shell();
        let id = mgr
            .create(
                SpawnOptions { program: Some(program), args, ..Default::default() },
                Box::new(move |ev| {
                    let _ = tx.send(ev);
                }),
            )
            .unwrap();

        mgr.close(id).expect("close succeeds");
        loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("no Exited within 10 s after close") {
                SessionEvent::Output(bytes) if bytes.windows(4).any(|w| w == b"\x1b[6n") => {
                    let _ = mgr.write(id, b"\x1b[1;1R");
                }
                SessionEvent::Output(_) => {}
                SessionEvent::Exited { .. } => break,
            }
        }
    }
}
