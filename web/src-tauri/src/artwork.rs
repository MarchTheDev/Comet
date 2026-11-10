//! Artwork searches use Apple's public music catalog. Desktop requests run in
//! Rust because many webviews reject cross-origin catalog requests.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
use serde_json::Value;
use std::time::{Duration, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
pub struct Artwork { url: String, mime: String, data: String }
fn trusted_image(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false; };
    let Some(host) = url.host_str() else { return false; };
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && (host == "mzstatic.com" || host.ends_with(".mzstatic.com"))
}
const MAX_CACHE_FILE: u64 = 5_700_000;
const MAX_CACHED_COVERS: usize = 100;
fn valid_query(query: &str) -> bool { !query.is_empty() && query.chars().count() <= 400 && !query.chars().any(char::is_control) }
fn cache_key(query: &str) -> String { format!("{:x}", Sha256::digest(query.trim().to_lowercase().as_bytes())) }
fn cache_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("music-artwork");
    fs::create_dir_all(&dir).ok()?;
    if fs::symlink_metadata(&dir).ok()?.file_type().is_symlink() { return None; }
    Some(dir)
}
fn image_signature(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}
fn valid_image(mime: &str, bytes: &[u8]) -> bool { bytes.len() <= 4 * 1024 * 1024 && image_signature(mime, bytes) }
fn valid_artwork(art: &Artwork) -> bool {
    trusted_image(&art.url) && art.data.len() <= 5_600_000 && STANDARD.decode(&art.data).ok().is_some_and(|bytes| valid_image(&art.mime, &bytes))
}
fn cache_file(dir: &Path, query: &str) -> PathBuf { dir.join(format!("{}.json", cache_key(query))) }
fn read_cache(dir: &Path, query: &str) -> Option<Artwork> {
    let path = cache_file(dir, query); let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CACHE_FILE { return None; }
    let result: Artwork = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    valid_artwork(&result).then_some(result)
}
fn write_cache(dir: &Path, query: &str, artwork: &Artwork) {
    if !valid_artwork(artwork) { return; }
    let target = cache_file(dir, query);
    if read_cache(dir, query).is_some() { return; }
    // Only remove a malformed regular file belonging to this cache, never a link.
    if fs::symlink_metadata(&target).ok().is_some_and(|m| m.is_file()) { let _ = fs::remove_file(&target); }
    let mut nonce = [0u8; 16]; if getrandom::fill(&mut nonce).is_err() { return; }
    let temporary = dir.join(format!(".artwork-{:x}.tmp", u128::from_le_bytes(nonce)));
    let Ok(data) = serde_json::to_vec(artwork) else { return; };
    let Ok(mut file) = OpenOptions::new().write(true).create_new(true).open(&temporary) else { return; };
    let ready = file.write_all(&data).and_then(|_| file.sync_all()).is_ok(); drop(file);
    if ready { let _ = crate::rename_without_replace(&temporary, &target); }
    let _ = fs::remove_file(&temporary);
    let Ok(entries) = fs::read_dir(dir) else { return; };
    let mut files: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        let hash = name.strip_suffix(".json")?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
        let metadata = entry.metadata().ok()?; if !entry.file_type().ok()?.is_file() { return None; }
        Some((metadata.modified().ok()?, entry.path()))
    }).collect();
    files.sort_by_key(|(modified, _)| *modified);
    let remove = files.len().saturating_sub(MAX_CACHED_COVERS);
    for (_, path) in files.into_iter().take(remove) { let _ = fs::remove_file(path); }
}
// Hash a bounded amount of file data as well as its path and metadata. This
// restores art before the much slower audio-tag scan but invalidates the alias
// when a file is replaced or its beginning/end metadata changes.
fn file_fingerprint(path: &Path) -> Result<String, String> {
    const SAMPLE: u64 = 64 * 1024;
    let canonical = fs::canonicalize(path).map_err(|_| "Couldn't identify the audio file.")?;
    let mut file = File::open(&canonical).map_err(|_| "Couldn't identify the audio file.")?;
    let before = file.metadata().map_err(|_| "Couldn't identify the audio file.")?;
    if !before.is_file() { return Err("The audio file is not a regular file.".into()); }
    let modified = before.modified().ok();
    let nanos = modified.and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
    let mut digest = Sha256::new();
    digest.update(b"comet-audio-file-v1\0");
    digest.update(canonical.to_string_lossy().as_bytes());
    digest.update([0u8]); digest.update(before.len().to_le_bytes()); digest.update(nanos.to_le_bytes());
    let mut bytes = Vec::with_capacity(SAMPLE as usize);
    (&mut file).take(SAMPLE).read_to_end(&mut bytes).map_err(|_| "Couldn't inspect the audio file.")?;
    digest.update(&bytes);
    if before.len() > SAMPLE {
        file.seek(SeekFrom::End(-(SAMPLE as i64))).map_err(|_| "Couldn't inspect the audio file.")?;
        bytes.clear(); (&mut file).take(SAMPLE).read_to_end(&mut bytes).map_err(|_| "Couldn't inspect the audio file.")?;
        digest.update(&bytes);
    }
    let after = file.metadata().map_err(|_| "Couldn't identify the audio file.")?;
    if before.len() != after.len() || modified != after.modified().ok() { return Err("The audio file changed while checking its cover.".into()); }
    Ok(format!("{:x}", digest.finalize()))
}
fn valid_fingerprint(value: &str) -> bool { value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
fn alias_file(dir: &Path, fingerprint: &str) -> PathBuf { dir.join(format!("{fingerprint}.alias")) }
fn read_alias(dir: &Path, fingerprint: &str) -> Option<String> {
    if !valid_fingerprint(fingerprint) { return None; }
    let path = alias_file(dir, fingerprint); let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 1600 { return None; }
    let query = fs::read_to_string(path).ok()?;
    valid_query(&query).then_some(query)
}
fn write_alias(dir: &Path, fingerprint: &str, query: &str) {
    if !valid_fingerprint(fingerprint) || !valid_query(query) || read_cache(dir, query).is_none() { return; }
    let target = alias_file(dir, fingerprint);
    if read_alias(dir, fingerprint).and_then(|old| read_cache(dir, &old)).is_some() { return; }
    // Replace malformed/stale regular alias files, never links or other paths.
    if fs::symlink_metadata(&target).ok().is_some_and(|metadata| metadata.is_file()) { let _ = fs::remove_file(&target); }
    let mut nonce = [0u8; 16]; if getrandom::fill(&mut nonce).is_err() { return; }
    let temporary = dir.join(format!(".alias-{:x}.tmp", u128::from_le_bytes(nonce)));
    let Ok(mut file) = OpenOptions::new().write(true).create_new(true).open(&temporary) else { return; };
    let ready = file.write_all(query.as_bytes()).and_then(|_| file.sync_all()).is_ok(); drop(file);
    if ready { let _ = crate::rename_without_replace(&temporary, &target); }
    let _ = fs::remove_file(&temporary);
    let Ok(entries) = fs::read_dir(dir) else { return; };
    let mut files: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        if !valid_fingerprint(name.strip_suffix(".alias")?) || !entry.file_type().ok()?.is_file() { return None; }
        Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
    }).collect();
    files.sort_by_key(|(modified, _)| *modified);
    let remove = files.len().saturating_sub(300);
    for (_, path) in files.into_iter().take(remove) { let _ = fs::remove_file(path); }
}
#[derive(Serialize, Deserialize, Clone)]
pub struct AudioMetadata { title: String, artist: String, mime: Option<String>, data: Option<String> }
fn valid_metadata(info: &AudioMetadata) -> bool {
    if info.title.len() > 4000 || info.artist.len() > 4000 || info.title.chars().count() > 1000 || info.artist.chars().count() > 1000 { return false; }
    match (&info.mime, &info.data) {
        (None, None) => true,
        (Some(mime), Some(data)) if data.len() <= 11_185_000 => STANDARD.decode(data).ok().is_some_and(|bytes| !bytes.is_empty() && bytes.len() <= 8 * 1024 * 1024 && image_signature(mime, &bytes)),
        _ => false,
    }
}
fn metadata_directory(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("audio-metadata");
    fs::create_dir_all(&dir).ok()?;
    if fs::symlink_metadata(&dir).ok()?.file_type().is_symlink() { return None; }
    Some(dir)
}
fn metadata_file(dir: &Path, fingerprint: &str) -> PathBuf { dir.join(format!("{fingerprint}.audio")) }
fn read_metadata(dir: &Path, fingerprint: &str) -> Option<AudioMetadata> {
    if !valid_fingerprint(fingerprint) { return None; }
    let path = metadata_file(dir, fingerprint); let file = fs::symlink_metadata(&path).ok()?;
    if !file.is_file() || file.len() > 11_300_000 { return None; }
    let info: AudioMetadata = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    valid_metadata(&info).then_some(info)
}
fn write_metadata(dir: &Path, fingerprint: &str, info: &AudioMetadata) {
    if !valid_fingerprint(fingerprint) || !valid_metadata(info) || read_metadata(dir, fingerprint).is_some() { return; }
    let target = metadata_file(dir, fingerprint);
    if fs::symlink_metadata(&target).ok().is_some_and(|metadata| metadata.is_file()) { let _ = fs::remove_file(&target); }
    let mut nonce = [0u8; 16]; if getrandom::fill(&mut nonce).is_err() { return; }
    let temporary = dir.join(format!(".audio-{:x}.tmp", u128::from_le_bytes(nonce)));
    let Ok(data) = serde_json::to_vec(info) else { return; };
    let Ok(mut file) = OpenOptions::new().write(true).create_new(true).open(&temporary) else { return; };
    let ready = file.write_all(&data).and_then(|_| file.sync_all()).is_ok(); drop(file);
    if ready { let _ = crate::rename_without_replace(&temporary, &target); }
    let _ = fs::remove_file(&temporary);
    let Ok(entries) = fs::read_dir(dir) else { return; };
    let mut files: Vec<_> = entries.filter_map(Result::ok).filter_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        if !valid_fingerprint(name.strip_suffix(".audio")?) || !entry.file_type().ok()?.is_file() { return None; }
        let metadata = entry.metadata().ok()?;
        Some((metadata.modified().ok()?, metadata.len(), entry.path()))
    }).collect();
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut bytes: u64 = files.iter().map(|(_, size, _)| *size).sum();
    let mut remaining = files.len();
    for (_, size, path) in files {
        if remaining <= 80 && bytes <= 160 * 1024 * 1024 { break; }
        if fs::remove_file(path).is_ok() { remaining -= 1; bytes = bytes.saturating_sub(size); }
    }
}
#[tauri::command]
pub async fn read_audio_metadata(app: tauri::AppHandle, fingerprint: String) -> Option<AudioMetadata> {
    tauri::async_runtime::spawn_blocking(move || metadata_directory(&app).and_then(|dir| read_metadata(&dir, &fingerprint))).await.ok().flatten()
}
#[tauri::command]
pub async fn remember_audio_metadata(app: tauri::AppHandle, fingerprint: String, metadata: AudioMetadata) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = metadata_directory(&app) { write_metadata(&dir, &fingerprint, &metadata); }
    }).await;
}

