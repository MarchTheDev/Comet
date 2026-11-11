//! Safe, bounded RSS / Atom / JSON Feed & full-article fetcher + native OPML export dialog.
//! Shares public-host and DNS SSRF protections with `link_preview`, reuses a pooled HTTP
//! client with fast connect timeouts, supports `<link rel="alternate">` feed auto-discovery,
//! and saves exported OPML files through the native OS file explorer dialog.

use crate::link_preview::{
    decode_entities, ensure_public_dns, get_attr, is_public_url_candidate, iter_tags,
    validate_public_url,
};
use serde::Serialize;
use std::fs;
use std::sync::OnceLock;
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;

const MAX_FEED_BYTES: usize = 8 * 1024 * 1024;
const MAX_ARTICLE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 6 * 1024 * 1024;
const MAX_OPML_EXPORT_BYTES: usize = 2 * 1024 * 1024;

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedRssResponse {
    pub final_url: String,
    pub content_type: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_gzip_base64: Option<String>,
}

fn shared_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client);
    }
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("Too many redirects");
        }
        if is_public_url_candidate(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("Blocked redirect to private or unsupported address")
        }
    });
    let built = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .redirect(policy)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(18))
        .build()
        .map_err(|_| "Couldn't initialize feed client.".to_string())?;
    let _ = HTTP_CLIENT.set(built);
    HTTP_CLIENT
        .get()
        .ok_or_else(|| "Couldn't initialize feed client.".to_string())
}

#[tauri::command]
pub async fn fetch_rss_feed(url: String) -> Result<FetchedRssResponse, String> {
    let accept = "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9, text/html;q=0.7, */*;q=0.5";
    let initial = fetch_public_document(&url, accept, MAX_FEED_BYTES).await?;
    if looks_like_html_page(&initial.content_type, &initial.body) {
        if let Ok(base) = url::Url::parse(&initial.final_url) {
            if let Some(discovered) = discover_feed_url(&initial.body, &base) {
                if discovered != initial.final_url {
                    return fetch_public_document(&discovered, accept, MAX_FEED_BYTES).await;
                }
            }
        }
    }
    Ok(initial)
}

#[tauri::command]
pub async fn fetch_rss_article(url: String) -> Result<FetchedRssResponse, String> {
    let accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";
    fetch_public_document(&url, accept, MAX_ARTICLE_BYTES).await
}

#[tauri::command]
pub async fn fetch_rss_image(url: String, referer: Option<String>) -> Result<String, String> {
    let parsed = validate_public_url(&url)?;
    let check_host = parsed
        .host_str()
        .ok_or_else(|| "Invalid image host.".to_string())?
        .to_string();
    let check_port = parsed.port_or_known_default().unwrap_or(443);

    tauri::async_runtime::spawn_blocking(move || ensure_public_dns(&check_host, check_port))
        .await
        .map_err(|_| "Couldn't verify image address.".to_string())??;

    let client = shared_client()?;
    let mut request = client
        .get(parsed.clone())
        .header(
            reqwest::header::ACCEPT,
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9");

    if let Some(raw_ref) = referer.as_deref() {
        if let Ok(ref_url) = validate_public_url(raw_ref) {
            if let Some(host) = ref_url.host_str() {
                let origin_ref = match ref_url.port() {
                    Some(port) => format!("{}://{}:{}/", ref_url.scheme(), host, port),
                    None => format!("{}://{}/", ref_url.scheme(), host),
                };
                request = request.header(reqwest::header::REFERER, origin_ref);
            }
        }
    }

    let mut response = request
        .send()
        .await
        .map_err(|_| "Couldn't load article image.".to_string())?;

    if !response.status().is_success() {
        return Err(format!("Image returned HTTP {}.", response.status().as_u16()));
    }

    let final_url = response.url().clone();
    if !is_public_url_candidate(&final_url) {
        return Err("Blocked non-public image address.".into());
    }

    let header_ct = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    let mut buffer = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Interrupted while reading image.".to_string())?
    {
        if buffer.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("Article image exceeds size limit.".into());
        }
        buffer.extend_from_slice(&chunk);
    }

    if buffer.is_empty() {
        return Err("Empty image response.".into());
    }

    let mime = detect_image_mime(&header_ct, &buffer)
        .ok_or_else(|| "Unsupported or non-image content.".to_string())?;
    let encoded = encode_base64(&buffer);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn detect_image_mime(header_ct: &str, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if brand == b"avif" || brand == b"avis" {
            return Some("image/avif");
        }
    }
    let head = std::str::from_utf8(&bytes[..bytes.len().min(512)]).unwrap_or("");
    let head_lower = head.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    if head_lower.starts_with("<svg")
        || (head_lower.starts_with("<?xml") && head_lower.contains("<svg"))
    {
        return Some("image/svg+xml");
    }
    match header_ct {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        "image/avif" => Some("image/avif"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[tauri::command]
pub async fn export_rss_opml(
    app: tauri::AppHandle,
    opml: String,
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    if opml.len() > MAX_OPML_EXPORT_BYTES {
        return Err("OPML export is too large.".into());
    }
    let trimmed = opml.trim_start();
    if !trimmed.starts_with("<?xml") || !trimmed.contains("<opml") {
        return Err("Invalid OPML document.".into());
    }
    let default_name = suggested_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.contains('/') && !s.contains('\\'))
        .unwrap_or("comet-feeds.opml")
        .to_string();

    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Export RSS feeds")
            .set_file_name(&default_name)
            .add_filter("OPML feed list", &["opml", "xml"])
            .blocking_save_file();

        let Some(mut path) = picked.and_then(|p| p.into_path().ok()) else {
            return Ok(None);
        };
        if path.extension().is_none() {
            path.set_extension("opml");
        }
        if !path.is_absolute() {
            return Err("Choose a valid folder on this device.".into());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "Choose a valid destination folder.".to_string())?;
        if !parent.is_dir() {
            return Err("The selected destination folder does not exist.".into());
        }

        fs::write(&path, opml.as_bytes())
            .map_err(|e| format!("Couldn't write OPML file: {e}"))?;

        let label = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        Ok(Some(label))
    })
    .await
    .map_err(|_| "Export dialog was interrupted.".to_string())?
}

