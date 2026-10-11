//! The capability broker (docs/05-mod-system.md §6, decision D5 and K8).
//!
//! A [`Grant`] is what one mod may do, built from its manifest. Every privileged operation goes through a `check_*`
//! method first. Paths are resolved (symlinks and `..` removed) before any check, so a link inside an allowed
//! folder cannot lead out of it. The `read_*`, `write_*`, and `run_process` methods check and then act.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use globset::GlobMatcher;
use serde::Serialize;

use crate::manifest::{Manifest, bare_process_name};
use crate::paths::{PathVars, canonical, expand, expand_glob, key, slashed, within};

/// `CREATE_NO_WINDOW`: a helper process must not flash a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `FILE_ATTRIBUTE_HIDDEN`, from the Win32 API.
#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

/// The folders a mod must never write to, whatever its `fs.write` says (docs/05 §6.4, decision K8).
///
/// The host builds this from its own folders. It is separate from [`Grant`] so the app decides the layout, and
/// the broker only applies the rules.
#[derive(Debug, Clone)]
pub struct Protected {
    /// otterm's config folder (`config.toml`, `shell-integration/`).
    pub config_dir: PathBuf,
    /// otterm's data folder. It holds `mods/` and every mod's `mod-data/`, so one mod cannot touch another's data.
    pub data_dir: PathBuf,
    /// The user's home folder. Dot-names directly under it, such as `~/.bashrc` and `~/.ssh/`, are protected.
    pub home: PathBuf,
    /// Folders of all installed mods. A mod's own folder is exempt; the rest are protected.
    pub mod_dirs: Vec<PathBuf>,
}

/// What one mod may do. Built from its manifest and the current path variables.
#[derive(Debug)]
pub struct Grant {
    vars: PathVars,
    /// `${data}` as the host wrote it, before resolving links. Under per-app file system
    /// redirection (MSIX) a file and its folder can resolve into different trees, so the mod's own
    /// data folder is also judged by the paths as written.
    data_plain: PathBuf,
    protected: Protected,
    read: Vec<GlobMatcher>,
    read_roots: Vec<PathBuf>,
    write: Vec<GlobMatcher>,
    write_roots: Vec<PathBuf>,
    process: Vec<String>,
    network: Vec<NetPattern>,
    picked_read: Vec<PathBuf>,
    picked_save: Vec<PathBuf>,
    skipped: Vec<String>,
}

impl Grant {
    /// Build the grant for `manifest`.
    ///
    /// Patterns that cannot be used in this context (for example `${workspace}/**` with no workspace open) are
    /// left out, and listed by [`Grant::skipped`]. Leaving them out is the safe choice: a pattern that cannot be
    /// expanded grants nothing.
    pub fn new(manifest: &Manifest, vars: PathVars, protected: Protected) -> Self {
        let data_plain = vars.data.clone();
        let vars = PathVars {
            cwd: vars.cwd.map(canonical_or),
            home: canonical_or(vars.home),
            workspace: vars.workspace.map(canonical_or),
            mod_dir: canonical_or(vars.mod_dir),
            data: canonical_or(vars.data),
        };
        let protected = Protected {
            config_dir: canonical_or(protected.config_dir),
            data_dir: canonical_or(protected.data_dir),
            home: canonical_or(protected.home),
            mod_dirs: protected.mod_dirs.into_iter().map(canonical_or).collect(),
        };
        let perms = &manifest.permissions;
        let mut skipped = Vec::new();
        let (read, read_roots) = compile_all(&perms.fs.read, &vars, &mut skipped);
        let (write, write_roots) = compile_all(&perms.fs.write, &vars, &mut skipped);
        let mut network = Vec::new();
        for pattern in &perms.network {
            match NetPattern::parse(pattern) {
                Ok(p) => network.push(p),
                Err(e) => skipped.push(format!("{pattern}: {e}")),
            }
        }
        Self {
            vars,
            data_plain,
            protected,
            read,
            read_roots,
            write,
            write_roots,
            process: perms.process.iter().filter_map(|p| bare_process_name(p)).map(str::to_owned).collect(),
            network,
            picked_read: Vec::new(),
            picked_save: Vec::new(),
            skipped,
        }
    }

