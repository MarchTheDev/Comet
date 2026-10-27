//! Google desktop OAuth. Uses the system browser, PKCE and a loopback callback;
//! refresh tokens live only in the operating system credential store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_dialog::DialogExt;

const SERVICE: &str = "com.marco.comet.google";
static CONNECTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Credentials { client_id: String, client_secret: String, refresh_token: String }
#[derive(Deserialize)]
struct TokenReply { access_token: Option<String>, refresh_token: Option<String>, scope: Option<String> }

fn scope(service: &str) -> Result<&'static str, String> {
    match service {
        "calendar" => Ok("https://www.googleapis.com/auth/calendar.events"),
        "drive" => Ok("https://www.googleapis.com/auth/drive.file"),
        "all" => Ok("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file"),
        _ => Err("Unknown Google service.".into()),
    }
}
fn entry(service: &str) -> Result<keyring::Entry, String> {
    scope(service)?;
    keyring::Entry::new(SERVICE, service).map_err(|_| "The system credential store isn't available.".into())
}
fn read_credentials(service: &str) -> Result<Credentials, String> {
    let raw = match entry("all")?.get_password() {
        Ok(raw) => raw,
        Err(keyring::Error::NoEntry) if service != "all" => entry(service)?.get_password().map_err(|_| "Google isn't connected or the system credential store is locked.")?,
        Err(_) => return Err("Google isn't connected or the system credential store is locked.".into()),
    };
    serde_json::from_str(&raw).map_err(|_| "Stored Google authorization is invalid. Disconnect and reconnect.".into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(concat!("Comet/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60)).build().map_err(|_| "Couldn't initialize the network connection.".into())
}
struct ConnectingGuard(&'static AtomicBool);
impl Drop for ConnectingGuard { fn drop(&mut self) { self.0.store(false, Ordering::Release); } }

#[tauri::command]
pub async fn google_status(service: String) -> Result<bool, String> {
    scope(&service)?;
    tauri::async_runtime::spawn_blocking(move || {
        match entry("all")?.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) if service != "all" => match entry(&service)?.get_password() {
                Ok(_) => Ok(true), Err(keyring::Error::NoEntry) => Ok(false), Err(_) => Err("The system credential store isn't available or is locked.".into()),
            },
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err("The system credential store isn't available or is locked.".into()),
        }
    }).await.map_err(|_| "Couldn't check Google connection.".to_string())?
}

#[tauri::command]
pub async fn google_disconnect(service: String) -> Result<(), String> {
    scope(&service)?;
    if CONNECTING.load(Ordering::Acquire) { return Err("Wait for the sign-in to finish first.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let services: Vec<&str> = if service == "all" { vec!["all", "calendar", "drive"] } else { vec![service.as_str()] };
        for name in services {
            match entry(name)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {}, Err(_) => return Err("Couldn't remove Google authorization from the system credential store.".into()) }
        }
        Ok(())
    }).await.map_err(|_| "Couldn't disconnect Google.".to_string())?
}

#[tauri::command]
pub async fn google_connect(app: tauri::AppHandle, service: String, client_id: String, client_secret: String) -> Result<(), String> {
    let requested_scope = scope(&service)?;
    if CONNECTING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A Google sign-in is already in progress.".into()); }
    let _guard = ConnectingGuard(&CONNECTING);
    if client_id.len() > 300 || !client_id.ends_with(".apps.googleusercontent.com") || !client_id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')) || client_secret.len() > 300 || client_secret.chars().any(char::is_control) {
        return Err("Enter a valid Google OAuth desktop client ID and optional client secret.".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "Couldn't open the local authorization callback.")?;
    listener.set_nonblocking(true).map_err(|_| "Couldn't prepare the authorization callback.")?;
    let port = listener.local_addr().map_err(|_| "Couldn't prepare the authorization callback.")?.port();
    let redirect = format!("http://127.0.0.1:{port}/oauth2redirect");
    let mut verifier_bytes = [0u8; 32]; let mut state_bytes = [0u8; 32];
    getrandom::fill(&mut verifier_bytes).map_err(|_| "Couldn't create secure sign-in data.")?;
    getrandom::fill(&mut state_bytes).map_err(|_| "Couldn't create secure sign-in data.")?;
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    let mut authorization = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").map_err(|_| "Couldn't start Google sign-in.")?;
    authorization.query_pairs_mut().append_pair("client_id", &client_id).append_pair("redirect_uri", &redirect).append_pair("response_type", "code").append_pair("scope", requested_scope).append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256").append_pair("state", &state).append_pair("access_type", "offline").append_pair("prompt", "consent");
    app.opener().open_url(authorization.as_str(), None::<&str>).map_err(|_| "Couldn't open the browser for Google sign-in.")?;
    let code = tauri::async_runtime::spawn_blocking(move || wait_callback(listener, &state)).await.map_err(|_| "Google sign-in was interrupted.")??;
    let mut form = vec![("client_id", client_id.as_str()), ("code", code.as_str()), ("code_verifier", verifier.as_str()), ("redirect_uri", redirect.as_str()), ("grant_type", "authorization_code")];
    if !client_secret.is_empty() { form.push(("client_secret", client_secret.as_str())); }
    let response = client()?.post("https://oauth2.googleapis.com/token").form(&form).send().await.map_err(|_| "Couldn't exchange the Google authorization.")?;
    if !response.status().is_success() { return Err("Google declined the authorization. Check the desktop OAuth client and enabled API, then try again.".into()); }
    let reply: TokenReply = response.json().await.map_err(|_| "Google returned an invalid authorization response.")?;
    if reply.scope.as_deref().is_some_and(|granted| !requested_scope.split_whitespace().all(|scope| granted.split_whitespace().any(|value| value == scope))) { return Err("Google did not grant the requested permission.".into()); }
    let refresh_token = reply.refresh_token.filter(|token| !token.is_empty() && token.len() < 10_000).ok_or("Google didn't return a refresh token. Disconnect Comet in your Google account and try again.")?;
    let credentials = serde_json::to_string(&Credentials { client_id, client_secret, refresh_token }).map_err(|_| "Couldn't prepare Google authorization.")?;
    tauri::async_runtime::spawn_blocking(move || entry(&service)?.set_password(&credentials).map_err(|_| "Couldn't store authorization in the system credential store. No insecure fallback was used.".into())).await.map_err(|_| "Couldn't store Google authorization.".to_string())?
}

fn wait_callback(listener: TcpListener, expected: &str) -> Result<String, String> {
    let until = Instant::now() + Duration::from_secs(180);
    while Instant::now() < until {
        match listener.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut bytes = [0u8; 8192]; let count = stream.read(&mut bytes).unwrap_or(0);
                let text = String::from_utf8_lossy(&bytes[..count]);
                let target = text.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|line| line.split(' ').next()).unwrap_or("");
                let parsed = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
                let result = parsed.and_then(|url| {
                    if url.path() != "/oauth2redirect" { return None; }
                    let params: Vec<_> = url.query_pairs().collect();
                    let states: Vec<_> = params.iter().filter(|(k, _)| k == "state").map(|(_, v)| v.as_ref()).collect();
                    if states.len() != 1 || states[0] != expected { return None; }
                    if params.iter().any(|(key, _)| key == "error") { return Some(Err("Google sign-in was cancelled or declined.".to_string())); }
                    let codes: Vec<_> = params.iter().filter(|(key, _)| key == "code").map(|(_, value)| value.to_string()).collect();
                    if codes.len() == 1 && !codes[0].is_empty() && codes[0].len() < 4096 { Some(Ok(codes[0].clone())) } else { None }
                });
                let body = if result.as_ref().is_some_and(Result::is_ok) { "Authorization received. You can return to Comet and close this tab." } else { "This authorization request was not accepted. Return to Comet." };
                let response = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if result.is_some() { "200 OK" } else { "400 Bad Request" }, body.len(), body);
                let _ = stream.write_all(response.as_bytes());
                if let Some(result) = result { return result; }
            },
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => return Err("The authorization callback failed.".into()),
        }
    }
    Err("Google sign-in timed out. Please try again.".into())
}

