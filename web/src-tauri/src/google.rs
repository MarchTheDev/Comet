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

const SERVICE: &str = "com.marco.comet.google";
static CALENDAR_CONNECTING: AtomicBool = AtomicBool::new(false);
static DRIVE_CONNECTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
struct Credentials { client_id: String, client_secret: String, refresh_token: String }
#[derive(Deserialize)]
struct TokenReply { access_token: Option<String>, refresh_token: Option<String>, scope: Option<String> }

fn scope(service: &str) -> Result<&'static str, String> {
    match service {
        "calendar" => Ok("https://www.googleapis.com/auth/calendar.events"),
        "drive" => Ok("https://www.googleapis.com/auth/drive.file"),
        _ => Err("Unknown Google service.".into()),
    }
}
fn entry(service: &str) -> Result<keyring::Entry, String> {
    scope(service)?;
    keyring::Entry::new(SERVICE, service).map_err(|_| "The system credential store isn't available.".into())
}
fn read_credentials(service: &str) -> Result<Credentials, String> {
    let raw = entry(service)?.get_password().map_err(|_| "Google isn't connected or the system credential store is locked.")?;
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
    tauri::async_runtime::spawn_blocking(move || match entry(&service)?.get_password() {
        Ok(_) => Ok(true), Err(keyring::Error::NoEntry) => Ok(false), Err(_) => Err("The system credential store isn't available or is locked.".into()),
    }).await.map_err(|_| "Couldn't check Google connection.".to_string())?
}

#[tauri::command]
pub async fn google_disconnect(service: String) -> Result<(), String> {
    scope(&service)?;
    if (if service == "calendar" { &CALENDAR_CONNECTING } else { &DRIVE_CONNECTING }).load(Ordering::Acquire) { return Err("Wait for the sign-in to finish first.".into()); }
    tauri::async_runtime::spawn_blocking(move || match entry(&service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(_) => Err("Couldn't remove Google authorization from the system credential store.".into()),
    }).await.map_err(|_| "Couldn't disconnect Google.".to_string())?
}

#[tauri::command]
pub async fn google_connect(app: tauri::AppHandle, service: String, client_id: String, client_secret: String) -> Result<(), String> {
    let requested_scope = scope(&service)?;
    let lock = if service == "calendar" { &CALENDAR_CONNECTING } else { &DRIVE_CONNECTING };
    if lock.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A Google sign-in is already in progress.".into()); }
    let _guard = ConnectingGuard(lock);
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
    if reply.scope.as_deref().is_some_and(|granted| !granted.split_whitespace().any(|value| value == requested_scope)) { return Err("Google did not grant the requested permission.".into()); }
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
    if !response.status().is_success() { return Err(format!("Google Calendar returned {}. Refresh and try again.", response.status().as_u16())); }
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