    /// Patterns from the manifest that could not be used here, with the reason. Show them to the user.
    pub fn skipped(&self) -> &[String] {
        &self.skipped
    }

    /// Allow reading a path the user chose in a native open dialog (docs/05 §5.2, `ctx.ui.pickPath`).
    ///
    /// This grants read access only. The path is resolved now, so a later rename of a link does not change it.
    pub fn allow_picked(&mut self, path: PathBuf) -> Result<()> {
        let path = resolve(&path)?;
        self.picked_read.push(path);
        Ok(())
    }

    /// Allow reading and writing a path the user chose in a native save dialog.
    ///
    /// A save dialog is the only way a mod may write into a protected folder (docs/05 §6.4). The user picked the
    /// location, so this skips the `fs.write` globs and the protected list. Only the app may call it, and only for
    /// a path that came from a dialog.
    pub fn allow_picked_for_save(&mut self, path: PathBuf) -> Result<()> {
        let path = resolve(&path)?;
        self.picked_save.push(path);
        Ok(())
    }

    /// Check that a read is allowed and return the resolved path. The file must exist.
    ///
    /// Allowed: inside `${mod}` or `${data}`, matching an `fs.read` glob, or picked by the user.
    pub fn check_read(&self, path: &Path) -> Result<PathBuf> {
        require_absolute(path)?;
        let canon = canonical(path).with_context(|| format!("cannot read {}", path.display()))?;
        // The mod's own data folder is judged by the path as written too: under per-app file
        // system redirection (MSIX) a file's resolved path can land in another tree than its folder's.
        if self.read_allowed(&canon) || within(path, &self.data_plain) || within(&canon, &self.data_plain) {
            Ok(canon)
        } else if canon != path {
            bail!("not in fs.read: {} (resolved from {})", canon.display(), path.display())
        } else {
            bail!("not in fs.read: {}", canon.display())
        }
    }

    /// Check that a write is allowed and return the resolved path. The file may not exist yet.
    ///
    /// Order of the checks: the user's own save picks, then the mod's own data folder (always writable, §6.4),
    /// then the `fs.write` globs, then the mod's own folder, and finally the protected list.
    pub fn check_write(&self, path: &Path) -> Result<PathBuf> {
        let canon = resolve(path)?;
        if self.picked_save.iter().any(|p| within(&canon, p)) {
            return Ok(canon);
        }
        if within(&canon, &self.vars.data) || within(path, &self.data_plain) || within(&canon, &self.data_plain) {
            return Ok(canon);
        }
        let granted = self.write_roots.iter().any(|r| within(&canon, r))
            || self.write.iter().any(|g| g.is_match(slashed(&canon)));
        if !granted {
            bail!("not in fs.write: {}", canon.display());
        }
        if within(&canon, &self.vars.mod_dir) {
            return Ok(canon);
        }
        if let Some(why) = self.protected_reason(&canon) {
            bail!("not allowed to write to {why}: {}", canon.display());
        }
        Ok(canon)
    }

    /// Check that a process may be started (docs/05 §6.1).
    ///
    /// `cmd` must be a bare name, such as `git` or `git.exe`. A path is refused, so the mod cannot pick its own
    /// binary. The comparison ignores case on Windows.
    pub fn check_process(&self, cmd: &str) -> Result<()> {
        let Some(name) = bare_process_name(cmd) else {
            bail!("process must be a bare executable name: {cmd}");
        };
        let listed = self.process.iter().any(|p| if cfg!(windows) { p.eq_ignore_ascii_case(name) } else { p == name });
        if listed { Ok(()) } else { bail!("not in permissions.process: {cmd}") }
    }

    /// Check that an `http` or `https` URL matches a `permissions.network` pattern.
    ///
    /// The scheme, host (`*.example.com` matches subdomains only), port, and path must all match. A path with `.`
    /// or `..` segments is refused, because a server may resolve it differently from the check. The HTTP request
    /// itself is made by the app, not here.
    pub fn check_network(&self, url: &str) -> Result<()> {
        let parsed = parse_url(url)?;
        if self.network.iter().any(|p| p.matches(&parsed)) {
            Ok(())
        } else {
            bail!("not in permissions.network: {}://{}{}", parsed.scheme, parsed.host, parsed.path)
        }
    }