#[derive(Serialize)]
pub struct FileArtwork { query: String, artwork: Artwork }
#[tauri::command]
pub async fn music_file_fingerprint(vault: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let checked = crate::checked_vault_entry(&vault, &path)?;
        file_fingerprint(&checked)
    }).await.map_err(|_| "Couldn't identify the audio file.".to_string())?
}
#[tauri::command]
pub async fn read_music_cover_for_file(app: tauri::AppHandle, fingerprint: String) -> Option<FileArtwork> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = cache_directory(&app)?; let query = read_alias(&dir, &fingerprint)?;
        let artwork = read_cache(&dir, &query)?; Some(FileArtwork { query, artwork })
    }).await.ok().flatten()
}
#[tauri::command]
pub async fn remember_music_cover_for_file(app: tauri::AppHandle, fingerprint: String, query: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = cache_directory(&app) { write_alias(&dir, &fingerprint, query.trim()); }
    }).await;
}

#[tauri::command]
pub async fn read_cached_music_cover(app: tauri::AppHandle, query: String) -> Option<Artwork> {
    let query = query.trim().to_string(); if !valid_query(&query) { return None; }
    tauri::async_runtime::spawn_blocking(move || cache_directory(&app).and_then(|dir| read_cache(&dir, &query))).await.ok().flatten()
}
async fn limited(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > max as u64) { return Err("Artwork is unavailable or too large.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Artwork download was interrupted.")? {
        if bytes.len() + chunk.len() > max { return Err("Artwork is too large.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn lookup_music_cover(app: tauri::AppHandle, query: String) -> Result<Option<Artwork>, String> {
    let query = query.trim();
    if !valid_query(query) { return Err("Invalid artwork search.".into()); }
    let cache = cache_directory(&app);
    if let Some(found) = cache.as_ref().and_then(|dir| read_cache(dir, query)) { return Ok(Some(found)); }
    let client = reqwest::Client::builder().user_agent(concat!("Comet/", env!("CARGO_PKG_VERSION"))).redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(20)).build().map_err(|_| "Couldn't start artwork lookup.")?;
    let search = client.get("https://itunes.apple.com/search").query(&[("media", "music"), ("entity", "song"), ("limit", "10"), ("term", query)]).send().await.map_err(|_| "Couldn't reach the music catalog.")?;
    let json: Value = serde_json::from_slice(&limited(search, 1024 * 1024).await?).map_err(|_| "Invalid music catalog response.")?;
    let Some(candidate) = json.get("results").and_then(Value::as_array).and_then(|items| items.iter().find_map(|item| item.get("artworkUrl100").and_then(Value::as_str).filter(|url| trusted_image(url)))) else { return Ok(None); };
    let url = candidate.replace("100x100", "600x600");
    if !trusted_image(&url) { return Err("Invalid artwork URL.".into()); }
    let response = client.get(&url).send().await.map_err(|_| "Couldn't download the cover.")?;
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|h| h.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/gif" | "image/webp") { return Err("The catalog returned an unsupported image.".into()); }
    let bytes = limited(response, 4 * 1024 * 1024).await?;
    if !valid_image(&mime, &bytes) { return Err("The catalog returned a damaged image.".into()); }
    let artwork = Artwork { url, mime, data: STANDARD.encode(bytes) };
    if let Some(dir) = cache { let copy = artwork.clone(); let query = query.to_owned(); let _ = tauri::async_runtime::spawn_blocking(move || write_cache(&dir, &query, &copy)).await; }
    Ok(Some(artwork))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_apple_https_artwork_is_allowed() {
        assert!(trusted_image("https://is1-ssl.mzstatic.com/image/a.jpg"));
        assert!(!trusted_image("https://mzstatic.com.evil.test/a.jpg"));
        assert!(!trusted_image("https://user@mzstatic.com/a.jpg"));
        assert!(!trusted_image("http://mzstatic.com/a.jpg"));
    }
    #[test]
    fn file_identity_and_both_caches_survive_reopen_and_reject_stale_files() {
        let mut random = [0u8; 8]; getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("comet-audio-identity-{:x}", u64::from_le_bytes(random)));
        fs::create_dir(&root).unwrap();
        let track = root.join("song.mp3");
        fs::write(&track, b"original audio with tags").unwrap();
        let first = file_fingerprint(&track).unwrap();
        assert_eq!(first, file_fingerprint(&track).unwrap());
        assert!(valid_fingerprint(&first));
        let art = Artwork { url: "https://is1-ssl.mzstatic.com/image/a.png".into(), mime: "image/png".into(), data: STANDARD.encode(b"\x89PNG\r\n\x1a\nexample") };
        write_cache(&root, "artist title", &art);
        write_alias(&root, &first, "artist title");
        let alias = read_alias(&root, &first).unwrap();
        assert_eq!(read_cache(&root, &alias).unwrap().data, art.data);
        let metadata = AudioMetadata { title: "Title".into(), artist: "Artist".into(), mime: Some("image/png".into()), data: Some(art.data.clone()) };
        write_metadata(&root, &first, &metadata);
        let restored = read_metadata(&root, &first).unwrap();
        assert_eq!(restored.title, "Title"); assert_eq!(restored.data, metadata.data);
        fs::write(&track, b"replaced audio with tags").unwrap();
        let second = file_fingerprint(&track).unwrap();
        assert_ne!(first, second);
        assert!(read_alias(&root, &second).is_none()); assert!(read_metadata(&root, &second).is_none());
        assert!(read_alias(&root, "../invalid").is_none()); assert!(read_metadata(&root, "../invalid").is_none());
        let invalid = AudioMetadata { title: "Song".into(), artist: "Artist".into(), mime: Some("image/png".into()), data: Some(STANDARD.encode(b"not an image")) };
        write_metadata(&root, &second, &invalid); assert!(read_metadata(&root, &second).is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let sentinel = root.join("sentinel"); fs::write(&sentinel, b"safe").unwrap();
            symlink(&sentinel, alias_file(&root, &second)).unwrap();
            write_alias(&root, &second, "artist title");
            assert_eq!(fs::read(&sentinel).unwrap(), b"safe".to_vec()); assert!(read_alias(&root, &second).is_none());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn artwork_bytes_survive_restart_and_bad_entries_are_ignored() {
        let mut random = [0u8; 8]; getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("comet-art-cache-{:x}", u64::from_le_bytes(random)));
        fs::create_dir(&root).unwrap();
        let art = Artwork { url: "https://is1-ssl.mzstatic.com/image/a.png".into(), mime: "image/png".into(), data: STANDARD.encode(b"\x89PNG\r\n\x1a\nexample") };
        write_cache(&root, "artist track", &art);
        let restored = read_cache(&root, "artist track").unwrap();
        assert_eq!(restored.data, art.data); assert!(read_cache(&root, "different song").is_none());
        fs::write(cache_file(&root, "artist track"), b"bad data").unwrap();
        assert!(read_cache(&root, "artist track").is_none());
        write_cache(&root, "artist track", &art); assert!(read_cache(&root, "artist track").is_some());
        let untrusted = Artwork { url: "https://evil.test/a.png".into(), ..art };
        write_cache(&root, "other", &untrusted); assert!(read_cache(&root, "other").is_none());
        fs::remove_dir_all(root).unwrap();
    }

}
