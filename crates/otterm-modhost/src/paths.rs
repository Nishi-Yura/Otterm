//! Path variables and glob expansion for mod permissions (docs/05-mod-system.md §6.3), and the path comparisons
//! that the broker and the store share.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use globset::{GlobBuilder, GlobMatcher};

/// Names accepted inside `${...}` in permission patterns.
pub const VARIABLES: &[&str] = &["cwd", "home", "workspace", "mod", "data"];

/// The values behind `${cwd}`, `${home}`, `${workspace}`, `${mod}`, and `${data}`.
///
/// A variable whose value is `None` (no session cwd, no workspace open) cannot be used. A pattern that needs it
/// is then ignored rather than widened to match something else.
#[derive(Debug, Clone)]
pub struct PathVars {
    /// Working folder of the current terminal session.
    pub cwd: Option<PathBuf>,
    /// The user's home folder.
    pub home: PathBuf,
    /// Root of the open workspace, if any.
    pub workspace: Option<PathBuf>,
    /// The mod's own folder (`${mod}`). Always readable by the mod.
    pub mod_dir: PathBuf,
    /// The mod's private data folder (`${data}`). Always readable and writable by the mod.
    pub data: PathBuf,
}

impl PathVars {
    /// The value of one variable, or an error that says why it is not available.
    fn get(&self, name: &str) -> Result<&Path> {
        let value = match name {
            "cwd" => self.cwd.as_deref(),
            "home" => Some(self.home.as_path()),
            "workspace" => self.workspace.as_deref(),
            "mod" => Some(self.mod_dir.as_path()),
            "data" => Some(self.data.as_path()),
            _ => bail!("unknown path variable ${{{name}}}"),
        };
        value.with_context(|| format!("${{{name}}} is not available here"))
    }
}

/// Replace every `${name}` in `template` with the variable's value. Nothing else is changed.
fn substitute(template: &str, vars: &PathVars) -> Result<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            bail!("unclosed ${{ in `{template}`");
        };
        out.push_str(&vars.get(&after[..end])?.to_string_lossy());
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Expand the variables in a path template, for example `${home}/notes`.
pub fn expand(template: &str, vars: &PathVars) -> Result<PathBuf> {
    Ok(PathBuf::from(substitute(template, vars)?))
}

/// Expand the variables in a glob pattern and compile it.
///
/// On Windows, `\` is turned into `/` first, because in a glob `\` escapes the next character. Matching is
/// case-insensitive on Windows, as the filesystem is. `*` and `**` both cross folder boundaries.
pub fn expand_glob(pattern: &str, vars: &PathVars) -> Result<GlobMatcher> {
    let text = substitute(pattern, vars)?;
    let text = if cfg!(windows) { text.replace('\\', "/") } else { text };
    let glob = GlobBuilder::new(&text)
        .literal_separator(false)
        .case_insensitive(cfg!(windows))
        .build()
        .with_context(|| format!("invalid path pattern `{pattern}`"))?;
    Ok(glob.compile_matcher())
}

/// The names of the `${...}` variables used in `template`, in order of appearance.
pub(crate) fn variable_names(template: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else { break };
        names.push(&after[..end]);
        rest = &after[end + 1..];
    }
    names
}

/// Why a permission template cannot be used (an unknown variable, or an unclosed `${`), if it cannot.
pub(crate) fn template_error(template: &str) -> Option<String> {
    if template.matches("${").count() != variable_names(template).len() {
        return Some("unclosed ${".into());
    }
    variable_names(template)
        .into_iter()
        .find(|name| !VARIABLES.contains(name))
        .map(|name| format!("unknown variable ${{{name}}}"))
}

/// Resolve symlinks and `..`. On Windows the `\\?\` prefix that `canonicalize` adds is removed, so the result
/// compares equal to a path the user typed.
pub(crate) fn canonical(path: &Path) -> io::Result<PathBuf> {
    fs::canonicalize(path).map(strip_verbatim)
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else { return path };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// A comparison key for a path. Separators are unified, and on Windows case is ignored, so that
/// `C:\Users\X` and `c:/users/x` match. Trailing separators are dropped.
pub(crate) fn key(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = if cfg!(windows) { text.replace('\\', "/").to_lowercase() } else { text.into_owned() };
    text.trim_end_matches('/').to_owned()
}

/// Whether `path` is `root` or lies inside it. Compares whole path segments, so `/a/bc` is not inside `/a/b`.
pub(crate) fn within(path: &Path, root: &Path) -> bool {
    let (p, r) = (key(path), key(root));
    p == r || p.strip_prefix(r.as_str()).is_some_and(|rest| rest.starts_with('/'))
}

/// A path as text with `/` separators, for matching against globs.
pub(crate) fn slashed(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { text.replace('\\', "/") } else { text.into_owned() }
}
