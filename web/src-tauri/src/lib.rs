// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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
async fn read_note(vault: String, path: String) -> Result<String, String> {
    let note = checked_vault_entry(&vault, &path)?;
    std::fs::read_to_string(note).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_note(vault: String, path: String, content: String) -> Result<(), String> {
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

// Validate the nearest existing parent before creating missing Inbox/assets
// directories. Canonical paths ensure a symlink cannot redirect creation to a
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
    std::fs::rename(&source, &destination).map_err(|e| e.to_string())
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

#[tauri::command]
async fn copy_asset(vault: String, src: String, dest: String) -> Result<(), String> {
    let asset = checked_new_entry(&vault, &dest, true)?;
    let mut source = std::fs::File::open(&src).map_err(|e| e.to_string())?;
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
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
            {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_vault,
            read_note,
            write_note,
            open_vault,
            restore_vault_access,
            rename_entry,
            delete_entry,
            create_dir,
            create_note,
            copy_asset,
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
            assert!(checked_new_entry(root, linked_folder.join("new.md").to_str().unwrap(), true).is_err());
        }
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
