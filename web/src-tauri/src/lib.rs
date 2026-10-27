// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, PathBuf};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[tauri::command]
async fn list_vault(path: String) -> Vec<VaultEntry> {
    let mut entries = Vec::new();
    let root = match std::fs::canonicalize(&path) {
        Ok(root) => root,
        Err(_) => return entries,
    };
    let mut visited = HashSet::new();
    let mut scheduled = HashSet::new();
    scheduled.insert(root.clone());
    let mut stack = vec![PathBuf::from(&path)];
    while let Some(current) = stack.pop() {
        let resolved = match std::fs::canonicalize(&current) {
            Ok(resolved) if resolved.starts_with(&root) => resolved,
            _ => continue,
        };
        if !visited.insert(resolved) {
            continue;
        }
        let read = match std::fs::read_dir(&current) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let mut children: Vec<_> = read
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        children.sort();
        for child in children {
            // Avoid following a link outside the chosen folder, or back into a
            // directory we've already traversed.
            let resolved = match std::fs::canonicalize(&child) {
                Ok(resolved) if resolved.starts_with(&root) => resolved,
                _ => continue,
            };
            let is_dir = child.is_dir();
            if !is_dir && !child.is_file() {
                continue;
            }
            if is_dir && !scheduled.insert(resolved) {
                continue;
            }
            let name = child
                .file_name()
                .and_then(|n| n.to_str().map(|s| s.to_string()))
                .unwrap_or_default();
            entries.push(VaultEntry {
                name,
                path: child.to_string_lossy().to_string(),
                kind: if is_dir { "folder".to_string() } else { "file".to_string() },
            });
            if is_dir {
                stack.push(child);
            }
        }
    }
    entries
}

#[tauri::command]
async fn open_vault_file(app: tauri::AppHandle, vault: String, path: String) -> Result<(), String> {
    let file = checked_vault_entry(&vault, &path)?;
    if !file.is_file() {
        return Err("The selected item is not a file.".into());
    }
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

// This command is used only for a workspace the user opened or remembered.
// Resolve the directory before passing it to the platform's file manager.
#[tauri::command]
async fn open_workspace_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let requested = PathBuf::from(&path);
    if !requested.is_absolute() || requested.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("Choose a workspace folder on this device.".into());
    }
    let directory = std::fs::canonicalize(&requested).map_err(|e| e.to_string())?;
    if !directory.is_dir() { return Err("The workspace is not a folder.".into()); }
    app.opener().open_path(directory.to_string_lossy().to_string(), None::<&str>).map_err(|e| e.to_string())
}