async fn token(service: &str) -> Result<String, String> {
    let name = service.to_string();
    let credentials = tauri::async_runtime::spawn_blocking(move || read_credentials(&name)).await.map_err(|_| "Couldn't read Google authorization.")??;
    let mut form = vec![("client_id", credentials.client_id.as_str()), ("refresh_token", credentials.refresh_token.as_str()), ("grant_type", "refresh_token")];
    if !credentials.client_secret.is_empty() { form.push(("client_secret", credentials.client_secret.as_str())); }
    let response = client()?.post("https://oauth2.googleapis.com/token").form(&form).send().await.map_err(|_| "Couldn't reach Google. Check your connection.")?;
    if !response.status().is_success() { return Err("Google authorization expired or was revoked. Reconnect in Settings.".into()); }
    let reply: TokenReply = response.json().await.map_err(|_| "Google returned an invalid token response.")?;
    reply.access_token.filter(|token| !token.is_empty() && token.len() < 10_000).ok_or("Google returned an invalid access token.".into())
}

fn event_id(value: &str) -> bool { !value.is_empty() && value.len() <= 1024 && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')) }
fn time_bound(value: &str) -> bool { value.len() <= 40 && value.len() >= 10 && value.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'-' | b'+' | b':' | b'.' | b'T' | b'Z')) }
fn event_patch(value: &Value, creating: bool) -> bool {
    let Some(map) = value.as_object() else { return false; };
    if map.is_empty() || map.keys().any(|key| !matches!(key.as_str(), "summary" | "description" | "start" | "end")) { return false; }
    if creating && !(map.contains_key("summary") && map.contains_key("start") && map.contains_key("end")) { return false; }
    for (key, val) in map {
        match key.as_str() {
            "summary" if val.as_str().is_some_and(|s| !s.trim().is_empty() && s.len() <= 800) => {},
            "description" if val.as_str().is_some_and(|s| s.len() <= 20_000) => {},
            "start" | "end" if val.as_object().is_some_and(|m| m.len() == 1 && m.iter().all(|(k, v)| matches!(k.as_str(), "date" | "dateTime") && v.as_str().is_some_and(time_bound))) => {},
            _ => return false,
        }
    }
    true
}
async fn response_json(mut response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() { return Err(format!("Google returned {}. Refresh and try again.", response.status().as_u16())); }
    if response.content_length().is_some_and(|length| length > 8 * 1024 * 1024) { return Err("Google's response is too large.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Couldn't read Google's response.")? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 { return Err("Google's response is too large.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Google returned invalid calendar data.".into())
}
#[tauri::command]
pub async fn google_calendar_list(start: String, end: String) -> Result<Vec<Value>, String> {
    if !time_bound(&start) || !time_bound(&end) { return Err("Invalid calendar date range.".into()); }
    let access = token("calendar").await?; let client = client()?;
    let mut result = Vec::new(); let mut page = String::new();
    for _ in 0..10 {
        let response = client.get("https://www.googleapis.com/calendar/v3/calendars/primary/events").bearer_auth(&access)
            .query(&[("timeMin", start.as_str()), ("timeMax", end.as_str()), ("singleEvents", "true"), ("orderBy", "startTime"), ("maxResults", "250"), ("pageToken", page.as_str()), ("fields", "nextPageToken,items(id,etag,summary,description,start,end,status,recurringEventId)")])
            .send().await.map_err(|_| "Couldn't reach Google Calendar.")?;
        let data = response_json(response).await?;
        if let Some(items) = data.get("items").and_then(Value::as_array) { result.extend(items.iter().cloned()); }
        page = data.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string();
        if page.is_empty() { return Ok(result); }
        if page.len() > 2000 { return Err("Google returned an invalid page token.".into()); }
    }
    Err("Too many Google Calendar events for this date range.".into())
}
#[tauri::command]
pub async fn google_calendar_create(patch: Value) -> Result<Value, String> {
    if !event_patch(&patch, true) { return Err("Invalid calendar event.".into()); }
    let response = client()?.post("https://www.googleapis.com/calendar/v3/calendars/primary/events").bearer_auth(token("calendar").await?).json(&patch).send().await.map_err(|_| "Couldn't reach Google Calendar.")?;
    response_json(response).await
}
#[tauri::command]
pub async fn google_calendar_update(id: String, etag: String, patch: Value) -> Result<Value, String> {
    if !event_id(&id) || etag.is_empty() || etag.len() > 512 || etag.chars().any(char::is_control) || !event_patch(&patch, false) { return Err("Invalid calendar event change.".into()); }
    let response = client()?.patch(format!("https://www.googleapis.com/calendar/v3/calendars/primary/events/{id}")).bearer_auth(token("calendar").await?).header("If-Match", etag).json(&patch).send().await.map_err(|_| "Couldn't reach Google Calendar.")?;
    if response.status().as_u16() == 412 { return Err("This Google event changed elsewhere. Refresh before editing it again.".into()); }
    response_json(response).await
}
#[tauri::command]
pub async fn google_calendar_delete(id: String, etag: String) -> Result<(), String> {
    if !event_id(&id) || etag.is_empty() || etag.len() > 512 || etag.chars().any(char::is_control) { return Err("Invalid calendar event.".into()); }
    let response = client()?.delete(format!("https://www.googleapis.com/calendar/v3/calendars/primary/events/{id}")).bearer_auth(token("calendar").await?).header("If-Match", etag).send().await.map_err(|_| "Couldn't reach Google Calendar.")?;
    if response.status().is_success() { Ok(()) } else if response.status().as_u16() == 412 { Err("This Google event changed elsewhere. Refresh before deleting it.".into()) } else { Err(format!("Google Calendar returned {}. Refresh and try again.", response.status().as_u16())) }
}

// Drive snapshots are immutable and explicit: no existing file or workspace is
// overwritten, so two devices cannot silently destroy each other's changes.
fn drive_id(value: &str) -> bool { !value.is_empty() && value.len() <= 200 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) }
fn drive_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(concat!("Comet/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(900)).build().map_err(|_| "Couldn't initialize the network connection.".into())
}
#[tauri::command]
pub async fn google_drive_list() -> Result<Vec<Value>, String> {
    let access = token("drive").await?; let client = drive_client()?; let mut result = Vec::new(); let mut page = String::new();
    for _ in 0..10 {
        let response = client.get("https://www.googleapis.com/drive/v3/files").bearer_auth(&access)
            .query(&[("q", "trashed = false and appProperties has { key='cometFormat' and value='1' }"), ("fields", "nextPageToken,files(id,name,modifiedTime,size)"), ("pageSize", "100"), ("orderBy", "modifiedTime desc"), ("pageToken", page.as_str())])
            .send().await.map_err(|_| "Couldn't reach Google Drive.")?;
        let data = response_json(response).await?;
        if let Some(files) = data.get("files").and_then(Value::as_array) { result.extend(files.iter().filter(|item| item.get("id").and_then(Value::as_str).is_some_and(drive_id)).cloned()); }
        page = data.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string();
        if page.is_empty() { return Ok(result); }
        if page.len() > 2000 { return Err("Google returned an invalid page token.".into()); }
    }
    Err("Too many snapshots to list. Remove old snapshots in Google Drive.".into())
}
#[tauri::command]
pub async fn google_drive_backup(vault: String) -> Result<(), String> {
    let access = token("drive").await?;
    let name = std::path::Path::new(&vault).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(100).collect::<String>();
    let snapshot = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::pack(&vault)).await.map_err(|_| "Couldn't prepare the workspace snapshot.")??;
    let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't prepare the upload.")?;
    let boundary = format!("comet{:x}", u128::from_le_bytes(nonce));
    let metadata = serde_json::to_string(&json!({ "name": format!("Comet - {name}.comet-workspace"), "mimeType": "application/octet-stream", "appProperties": {"cometFormat": "1"} })).map_err(|_| "Couldn't prepare snapshot information.")?;
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
    body.extend_from_slice(&snapshot); body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = drive_client()?.post("https://www.googleapis.com/upload/drive/v3/files").query(&[("uploadType", "multipart"), ("fields", "id")]).bearer_auth(access)
        .header("Content-Type", format!("multipart/related; boundary={boundary}")).body(body).send().await.map_err(|_| "The upload was interrupted. The local workspace was not changed; check Google Drive before retrying.")?;
    let reply = response_json(response).await?;
    if !reply.get("id").and_then(Value::as_str).is_some_and(drive_id) { return Err("Google returned an invalid upload result. Check Drive before retrying.".into()); }
    Ok(())
}
#[tauri::command]
pub async fn google_drive_import(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    if !drive_id(&id) { return Err("Invalid Google Drive snapshot.".into()); }
    let selected = app.dialog().file().set_title("Choose a folder for the new imported workspace").blocking_pick_folder();
    let Some(parent) = selected.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let access = token("drive").await?; let client = drive_client()?;
    let url = format!("https://www.googleapis.com/drive/v3/files/{id}");
    let metadata = response_json(client.get(&url).query(&[("fields", "id,appProperties,size,trashed")]).bearer_auth(&access).send().await.map_err(|_| "Couldn't reach Google Drive.")?).await?;
    if metadata.pointer("/appProperties/cometFormat").and_then(Value::as_str) != Some("1") || metadata.get("trashed").and_then(Value::as_bool) == Some(true) { return Err("This isn't a Comet workspace snapshot.".into()); }
    if metadata.get("size").and_then(Value::as_str).and_then(|s| s.parse::<usize>().ok()).is_some_and(|size| size > crate::workspace_archive::MAX_ARCHIVE) { return Err("The snapshot exceeds the 128 MB import limit.".into()); }
    let mut response = client.get(&url).query(&[("alt", "media")]).bearer_auth(access).send().await.map_err(|_| "Couldn't download the snapshot.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > crate::workspace_archive::MAX_ARCHIVE as u64) { return Err("The snapshot is missing or exceeds the 128 MB limit.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The snapshot download was interrupted.")? {
        if bytes.len() + chunk.len() > crate::workspace_archive::MAX_ARCHIVE { return Err("The snapshot exceeds the 128 MB import limit.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let path = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::unpack(&bytes, &parent)).await.map_err(|_| "The import was interrupted.")??;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_input_is_bounded_and_never_accepts_extra_fields() {
        let valid = json!({"summary":"Hello","start":{"date":"2026-10-27"},"end":{"date":"2026-10-28"}});
        assert!(event_patch(&valid, true));
        assert!(!event_patch(&json!({"summary":"x","attendees":[]}), false));
        assert!(!event_patch(&json!({"summary":"x","start":{"date":"2026-10-27","timeZone":"evil"}}), false));
        assert!(event_id("abc_123-xyz")); assert!(!event_id("../event"));
        assert!(!time_bound("2026-01-01&x=1"));
    }
}

// Immutable revision snapshots form a small DAG. Concurrent uploads create
// separate heads; a later sync merges them with their common ancestor rather
// than letting a last-writer-wins update erase another device's work.
static SYNCING: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Debug)]
struct Revision { id: String, group: String, name: String, modified: String, parents: Vec<String> }
fn group_id(value: &str) -> bool { value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()) }
fn revision(value: &Value) -> Option<Revision> {
    let id = value.get("id")?.as_str()?.to_string(); let props = value.get("appProperties")?.as_object()?;
    let group = props.get("cometGroup")?.as_str()?.to_string();
    if !drive_id(&id) || !group_id(&group) || props.get("cometSync")?.as_str()? != "2" { return None; }
    let mut parents = Vec::new();
    for key in ["parentA", "parentB"] { if let Some(parent) = props.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) { if !drive_id(parent) || parent == id { return None; } parents.push(parent.to_string()); } }
    Some(Revision { id, group, name: value.get("name").and_then(Value::as_str).unwrap_or("Comet workspace").chars().take(150).collect(), modified: value.get("modifiedTime").and_then(Value::as_str).unwrap_or("").to_string(), parents })
}
async fn revisions(access: &str) -> Result<Vec<Revision>, String> {
    let client = drive_client()?; let mut result = Vec::new(); let mut page = String::new();
    for _ in 0..20 {
        let response = client.get("https://www.googleapis.com/drive/v3/files").bearer_auth(access)
            .query(&[("q", "trashed = false and appProperties has { key='cometSync' and value='2' }"), ("fields", "nextPageToken,files(id,name,modifiedTime,appProperties)"), ("pageSize", "100"), ("orderBy", "modifiedTime desc"), ("pageToken", page.as_str())])
            .send().await.map_err(|_| "Couldn't reach Google Drive.")?;
        let data = response_json(response).await?;
        if let Some(files) = data.get("files").and_then(Value::as_array) { result.extend(files.iter().filter_map(revision)); }
        page = data.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string();
        if page.is_empty() { return Ok(result); }
        if page.len() > 2000 { return Err("Google returned an invalid page token.".into()); }
    }
    Err("Too many sync revisions to list safely. No files were changed.".into())
}
fn heads(revisions: &[Revision]) -> Vec<&Revision> {
    let referenced: std::collections::HashSet<&str> = revisions.iter().flat_map(|r| r.parents.iter().map(String::as_str)).collect();
    revisions.iter().filter(|r| !referenced.contains(r.id.as_str())).collect()
}
fn ancestor_distances(id: &str, revisions: &[Revision]) -> std::collections::HashMap<String, usize> {
    let map: std::collections::HashMap<&str, &Revision> = revisions.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut distances = std::collections::HashMap::new(); let mut pending = std::collections::VecDeque::from([(id.to_string(), 0usize)]);
    while let Some((next, distance)) = pending.pop_front() {
        if distances.contains_key(&next) || distance > revisions.len() { continue; }
        distances.insert(next.clone(), distance);
        if let Some(rev) = map.get(next.as_str()) { for parent in &rev.parents { pending.push_back((parent.clone(), distance + 1)); } }
    }
    distances
}
fn common_ancestor(left: &str, right: &str, revisions: &[Revision]) -> Option<String> {
    let a = ancestor_distances(left, revisions); let b = ancestor_distances(right, revisions);
    a.iter().filter_map(|(id, distance)| b.get(id).map(|other| (id, distance + other))).min_by(|(left_id, left_distance), (right_id, right_distance)| left_distance.cmp(right_distance).then_with(|| left_id.cmp(right_id))).map(|(id, _)| id.clone())
}
async fn sync_download(access: &str, id: &str, group: &str) -> Result<Vec<u8>, String> {
    if !drive_id(id) || !group_id(group) { return Err("Invalid sync revision.".into()); }
    let client = drive_client()?; let url = format!("https://www.googleapis.com/drive/v3/files/{id}");
    let meta = response_json(client.get(&url).query(&[("fields", "id,name,modifiedTime,appProperties,size,trashed")]).bearer_auth(access).send().await.map_err(|_| "Couldn't reach Google Drive.")?).await?;
    if meta.get("trashed").and_then(Value::as_bool) == Some(true) || !revision(&meta).is_some_and(|r| r.group == group && r.id == id) { return Err("The sync revision is missing or belongs to another workspace.".into()); }
    if meta.get("size").and_then(Value::as_str).and_then(|s| s.parse::<usize>().ok()).is_some_and(|size| size > crate::workspace_archive::MAX_ARCHIVE) { return Err("The sync revision exceeds 128 MB.".into()); }
    let mut response = client.get(&url).query(&[("alt", "media")]).bearer_auth(access).send().await.map_err(|_| "Couldn't download the sync revision.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > crate::workspace_archive::MAX_ARCHIVE as u64) { return Err("The sync revision is missing or exceeds 128 MB.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The sync download was interrupted.")? {
        if bytes.len() + chunk.len() > crate::workspace_archive::MAX_ARCHIVE { return Err("The sync revision exceeds 128 MB.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn sync_upload(access: &str, name: &str, group: &str, parents: &[String], bytes: &[u8]) -> Result<String, String> {
    if !group_id(group) || parents.len() > 2 || parents.iter().any(|id| !drive_id(id)) { return Err("Invalid sync revision metadata.".into()); }
    let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't prepare a sync revision.")?;
    let boundary = format!("comet{:x}", u128::from_le_bytes(nonce));
    let mut props = serde_json::Map::new();
    props.insert("cometSync".into(), json!("2")); props.insert("cometGroup".into(), json!(group));
    if let Some(parent) = parents.first() { props.insert("parentA".into(), json!(parent)); }
    if let Some(parent) = parents.get(1) { props.insert("parentB".into(), json!(parent)); }
    let meta = serde_json::to_string(&json!({ "name": name, "mimeType": "application/octet-stream", "appProperties": props })).map_err(|_| "Couldn't prepare sync metadata.")?;
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes); body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = drive_client()?.post("https://www.googleapis.com/upload/drive/v3/files").query(&[("uploadType", "multipart"), ("fields", "id")]).bearer_auth(access).header("Content-Type", format!("multipart/related; boundary={boundary}")).body(body).send().await.map_err(|_| "The sync upload was interrupted; local files were preserved. Retry sync.")?;
    let result = response_json(response).await?; result.get("id").and_then(Value::as_str).filter(|id| drive_id(id)).map(str::to_string).ok_or("Google returned an invalid sync revision ID.".into())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncWorkspace { group: String, id: String, name: String, modified: String, branches: usize }
#[tauri::command]
pub async fn google_sync_list() -> Result<Vec<SyncWorkspace>, String> {
    let access = token("drive").await?; let all = revisions(&access).await?;
    let mut groups: std::collections::BTreeMap<String, Vec<Revision>> = std::collections::BTreeMap::new();
    for item in all { groups.entry(item.group.clone()).or_default().push(item); }
    Ok(groups.into_iter().filter_map(|(group, items)| {
        let mut heads = heads(&items); heads.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        heads.first().map(|head| SyncWorkspace { group, id: head.id.clone(), name: head.name.clone(), modified: head.modified.clone(), branches: heads.len() })
    }).collect())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncImport { path: String, group: String, base: String }
#[tauri::command]
pub async fn google_sync_import(app: tauri::AppHandle, id: String, group: String) -> Result<Option<SyncImport>, String> {
    if !drive_id(&id) || !group_id(&group) { return Err("Invalid synced workspace.".into()); }
    let selected = app.dialog().file().set_title("Choose a folder for the synced workspace").blocking_pick_folder();
    let Some(parent) = selected.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let access = token("drive").await?; let bytes = sync_download(&access, &id, &group).await?;
    let path = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::unpack(&bytes, &parent)).await.map_err(|_| "The import was interrupted.")??;
    Ok(Some(SyncImport { path: path.to_string_lossy().to_string(), group, base: id }))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult { group: String, base: String, applied: usize, conflicts: usize, deleted: usize, safety_folder: Option<String>, more: bool }
#[tauri::command]
pub async fn google_sync_now(vault: String, group: String, base: String) -> Result<SyncResult, String> {
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING);
    if (!group.is_empty() && !group_id(&group)) || (!base.is_empty() && !drive_id(&base)) || (group.is_empty() != base.is_empty()) { return Err("Invalid workspace sync state.".into()); }
    let access = token("drive").await?;
    let name = std::path::Path::new(&vault).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(100).collect::<String>();
    let display_name = format!("Comet sync - {name}");
    if group.is_empty() {
        let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't create a workspace identity.")?;
        let group = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let path = vault.clone(); let snapshot = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::pack(&path)).await.map_err(|_| "Couldn't prepare the workspace.")??;
        let id = sync_upload(&access, &display_name, &group, &[], &snapshot).await?;
        return Ok(SyncResult { group, base: id, applied: 0, conflicts: 0, deleted: 0, safety_folder: None, more: false });
    }
    let all = revisions(&access).await?; let group_revs: Vec<_> = all.into_iter().filter(|r| r.group == group).collect();
    if !group_revs.iter().any(|r| r.id == base) { return Err("The sync baseline is missing in Google Drive. No local files were changed; import a new copy or reconnect the original account.".into()); }
    let mut current_heads = heads(&group_revs); current_heads.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
    if current_heads.is_empty() { return Err("Google returned an invalid sync revision history. No local files were changed.".into()); }
    let base_ancestors = ancestor_distances(&base, &group_revs);
    let remote = current_heads.iter().find(|head| head.id != base && !base_ancestors.contains_key(&head.id)).map(|item| item.id.clone());
    let mut summary = crate::workspace_archive::MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None };
    let mut parents = vec![base.clone()];
    let remote_snapshot = if let Some(remote_id) = remote {
        let ancestor = common_ancestor(&base, &remote_id, &group_revs);
        let original = if let Some(id) = ancestor { Some(sync_download(&access, &id, &group).await?) } else { None };
        let incoming = sync_download(&access, &remote_id, &group).await?;
        let path = vault.clone(); let incoming_copy = incoming.clone();
        summary = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::merge(&path, original.as_deref(), &incoming_copy)).await.map_err(|_| "The local sync merge was interrupted.")??;
        parents.push(remote_id); Some(incoming)
    } else { None };
    let describe_merge = |error: String| match &summary.safety_folder {
        Some(folder) => format!("{error} Remote changes already merged locally were preserved. Replaced or deleted originals are in {folder}."),
        None => format!("{error} Remote changes already merged locally were preserved."),
    };
    let path = vault.clone(); let snapshot = tauri::async_runtime::spawn_blocking(move || crate::workspace_archive::pack(&path)).await.map_err(|_| describe_merge("Couldn't prepare the workspace after merging.".into()))?.map_err(&describe_merge)?;
    let base_snapshot = if remote_snapshot.is_none() { Some(sync_download(&access, &base, &group).await?) } else { None };
    let id = if parents.len() == 1 && base_snapshot.as_ref().is_some_and(|old| old.as_slice() == snapshot.as_slice()) { base.clone() }
        else if parents.len() == 2 && ancestor_distances(&parents[1], &group_revs).contains_key(&base) && remote_snapshot.as_ref().is_some_and(|old| old.as_slice() == snapshot.as_slice()) { parents[1].clone() }
        else { sync_upload(&access, &display_name, &group, &parents, &snapshot).await.map_err(&describe_merge)? };
    Ok(SyncResult { group, base: id, applied: summary.applied, conflicts: summary.conflicts, deleted: summary.deleted, safety_folder: summary.safety_folder, more: current_heads.len() > 1 })
}

