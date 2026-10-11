//! Schema migrations for `config.toml` (docs/06 §1). Edits go through toml_edit so comments and
//! key order survive. The original file is copied to `config.toml.bak-<from>` before any write.

use std::path::{Path, PathBuf};

use crate::schema::CURRENT_SCHEMA;

/// Rewrites a document from one schema version to the next.
type Step = fn(&mut toml_edit::DocumentMut);

/// `STEPS[i]` converts schema `i + 1` to `i + 2`. Empty while the schema is 1. To add one, write
/// the step above, append it here, and bump `CURRENT_SCHEMA` in schema.rs.
const STEPS: &[Step] = &[];

/// What [`migrate_file`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Migration {
    UpToDate,
    Migrated {
        from: u32,
        backup: PathBuf,
    },
    /// Written by a newer otterm. Left untouched so nothing is lost on downgrade.
    Newer(u32),
}

/// Bring the file at `path` up to [`CURRENT_SCHEMA`]. A missing file or a missing `schema` key
/// counts as schema 1.
pub fn migrate_file(path: &Path) -> Result<Migration, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Migration::UpToDate),
        Err(e) => return Err(e.to_string()),
    };
    let probe: toml_edit::DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let from = match probe.get("schema") {
        None => 1,
        Some(item) => item.as_integer().and_then(|n| u32::try_from(n).ok()).ok_or("schema must be a whole number")?,
    };
    if from == 0 {
        return Err("schema must be at least 1".into());
    }
    if from > CURRENT_SCHEMA {
        return Ok(Migration::Newer(from));
    }
    if from == CURRENT_SCHEMA {
        return Ok(Migration::UpToDate);
    }

    let backup = backup_path(path, from);
    std::fs::copy(path, &backup).map_err(|e| e.to_string())?;
    // A missing key is written first so that it lands above any table header.
    let text = if probe.contains_key("schema") { text } else { format!("schema = {from}\n{text}") };
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    for s in from..CURRENT_SCHEMA {
        let step = STEPS.get((s - 1) as usize).ok_or_else(|| format!("no migration from schema {s}"))?;
        step(&mut doc);
    }
    doc["schema"] = toml_edit::value(i64::from(CURRENT_SCHEMA));
    std::fs::write(path, doc.to_string()).map_err(|e| e.to_string())?;
    Ok(Migration::Migrated { from, backup })
}

/// `config.toml.bak-<from>`, then `-2`, `-3`, ... when a name is taken, so no backup is overwritten.
fn backup_path(path: &Path, from: u32) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!("-{n}") };
        let candidate = path.with_file_name(format!("{name}.bak-{from}{suffix}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}