// Reveal only an existing entry inside the selected workspace. Never pass an
// arbitrary renderer-supplied path to the system file manager.
#[tauri::command]
async fn reveal_vault_entry(vault: String, path: String) -> Result<(), String> {
    let entry = checked_vault_entry(&vault, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(entry).map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_note(vault: String, path: String) -> Result<String, String> {
    let note = checked_vault_entry(&vault, &path)?;
    let metadata = std::fs::metadata(&note).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return Err("This file is not a text file or is too large to edit (16 MB maximum).".into());
    }
    let content = std::fs::read_to_string(note).map_err(|_| "This file isn't UTF-8 text.".to_string())?;
    if content.contains('\0') {
        return Err("This file contains binary data and can't be edited as text.".into());
    }
    Ok(content)
}

#[tauri::command]
async fn write_note(vault: String, path: String, content: String) -> Result<(), String> {
    if content.len() > 16 * 1024 * 1024 { return Err("Text files are limited to 16 MB. Reduce the text before saving.".into()); }
    if content.contains('\0') { return Err("This text contains a NUL character and cannot be saved as an editable file.".into()); }
    let note = checked_vault_entry(&vault, &path)?;
    std::fs::write(note, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_vault(app: tauri::AppHandle) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder();
    folder.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

// The folder picker grants image access for the current run. Restore that
// narrowly scoped access when reopening a folder the user chose previously.
#[tauri::command]
async fn restore_vault_access(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let resolved = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !resolved.is_dir() {
        return Err("The saved workspace is not a folder.".to_string());
    }
    let scope = app.asset_protocol_scope();
    scope.allow_directory(&resolved, true).map_err(|e| e.to_string())?;
    scope.allow_directory(&path, true).map_err(|e| e.to_string())?;
    Ok(())
}

fn lexical_vault_child(vault: &str, path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault);
    let target = PathBuf::from(path);
    let has_parent = |item: &PathBuf| item.components().any(|part| matches!(part, Component::ParentDir));
    if !root.is_absolute() || !target.is_absolute() || has_parent(&root) || has_parent(&target)
        || target == root || !target.starts_with(&root)
    {
        return Err("That item is outside the workspace.".to_string());
    }
    Ok(target)
}

fn checked_vault_entry(vault: &str, path: &str) -> Result<PathBuf, String> {
    let entry = lexical_vault_child(vault, path)?;
    let root = std::fs::canonicalize(vault).map_err(|e| e.to_string())?;
    let target = std::fs::canonicalize(&entry).map_err(|e| e.to_string())?;
    if !root.is_dir() || target == root || !target.starts_with(&root) {
        return Err("That item is outside the workspace.".to_string());
    }
    Ok(entry)
}

// Validate the nearest existing parent before creating missing directories. Canonical paths ensure a symlink cannot redirect creation to a
// location outside the selected workspace.
fn checked_new_entry(vault: &str, path: &str, create_parent: bool) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(vault).map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("The workspace is not a folder.".to_string());
    }
    let target = lexical_vault_child(vault, path)?;
    if target.file_name().is_none() {
        return Err("Choose a path inside the workspace.".to_string());
    }
    let parent = target.parent().ok_or("The item has no parent folder.")?;
    let mut ancestor = parent;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("The item has no accessible parent folder.")?;
    }
    let resolved = std::fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) {
        return Err("That item is outside the workspace.".to_string());
    }
    if create_parent {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let resolved_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !resolved_parent.starts_with(&root) {
        return Err("That item is outside the workspace.".to_string());
    }
    Ok(target)
}