#[cfg(test)]
mod sync_history_tests {
    use super::*;
    fn rev(id: &str, parents: &[&str]) -> Revision { Revision { id: id.into(), group: "a".repeat(32), name: "vault".into(), modified: "".into(), parents: parents.iter().map(|v| v.to_string()).collect() } }
    #[test]
    fn finds_concurrent_heads_and_shared_ancestor() {
        let history = vec![rev("root", &[]), rev("left", &["root"]), rev("right", &["root"])];
        let mut ids: Vec<_> = heads(&history).iter().map(|r| r.id.clone()).collect(); ids.sort();
        assert_eq!(ids, ["left", "right"]); assert_eq!(common_ancestor("left", "right", &history).as_deref(), Some("root"));
        let mut merged = history.clone(); merged.push(rev("merge", &["left", "right"]));
        assert_eq!(heads(&merged).iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["merge"]);
        assert_eq!(common_ancestor("left", "merge", &merged).as_deref(), Some("left"));
    }
    #[test]
    fn rejects_invalid_revision_metadata() {
        let good = json!({"id":"abc-123", "appProperties":{"cometSync":"2", "cometGroup":"a".repeat(32), "parentA":"root"}});
        assert!(revision(&good).is_some());
        let bad = json!({"id":"../unsafe", "appProperties":{"cometSync":"2", "cometGroup":"a".repeat(32)}});
        assert!(revision(&bad).is_none());
    }
}
