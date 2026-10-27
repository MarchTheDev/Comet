//! Bounded-memory file imports. A completed file is published only after a
//! same-directory staging file is fully written and synced, without replacing
//! anything another process may have created in the meantime.
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const CHUNK_BYTES: usize = 512 * 1024;
const MAX_ACTIVE: usize = 16;

#[derive(Default)]
pub struct DroppedUploads(Arc<Mutex<HashMap<String, StagedUpload>>>);

pub fn is_stage_name(name: &str) -> bool {
    name.strip_prefix(".comet-upload-").and_then(|s| s.strip_suffix(".part"))
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|c| c.is_ascii_hexdigit()))
}

struct StagedUpload {
    vault: String,
    destination: String,
    parent: PathBuf,
    temporary: PathBuf,
    file: Option<File>,
    expected: u64,
    written: u64,
}
impl StagedUpload {
    fn new(vault: &str, destination: &str, expected: u64, create_parent: bool) -> Result<Self, String> {
        let path = crate::checked_new_entry(vault, destination, create_parent)?;
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err("An item with that name already exists.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
        let parent = fs::canonicalize(path.parent().ok_or("The item has no parent folder.")?).map_err(|e| e.to_string())?;
        for _ in 0..20 {
            let mut random = [0u8; 16]; getrandom::fill(&mut random).map_err(|_| "Couldn't prepare a file import.")?;
            let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let temporary = parent.join(format!(".comet-upload-{suffix}.part"));
            match OpenOptions::new().write(true).create_new(true).open(&temporary) {
                Ok(file) => return Ok(Self { vault: vault.into(), destination: destination.into(), parent, temporary, file: Some(file), expected, written: 0 }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("Couldn't create a unique temporary import file.".into())
    }
    fn append(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES || offset != self.written || self.written.checked_add(bytes.len() as u64).is_none_or(|n| n > self.expected) {
            return Err("The upload chunk is invalid or out of order.".into());
        }
        self.file.as_mut().ok_or("The upload is already closed.")?.write_all(bytes).map_err(|e| e.to_string())?;
        self.written += bytes.len() as u64;
        Ok(())
    }
    fn publish(mut self) -> Result<(), String> {
        if self.written != self.expected { return Err("The file import was incomplete; nothing was added.".into()); }
        let file = self.file.take().ok_or("The upload is already closed.")?;
        if file.metadata().map_err(|e| e.to_string())?.len() != self.expected { return Err("The temporary import changed; nothing was added.".into()); }
        file.sync_all().map_err(|e| e.to_string())?; drop(file);
        // Recheck both containment and the actual parent after the lengthy copy.
        let destination = crate::checked_new_entry(&self.vault, &self.destination, false)?;
        let parent = fs::canonicalize(destination.parent().ok_or("The item has no parent folder.")?).map_err(|e| e.to_string())?;
        if parent != self.parent { return Err("The destination folder changed during the import; nothing was added.".into()); }
        let target = parent.join(destination.file_name().ok_or("The item has no name.")?);
        let result = crate::rename_without_replace(&self.temporary, &target).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists { "An item with that name already exists.".into() } else { e.to_string() }
        });
        if result.is_ok() { self.temporary = PathBuf::new(); }
        result
    }
}
impl Drop for StagedUpload {
    fn drop(&mut self) { drop(self.file.take()); let _ = fs::remove_file(&self.temporary); }
}

#[tauri::command]
pub async fn begin_dropped_upload(state: tauri::State<'_, DroppedUploads>, vault: String, path: String, size: u64) -> Result<String, String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = shared.lock().map_err(|_| "Couldn't prepare the file import.")?;
        if sessions.len() >= MAX_ACTIVE { return Err("Too many file imports are active; wait for one to finish.".into()); }
        let staged = StagedUpload::new(&vault, &path, size, false)?;
        let id = staged.temporary.file_name().and_then(|s| s.to_str()).ok_or("Couldn't prepare a file import.")?.to_string();
        sessions.insert(id.clone(), staged); Ok(id)
    }).await.map_err(|_| "The file import was interrupted.".to_string())?
}
#[tauri::command]
pub async fn append_dropped_upload(state: tauri::State<'_, DroppedUploads>, id: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = shared.lock().map_err(|_| "Couldn't continue the file import.")?;
        sessions.get_mut(&id).ok_or("The upload is no longer active.")?.append(offset, &bytes)
    }).await.map_err(|_| "The file import was interrupted.".to_string())?
}
#[tauri::command]
pub async fn finish_dropped_upload(state: tauri::State<'_, DroppedUploads>, id: String) -> Result<(), String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let staged = shared.lock().map_err(|_| "Couldn't finish the file import.")?.remove(&id).ok_or("The upload is no longer active.")?;
        staged.publish()
    }).await.map_err(|_| "The file import was interrupted.".to_string())?
}
#[tauri::command]
pub async fn abort_dropped_upload(state: tauri::State<'_, DroppedUploads>, id: String) -> Result<(), String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = shared.lock().map_err(|_| "Couldn't cancel the file import.")?.remove(&id);
        Ok(())
    }).await.map_err(|_| "The file import was interrupted.".to_string())?
}

