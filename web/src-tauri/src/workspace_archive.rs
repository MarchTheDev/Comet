//! Small, portable, uncompressed snapshots. Never follow links or overwrite an
//! existing workspace. Validate the whole input and its checksum before writing.
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_ARCHIVE: usize = 128 * 1024 * 1024;
pub(crate) const MAX_ENTRIES: usize = 20_000;
const MAGIC: &[u8] = b"COMETWS1\0";

fn valid_part(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." || (name.ends_with('.') || name.ends_with(' ')) || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) { return false; }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") { return false; }
    if (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9') { return false; }
    true
}
pub(crate) fn safe_path(name: &str) -> bool { name.len() <= 2048 && name.split('/').count() <= 32 && name.split('/').all(valid_part) }
fn relative_name(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(root).map_err(|_| "An item is outside the workspace.")?;
    let mut parts = Vec::new();
    for part in relative.components() {
        let Component::Normal(part) = part else { return Err("The workspace contains an unsafe path.".into()); };
        let value = part.to_str().ok_or("A filename isn't valid UTF-8 and can't be transferred between devices.")?;
        if !valid_part(value) { return Err(format!("The filename {value:?} isn't portable between devices.")); }
        parts.push(value);
    }
    let result = parts.join("/");
    if !safe_path(&result) { return Err("A workspace path is too long or deeply nested.".into()); }
    Ok(result)
}

pub fn pack(vault: &str) -> Result<Vec<u8>, String> {
    let requested = Path::new(vault);
    if !requested.is_absolute() || requested.components().any(|c| matches!(c, Component::ParentDir)) { return Err("Choose a local workspace folder.".into()); }
    let root = fs::canonicalize(requested).map_err(|_| "Couldn't open the workspace.")?;
    if !root.is_dir() { return Err("The workspace isn't a folder.".into()); }
    let mut result = MAGIC.to_vec(); let mut pending = vec![root.clone()]; let mut count = 0;
    let mut names = HashSet::new();
    while let Some(directory) = pending.pop() {
        let mut children = fs::read_dir(&directory).map_err(|_| "Couldn't read a workspace folder.")?.collect::<Result<Vec<_>, _>>().map_err(|_| "Couldn't read a workspace item.")?;
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            if entry.file_name().to_str().is_some_and(crate::upload::is_stage_name) {
                return Err("An incomplete Comet file import is present. Wait for it to finish, or remove the .comet-upload-…part file after an interrupted import, then try syncing again.".into());
            }
            count += 1; if count > MAX_ENTRIES { return Err("This workspace has more than 20,000 items.".into()); }
            let path = entry.path(); let metadata = fs::symlink_metadata(&path).map_err(|_| "Couldn't inspect a workspace item.")?;
            if metadata.file_type().is_symlink() { return Err("Snapshots don't follow symbolic links. Remove or exclude the link before uploading; nothing was uploaded.".into()); }
            if !metadata.is_dir() && !metadata.is_file() { return Err("The workspace contains an unsupported item; nothing was uploaded.".into()); }
            let resolved = fs::canonicalize(&path).map_err(|_| "Couldn't inspect a workspace item.")?;
            if !resolved.starts_with(&root) { return Err("A workspace item points outside the workspace.".into()); }
            let name = relative_name(&root, &path)?;
            if !names.insert(name.to_lowercase()) { return Err("Two workspace paths differ only by letter case. Rename one before transferring to another OS.".into()); }
            let size = if metadata.is_file() { metadata.len() } else { 0 };
            if size > MAX_ARCHIVE as u64 { return Err("This workspace exceeds the 128 MB snapshot limit. Nothing was uploaded.".into()); }
            let needed = 13u64 + name.len() as u64 + size;
            if needed > MAX_ARCHIVE as u64 || (result.len() as u64 + needed + 33) > MAX_ARCHIVE as u64 { return Err("This workspace exceeds the 128 MB snapshot limit. Nothing was uploaded.".into()); }
            result.push(if metadata.is_dir() { 2 } else { 1 });
            result.extend_from_slice(&(name.len() as u32).to_le_bytes()); result.extend_from_slice(&size.to_le_bytes()); result.extend_from_slice(name.as_bytes());
            if metadata.is_dir() { pending.push(path); }
            else {
                let file = File::open(path).map_err(|_| "Couldn't read a workspace file.")?;
                let before = file.metadata().map_err(|_| "Couldn't inspect a workspace file.")?;
                if !before.is_file() || before.len() != size || before.modified().ok() != metadata.modified().ok() { return Err("A file changed during the snapshot. Try again after saving it.".into()); }
                let mut data = Vec::new(); (&file).take(size + 1).read_to_end(&mut data).map_err(|_| "Couldn't read a workspace file.")?;
                let after = file.metadata().map_err(|_| "Couldn't inspect a workspace file.")?;
                if data.len() as u64 != size || after.len() != size || after.modified().ok() != before.modified().ok() { return Err("A file changed during the snapshot. Try again after saving it.".into()); }
                result.extend_from_slice(&data);
            }
        }
    }
    result.push(0); let hash = Sha256::digest(&result); result.extend_from_slice(&hash);
    validate(&result)?; Ok(result)
}

