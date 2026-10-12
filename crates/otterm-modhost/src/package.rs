//! `.otmod` packages: a mod folder zipped with `otmod.toml` at the root (docs/05 §7.1, decision K7).
//!
//! A package is a zip file, so `pack` and `unpack` only build and check the archive. Installing one is
//! [`install_package`], which unpacks into a temporary folder and then uses the same [`install`] as a folder does.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use anyhow::{Context, Result, bail};
use semver::Version;
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::manifest::{Platform, valid_id};
use crate::store::{Installed, install, is_link_like, read_manifest};

/// File name of the manifest, which must be at the root of a package.
const MANIFEST_FILE: &str = "otmod.toml";
/// Largest package file, compressed (decision K7): 50 MB.
const PACKAGE_LIMIT: u64 = 50 * 1024 * 1024;
/// Largest total of the uncompressed files (decision K7): 200 MB.
const UNPACKED_LIMIT: u64 = 200 * 1024 * 1024;
/// Extension of a package file.
const PACKAGE_EXT: &str = "otmod";

/// Zip the mod folder `source` into `out_dir/<id>-<version>.otmod`, and return that path.
///
/// `node_modules`, `.git`, and existing packages are left out. A link anywhere in the folder is an error, as in
/// [`install`]. The entries are sorted, so the same folder gives the same order of files every time.
pub fn pack(source: &Path, out_dir: &Path) -> Result<PathBuf> {
    let manifest = read_manifest(source)?;
    let id = manifest.mod_.id.clone();
    if !valid_id(&id) {
        bail!("invalid mod id `{id}` in {}", source.join(MANIFEST_FILE).display());
    }
    let mut files = Vec::new();
    collect(source, "", &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    // Checked before writing, so that `unpack` never has to refuse a package that `pack` made.
    let mut total = 0u64;
    for (_, path) in &files {
        total += fs::metadata(path).with_context(|| format!("cannot read {}", path.display()))?.len();
    }
    if total > UNPACKED_LIMIT {
        bail!("the mod is {total} bytes unpacked; a package is limited to 200 MB");
    }
    fs::create_dir_all(out_dir).with_context(|| format!("cannot create {}", out_dir.display()))?;
    let out = out_dir.join(format!("{id}-{}.{PACKAGE_EXT}", manifest.mod_.version));
    // Written under a temporary name, then renamed, so a failed pack never replaces a good package.
    let part = out.with_extension(format!("{PACKAGE_EXT}.part"));
    if let Err(e) = write_zip(&part, &files) {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    if fs::metadata(&part)?.len() > PACKAGE_LIMIT {
        let _ = fs::remove_file(&part);
        bail!("the package is larger than 50 MB compressed");
    }
    fs::rename(&part, &out).with_context(|| format!("cannot replace {}", out.display()))?;
    Ok(out)
}

/// Gather the files under `dir` as `(name in the package, path)`. Names use `/`, whatever the platform.
fn collect(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("cannot read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            bail!("file name is not UTF-8: {}", path.display());
        };
        // An older package is not packed into a new one, and `.part` is a pack in progress.
        if name == "node_modules" || name == ".git" || name.ends_with(PACKAGE_EXT) || name.ends_with(".otmod.part") {
            continue;
        }
        let name_in_package = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        // `DirEntry::metadata` does not follow links, so a link shows up here as a link.
        let meta = entry.metadata()?;
        if meta.file_type().is_symlink() || (meta.is_dir() && is_link_like(&path)) {
            bail!("links are not allowed in a mod package: {}", path.display());
        }
        if meta.is_dir() {
            collect(&path, &name_in_package, out)?;
        } else {
            out.push((name_in_package, path));
        }
    }
    Ok(())
}

/// Write the zip file. The timestamp is fixed, so the bytes do not depend on when the folder was packed.
fn write_zip(path: &Path, files: &[(String, PathBuf)]) -> Result<()> {
    let file = File::create(path).with_context(|| format!("cannot write {}", path.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(DateTime::default());
    for (name, src) in files {
        zip.start_file(name.as_str(), options)?;
        let mut input = File::open(src).with_context(|| format!("cannot read {}", src.display()))?;
        io::copy(&mut input, &mut zip).with_context(|| format!("cannot pack {}", src.display()))?;
    }
    zip.finish()?;
    Ok(())
}

/// Unpack the package `archive` into the folder `dest`, which is created if missing.
///
/// Checks (decision K7): the archive is at most 50 MB, the files add up to at most 200 MB, counted from the bytes
/// actually read rather than the headers. A name with `..`, an absolute path, or a drive prefix is refused, and so
/// is a symlink entry. `otmod.toml` must be at the root, or inside one top-level folder, which is then removed from
/// the paths. Files are written as plain files without the mode bits in the archive, so an executable file is inert.
pub fn unpack(archive: &Path, dest: &Path) -> Result<()> {
    let size = fs::metadata(archive).with_context(|| format!("cannot read {}", archive.display()))?.len();
    if size > PACKAGE_LIMIT {
        bail!("the package is larger than 50 MB");
    }
    let mut zip =
        ZipArchive::new(File::open(archive)?).with_context(|| format!("{} is not a package", archive.display()))?;

    // First pass: check every name before writing anything, and note where the manifest is.
    let mut entries: Vec<(usize, PathBuf, bool)> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let raw = String::from_utf8_lossy(entry.name_raw()).into_owned();
        if entry.is_symlink() {
            bail!("links are not allowed in a package: {raw}");
        }
        let Some(path) = entry.enclosed_name() else {
            bail!("unsafe path in a package: {raw}");
        };
        entries.push((i, path, entry.is_dir()));
    }
    let strip = top_folder(&entries)?;

    fs::create_dir_all(dest).with_context(|| format!("cannot create {}", dest.display()))?;
    let mut total = 0u64;
    for (i, path, is_dir) in entries {
        let rel = match &strip {
            Some(top) => match path.strip_prefix(top) {
                Ok(rel) => rel.to_path_buf(),
                Err(_) => continue,
            },
            None => path,
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dest.join(&rel);
        if is_dir {
            fs::create_dir_all(&target)?;
            continue;
        }
        let mut entry = zip.by_index(i)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&target).with_context(|| format!("cannot write {}", target.display()))?;
        // Read one byte past the budget, so that an oversize file is seen without reading all of it.
        let budget = UNPACKED_LIMIT - total;
        let mut limited = (&mut entry).take(budget + 1);
        total += io::copy(&mut limited, &mut out).with_context(|| format!("cannot unpack {}", rel.display()))?;
        if total > UNPACKED_LIMIT {
            bail!("the package unpacks to more than 200 MB");
        }
    }
    Ok(())
}

/// The folder to strip, or `None` when `otmod.toml` is at the root. `Some(folder)` when the only top-level
/// folder holds it. Anything else is an error.
fn top_folder(entries: &[(usize, PathBuf, bool)]) -> Result<Option<PathBuf>> {
    let manifest = Path::new(MANIFEST_FILE);
    if entries.iter().any(|(_, p, dir)| !dir && p == manifest) {
        return Ok(None);
    }
    let tops: BTreeSet<PathBuf> = entries
        .iter()
        .filter_map(|(_, p, _)| match p.components().next()? {
            Component::Normal(name) => Some(PathBuf::from(name)),
            _ => None,
        })
        .collect();
    if tops.len() == 1 {
        let top = tops.into_iter().next().unwrap_or_default();
        let nested = top.join(MANIFEST_FILE);
        if entries.iter().any(|(_, p, dir)| !dir && *p == nested) {
            return Ok(Some(top));
        }
    }
    bail!("the package has no {MANIFEST_FILE} at its root or in one top-level folder")
}

/// Unpack `archive` into a new folder under `data_dir/tmp`, install it with [`install`], and remove the folder.
///
/// The folder is removed on error too. The package is never installed from the archive's own folder.
/// A package may not use the official `otterm.` namespace: otterm's own mods ship inside the app. With
/// `expect_id` (a registry install), a package holding any other mod is refused, since it would replace that mod.
pub fn install_package(
    data_dir: &Path,
    archive: &Path,
    expect_id: Option<&str>,
    platform: Platform,
    host: &Version,
) -> Result<Installed> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tmp_root = data_dir.join("tmp");
    fs::create_dir_all(&tmp_root).with_context(|| format!("cannot create {}", tmp_root.display()))?;
    // Process id, time, and a counter, so that two installs never share a folder.
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = tmp_root.join(format!("unpack-{}-{nanos}-{n}", std::process::id()));
    let result = unpack(archive, &dir).and_then(|()| {
        let id = read_manifest(&dir)?.mod_.id;
        if id.starts_with("otterm.") {
            bail!("`{id}`: the otterm. namespace is for otterm's own mods, which ship inside the app");
        }
        if let Some(expected) = expect_id
            && id != expected
        {
            bail!("the package for {expected} holds a different mod, {id}");
        }
        install(data_dir, &dir, false, platform, host)
    });
    let _ = fs::remove_dir_all(&dir);
    result
}

/// The SHA-256 of the file at `path`, as lowercase hex.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("cannot read {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        write!(hex, "{byte:02x}")?;
    }
    Ok(hex)
}