    /// Read a text file. With `max_bytes`, a longer file is cut there, and a multi-byte character cut in half is
    /// dropped. A file that is not UTF-8 is an error.
    pub fn read_text(&self, path: &Path, max_bytes: Option<usize>) -> Result<String> {
        let bytes = self.read_bytes(path, max_bytes)?;
        let truncated = max_bytes.is_some_and(|n| bytes.len() >= n);
        match String::from_utf8(bytes) {
            Ok(text) => Ok(text),
            Err(e) if truncated && e.utf8_error().error_len().is_none() => {
                let valid = e.utf8_error().valid_up_to();
                Ok(std::str::from_utf8(&e.as_bytes()[..valid])?.to_owned())
            }
            Err(_) => bail!("not UTF-8 text: {}", path.display()),
        }
    }

    /// Read a file's bytes. With `max_bytes`, a longer file is cut there.
    pub fn read_bytes(&self, path: &Path, max_bytes: Option<usize>) -> Result<Vec<u8>> {
        let path = self.check_read(path)?;
        let file = fs::File::open(&path).with_context(|| format!("cannot open {}", path.display()))?;
        let limit = max_bytes.map_or(u64::MAX, |n| u64::try_from(n).unwrap_or(u64::MAX));
        let mut buf = Vec::new();
        file.take(limit).read_to_end(&mut buf).with_context(|| format!("cannot read {}", path.display()))?;
        Ok(buf)
    }