#[tauri::command]
async fn rename_entry(vault: String, path: String, new_name: String) -> Result<(), String> {
    let source = checked_vault_entry(&vault, &path)?;
    if new_name.is_empty()
        || new_name == "."
        || new_name == ".."
        || new_name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Choose a valid file name.".to_string());
    }
    let parent = source.parent().ok_or("The item has no parent folder.")?;
    let destination = parent.join(&new_name);
    if destination == source {
        return Ok(());
    }
    match std::fs::symlink_metadata(&destination) {
        Ok(_) => return Err("An item with that name already exists.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    rename_without_replace(&source, &destination).map_err(|e| e.to_string())
}

// A drag must never replace an existing item, including if another process
// creates the destination after the UI has listed the folder.
#[cfg(target_os = "linux")]
fn rename_without_replace(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" { fn renameat2(olddirfd: i32, oldpath: *const i8, newdirfd: i32, newpath: *const i8, flags: u32) -> i32; }
    let from = CString::new(source.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let to = CString::new(destination.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // AT_FDCWD and RENAME_NOREPLACE. A filesystem without support fails safely.
    if unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(target_os = "macos")]
fn rename_without_replace(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" { fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> i32; }
    let from = CString::new(source.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let to = CString::new(destination.as_os_str().as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(windows)]
fn rename_without_replace(source: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileW(from: *const u16, to: *const u16) -> i32; }
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_without_replace(_source: &std::path::Path, _destination: &std::path::Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Safe moves are not available on this platform."))
}

#[tauri::command]
async fn move_entry(vault: String, path: String, folder: String) -> Result<String, String> {
    let source = checked_vault_entry(&vault, &path)?;
    let root = std::fs::canonicalize(&vault).map_err(|e| e.to_string())?;
    let destination_folder = if PathBuf::from(&folder) == PathBuf::from(&vault) {
        PathBuf::from(&vault)
    } else {
        checked_vault_entry(&vault, &folder)?
    };
    let resolved_folder = std::fs::canonicalize(&destination_folder).map_err(|e| e.to_string())?;
    if !resolved_folder.is_dir() || !resolved_folder.starts_with(&root) {
        return Err("Choose a folder inside the workspace.".into());
    }
    let resolved_source = std::fs::canonicalize(&source).map_err(|e| e.to_string())?;
    if source.is_dir() && resolved_folder.starts_with(&resolved_source) {
        return Err("A folder cannot be moved into itself.".into());
    }
    let name = source.file_name().ok_or("The item has no name.")?;
    let destination = destination_folder.join(name);
    if destination == source { return Ok(path); }
    checked_new_entry(&vault, &destination.to_string_lossy(), false)?;
    rename_without_replace(&source, &destination).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists { "An item with that name already exists.".to_string() } else { e.to_string() }
    })?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
async fn delete_entry(vault: String, path: String) -> Result<(), String> {
    let target = checked_vault_entry(&vault, &path)?;
    let metadata = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn create_dir(vault: String, path: String) -> Result<(), String> {
    let folder = checked_new_entry(&vault, &path, false)?;
    std::fs::create_dir(folder).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_note(vault: String, path: String, content: String) -> Result<(), String> {
    let note = checked_new_entry(&vault, &path, true)?;
    // Creating a note must never silently replace an existing file.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(note)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

// HTML drop is enabled in WebView2 so both web links and files reach the UI.
// Bounded uploads use exclusive creation, just like the file-picker import.
#[tauri::command]
async fn import_dropped_bytes(vault: String, path: String, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > 20 * 1024 * 1024 { return Err("Dropped files are limited to 20 MB; use Upload files for larger files.".into()); }
    let destination = checked_new_entry(&vault, &path, false)?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(&bytes) {
        drop(file);
        let _ = std::fs::remove_file(&destination);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
async fn copy_asset(vault: String, src: String, dest: String) -> Result<(), String> {
    let asset = checked_new_entry(&vault, &dest, true)?;
    let mut source = std::fs::File::open(&src).map_err(|e| e.to_string())?;
    if !source.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Only files can be imported.".into()); }
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(asset)
        .map_err(|e| e.to_string())?;
    std::io::copy(&mut source, &mut destination)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub snippet: String,
}

#[tauri::command]
async fn search_vault(vault: String, query: String) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let q = query.to_lowercase();
    if q.trim().is_empty() {
        return hits;
    }
    let root = match std::fs::canonicalize(&vault) {
        Ok(root) => root,
        Err(_) => return hits,
    };
    let mut visited = HashSet::new();
    let mut scheduled = HashSet::new();
    scheduled.insert(root.clone());
    let mut stack = vec![PathBuf::from(&vault)];
    while let Some(current) = stack.pop() {
        let resolved = match std::fs::canonicalize(&current) {
            Ok(resolved) if resolved.starts_with(&root) => resolved,
            _ => continue,
        };
        if !visited.insert(resolved) {
            continue;
        }
        let read = match std::fs::read_dir(&current) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            let resolved = match std::fs::canonicalize(&path) {
                Ok(resolved) if resolved.starts_with(&root) => resolved,
                _ => continue,
            };
            if path.is_dir() {
                if scheduled.insert(resolved) {
                    stack.push(path);
                }
                continue;
            }
            if !path.is_file() || !path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt" | "text" | "log" | "csv" | "tsv" | "json" | "jsonl" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "html" | "htm" | "css" | "js" | "jsx" | "ts" | "tsx" | "py" | "rs" | "sh" | "sql" | "tex" | "rst" | "url" | "comet-todo"))
                .unwrap_or(true)
            {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if std::fs::metadata(&path).map(|m| m.len() > 16 * 1024 * 1024).unwrap_or(true) { continue; }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) if !c.contains('\0') => c,
                _ => continue,
            };
            if !name.to_lowercase().contains(&q) && !content.to_lowercase().contains(&q) {
                continue;
            }
            let snippet = content
                .lines()
                .find(|l| l.to_lowercase().contains(&q))
                .unwrap_or("Matching filename")
                .trim()
                .to_string();
            hits.push(SearchHit {
                path: path.to_string_lossy().to_string(),
                name,
                snippet,
            });
        }
    }
    hits.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    hits
}

struct TrayAvailable(bool);

#[tauri::command]
fn tray_available(available: tauri::State<'_, TrayAvailable>) -> bool { available.0 }

// The frontend calls this only after the pending save queue has been flushed.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) { app.exit(0); }

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "Open Comet", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Comet", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("comet-tray")
        .tooltip("Comet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // Do not exit directly: the webview owns the autosave queue.
                if app.get_webview_window("main").is_some() {
                    let _ = app.emit("comet-request-quit", ());
                } else { app.exit(0); }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Re-launching a tray-resident Comet restores the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            let available = create_tray(app.handle()).is_ok();
            app.manage(TrayAvailable(available));
            // If a tray cannot be created, never leave the application hidden.
            if !available { show_main_window(app.handle()); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_vault,
            tray_available,
            quit_app,
            open_vault_file,
            open_workspace_directory,
            reveal_vault_entry,
            read_note,
            write_note,
            open_vault,
            restore_vault_access,
            rename_entry,
            move_entry,
            delete_entry,
            create_dir,
            create_note,
            copy_asset,
            import_dropped_bytes,
            search_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{checked_new_entry, checked_vault_entry};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn workspace_paths_remain_scoped() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("comet-vault-test-{}-{unique}", std::process::id()));
        let vault = base.join("vault");
        let outside = base.join("outside.md");
        let note = vault.join("note.md");
        fs::create_dir_all(&vault).unwrap();
        fs::write(&note, "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        let root = vault.to_str().unwrap();
        assert!(checked_vault_entry(root, note.to_str().unwrap()).is_ok());
        assert!(checked_vault_entry(root, root).is_err());
        assert!(checked_vault_entry(root, outside.to_str().unwrap()).is_err());
        let capture = vault.join("Inbox").join("capture.md");
        assert!(checked_new_entry(root, capture.to_str().unwrap(), true).is_ok());
        assert!(checked_new_entry(root, outside.to_str().unwrap(), true).is_err());
        assert!(checked_new_entry(root, vault.join("..").join("escape.md").to_str().unwrap(), true).is_err());

        #[cfg(unix)]
        {
            let link = vault.join("external.md");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(checked_vault_entry(root, link.to_str().unwrap()).is_err());
            let outside_link = base.join("link-to-note.md");
            std::os::unix::fs::symlink(&note, &outside_link).unwrap();
            assert!(checked_vault_entry(root, outside_link.to_str().unwrap()).is_err());
            let outside_vault_link = base.join("link-to-vault");
            std::os::unix::fs::symlink(&vault, &outside_vault_link).unwrap();
            assert!(checked_new_entry(root, outside_vault_link.join("new.md").to_str().unwrap(), true).is_err());
            let outside_folder = base.join("outside");
            fs::create_dir(&outside_folder).unwrap();
            let linked_folder = vault.join("linked-folder");
            std::os::unix::fs::symlink(&outside_folder, &linked_folder).unwrap();
            assert!(checked_vault_entry(root, linked_folder.to_str().unwrap()).is_err());
            assert!(checked_new_entry(root, linked_folder.join("new.md").to_str().unwrap(), true).is_err());
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn moves_and_imports_never_replace_existing_files() {
        use super::{copy_asset, import_dropped_bytes, move_entry, read_note, write_note};
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("comet-move-test-{}-{unique}", std::process::id()));
        let vault = base.join("vault");
        let source_folder = vault.join("source");
        let destination_folder = vault.join("destination");
        fs::create_dir_all(&source_folder).unwrap();
        fs::create_dir_all(&destination_folder).unwrap();
        assert!(checked_vault_entry(vault.to_str().unwrap(), source_folder.to_str().unwrap()).is_ok());
        let source = source_folder.join("note.md");
        let destination = destination_folder.join("note.md");
        let external = base.join("upload.bin");
        fs::write(&source, "original").unwrap();
        fs::write(&destination, "existing").unwrap();
        fs::write(&external, [0, 255, 1]).unwrap();
        let path = |item: &std::path::Path| item.to_string_lossy().to_string();
        let root = path(&vault);
        tauri::async_runtime::block_on(async {
            assert!(move_entry(root.clone(), path(&source), path(&destination_folder)).await.is_err());
            assert_eq!(fs::read_to_string(&source).unwrap(), "original");
            assert_eq!(fs::read_to_string(&destination).unwrap(), "existing");
            fs::remove_file(&destination).unwrap();
            assert_eq!(move_entry(root.clone(), path(&source), path(&destination_folder)).await.unwrap(), path(&destination));
            assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
            assert!(move_entry(root.clone(), path(&destination_folder), path(&destination_folder)).await.is_err());
            assert!(copy_asset(root.clone(), path(&external), path(&destination)).await.is_err());
            assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
            assert!(write_note(root.clone(), path(&destination), "x".repeat(16 * 1024 * 1024 + 1)).await.is_err());
            assert!(write_note(root.clone(), path(&destination), "nul\0byte".into()).await.is_err());
            assert_eq!(fs::read_to_string(&destination).unwrap(), "original");
            let binary = destination_folder.join("upload.bin");
            copy_asset(root.clone(), path(&external), path(&binary)).await.unwrap();
            assert!(read_note(root.clone(), path(&binary)).await.is_err());
            assert!(import_dropped_bytes(root.clone(), path(&binary), vec![42]).await.is_err());
            assert_eq!(fs::read(&binary).unwrap(), vec![0, 255, 1]);
            let dropped = destination_folder.join("dropped.bin");
            import_dropped_bytes(root.clone(), path(&dropped), vec![3, 0, 255]).await.unwrap();
            assert_eq!(fs::read(&dropped).unwrap(), vec![3, 0, 255]);
            assert!(import_dropped_bytes(root.clone(), path(&vault.join("../escape.bin")), vec![1]).await.is_err());
            assert!(import_dropped_bytes(root.clone(), path(&destination_folder.join("huge.bin")), vec![0; 20 * 1024 * 1024 + 1]).await.is_err());
        });
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn vault_commands_skip_external_links_and_cycles() {
        use super::{copy_asset, create_dir, create_note, delete_entry, list_vault, read_note, rename_entry, search_vault, write_note};
        use std::os::unix::fs::symlink;
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("comet-command-test-{}-{unique}", std::process::id()));
        let vault = base.join("vault");
        let outside = base.join("outside");
        fs::create_dir_all(vault.join("Notes")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let note = vault.join("Notes/Alpha.md");
        let secret = outside.join("secret.md");
        fs::write(&note, "inside").unwrap();
        fs::write(vault.join("Notes/data.jsonl"), "searchable structured content").unwrap();
        fs::write(vault.join("Notes/binary"), [0, 255, 2]).unwrap();
        fs::write(&secret, "secret outside").unwrap();
        symlink(&outside, vault.join("External")).unwrap();
        symlink(&vault, vault.join("Cycle")).unwrap();
        let root = vault.to_string_lossy().to_string();
        let path = |item: &std::path::Path| item.to_string_lossy().to_string();

        tauri::async_runtime::block_on(async {
            let entries = list_vault(root.clone()).await;
            assert!(entries.iter().any(|entry| entry.name == "Alpha.md"));
            assert!(!entries.iter().any(|entry| entry.name == "Cycle" || entry.name == "External" || entry.name == "secret.md"));
            assert_eq!(search_vault(root.clone(), "inside".into()).await.len(), 1);
            assert_eq!(search_vault(root.clone(), "structured content".into()).await.len(), 1);
            assert!(search_vault(root.clone(), "secret".into()).await.is_empty());
            let external = vault.join("External/secret.md");
            assert!(read_note(root.clone(), path(&external)).await.is_err());
            assert!(write_note(root.clone(), path(&external), "bad".into()).await.is_err());
            assert!(create_note(root.clone(), path(&vault.join("External/new.md")), "bad".into()).await.is_err());
            assert!(create_dir(root.clone(), path(&vault.join("External/new-folder"))).await.is_err());
            assert!(copy_asset(root.clone(), path(&secret), path(&vault.join("External/copied.md"))).await.is_err());
            let capture = vault.join("Inbox/capture.md");
            create_note(root.clone(), path(&capture), "new thought".into()).await.unwrap();
            assert!(create_note(root.clone(), path(&capture), "overwrite".into()).await.is_err());
            rename_entry(root.clone(), path(&capture), "renamed.md".into()).await.unwrap();
            let renamed = vault.join("Inbox/renamed.md");
            assert!(rename_entry(root.clone(), path(&renamed), "../escape.md".into()).await.is_err());
            assert!(delete_entry(root.clone(), path(&external)).await.is_err());
            delete_entry(root.clone(), path(&renamed)).await.unwrap();
        });
        assert_eq!(fs::read_to_string(&secret).unwrap(), "secret outside");
        assert!(!outside.join("new.md").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