pub fn copy_file(vault: &str, src: &str, dest: &str) -> Result<(), String> {
    let mut source = File::open(src).map_err(|e| e.to_string())?;
    let before = source.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() { return Err("Only files can be imported.".into()); }
    let mut staged = StagedUpload::new(vault, dest, before.len(), true)?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    loop {
        let read = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 { break; }
        staged.append(staged.written, &buffer[..read])?;
    }
    let after = source.metadata().map_err(|e| e.to_string())?;
    if after.len() != before.len() || after.modified().ok() != before.modified().ok() { return Err("The source file changed during the import; nothing was added.".into()); }
    staged.publish()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        let mut id = [0u8; 8]; getrandom::fill(&mut id).unwrap();
        let root = std::env::temp_dir().join(format!("comet-upload-test-{:x}", u64::from_le_bytes(id)));
        fs::create_dir_all(root.join("vault/folder")).unwrap(); root
    }
    #[test]
    fn chunks_publish_only_complete_files_and_preserve_existing_data() {
        let root = temporary(); let vault = root.join("vault"); let dest = vault.join("folder/file.bin");
        let v = vault.to_str().unwrap(); let p = dest.to_str().unwrap();
        let mut upload = StagedUpload::new(v, p, 5, false).unwrap(); let stage = upload.temporary.clone();
        assert!(!dest.exists() && is_stage_name(stage.file_name().unwrap().to_str().unwrap()));
        assert!(crate::workspace_archive::pack(v).unwrap_err().contains("incomplete Comet file import"));
        upload.append(0, &[1, 2]).unwrap(); assert!(upload.append(0, &[3]).is_err());
        assert!(upload.append(2, &[0; CHUNK_BYTES + 1]).is_err());
        assert!(upload.publish().is_err()); assert!(!dest.exists() && !stage.exists());
        assert!(crate::workspace_archive::pack(v).is_ok());
        let mut upload = StagedUpload::new(v, p, 5, false).unwrap(); upload.append(0, &[1, 2, 3]).unwrap(); upload.append(3, &[4, 5]).unwrap();
        fs::write(&dest, b"other process").unwrap(); let stage = upload.temporary.clone(); assert!(upload.publish().is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"other process"); assert!(!stage.exists());
        fs::remove_file(&dest).unwrap(); let mut upload = StagedUpload::new(v, p, 5, false).unwrap(); upload.append(0, &[1, 2, 3, 4, 5]).unwrap(); upload.publish().unwrap();
        assert_eq!(fs::read(&dest).unwrap(), [1, 2, 3, 4, 5]);
        assert!(StagedUpload::new(v, root.join("escape.bin").to_str().unwrap(), 0, false).is_err());
        let empty = vault.join("empty.bin"); StagedUpload::new(v, empty.to_str().unwrap(), 0, false).unwrap().publish().unwrap(); assert_eq!(fs::metadata(empty).unwrap().len(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn import_size_is_not_limited_to_twenty_megabytes() {
        let root = temporary(); let vault = root.join("vault"); let dest = vault.join("big.bin"); let length = 20 * 1024 * 1024 + 31;
        let mut upload = StagedUpload::new(vault.to_str().unwrap(), dest.to_str().unwrap(), length as u64, false).unwrap();
        let chunk = vec![7u8; CHUNK_BYTES]; let mut done = 0;
        while done < length { let n = CHUNK_BYTES.min(length - done); upload.append(done as u64, &chunk[..n]).unwrap(); done += n; }
        upload.publish().unwrap(); assert_eq!(fs::metadata(dest).unwrap().len(), length as u64);
        fs::remove_dir_all(root).unwrap();
    }
}