    /// List a folder. Entries are sorted by name. Hidden entries are left out unless `include_hidden` is set.
    /// A name starting with `.` is hidden on every platform. On Windows, the hidden attribute also counts.
    pub fn read_dir(&self, path: &Path, include_hidden: bool) -> Result<Vec<DirEntry>> {
        let dir = self.check_read(path)?;
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir).with_context(|| format!("cannot list {}", dir.display()))? {
            let entry = entry?;
            let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
            let described = describe(&entry.path(), &meta);
            if include_hidden || !described.hidden {
                out.push(described);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Describe one path. The path must be readable.
    pub fn stat(&self, path: &Path) -> Result<DirEntry> {
        let path = self.check_read(path)?;
        let meta = fs::symlink_metadata(&path).with_context(|| format!("cannot stat {}", path.display()))?;
        Ok(describe(&path, &meta))
    }

    /// Whether a path exists. A path the mod may not read is an error, not `false`, so the answer cannot be used
    /// to probe the filesystem.
    pub fn exists(&self, path: &Path) -> Result<bool> {
        let canon = resolve(path)?;
        if !self.read_allowed(&canon) {
            bail!("not in fs.read: {}", canon.display());
        }
        Ok(fs::symlink_metadata(&canon).is_ok())
    }

    /// Write a text file, replacing any existing content.
    pub fn write_text(&self, path: &Path, text: &str) -> Result<()> {
        self.write_bytes(path, text.as_bytes())
    }

    /// Write a file's bytes, replacing any existing content.
    pub fn write_bytes(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let path = self.check_write(path)?;
        fs::write(&path, bytes).with_context(|| format!("cannot write {}", path.display()))
    }

    /// Create a folder and any missing parents.
    pub fn mkdir(&self, path: &Path) -> Result<()> {
        let path = self.check_write(path)?;
        fs::create_dir_all(&path).with_context(|| format!("cannot create {}", path.display()))
    }

    /// Rename or move a path. Both the source and the destination must be writable.
    pub fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        let from = self.check_write(from)?;
        let to = self.check_write(to)?;
        fs::rename(&from, &to).with_context(|| format!("cannot rename {}", from.display()))
    }

    /// Start a process without waiting for it (docs/05 §5.2, `ctx.process.spawn`). The caller owns the child: it reads
    /// its output, writes its stdin, and kills it. The same `permissions.process` and `cwd` checks as
    /// [`Grant::run_process`] apply, so a mod cannot start anything its manifest does not list.
    pub fn spawn_process(
        &self,
        cmd: &str,
        args: &[String],
        cwd: Option<PathBuf>,
        env: &BTreeMap<String, String>,
    ) -> Result<Child> {
        let mut command = self.process_command(cmd, args, cwd, env)?;
        command.stdin(Stdio::piped());
        hide_window(&mut command);
        command.spawn().with_context(|| format!("cannot start {cmd}"))
    }

    /// Check `cmd` and `cwd`, and build the command with its arguments, environment, and piped output.
    fn process_command(
        &self,
        cmd: &str,
        args: &[String],
        cwd: Option<PathBuf>,
        env: &BTreeMap<String, String>,
    ) -> Result<Command> {
        self.check_process(cmd)?;
        let cwd = match cwd.or_else(|| self.vars.cwd.clone()) {
            Some(dir) => Some(self.check_read(&dir)?),
            None => None,
        };
        let mut command = Command::new(cmd);
        command.args(args).envs(env).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = &cwd {
            command.current_dir(dir);
        }
        Ok(command)
    }

    /// Start a process and wait for it, with its output captured (docs/05 §5.2, `ctx.process.run`).
    ///
    /// `cmd` must be in `permissions.process`. `cwd` must be readable, and defaults to the session's cwd. The
    /// child inherits the app's environment, with `env` added. With `timeout_ms`, the child is killed when the
    /// time runs out, and `timed_out` is set. On Windows no console window is shown.
    pub fn run_process(
        &self,
        cmd: &str,
        args: &[String],
        cwd: Option<PathBuf>,
        env: &BTreeMap<String, String>,
        timeout_ms: Option<u64>,
        stdin: Option<String>,
    ) -> Result<ProcessOutput> {
        let mut command = self.process_command(cmd, args, cwd, env)?;
        command.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        hide_window(&mut command);
        let mut child = command.spawn().with_context(|| format!("cannot start {cmd}"))?;
        if let (Some(text), Some(mut input)) = (stdin, child.stdin.take()) {
            // Written from a thread: a child that never reads its stdin must not block us.
            thread::spawn(move || {
                let _ = input.write_all(text.as_bytes());
            });
        }
        let stdout = spawn_reader(child.stdout.take());
        let stderr = spawn_reader(child.stderr.take());
        let (status, timed_out) = wait_with_timeout(&mut child, timeout_ms)?;
        Ok(ProcessOutput {
            code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: collect(stdout),
            stderr: collect(stderr),
            timed_out,
        })
    }

    /// Whether reading `canon` (already resolved) is allowed.
    fn read_allowed(&self, canon: &Path) -> bool {
        within(canon, &self.vars.mod_dir)
            || within(canon, &self.vars.data)
            || self.read_roots.iter().any(|r| within(canon, r))
            || self.read.iter().any(|g| g.is_match(slashed(canon)))
            || self.picked_read.iter().any(|p| within(canon, p))
            || self.picked_save.iter().any(|p| within(canon, p))
    }

    /// Why `canon` is in the protected list, or `None` if it is not.
    fn protected_reason(&self, canon: &Path) -> Option<&'static str> {
        let p = &self.protected;
        if within(canon, &p.config_dir) {
            return Some("otterm's config folder");
        }
        if within(canon, &p.data_dir) {
            return Some("otterm's data folder");
        }
        if p.mod_dirs.iter().any(|d| within(canon, d)) {
            return Some("another mod's folder");
        }
        let home = key(&p.home);
        if let Some(rest) = key(canon).strip_prefix(&format!("{home}/"))
            && rest.split('/').next().is_some_and(|first| first.starts_with('.'))
        {
            return Some("a dot-file or dot-folder in your home folder");
        }
        if system_dirs().iter().any(|d| within(canon, d)) {
            return Some("a system folder");
        }
        None
    }
}

/// Resolve a path for a write. The file may not exist yet: the nearest existing ancestor is resolved, and the
/// missing names are appended. A dangling symlink is an error, so a write cannot go through it.
fn resolve(path: &Path) -> Result<PathBuf> {
    require_absolute(path)?;
    let mut missing = Vec::new();
    let mut cur = path;
    // `symlink_metadata` sees a dangling link as existing, so `canonical` below refuses it instead of creating
    // the file at the link's target.
    while fs::symlink_metadata(cur).is_err() {
        let (Some(name), Some(parent)) = (cur.file_name(), cur.parent()) else {
            bail!("cannot resolve {}", path.display());
        };
        missing.push(name);
        cur = parent;
    }
    let mut out = canonical(cur).with_context(|| format!("cannot resolve {}", path.display()))?;
    out.extend(missing.iter().rev());
    Ok(out)
}

