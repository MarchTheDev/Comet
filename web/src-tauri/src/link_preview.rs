//! Safe, bounded OpenGraph / HTML metadata preview fetcher for Discord-style link embeds.
//! Blocks loopback, private, link-local, and non-public hosts/IPs, caps response size,
//! and returns sanitized plain-text metadata.

use serde::Serialize;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

const MAX_HTML_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreviewData {
    pub url: String,
    pub site_name: String,
    pub title: String,
    pub description: String,
    pub image: String,
    pub theme_color: String,
}

#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    let parsed = validate_public_url(&url)?;
    let check_host = parsed
        .host_str()
        .ok_or_else(|| "Invalid link host.".to_string())?
        .to_string();
    let check_port = parsed.port_or_known_default().unwrap_or(443);

    tauri::async_runtime::spawn_blocking(move || ensure_public_dns(&check_host, check_port))
        .await
        .map_err(|_| "Couldn't verify link address.".to_string())??;

    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 4 {
            return attempt.error("Too many redirects");
        }
        if is_public_url_candidate(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("Blocked redirect to private or unsupported address")
        }
    });

    let client = reqwest::Client::builder()
        .user_agent(concat!("CometLinkPreview/", env!("CARGO_PKG_VERSION")))
        .redirect(policy)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| "Couldn't initialize preview client.".to_string())?;

    let mut response = client
        .get(parsed.clone())
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml;q=0.9,image/*;q=0.5,*/*;q=0.1",
        )
        .send()
        .await
        .map_err(|_| "Couldn't reach that link.".to_string())?;

    if !response.status().is_success() {
        return Err("Preview unavailable.".into());
    }

    let final_url = response.url().clone();
    if !is_public_url_candidate(&final_url) {
        return Err("Blocked non-public address.".into());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let host_label = final_url
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_string();

    if content_type.starts_with("image/") {
        return Ok(LinkPreviewData {
            url: final_url.to_string(),
            site_name: host_label.clone(),
            title: final_url
                .path_segments()
                .and_then(|mut s| s.next_back())
                .filter(|s| !s.is_empty())
                .unwrap_or(&host_label)
                .to_string(),
            description: String::new(),
            image: final_url.to_string(),
            theme_color: String::new(),
        });
    }

    if !content_type.is_empty()
        && !content_type.contains("text/html")
        && !content_type.contains("application/xhtml")
    {
        return Err("Not an HTML page.".into());
    }

    let mut buffer = Vec::with_capacity(16 * 1024);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Interrupted while reading preview.".to_string())?
    {
        let remaining = MAX_HTML_BYTES.saturating_sub(buffer.len());
        if remaining == 0 {
            break;
        }
        let take = chunk.len().min(remaining);
        buffer.extend_from_slice(&chunk[..take]);
        if buffer.len() >= MAX_HTML_BYTES {
            break;
        }
        // Stop early once </head> has been read completely.
        if buffer.len() > 2048 && contains_ascii_case_insensitive(&buffer, b"</head>") {
            break;
        }
    }

    let html = String::from_utf8_lossy(&buffer);
    Ok(extract_metadata(&html, &final_url, &host_label))
}

pub(crate) fn validate_public_url(raw: &str) -> Result<url::Url, String> {
    if raw.len() > 2048 {
        return Err("Link is too long.".into());
    }
    let parsed = url::Url::parse(raw.trim()).map_err(|_| "Invalid link.".to_string())?;
    if !is_public_url_candidate(&parsed) {
        return Err("Preview is only available for public web links.".into());
    }
    Ok(parsed)
}

pub(crate) fn is_public_url_candidate(parsed: &url::Url) -> bool {
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let lower = host.trim_end_matches('.').to_ascii_lowercase();
    if lower.is_empty()
        || lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || !lower.contains('.')
    {
        return false;
    }
    let unbracketed = lower.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return is_global_ip(ip);
    }
    true
}