async fn fetch_public_document(
    raw_url: &str,
    accept_header: &str,
    max_bytes: usize,
) -> Result<FetchedRssResponse, String> {
    let parsed = validate_public_url(raw_url)?;
    let check_host = parsed
        .host_str()
        .ok_or_else(|| "Invalid feed host.".to_string())?
        .to_string();
    let check_port = parsed.port_or_known_default().unwrap_or(443);

    tauri::async_runtime::spawn_blocking(move || ensure_public_dns(&check_host, check_port))
        .await
        .map_err(|_| "Couldn't verify feed address.".to_string())??;

    let client = shared_client()?;

    let mut response = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, accept_header)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header("Upgrade-Insecure-Requests", "1")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Connection timed out while contacting that feed.".to_string()
            } else {
                "Couldn't reach that feed. Check the URL or your connection.".to_string()
            }
        })?;

    if !response.status().is_success() {
        return Err(format!("Feed returned HTTP {}.", response.status().as_u16()));
    }

    let final_url = response.url().clone();
    if !is_public_url_candidate(&final_url) {
        return Err("Blocked non-public feed address.".into());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let content_encoding = response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut buffer = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Interrupted while reading feed.".to_string())?
    {
        let remaining = max_bytes.saturating_sub(buffer.len());
        if remaining == 0 {
            break;
        }
        let take = chunk.len().min(remaining);
        buffer.extend_from_slice(&chunk[..take]);
        if buffer.len() >= max_bytes {
            break;
        }
    }

    let is_gzip = content_encoding.contains("gzip") || buffer.starts_with(b"\x1f\x8b");

    Ok(FetchedRssResponse {
        final_url: final_url.to_string(),
        content_type,
        body: if is_gzip {
            String::new()
        } else {
            String::from_utf8_lossy(&buffer).into_owned()
        },
        body_gzip_base64: if is_gzip {
            Some(encode_base64(&buffer))
        } else {
            None
        },
    })
}

fn looks_like_html_page(content_type: &str, body: &str) -> bool {
    let trimmed = body.trim_start_matches('\u{feff}').trim_start();
    let lower_head: String = trimmed.chars().take(256).collect::<String>().to_ascii_lowercase();
    if lower_head.starts_with("<?xml")
        || lower_head.starts_with("<rss")
        || lower_head.starts_with("<feed")
        || lower_head.starts_with("<rdf")
        || lower_head.starts_with('{')
    {
        return false;
    }
    content_type.contains("text/html")
        || lower_head.starts_with("<!doctype html")
        || lower_head.starts_with("<html")
}

fn discover_feed_url(html: &str, base_url: &url::Url) -> Option<String> {
    for tag in iter_tags(html, "link") {
        let rel = get_attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel.split_whitespace().any(|r| r == "alternate") {
            continue;
        }
        let mime = get_attr(tag, "type").unwrap_or_default().to_ascii_lowercase();
        let is_feed = mime.contains("rss")
            || mime.contains("atom")
            || mime.contains("feed+json")
            || mime.contains("xml");
        if !is_feed {
            continue;
        }
        let Some(href) = get_attr(tag, "href") else {
            continue;
        };
        let decoded = decode_entities(href.trim());
        if decoded.is_empty() {
            continue;
        }
        if let Ok(resolved) = base_url.join(&decoded) {
            if is_public_url_candidate(&resolved) {
                return Some(resolved.to_string());
            }
        }
    }
    None
}