fn require_absolute(path: &Path) -> Result<()> {
    if path.is_absolute() { Ok(()) } else { bail!("path must be absolute: {}", path.display()) }
}

/// Resolve a root the way [`resolve`] resolves a path to be written: through its nearest existing
/// ancestor. `${data}` may not exist yet, and `expand` resolves the same way, so both sides of a
/// check agree even where a folder's resolved form differs from the path as written.
fn canonical_or(path: PathBuf) -> PathBuf {
    resolve(&path).unwrap_or(path)
}

/// Compile glob templates. A template that cannot be used is recorded in `skipped` and left out.
///
/// `dir/**` does not match `dir` itself in globset, but the docs mean the folder too (docs/05 §3.1). So a template
/// ending in `/**` also yields its folder as a root, which [`within`] matches. Only a literal folder qualifies: a
/// glob character before the `/**` would make the root a different folder from the one meant.
fn compile_all(templates: &[String], vars: &PathVars, skipped: &mut Vec<String>) -> (Vec<GlobMatcher>, Vec<PathBuf>) {
    let mut matchers = Vec::new();
    let mut roots = Vec::new();
    for template in templates {
        match expand_glob(template, vars) {
            Ok(matcher) => matchers.push(matcher),
            Err(e) => {
                skipped.push(format!("{template}: {e:#}"));
                continue;
            }
        }
        // Checked after expansion: `${cwd}` itself contains `{`, and only the literal folder must be glob-free.
        if let Some(prefix) = template.strip_suffix("/**")
            && let Ok(root) = expand(prefix, vars)
            && !root.to_string_lossy().contains(['*', '?', '[', '{'])
        {
            roots.push(root);
        }
    }
    (matchers, roots)
}

/// Folders that are never writable. The Unix list is standard; macOS adds its own system folders.
fn system_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    } else {
        let mut dirs: Vec<PathBuf> =
            ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64", "/boot"].iter().copied().map(PathBuf::from).collect();
        if cfg!(target_os = "macos") {
            dirs.extend(["/System", "/Library", "/private/etc"].iter().copied().map(PathBuf::from));
        }
        dirs
    }
}

/// Describe a path whose metadata is already known.
fn describe(path: &Path, meta: &fs::Metadata) -> DirEntry {
    let name = path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned();
    let ft = meta.file_type();
    let kind = if ft.is_symlink() {
        EntryKind::Symlink
    } else if ft.is_dir() {
        EntryKind::Dir
    } else if ft.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    let hidden = name.starts_with('.') || has_hidden_attribute(meta);
    DirEntry {
        name,
        path: path.to_path_buf(),
        kind,
        size: meta.len(),
        modified_at: meta.modified().ok().and_then(unix_ms),
        hidden,
    }
}

#[cfg(windows)]
fn has_hidden_attribute(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn has_hidden_attribute(_meta: &fs::Metadata) -> bool {
    false
}

/// Milliseconds since the Unix epoch, or `None` for a time before it.
pub(crate) fn unix_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH).ok().and_then(|d| u64::try_from(d.as_millis()).ok())
}