pub(crate) fn ensure_public_dns(host: &str, port: u16) -> Result<(), String> {
    let unbracketed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return if is_global_ip(ip) {
            Ok(())
        } else {
            Err("Blocked private IP.".into())
        };
    }
    let addrs: Vec<_> = (host, port)
        .to_socket_addrs()
        .map_err(|_| "Couldn't resolve link host.".to_string())?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !is_global_ip(addr.ip())) {
        return Err("Blocked non-public address.".into());
    }
    Ok(())
}

fn is_global_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_documentation()
                && !v4.is_unspecified()
                && !v4.is_multicast()
                && !(o[0] == 100 && (o[1] & 0b1100_0000) == 0b0100_0000)
                && !(o[0] == 198 && (o[1] == 18 || o[1] == 19))
                && o[0] != 0
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_global_ip(IpAddr::V4(mapped));
            }
            let seg0 = v6.segments()[0];
            !v6.is_loopback()
                && !v6.is_unspecified()
                && !v6.is_multicast()
                && (seg0 & 0xfe00) != 0xfc00
                && (seg0 & 0xffc0) != 0xfe80
                && !(seg0 == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|win| win.eq_ignore_ascii_case(needle))
}

fn extract_metadata(html: &str, base_url: &url::Url, default_site: &str) -> LinkPreviewData {
    let mut og_title = String::new();
    let mut twitter_title = String::new();
    let mut og_desc = String::new();
    let mut twitter_desc = String::new();
    let mut meta_desc = String::new();
    let mut site_name = String::new();
    let mut og_image = String::new();
    let mut twitter_image = String::new();
    let mut theme_color = String::new();

    for tag in iter_tags(html, "meta") {
        let key = get_attr(tag, "property")
            .or_else(|| get_attr(tag, "name"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        let Some(raw_val) = get_attr(tag, "content") else {
            continue;
        };
        let val = clean_text(&decode_entities(&raw_val), 400);
        if val.is_empty() {
            continue;
        }
        match key.as_str() {
            "og:title" if og_title.is_empty() => og_title = val,
            "twitter:title" if twitter_title.is_empty() => twitter_title = val,
            "og:description" if og_desc.is_empty() => og_desc = val,
            "twitter:description" if twitter_desc.is_empty() => twitter_desc = val,
            "description" if meta_desc.is_empty() => meta_desc = val,
            "og:site_name" if site_name.is_empty() => site_name = clean_text(&val, 80),
            "og:image" | "og:image:url" if og_image.is_empty() => og_image = val,
            "twitter:image" | "twitter:image:src" if twitter_image.is_empty() => twitter_image = val,
            "theme-color" if theme_color.is_empty() => {
                if is_hex_color(&val) {
                    theme_color = val;
                }
            }
            _ => {}
        }
    }

    let doc_title = extract_title_tag(html);
    let title = first_non_empty(&[&og_title, &twitter_title, &doc_title, default_site]);
    let description = first_non_empty(&[&og_desc, &twitter_desc, &meta_desc]);
    let raw_image = first_non_empty(&[&og_image, &twitter_image]);
    let image = if raw_image.is_empty() {
        String::new()
    } else {
        base_url
            .join(&raw_image)
            .ok()
            .filter(is_public_url_candidate)
            .map(|u| u.to_string())
            .unwrap_or_default()
    };

    LinkPreviewData {
        url: base_url.to_string(),
        site_name: if site_name.is_empty() {
            default_site.to_string()
        } else {
            site_name
        },
        title: clean_text(&title, 180),
        description: clean_text(&description, 320),
        image,
        theme_color,
    }
}

fn first_non_empty(candidates: &[&str]) -> String {
    candidates
        .iter()
        .find(|s| !s.trim().is_empty())
        .map(|s| (*s).to_string())
        .unwrap_or_default()
}

fn is_hex_color(value: &str) -> bool {
    let trimmed = value.trim();
    matches!(trimmed.len(), 4 | 7)
        && trimmed.starts_with('#')
        && trimmed.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn iter_tags<'a>(html: &'a str, tag_name: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let bytes = html.as_bytes();
    let needle_len = tag_name.len() + 1;
    let mut i = 0;
    while i + needle_len < bytes.len() && out.len() < 120 {
        if bytes[i] == b'<'
            && html[i + 1..]
                .get(..tag_name.len())
                .is_some_and(|s| s.eq_ignore_ascii_case(tag_name))
            && bytes
                .get(i + 1 + tag_name.len())
                .is_some_and(|b| b.is_ascii_whitespace() || *b == b'/' || *b == b'>')
        {
            if let Some(end_rel) = find_tag_end(&html[i..]) {
                out.push(&html[i..=i + end_rel]);
                i += end_rel + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn find_tag_end(slice: &str) -> Option<usize> {
    let mut quote: Option<u8> = None;
    for (idx, b) in slice.bytes().enumerate().take(2048) {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b'>' => return Some(idx),
            _ => {}
        }
    }
    None
}

pub(crate) fn get_attr(tag: &str, attr_name: &str) -> Option<String> {
    let inner = tag.trim_start_matches('<').trim_end_matches('>').trim_end_matches('/');
    let mut rest = inner;
    // Skip tag name
    let first_ws = rest.find(|c: char| c.is_ascii_whitespace())?;
    rest = &rest[first_ws..];

    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let name_end = rest
            .find(|c: char| c == '=' || c.is_ascii_whitespace())
            .unwrap_or(rest.len());
        let current_name = &rest[..name_end];
        rest = rest[name_end..].trim_start();
        if !rest.starts_with('=') {
            continue;
        }
        rest = rest[1..].trim_start();
        let (value, after) = if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"').unwrap_or(stripped.len());
            (&stripped[..end], &stripped[(end + 1).min(stripped.len())..])
        } else if let Some(stripped) = rest.strip_prefix('\'') {
            let end = stripped.find('\'').unwrap_or(stripped.len());
            (&stripped[..end], &stripped[(end + 1).min(stripped.len())..])
        } else {
            let end = rest
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(rest.len());
            (&rest[..end], &rest[end..])
        };
        if current_name.eq_ignore_ascii_case(attr_name) {
            return Some(value.to_string());
        }
        rest = after;
    }
    None
}

fn extract_title_tag(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start_tag) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt_rel) = html[start_tag..].find('>') else {
        return String::new();
    };
    let content_start = start_tag + gt_rel + 1;
    let Some(end_rel) = lower[content_start..].find("</title>") else {
        return String::new();
    };
    clean_text(&decode_entities(&html[content_start..content_start + end_rel]), 180)
}

pub(crate) fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }
        let mut entity = String::new();
        let mut terminated = false;
        for _ in 0..12 {
            match chars.peek().copied() {
                Some(';') => {
                    chars.next();
                    terminated = true;
                    break;
                }
                Some(c) if c.is_ascii_alphanumeric() || c == '#' => {
                    entity.push(c);
                    chars.next();
                }
                _ => break,
            }
        }
        if !terminated {
            out.push('&');
            out.push_str(&entity);
            continue;
        }
        let decoded = match entity.as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" | "#160" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            s if s.starts_with("#x") || s.starts_with("#X") => {
                u32::from_str_radix(&s[2..], 16).ok().and_then(char::from_u32)
            }
            s if s.starts_with('#') => s[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        if let Some(c) = decoded {
            out.push(c);
        } else {
            out.push('&');
            out.push_str(&entity);
            out.push(';');
        }
    }
    out
}

fn clean_text(input: &str, max_chars: usize) -> String {
    let collapsed: String = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        collapsed
    } else {
        let mut truncated: String = collapsed.chars().take(max_chars.saturating_sub(1)).collect();
        truncated.push('…');
        truncated
    }
}
