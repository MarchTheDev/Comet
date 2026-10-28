//! Save encrypted password backups only to a location explicitly selected in
//! the native picker. The renderer receives an expiring, one-use capability,
//! never an arbitrary filesystem write primitive.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const MAX_BACKUP: usize = 8_002_000;
const MAX_PENDING: usize = 4;
const LIFETIME: Duration = Duration::from_secs(300);
#[derive(Default)]
pub struct PasswordBackups(Arc<Mutex<HashMap<String, Destination>>>);
struct Destination { parent_requested: PathBuf, parent: PathBuf, name: std::ffi::OsString, created: Instant }

fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)))
}
fn decoded_length(value: &Value, key: &str) -> Option<usize> {
    let encoded = value.get(key)?.as_str()?;
    if encoded.len() > MAX_BACKUP { return None; }
    STANDARD.decode(encoded).ok().map(|data| data.len())
}
fn valid_envelope(raw: &str) -> Option<String> {
    if raw.len() > 8_000_000 { return None; }
    let value: Value = serde_json::from_str(raw).ok()?;
    if !exact(&value, &["format", "version", "kdf", "iterations", "salt", "iv", "ciphertext"])
        || value.get("format")?.as_str()? != "comet-passwords" || value.get("version")?.as_u64()? != 1
        || value.get("kdf")?.as_str()? != "PBKDF2-SHA256" || !(600_000..=2_000_000).contains(&value.get("iterations")?.as_u64()?)
        || decoded_length(&value, "salt")? != 16 || decoded_length(&value, "iv")? != 12 || decoded_length(&value, "ciphertext")? < 16 { return None; }
    Some(value.get("salt")?.as_str()?.to_owned())
}
fn valid_backup(raw: &str) -> bool {
    if raw.len() > MAX_BACKUP { return false; }
    if valid_envelope(raw).is_some() { return true; }
    let Ok(value) = serde_json::from_str::<Value>(raw) else { return false; };
    if !exact(&value, &["format", "version", "envelope", "recovery"]) || value.get("format").and_then(Value::as_str) != Some("comet-passwords-bundle") || value.get("version").and_then(Value::as_u64) != Some(1) { return false; }
    let Some(salt) = value.get("envelope").and_then(Value::as_str).and_then(valid_envelope) else { return false; };
    let Some(recovery) = value.get("recovery") else { return false; };
    exact(recovery, &["format", "version", "salt", "iv", "wrappedKey"])
        && recovery.get("format").and_then(Value::as_str) == Some("comet-password-recovery")
        && recovery.get("version").and_then(Value::as_u64) == Some(1)
        && recovery.get("salt").and_then(Value::as_str) == Some(salt.as_str())
        && decoded_length(recovery, "iv") == Some(12) && decoded_length(recovery, "wrappedKey") == Some(48)
}
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16]; getrandom::fill(&mut bytes).map_err(|_| "Couldn't prepare a backup.")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn destination(path: &Path) -> Result<Destination, String> {
    if !path.is_absolute() { return Err("Choose a location on this device.".into()); }
    let name = path.file_name().ok_or("Choose a file name for the backup.")?.to_os_string();
    let parent_requested = path.parent().ok_or("Choose a folder for the backup.")?.to_path_buf();
    let parent = fs::canonicalize(&parent_requested).map_err(|_| "Couldn't open the chosen backup folder.")?;
    if !parent.is_dir() { return Err("Choose a folder for the backup.".into()); }
    match fs::symlink_metadata(parent.join(&name)) {
        Ok(_) => return Err("A file with that name already exists. Choose a new name; nothing was overwritten.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err("Couldn't check the backup destination.".into()),
    }
    Ok(Destination { parent_requested, parent, name, created: Instant::now() })
}
fn publish(dest: Destination, raw: &str) -> Result<(), String> {
    if dest.created.elapsed() > LIFETIME { return Err("The backup selection expired. Choose a location again.".into()); }
    if !valid_backup(raw) { return Err("This isn't a valid encrypted Comet password backup. Nothing was saved.".into()); }
    let parent = fs::canonicalize(&dest.parent_requested).map_err(|_| "The backup folder changed. Choose a location again.")?;
    if parent != dest.parent { return Err("The backup folder changed. Choose a location again.".into()); }
    let target = parent.join(&dest.name);
    let temporary = parent.join(format!(".comet-password-backup-{}.part", random_token()?));
    let mut created = false;
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_| "Couldn't create the encrypted backup.")?;
        created = true;
        file.write_all(raw.as_bytes()).map_err(|_| "Couldn't write the encrypted backup.")?;
        file.sync_all().map_err(|_| "Couldn't finish the encrypted backup.")?;
        drop(file);
        if fs::canonicalize(&dest.parent_requested).ok().as_ref() != Some(&dest.parent) { return Err("The backup folder changed. Nothing was saved.".into()); }
        crate::rename_without_replace(&temporary, &target).map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists { "A file with that name already exists. Choose a new name; nothing was overwritten.".to_string() } else { format!("Couldn't save the encrypted backup: {error}") })?;
        Ok(())
    })();
    if result.is_err() && created { let _ = fs::remove_file(&temporary); }
    result
}