/// Stop a helper process from showing a console window. Does nothing off Windows.
pub(crate) fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Read a child's pipe on a thread, so that reading both pipes at once cannot deadlock.
fn spawn_reader<R: Read + Send + 'static>(stream: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// The captured output. A grandchild that keeps the pipe open after its parent exits must not hang us, so the
/// wait is bounded.
fn collect(rx: mpsc::Receiver<Vec<u8>>) -> String {
    let bytes = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Poll the child until it exits, or kill it at the deadline. Returns the status (if any) and whether it timed out.
fn wait_with_timeout(child: &mut Child, timeout_ms: Option<u64>) -> Result<(Option<std::process::ExitStatus>, bool)> {
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((Some(status), false));
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            let _ = child.kill();
            return Ok((child.wait().ok(), true));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// A `http` or `https` URL, split into the parts the network check compares.
#[derive(Debug)]
struct Url {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

fn default_port(scheme: &str) -> u16 {
    if scheme == "http" { 80 } else { 443 }
}

/// Parse an absolute `http` or `https` URL. The query and fragment are ignored.
fn parse_url(url: &str) -> Result<Url> {
    let Some((scheme, rest)) = url.split_once("://") else {
        bail!("not an absolute URL");
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        bail!("only http and https are allowed");
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = if path_end == 0 { "/" } else { &tail[..path_end] };
    if path.split('/').any(|seg| seg == "." || seg == "..") || path.to_ascii_lowercase().contains("%2e") {
        bail!("ambiguous path in URL");
    }
    let (host, port) = split_authority(authority, &scheme)?;
    Ok(Url { scheme, host, port, path: path.to_owned() })
}

/// Split `host[:port]`. User info and IPv6 literals are refused: a host allow-list cannot check them reliably.
fn split_authority(authority: &str, scheme: &str) -> Result<(String, u16)> {
    if authority.contains(['@', '[']) {
        bail!("user info and IPv6 hosts are not allowed");
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port.parse::<u16>().context("invalid port")?)),
        None => (authority, None),
    };
    if host.is_empty() {
        bail!("URL has no host");
    }
    Ok((host.to_ascii_lowercase(), port.unwrap_or(default_port(scheme))))
}

/// One `permissions.network` entry, such as `https://*.example.com/api/*`.
#[derive(Debug, Clone)]
pub(crate) struct NetPattern {
    scheme: String,
    host: String,
    port: u16,
    path: String,
    /// Whether `path` is a prefix (the pattern had `*`), or must match exactly.
    prefix: bool,
}

impl NetPattern {
    /// Parse a pattern. Only `http` and `https` are accepted.
    pub(crate) fn parse(text: &str) -> Result<Self> {
        let Some((scheme, rest)) = text.split_once("://") else {
            bail!("network pattern must start with https:// or http://");
        };
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            bail!("only http and https patterns are allowed");
        }
        let end = rest.find('/').unwrap_or(rest.len());
        let (host, port) = split_authority(&rest[..end], &scheme)?;
        let raw_path = if end == rest.len() { "/" } else { &rest[end..] };
        let (path, prefix) = match raw_path.split_once('*') {
            Some((before, _)) => (before.to_owned(), true),
            None => (raw_path.to_owned(), false),
        };
        Ok(Self { scheme, host, port, path, prefix })
    }

    /// Whether `url` is allowed by this pattern.
    fn matches(&self, url: &Url) -> bool {
        let host_ok = match self.host.strip_prefix("*.") {
            Some(base) => url.host.strip_suffix(base).and_then(|s| s.strip_suffix('.')).is_some_and(|s| !s.is_empty()),
            None => url.host == self.host,
        };
        let path_ok = if self.prefix { url.path.starts_with(&self.path) } else { url.path == self.path };
        self.scheme == url.scheme && host_ok && self.port == url.port && path_ok
    }
}

/// A `DirEntry` kind, as the UI shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// A regular file.
    File,
    /// A folder.
    Dir,
    /// A symbolic link (or a junction on Windows).
    Symlink,
    /// Anything else, such as a device or socket.
    Other,
}

/// One entry from [`Grant::read_dir`] or [`Grant::stat`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// File name, without the folder.
    pub name: String,
    /// Full path.
    pub path: PathBuf,
    /// What it is.
    pub kind: EntryKind,
    /// Size in bytes. For a link, the size of the link itself.
    pub size: u64,
    /// Last modification, in milliseconds since the Unix epoch.
    pub modified_at: Option<u64>,
    /// Whether it is hidden: a leading `.`, or the hidden attribute on Windows.
    pub hidden: bool,
}

/// The result of [`Grant::run_process`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    /// Exit code. `-1` if the process was killed or had no code.
    pub code: i32,
    /// Standard output, decoded as UTF-8 with invalid bytes replaced.
    pub stdout: String,
    /// Standard error, decoded the same way.
    pub stderr: String,
    /// Whether the process was killed because it ran past `timeout_ms`.
    pub timed_out: bool,
}
