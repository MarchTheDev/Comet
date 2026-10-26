// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::Write;
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
    let mut stack = vec![std::path::PathBuf::from(&path)];
    while let Some(current) = stack.pop() {
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
            let name = child
                .file_name()
                .and_then(|n| n.to_str().map(|s| s.to_string()))
                .unwrap_or_default();
            let is_dir = child.is_dir();
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
async fn read_note(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_note(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_vault(app: tauri::AppHandle) -> Option<String> {
    let folder = app.dialog().file().blocking_pick_folder();
    folder.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_note(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Creating a note must never silently replace an existing file.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn copy_asset(src: String, dest: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut source = std::fs::File::open(&src).map_err(|e| e.to_string())?;
    let mut destination = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
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
    let mut stack = vec![std::path::PathBuf::from(&vault)];
    while let Some(current) = stack.pop() {
        let read = match std::fs::read_dir(&current) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path
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
            create_dir,
            create_note,
            copy_asset,
            search_vault
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