#[tauri::command]
pub async fn choose_password_backup(app: tauri::AppHandle, state: tauri::State<'_, PasswordBackups>) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title("Save encrypted password backup")
        .set_file_name("comet-passwords-encrypted.json").add_filter("JSON backup", &["json"]).blocking_save_file();
    let Some(path) = picked.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let dest = destination(&path)?;
    let mut pending = state.0.lock().map_err(|_| "Couldn't prepare the backup.")?;
    pending.retain(|_, value| value.created.elapsed() <= LIFETIME);
    if pending.len() >= MAX_PENDING { return Err("Too many backup dialogs are open. Try again shortly.".into()); }
    let token = random_token()?; pending.insert(token.clone(), dest); Ok(Some(token))
}
#[tauri::command]
pub async fn cancel_password_backup(state: tauri::State<'_, PasswordBackups>, token: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Couldn't cancel the backup.")?.remove(&token); Ok(())
}
#[tauri::command]
pub async fn write_password_backup(state: tauri::State<'_, PasswordBackups>, token: String, encrypted: String) -> Result<(), String> {
    let dest = state.0.lock().map_err(|_| "Couldn't finish the backup.")?.remove(&token).ok_or("The backup selection expired. Choose a location again.")?;
    tauri::async_runtime::spawn_blocking(move || publish(dest, &encrypted)).await.map_err(|_| "The backup was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encrypted() -> String {
        serde_json::json!({ "format":"comet-passwords", "version":1, "kdf":"PBKDF2-SHA256", "iterations":600000,
            "salt":STANDARD.encode([0u8;16]), "iv":STANDARD.encode([1u8;12]), "ciphertext":STANDARD.encode([2u8;32]) }).to_string()
    }
    #[test]
    fn rejects_plaintext_and_malformed_envelopes() {
        assert!(valid_backup(&encrypted()));
        assert!(!valid_backup("{\"password\":\"secret\"}"));
        assert!(!valid_backup(&encrypted().replace("600000", "1")));
        assert!(!valid_backup(&encrypted().replace("comet-passwords", "something-else")));
        let envelope = encrypted(); let salt = STANDARD.encode([0u8;16]);
        let bundle = serde_json::json!({"format":"comet-passwords-bundle","version":1,"envelope":envelope,"recovery":{"format":"comet-password-recovery","version":1,"salt":salt,"iv":STANDARD.encode([3u8;12]),"wrappedKey":STANDARD.encode([4u8;48])}}).to_string();
        assert!(valid_backup(&bundle));
        assert!(!valid_backup(&bundle.replace("comet-password-recovery", "invalid")));
    }
    #[test]
    fn save_uses_a_new_file_and_never_replaces_a_racing_destination() {
        let root = std::env::temp_dir().join(format!("comet-backup-test-{}", random_token().unwrap()));
        fs::create_dir(&root).unwrap(); let target = root.join("backup.json");
        let selected = destination(&target).unwrap(); fs::write(&target, "existing").unwrap();
        assert!(publish(selected, &encrypted()).is_err()); assert_eq!(fs::read_to_string(&target).unwrap(), "existing");
        assert!(destination(&target).is_err()); fs::remove_file(&target).unwrap();
        publish(destination(&target).unwrap(), &encrypted()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), encrypted());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