#[derive(Debug)]
struct Item { name: String, directory: bool, start: usize, size: usize }
fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, String> {
    let end = cursor.checked_add(4).ok_or("Invalid snapshot.")?; let value = bytes.get(*cursor..end).ok_or("Truncated snapshot.")?; *cursor = end; Ok(u32::from_le_bytes(value.try_into().unwrap()))
}
fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, String> {
    let end = cursor.checked_add(8).ok_or("Invalid snapshot.")?; let value = bytes.get(*cursor..end).ok_or("Truncated snapshot.")?; *cursor = end; Ok(u64::from_le_bytes(value.try_into().unwrap()))
}
fn validate(bytes: &[u8]) -> Result<Vec<Item>, String> {
    if bytes.len() < MAGIC.len() + 33 || bytes.len() > MAX_ARCHIVE || !bytes.starts_with(MAGIC) { return Err("This is not a supported Comet workspace snapshot.".into()); }
    let end = bytes.len() - 32;
    if Sha256::digest(&bytes[..end]).as_slice() != &bytes[end..] { return Err("The workspace snapshot is damaged. Nothing was imported.".into()); }
    let content = &bytes[..end]; let mut cursor = MAGIC.len(); let mut items = Vec::new(); let mut names = HashMap::new();
    loop {
        let kind = *content.get(cursor).ok_or("Truncated snapshot.")?; cursor += 1;
        if kind == 0 { if cursor != end { return Err("Invalid snapshot contents.".into()); } break; }
        if !matches!(kind, 1 | 2) || items.len() >= MAX_ENTRIES { return Err("Unsupported snapshot contents.".into()); }
        let name_len = read_u32(content, &mut cursor)? as usize; let size = read_u64(content, &mut cursor)?;
        if name_len == 0 || name_len > 2048 || size > MAX_ARCHIVE as u64 || (kind == 2 && size != 0) { return Err("Invalid snapshot item.".into()); }
        let name_end = cursor.checked_add(name_len).ok_or("Invalid snapshot.")?;
        let name = std::str::from_utf8(content.get(cursor..name_end).ok_or("Truncated snapshot.")?).map_err(|_| "Invalid snapshot filename.")?.to_string(); cursor = name_end;
        if !safe_path(&name) { return Err("Snapshot contains an unsafe or non-portable path.".into()); }
        let key = name.to_lowercase();
        if names.insert(key, kind).is_some() { return Err("Snapshot contains duplicate paths.".into()); }
        let file_end = cursor.checked_add(size as usize).ok_or("Invalid snapshot.")?;
        if file_end > end { return Err("Truncated snapshot file.".into()); }
        items.push(Item { name, directory: kind == 2, start: cursor, size: size as usize }); cursor = file_end;
    }
    for item in &items {
        let mut parent = item.name.as_str();
        while let Some((head, _)) = parent.rsplit_once('/') {
            if names.get(&head.to_lowercase()) != Some(&2) { return Err("Snapshot has a missing or conflicting parent folder.".into()); }
            parent = head;
        }
    }
    Ok(items)
}

