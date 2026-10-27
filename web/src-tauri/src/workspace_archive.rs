//! Small, portable, uncompressed snapshots. Never follow links or overwrite an
//! existing workspace. Validate the whole input and its checksum before writing.
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const MAX_ARCHIVE: usize = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAGIC: &[u8] = b"COMETWS1\0";

fn valid_part(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 || name == "." || name == ".." || (name.ends_with('.') || name.ends_with(' ')) || name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) { return false; }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") { return false; }
    if (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9') { return false; }
    true
}
fn safe_path(name: &str) -> bool { name.len() <= 2048 && name.split('/').count() <= 32 && name.split('/').all(valid_part) }
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
