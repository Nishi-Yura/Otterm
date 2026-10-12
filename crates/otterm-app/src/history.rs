//! The run history (decision K1): every command the shell integration saw, with its folder, exit
//! code, start time and duration, in `<data>/history.sqlite`. Output is not stored. Secret-looking
//! arguments are redacted before writing (same idea as the AI mask, docs/10 §4.2). Input typed
//! while echo was off is never reported by the shell integration in the first place (K2).

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

pub struct History {
    conn: Mutex<Option<Connection>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: i64,
    /// ms since the Unix epoch.
    pub started: i64,
    pub ms: i64,
    pub exit: i64,
    pub command: String,
    pub cwd: String,
    pub profile: String,
}

/// A finished command, as the shell integration reported it.
pub struct NewRun {
    pub command: String,
    pub cwd: String,
    pub exit: i32,
    /// ms since the Unix epoch.
    pub started: i64,
    pub ms: u32,
    pub profile: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    /// Substring of the command (case-insensitive).
    pub text: String,
    /// Only runs in this folder.
    pub cwd: Option<String>,
    pub success_only: bool,
    /// Only runs since this time (ms since the epoch).
    pub since: Option<i64>,
    pub limit: u32,
}

impl History {
    /// Open (creating) the database, or run without one when the folder is not writable.
    pub fn open(data_dir: Option<PathBuf>) -> Self {
        let conn = data_dir.and_then(|d| {
            std::fs::create_dir_all(&d).ok()?;
            let c = Connection::open(d.join("history.sqlite")).ok()?;
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY,
                    started INTEGER NOT NULL,
                    ms INTEGER NOT NULL,
                    exit INTEGER NOT NULL,
                    command TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    profile TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS runs_started ON runs(started);",
            )
            .ok()?;
            Some(c)
        });
        Self { conn: Mutex::new(conn) }
    }

    /// Drop runs older than `days` (0 keeps everything).
    pub fn prune(&self, days: u32) {
        if days == 0 {
            return;
        }
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let cutoff = now_ms() - i64::from(days) * 86_400_000;
            let _ = c.execute("DELETE FROM runs WHERE started < ?1", params![cutoff]);
        }
    }

    /// Store one finished command. `redact` masks secret-looking arguments first.
    pub fn record(&self, run: &NewRun, redact: bool) {
        let command = if redact { redact_secrets(&run.command) } else { run.command.clone() };
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let _ = c.execute(
                "INSERT INTO runs (started, ms, exit, command, cwd, profile) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run.started, i64::from(run.ms), i64::from(run.exit), command, run.cwd, run.profile],
            );
        }
    }

    /// Newest first.
    pub fn query(&self, q: &Query) -> Vec<Run> {
        let guard = self.conn.lock().unwrap();
        let Some(c) = guard.as_ref() else { return Vec::new() };
        let limit = if q.limit == 0 { 200 } else { q.limit.min(2000) };
        let pattern = format!("%{}%", q.text.replace('%', "\\%").replace('_', "\\_"));
        let Ok(mut stmt) = c.prepare(
            "SELECT id, started, ms, exit, command, cwd, profile FROM runs
             WHERE command LIKE ?1 ESCAPE '\\'
               AND (?2 IS NULL OR cwd = ?2)
               AND (?3 = 0 OR exit = 0)
               AND (?4 IS NULL OR started >= ?4)
             ORDER BY started DESC LIMIT ?5",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![pattern, q.cwd, q.success_only as i64, q.since, limit], |r| {
            Ok(Run {
                id: r.get(0)?,
                started: r.get(1)?,
                ms: r.get(2)?,
                exit: r.get(3)?,
                command: r.get(4)?,
                cwd: r.get(5)?,
                profile: r.get(6)?,
            })
        });
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    pub fn delete(&self, id: i64) {
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let _ = c.execute("DELETE FROM runs WHERE id = ?1", params![id]);
        }
    }

    pub fn clear(&self) {
        if let Some(c) = self.conn.lock().unwrap().as_ref() {
            let _ = c.execute("DELETE FROM runs", []);
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// `--password x`, `TOKEN=…`, `Authorization: Bearer …` and long key-like words become
/// `[REDACTED]`. Conservative: it looks at the words that follow a secret-like name.
pub fn redact_secrets(command: &str) -> String {
    let names = ["password", "passwd", "pwd", "secret", "token", "apikey", "api_key", "api-key", "auth", "bearer"];
    let mut out: Vec<String> = Vec::new();
    let mut redact_next = false;
    for word in command.split(' ') {
        let lower = word.to_ascii_lowercase();
        if redact_next && !word.is_empty() {
            out.push("[REDACTED]".into());
            redact_next = false;
            continue;
        }
        // `--password=x`, `TOKEN=x`
        if let Some((k, v)) = word.split_once('=')
            && !v.is_empty()
            && names.iter().any(|n| k.to_ascii_lowercase().trim_start_matches('-').contains(n))
        {
            out.push(format!("{k}=[REDACTED]"));
            continue;
        }
        // `--password x`, `Bearer x`. A bare `-p` is not treated as a password: it is `mkdir -p`,
        // `ssh -p 22` and `docker run -p` far more often, and the commands that take a password
        // with `-p` (mysql, sshpass) take it attached (`-pSECRET`) or ask for it.
        if names.iter().any(|n| lower.trim_start_matches('-') == *n) {
            redact_next = true;
            out.push(word.to_owned());
            continue;
        }
        // Long key-like words (GitHub, AWS, Slack tokens).
        let keylike = word.len() >= 32
            && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && word.chars().any(|c| c.is_ascii_digit())
            && word.chars().any(|c| c.is_ascii_uppercase());
        out.push(if keylike { "[REDACTED]".into() } else { word.to_owned() });
    }
    out.join(" ")
}