/// A validated view over an archive, used by the incremental Drive protocol.
/// Contents are borrowed so inspecting a snapshot does not copy the workspace.
#[derive(Debug)]
pub(crate) struct ArchiveEntry<'a> {
    pub name: String,
    pub directory: bool,
    pub bytes: &'a [u8],
}
pub(crate) fn entries(bytes: &[u8]) -> Result<Vec<ArchiveEntry<'_>>, String> {
    Ok(validate(bytes)?.into_iter().map(|item| ArchiveEntry {
        name: item.name, directory: item.directory, bytes: &bytes[item.start..item.start + item.size],
    }).collect())
}
/// Reconstitute the existing, checksummed interchange format from individually
/// verified file contents. Validate the complete tree before exposing it.
pub(crate) fn assemble<'a>(items: impl IntoIterator<Item = ArchiveEntry<'a>>) -> Result<Vec<u8>, String> {
    let mut result = MAGIC.to_vec();
    let mut count = 0usize;
    for item in items {
        count += 1;
        if count > MAX_ENTRIES || !safe_path(&item.name) || (item.directory && !item.bytes.is_empty()) {
            return Err("Invalid incremental workspace manifest.".into());
        }
        let needed = 13usize.checked_add(item.name.len()).and_then(|n| n.checked_add(item.bytes.len())).ok_or("Workspace is too large.")?;
        if result.len().checked_add(needed).and_then(|n| n.checked_add(33)).is_none_or(|n| n > MAX_ARCHIVE) {
            return Err("This workspace exceeds the 128 MB sync limit. Local files were preserved.".into());
        }
        result.push(if item.directory { 2 } else { 1 });
        result.extend_from_slice(&(item.name.len() as u32).to_le_bytes());
        result.extend_from_slice(&(item.bytes.len() as u64).to_le_bytes());
        result.extend_from_slice(item.name.as_bytes());
        result.extend_from_slice(item.bytes);
    }
    result.push(0);
    let hash = Sha256::digest(&result); result.extend_from_slice(&hash);
    validate(&result)?;
    Ok(result)
}

