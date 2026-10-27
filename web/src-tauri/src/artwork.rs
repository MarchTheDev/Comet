//! Artwork searches use Apple's public music catalog. Desktop requests run in
//! Rust because many webviews reject cross-origin catalog requests.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize)]
pub struct Artwork { url: String, mime: String, data: String }
fn trusted_image(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false; };
    let Some(host) = url.host_str() else { return false; };
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && (host == "mzstatic.com" || host.ends_with(".mzstatic.com"))
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
pub async fn lookup_music_cover(query: String) -> Result<Option<Artwork>, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 400 || query.chars().any(char::is_control) { return Err("Invalid artwork search.".into()); }
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
    Ok(Some(Artwork { url, mime, data: STANDARD.encode(bytes) }))
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
}
