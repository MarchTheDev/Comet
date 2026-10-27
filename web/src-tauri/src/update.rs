//! User-initiated Windows installer handoff, like Orbit. The download is
//! restricted to this repository, bounded, and compared with GitHub's digest.
//! A digest obtained from the same release is not an independent signature.

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, version: String, digest: String) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, version, digest);
        Err("Automatic installer handoff is currently available on Windows only; use the release page.".into())
    }
    #[cfg(target_os = "windows")]
    {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        use tauri::Manager;
        const LIMIT: u64 = 256 * 1024 * 1024;
        if !valid_version(&version) || !newer_version(&version, env!("CARGO_PKG_VERSION")) || digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid update version or checksum.".into());
        }
        let name = format!("Comet-{version}-windows_setup.exe");
        let url = format!("https://github.com/MarchTheDev/Comet/releases/download/v{version}/{name}");
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.url().scheme() == "https" && matches!(attempt.url().host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"));
            if allowed && attempt.previous().len() < 8 { attempt.follow() } else { attempt.error("Untrusted download redirect") }
        });
        let client = reqwest::Client::builder().user_agent(concat!("Comet/", env!("CARGO_PKG_VERSION"))).redirect(policy).timeout(std::time::Duration::from_secs(600)).build().map_err(|_| "Couldn't initialize the download.")?;
        let mut response = client.get(url).send().await.map_err(|_| "Couldn't download the update.")?;
        if !response.status().is_success() || response.content_length().is_some_and(|size| size > LIMIT) { return Err("The update is missing or exceeds the download limit.".into()); }
        let directory = app.path().app_cache_dir().map_err(|_| "Couldn't access the update cache.")?.join("updates");
        std::fs::create_dir_all(&directory).map_err(|_| "Couldn't create the update cache.")?;
        let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't create a safe update filename.")?;
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let path = directory.join(format!("Comet-{version}-{suffix}.exe"));
        let result = async {
            let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "Couldn't create the update file.")?;
            let mut hash = Sha256::new(); let mut total = 0u64;
            while let Some(bytes) = response.chunk().await.map_err(|_| "The update download was interrupted.")? {
                total = total.checked_add(bytes.len() as u64).ok_or("Update is too large.")?;
                if total > LIMIT { return Err("The update exceeds the download limit."); }
                hash.update(&bytes); file.write_all(&bytes).map_err(|_| "Couldn't write the update.")?;
            }
            file.flush().map_err(|_| "Couldn't finish writing the update.")?;
            if total == 0 || format!("{:x}", hash.finalize()) != digest.to_ascii_lowercase() { return Err("The update checksum didn't match. Nothing was launched."); }
            drop(file);
            // Only the newly created, verified installer from the official release is run.
            std::process::Command::new(&path).spawn().map_err(|_| "Couldn't open the installer.")?;
            Ok(())
        }.await;
        if result.is_err() { let _ = std::fs::remove_file(&path); }
        result.map_err(str::to_string)
    }
}

#[cfg(any(target_os = "windows", test))]
fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|c| c.is_ascii_digit()))
}
#[cfg(any(target_os = "windows", test))]
fn newer_version(candidate: &str, current: &str) -> bool {
    if !valid_version(candidate) || !valid_version(current) { return false; }
    let parse = |s: &str| s.split('.').map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    parse(candidate) > parse(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_are_strict_and_must_increase() {
        assert!(newer_version("1.2.10", "1.2.9"));
        assert!(!newer_version("1.2.9", "1.2.9"));
        assert!(!newer_version("1.3.0-evil/../../x", "1.2.9"));
        assert!(!valid_version("1.2"));
    }
}