pub fn unpack(bytes: &[u8], parent: &Path) -> Result<PathBuf, String> {
    let mut items = validate(bytes)?;
    let parent = fs::canonicalize(parent).map_err(|_| "Couldn't open the chosen import folder.")?;
    if !parent.is_dir() { return Err("Choose a folder for the imported workspace.".into()); }
    let mut nonce = [0u8; 8]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't create an import folder.")?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let target = parent.join(format!("Comet import {suffix}"));
    fs::create_dir(&target).map_err(|_| "Couldn't create a new import folder. No existing workspace was changed.")?;
    let result = (|| -> Result<(), String> {
        items.sort_by_key(|item| (item.name.matches('/').count(), !item.directory));
        for item in items {
            let path = item.name.split('/').fold(target.clone(), |base, part| base.join(part));
            if item.directory { fs::create_dir(&path).map_err(|_| "Couldn't create an imported folder.")?; }
            else {
                let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "Couldn't create an imported file.")?;
                file.write_all(&bytes[item.start..item.start + item.size]).map_err(|_| "Couldn't write an imported file.")?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result { let _ = fs::remove_dir_all(&target); return Err(error); }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_round_trip_and_bad_paths() {
        let mut random = [0u8; 8]; getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("comet-archive-{:x}", u64::from_le_bytes(random)));
        fs::create_dir_all(root.join("source/folder")).unwrap();
        fs::write(root.join("source/folder/a.bin"), [0, 1, 2, 255]).unwrap(); fs::create_dir(root.join("source/empty")).unwrap();
        let data = pack(root.join("source").to_str().unwrap()).unwrap();
        let imported = unpack(&data, &root).unwrap();
        assert_eq!(fs::read(imported.join("folder/a.bin")).unwrap(), [0, 1, 2, 255]); assert!(imported.join("empty").is_dir());
        let mut damaged = data.clone(); damaged[10] ^= 1; assert!(validate(&damaged).is_err());
        assert!(!safe_path("../escape")); assert!(!safe_path("C:/outside")); assert!(!safe_path("a\\b")); assert!(!safe_path("folder/NUL.txt"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn incremental_archive_views_round_trip_and_validate_the_complete_tree() {
        let original = assemble(vec![ArchiveEntry { name: "folder".into(), directory: true, bytes: &[] }, ArchiveEntry { name: "folder/note.md".into(), directory: false, bytes: b"hello" }]).unwrap();
        let rebuilt = assemble(entries(&original).unwrap()).unwrap();
        assert_eq!(rebuilt, original);
        assert!(assemble(vec![ArchiveEntry { name: "../escape".into(), directory: false, bytes: b"x" }]).is_err());
        assert!(assemble(vec![ArchiveEntry { name: "missing/note".into(), directory: false, bytes: b"x" }]).is_err());
        assert!(assemble(vec![ArchiveEntry { name: "A".into(), directory: false, bytes: b"x" }, ArchiveEntry { name: "a".into(), directory: false, bytes: b"y" }]).is_err());
    }
    fn crafted(name: &str) -> Vec<u8> {
        let mut data = MAGIC.to_vec(); data.push(1); data.extend_from_slice(&(name.len() as u32).to_le_bytes()); data.extend_from_slice(&0u64.to_le_bytes()); data.extend_from_slice(name.as_bytes()); data.push(0);
        let hash = Sha256::digest(&data); data.extend_from_slice(&hash); data
    }
    #[test]
    fn checksummed_archives_still_reject_traversal_and_missing_parents() {
        assert!(validate(&crafted("../escape.txt")).is_err());
        assert!(validate(&crafted("C:/escape.txt")).is_err());
        assert!(validate(&crafted("missing/file.txt")).is_err());
        assert!(validate(&crafted("safe.txt")).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_links_before_upload() {
        use std::os::unix::fs::symlink;
        let mut random = [0u8; 8]; getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("comet-link-{:x}", u64::from_le_bytes(random)));
        fs::create_dir(&root).unwrap(); symlink("/", root.join("link")).unwrap();
        assert!(pack(root.to_str().unwrap()).is_err()); fs::remove_dir_all(root).unwrap();
    }
}

/// Three-way merge for Drive revisions. Never overwrites a changed local file;
/// replaced/deleted originals are moved to a separate same-volume safety folder
/// before create-new writes, so a racing editor cannot silently lose its work.
#[derive(Debug, serde::Serialize)]
pub struct MergeSummary { pub applied: usize, pub conflicts: usize, pub deleted: usize, pub safety_folder: Option<String>, pub changed_paths: Vec<String> }
#[derive(Clone, Copy, PartialEq, Eq)]
struct SnapshotValue<'a> { directory: bool, bytes: &'a [u8] }
fn snapshot_map(bytes: &[u8]) -> Result<std::collections::BTreeMap<String, SnapshotValue<'_>>, String> {
    Ok(validate(bytes)?.into_iter().map(|item| (item.name, SnapshotValue { directory: item.directory, bytes: &bytes[item.start..item.start + item.size] })).collect())
}
fn path_under(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !safe_path(relative) { return Err("Sync encountered an unsafe path.".into()); }
    let target = relative.split('/').fold(root.to_path_buf(), |base, part| base.join(part));
    let parent = target.parent().ok_or("Invalid sync path.")?;
    let resolved = fs::canonicalize(parent).map_err(|_| "A sync parent folder is missing.")?;
    if !resolved.starts_with(root) { return Err("A sync path points outside the workspace.".into()); }
    let mut check = root.to_path_buf();
    for component in parent.strip_prefix(root).map_err(|_| "Invalid sync path.")?.components() {
        check.push(component);
        if fs::symlink_metadata(&check).map_err(|_| "A sync parent folder is missing.")?.file_type().is_symlink() { return Err("Sync does not follow symbolic links.".into()); }
    }
    Ok(target)
}
fn conflict_path(path: &Path, tag: &str, index: usize) -> Result<PathBuf, String> {
    let name = path.file_name().and_then(|part| part.to_str()).ok_or("A sync filename is not UTF-8.")?;
    // Keep extensions at the end so conflict copies still open as their type.
    let (stem, ext) = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).map(|(stem, ext)| (stem, format!(".{ext}"))).unwrap_or((name, String::new()));
    let suffix = if index == 0 { format!(" (Google conflict {tag}){ext}") } else { format!(" (Google conflict {tag}-{index}){ext}") };
    if suffix.len() >= 255 { return Err("A sync filename is too long to preserve a conflict.".into()); }
    let limit = 255 - suffix.len();
    let mut trimmed = stem.to_string(); while trimmed.len() > limit { trimmed.pop(); }
    if trimmed.is_empty() { return Err("A sync filename is too long to preserve a conflict.".into()); }
    Ok(path.with_file_name(format!("{trimmed}{suffix}")))
}
// Stage complete bytes in the target directory, then publish atomically without
// replacing an existing file. A failed/interrupted write never looks complete.
fn atomic_write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    for _ in 0..20 {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| std::io::Error::other("Couldn't create temporary sync data"))?;
        let temp = parent.join(format!(".comet-sync-{:x}.tmp", u128::from_le_bytes(nonce)));
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        let result = written.and_then(|_| crate::rename_without_replace(&temp, path));
        if result.is_err() { let _ = fs::remove_file(&temp); }
        return result;
    }
    Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "Couldn't create unique temporary sync data"))
}
fn current_file_matches(path: &Path, bytes: &[u8]) -> bool {
    fs::symlink_metadata(path).ok().is_some_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() == bytes.len() as u64)
        && fs::read(path).ok().is_some_and(|old| old == bytes)
}
fn conflict_copy(root: &Path, path: &Path, bytes: &[u8]) -> Result<bool, String> {
    let hash = Sha256::digest(bytes); let tag = hash[..4].iter().map(|b| format!("{b:02x}")).collect::<String>();
    for index in 0..1000 {
        let candidate = conflict_path(path, &tag, index)?;
        // Refuse before writing a copy that the next portable snapshot could not pack.
        relative_name(root, &candidate)?;
        match atomic_write_new(&candidate, bytes) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if current_file_matches(&candidate, bytes) { return Ok(false); }
            },
            Err(_) => return Err("Couldn't create a complete sync conflict copy; the original was not overwritten.".into()),
        }
    }
    Err("Too many conflict copies with the same name.".into())
}
fn safety_directory(root: &Path, slot: &mut Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = slot { return Ok(path.clone()); }
    let parent = root.parent().ok_or("The workspace has no parent folder for safe sync backups.")?;
    let mut nonce = [0u8; 8]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't create a safety folder.")?;
    let target = parent.join(format!("Comet sync safety {:x}", u64::from_le_bytes(nonce)));
    fs::create_dir(&target).map_err(|_| "Couldn't create a safety folder beside this workspace; nothing was overwritten.")?;
    *slot = Some(target.clone()); Ok(target)
}
fn save_original(root: &Path, source: &Path, safety: &mut Option<PathBuf>, counter: usize) -> Result<PathBuf, String> {
    let relative = source.strip_prefix(root).map_err(|_| "A sync source is outside the workspace.")?;
    let target = safety_directory(root, safety)?.join(format!("{counter:05}")).join(relative);
    fs::create_dir_all(target.parent().ok_or("Invalid safety path.")?).map_err(|_| "Couldn't prepare the safety backup.")?;
    crate::rename_without_replace(source, &target).map_err(|_| "A local file changed or couldn't be safely moved. Sync stopped without overwriting it.")?;
    Ok(target)
}
pub fn merge(vault: &str, base: Option<&[u8]>, remote: &[u8]) -> Result<MergeSummary, String> {
    let root = fs::canonicalize(vault).map_err(|_| "Couldn't open the workspace for sync.")?;
    if !root.is_dir() { return Err("The workspace isn't a folder.".into()); }
    let local_bytes = pack(vault)?;
    let local = snapshot_map(&local_bytes)?; let base_map = if let Some(base) = base { snapshot_map(base)? } else { Default::default() }; let remote_map = snapshot_map(remote)?;
    let mut result = MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() };
    let mut safety = None; let mut counter = 0usize;
    let attempt = (|| -> Result<(), String> {
    // Mark folders containing changed/new remote descendants. This avoids
    // resurrecting an unchanged empty folder deleted locally.
    let mut changed_ancestors = HashSet::new();
    for (name, value) in &remote_map {
        if base_map.get(name).copied() != Some(*value) {
            let mut current = name.as_str();
            while let Some((parent, _)) = current.rsplit_once('/') { changed_ancestors.insert(parent.to_string()); current = parent; }
        }
    }
    // Map remote folder paths to local paths. None marks a locally deleted,
    // unchanged subtree that should not be resurrected.
    let mut mapped: HashMap<String, Option<String>> = HashMap::new();
    for (name, remote_value) in remote_map.iter().filter(|(_, value)| value.directory) {
        let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", name.as_str()));
        let remapped_parent = mapped.get(parent).and_then(|value| value.as_deref()).is_some_and(|value| value != parent);
        if mapped.get(parent).is_some_and(Option::is_none) || (!remapped_parent && local.get(name).is_none() && base_map.get(name).copied() == Some(*remote_value) && !changed_ancestors.contains(name)) {
            mapped.insert(name.clone(), None); continue;
        }
        let mapped_parent = mapped.get(parent).and_then(|v| v.as_deref()).unwrap_or(parent);
        let relative = if mapped_parent.is_empty() { leaf.to_string() } else { format!("{mapped_parent}/{leaf}") };
        let target = path_under(&root, &relative)?;
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => { mapped.insert(name.clone(), Some(relative)); },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => { fs::create_dir(&target).map_err(|_| "Couldn't create a synced folder.")?; mapped.insert(name.clone(), Some(relative)); result.applied += 1; },
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                let hash = Sha256::digest(name.as_bytes()); let tag = hash[..4].iter().map(|b| format!("{b:02x}")).collect::<String>();
                let mut created = None;
                for index in 0..1000 {
                    let candidate = conflict_path(&target, &tag, index)?;
                    match fs::create_dir(&candidate) {
                        Ok(()) => { result.conflicts += 1; created = Some(candidate); break; },
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                            // Reuse our deterministic conflict directory on retry;
                            // individual files are still created without replacement.
                            if fs::symlink_metadata(&candidate).ok().is_some_and(|m| m.is_dir() && !m.file_type().is_symlink()) { created = Some(candidate); break; }
                        },
                        Err(_) => return Err("Couldn't preserve a conflicting remote folder.".into()),
                    }
                }
                let candidate = created.ok_or("Too many conflicting folders.")?;
                let relative = relative_name(&root, &candidate)?; mapped.insert(name.clone(), Some(relative));
            },
            _ => return Err("Sync encountered an unsupported item or symbolic link.".into()),
        }
    }
    for (name, value) in remote_map.iter().filter(|(_, value)| !value.directory) {
        let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", name.as_str()));
        if mapped.get(parent).is_some_and(Option::is_none) { continue; }
        let mapped_parent = mapped.get(parent).and_then(|v| v.as_deref()).unwrap_or(parent);
        let relative = if mapped_parent.is_empty() { leaf.to_string() } else { format!("{mapped_parent}/{leaf}") };
        let target = path_under(&root, &relative)?;
        let changed_parent = mapped_parent != parent;
        let here = if changed_parent { None } else { local.get(name).copied() };
        let original = base_map.get(name).copied();
        if here == Some(*value) || (!changed_parent && original == Some(*value)) || (changed_parent && current_file_matches(&target, value.bytes)) { continue; }
        let clean_update = !changed_parent && here.is_some() && here == original && !here.unwrap().directory;
        if clean_update && current_file_matches(&target, here.unwrap().bytes) {
            counter += 1; let saved = save_original(&root, &target, &mut safety, counter)?;
            if !current_file_matches(&saved, here.unwrap().bytes) {
                // An external editor wrote after our snapshot; restore its edit
                // and preserve the incoming version as a conflict instead.
                crate::rename_without_replace(&saved, &target).map_err(|_| "A local file changed during sync; its original is in the safety folder.")?;
                if conflict_copy(&root, &target, value.bytes)? { result.conflicts += 1; }
                continue;
            }
            match atomic_write_new(&target, value.bytes) {
                Ok(()) => { result.applied += 1; result.changed_paths.push(relative.clone()); },
                Err(_) => { let _ = crate::rename_without_replace(&saved, &target); return Err(format!("Couldn't apply a complete remote file. The local original, if not restored, is safe in {}.", saved.display())); }
            }
        } else if here.is_some() || (!changed_parent && original.is_some()) {
            if conflict_copy(&root, &target, value.bytes)? { result.conflicts += 1; }
        } else {
            match atomic_write_new(&target, value.bytes) {
                Ok(()) => { result.applied += 1; result.changed_paths.push(relative.clone()); },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => { if conflict_copy(&root, &target, value.bytes)? { result.conflicts += 1; } },
                Err(_) => return Err("Couldn't create a complete synced file.".into()),
            }
        }
    }
    // Propagate a remote deletion only when the actual local bytes still equal
    // the common ancestor. Move originals out of the workspace first.
    for (name, old) in base_map.iter().filter(|(_, value)| !value.directory) {
        if !remote_map.contains_key(name) && local.get(name) == Some(old) {
            let target = path_under(&root, name)?;
            if current_file_matches(&target, old.bytes) {
                counter += 1; let saved = save_original(&root, &target, &mut safety, counter)?;
                if current_file_matches(&saved, old.bytes) { result.deleted += 1; result.changed_paths.push(name.clone()); }
                else { crate::rename_without_replace(&saved, &target).map_err(|_| "A local file changed during sync; its original is in the safety folder.")?; }
            }
        }
    }
    let mut old_dirs: Vec<_> = base_map.iter().filter(|(name, value)| value.directory && !remote_map.contains_key(*name)).map(|(name, _)| name).collect();
    old_dirs.sort_by_key(|name| std::cmp::Reverse(name.matches('/').count()));
    for name in old_dirs { if let Ok(path) = path_under(&root, name) { if fs::symlink_metadata(&path).ok().is_some_and(|m| m.is_dir() && !m.file_type().is_symlink()) { let _ = fs::remove_dir(path); } } }
    Ok(())
    })();
    if let Err(error) = attempt {
        return Err(match &safety { Some(path) => format!("{error} Originals already moved are in {}.", path.display()), None => error });
    }
    result.safety_folder = safety.map(|path| path.to_string_lossy().to_string());
    Ok(result)
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    fn test_dir(label: &str) -> PathBuf {
        let mut nonce = [0u8; 8]; getrandom::fill(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!("comet-sync-test-{label}-{:x}", u64::from_le_bytes(nonce)));
        fs::create_dir(&dir).unwrap(); dir
    }
    #[test]
    fn three_way_merge_preserves_conflicts_and_propagates_safe_edits_and_deletions() {
        let area = test_dir("merge"); let base = area.join("base"); let local = area.join("local"); let remote = area.join("remote");
        for dir in [&base, &local, &remote] { fs::create_dir(dir).unwrap(); fs::write(dir.join("same.txt"), "base").unwrap(); fs::write(dir.join("conflict.txt"), "base").unwrap(); fs::write(dir.join("deleted.txt"), "delete me").unwrap(); }
        let base_bytes = pack(base.to_str().unwrap()).unwrap();
        fs::write(local.join("conflict.txt"), "local edit").unwrap();
        fs::write(remote.join("same.txt"), "remote edit").unwrap(); fs::write(remote.join("conflict.txt"), "remote edit").unwrap(); fs::remove_file(remote.join("deleted.txt")).unwrap(); fs::write(remote.join("new.txt"), "new").unwrap();
        let remote_bytes = pack(remote.to_str().unwrap()).unwrap();
        let summary = merge(local.to_str().unwrap(), Some(&base_bytes), &remote_bytes).unwrap();
        assert_eq!(fs::read_to_string(local.join("same.txt")).unwrap(), "remote edit");
        assert_eq!(fs::read_to_string(local.join("conflict.txt")).unwrap(), "local edit");
        assert!(!local.join("deleted.txt").exists()); assert_eq!(fs::read_to_string(local.join("new.txt")).unwrap(), "new");
        assert_eq!(summary.conflicts, 1); assert_eq!(summary.deleted, 1);
        let conflict = fs::read_dir(&local).unwrap().map(Result::unwrap).find(|entry| entry.file_name().to_string_lossy().starts_with("conflict (Google conflict ")).unwrap();
        assert_eq!(fs::read_to_string(conflict.path()).unwrap(), "remote edit");
        let safety = PathBuf::from(summary.safety_folder.unwrap()); assert_eq!(fs::read_dir(&safety).unwrap().count(), 2);
        // Retrying with the same baseline does not duplicate the remote conflict.
        merge(local.to_str().unwrap(), Some(&base_bytes), &remote_bytes).unwrap();
        assert_eq!(fs::read_dir(&local).unwrap().map(Result::unwrap).filter(|entry| entry.file_name().to_string_lossy().starts_with("conflict (Google conflict ")).count(), 1);
        fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn unchanged_remote_does_not_resurrect_a_local_deletion() {
        let area = test_dir("deletion"); let base = area.join("base"); let local = area.join("local");
        fs::create_dir(&base).unwrap(); fs::create_dir(&local).unwrap(); fs::write(base.join("gone.md"), "old").unwrap();
        let bytes = pack(base.to_str().unwrap()).unwrap(); merge(local.to_str().unwrap(), Some(&bytes), &bytes).unwrap();
        assert_eq!(fs::read_dir(&local).unwrap().count(), 0); fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn deleted_unchanged_folders_are_not_resurrected() {
        let area = test_dir("deleted-folder"); let base = area.join("base"); let local = area.join("local");
        fs::create_dir_all(base.join("deep/sub")).unwrap(); fs::create_dir(&local).unwrap();
        fs::write(base.join("deep/sub/file.md"), "unchanged").unwrap();
        let bytes = pack(base.to_str().unwrap()).unwrap();
        merge(local.to_str().unwrap(), Some(&bytes), &bytes).unwrap();
        assert!(!local.join("deep").exists());
        fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn file_folder_conflict_and_retry_keep_both_without_duplicate_folders() {
        let area = test_dir("type-conflict"); let base = area.join("base"); let local = area.join("local"); let remote = area.join("remote");
        fs::create_dir(&base).unwrap(); fs::create_dir(&local).unwrap(); fs::create_dir_all(remote.join("item/sub")).unwrap();
        fs::write(local.join("item"), "local file").unwrap(); fs::write(remote.join("item/sub/inside.txt"), "remote file").unwrap();
        let old = pack(base.to_str().unwrap()).unwrap(); let incoming = pack(remote.to_str().unwrap()).unwrap();
        let first = merge(local.to_str().unwrap(), Some(&old), &incoming).unwrap(); assert_eq!(first.conflicts, 1);
        merge(local.to_str().unwrap(), Some(&old), &incoming).unwrap();
        assert_eq!(fs::read_to_string(local.join("item")).unwrap(), "local file");
        let folders: Vec<_> = fs::read_dir(&local).unwrap().map(Result::unwrap).filter(|e| e.file_type().unwrap().is_dir()).collect();
        assert_eq!(folders.len(), 1); assert_eq!(fs::read_to_string(folders[0].path().join("sub/inside.txt")).unwrap(), "remote file");
        fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn deletions_never_remove_locally_edited_files() {
        let area = test_dir("changed-delete"); let base = area.join("base"); let local = area.join("local"); let remote = area.join("remote");
        for dir in [&base, &local, &remote] { fs::create_dir(dir).unwrap(); }
        fs::write(base.join("a.md"), "old").unwrap(); fs::write(local.join("a.md"), "local changes").unwrap();
        let old = pack(base.to_str().unwrap()).unwrap(); let incoming = pack(remote.to_str().unwrap()).unwrap();
        let result = merge(local.to_str().unwrap(), Some(&old), &incoming).unwrap();
        assert_eq!(result.deleted, 0); assert_eq!(fs::read_to_string(local.join("a.md")).unwrap(), "local changes");
        fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn damaged_remote_does_not_change_local_workspace() {
        let area = test_dir("damaged"); let local = area.join("local"); fs::create_dir(&local).unwrap(); fs::write(local.join("keep.txt"), "safe").unwrap();
        let mut incoming = pack(local.to_str().unwrap()).unwrap(); incoming[10] ^= 1;
        assert!(merge(local.to_str().unwrap(), None, &incoming).is_err());
        assert_eq!(fs::read_to_string(local.join("keep.txt")).unwrap(), "safe"); assert_eq!(fs::read_dir(&local).unwrap().count(), 1);
        fs::remove_dir_all(area).unwrap();
    }
    #[test]
    fn atomic_create_never_replaces_an_existing_file_or_leaves_partial_data() {
        let area = test_dir("atomic"); let target = area.join("file"); fs::write(&target, "original").unwrap();
        assert_eq!(atomic_write_new(&target, b"incoming").unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(target).unwrap(), "original"); assert_eq!(fs::read_dir(&area).unwrap().count(), 1);
        fs::remove_dir_all(area).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn sync_refuses_local_symlinks_before_touching_files() {
        use std::os::unix::fs::symlink;
        let area = test_dir("symlink"); let base = area.join("base"); let local = area.join("local");
        fs::create_dir(&base).unwrap(); fs::create_dir(&local).unwrap(); fs::write(base.join("remote"), "remote").unwrap(); symlink(&base, local.join("linked")).unwrap();
        let data = pack(base.to_str().unwrap()).unwrap(); assert!(merge(local.to_str().unwrap(), None, &data).is_err());
        assert!(!local.join("remote").exists()); fs::remove_dir_all(area).unwrap();
    }

    #[test]
    fn locally_deleted_folder_preserves_remote_edited_descendant_as_conflict() {
        let area = test_dir("delete-edit"); let base = area.join("base"); let local = area.join("local"); let remote = area.join("remote");
        fs::create_dir_all(base.join("folder")).unwrap(); fs::create_dir(&local).unwrap(); fs::create_dir_all(remote.join("folder")).unwrap();
        fs::write(base.join("folder/note.md"), "old").unwrap(); fs::write(remote.join("folder/note.md"), "edited remotely").unwrap();
        let old = pack(base.to_str().unwrap()).unwrap(); let incoming = pack(remote.to_str().unwrap()).unwrap();
        let result = merge(local.to_str().unwrap(), Some(&old), &incoming).unwrap();
        assert_eq!(result.conflicts, 1); assert!(!local.join("folder/note.md").exists());
        let copy = fs::read_dir(local.join("folder")).unwrap().map(Result::unwrap).next().unwrap().path();
        assert_eq!(fs::read_to_string(copy).unwrap(), "edited remotely");
        fs::remove_dir_all(area).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn overly_long_conflict_names_fail_before_creating_untransferable_files() {
        let area = test_dir("long-conflict"); let local = area.join("local"); fs::create_dir(&local).unwrap();
        let mut path = local.clone(); for n in 0..8 { path.push(format!("{}{}", n, "x".repeat(239))); fs::create_dir(&path).unwrap(); }
        let target = path.join(format!("{}.txt", "n".repeat(100))); fs::write(&target, "local").unwrap();
        let before = fs::read_dir(&path).unwrap().count();
        assert!(conflict_copy(&fs::canonicalize(&local).unwrap(), &target, b"remote").is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "local"); assert_eq!(fs::read_dir(&path).unwrap().count(), before);
        fs::remove_dir_all(area).unwrap();
    }

}
