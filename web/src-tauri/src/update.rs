//! User-initiated desktop installer download and handoff, modeled on Orbit.
//! Downloads are restricted to official MarchTheDev/Comet GitHub release assets,
//! size-bounded, and verified against GitHub's SHA-256 digest before opening.

use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::{Emitter, Manager};

const LIMIT: u64 = 320 * 1024 * 1024;

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    version: String,
    digest: String,
    asset_name: Option<String>,
    tag: Option<String>,
) -> Result<String, String> {
    if !valid_release_version(&version) || !newer_release_version(&version, env!("CARGO_PKG_VERSION")) {
        return Err("Invalid update version.".into());
    }
    if !digest.is_empty() && (digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err("Invalid update checksum.".into());
    }

    let release_tag = match tag.as_deref() {
        Some(raw) if valid_tag(raw) => raw.to_string(),
        Some(_) => return Err("Invalid release tag.".into()),
        None => format!("v{version}"),
    };

    let default_asset = default_platform_asset(&version)
        .ok_or_else(|| "Automatic installer handoff is not supported on this platform; use the release page.".to_string())?;
    let chosen_name = match asset_name {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => default_asset,
    };
    if !valid_asset_name(&chosen_name) {
        return Err("Untrusted installer filename.".into());
    }

    let ext = allowed_extension(&chosen_name)
        .ok_or_else(|| "Unsupported installer format; use the release page.".to_string())?;

    let url = format!("https://github.com/MarchTheDev/Comet/releases/download/{release_tag}/{chosen_name}");
    let _ = app.emit("comet-update-step", "downloading");

    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let allowed = attempt.url().scheme() == "https"
            && matches!(
                attempt.url().host_str(),
                Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")
            );
        if allowed && attempt.previous().len() < 8 {
            attempt.follow()
        } else {
            attempt.error("Untrusted download redirect")
        }
    });

    let client = reqwest::Client::builder()
        .user_agent(concat!("Comet/", env!("CARGO_PKG_VERSION")))
        .redirect(policy)
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|_| "Couldn't initialize the download.")?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "Couldn't download the update.")?;

    if !response.status().is_success() || response.content_length().is_some_and(|size| size > LIMIT) {
        return Err("The update is missing or exceeds the download limit.".into());
    }

    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Couldn't access the update cache.")?
        .join("updates");
    std::fs::create_dir_all(&directory).map_err(|_| "Couldn't create the update cache.")?;

    let mut nonce = [0u8; 8];
    getrandom::fill(&mut nonce).map_err(|_| "Couldn't create a safe update filename.")?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let safe_ver: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    let path = directory.join(format!("Comet-{safe_ver}-{suffix}.{ext}"));

    let result: Result<String, &'static str> = async {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "Couldn't create the update file.")?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|_| "The update download was interrupted.")?
        {
            total = total.checked_add(bytes.len() as u64).ok_or("Update is too large.")?;
            if total > LIMIT {
                return Err("The update exceeds the download limit.");
            }
            hash.update(&bytes);
            file.write_all(&bytes).map_err(|_| "Couldn't write the update.")?;
        }
        file.flush().map_err(|_| "Couldn't finish writing the update.")?;
        if total == 0 {
            return Err("Downloaded update was empty.");
        }
        if !digest.is_empty() && format!("{:x}", hash.finalize()) != digest.to_ascii_lowercase() {
            return Err("The update checksum didn't match. Nothing was launched.");
        }
        drop(file);

        let _ = app.emit("comet-update-step", "opening");
        launch_installer(&path)?;
        Ok(path.to_string_lossy().into_owned())
    }
    .await;

    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result.map_err(str::to_string)
}

fn default_platform_asset(version: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        return Some(format!("Comet-{version}-windows-setup.exe"));
    }
    #[cfg(target_os = "linux")]
    {
        return Some(format!("Comet_{version}_amd64.deb"));
    }
    #[cfg(target_os = "macos")]
    {
        return Some(format!("Comet_{version}_universal.dmg"));
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = version;
        None
    }
}

fn launch_installer(path: &std::path::Path) -> Result<(), &'static str> {
    #[cfg(target_os = "windows")]
    {
        let is_msi = path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("msi"));
        if is_msi {
            std::process::Command::new("msiexec")
                .arg("/i")
                .arg(path)
                .spawn()
                .map_err(|_| "Couldn't open the installer.")?;
        } else {
            std::process::Command::new(path)
                .spawn()
                .map_err(|_| "Couldn't open the installer.")?;
        }
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let is_appimage = path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("appimage"));
        if is_appimage {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(path, perms);
            }
            if let Some(parent) = path.parent() {
                clean_linux_command("xdg-open")
                    .arg(parent)
                    .spawn()
                    .map_err(|_| "Couldn't open the downloaded AppImage folder.")?;
                return Ok(());
            }
        }
        clean_linux_command("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|_| "Couldn't hand the package to your system installer.")?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|_| "Couldn't open the disk image.")?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = path;
        Err("Installer launch is not supported on this platform.")
    }
}

#[cfg(target_os = "linux")]
fn clean_linux_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    for key in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "APPDIR",
        "APPIMAGE",
        "OWD",
        "ARGV0",
        "GSETTINGS_SCHEMA_DIR",
        "QT_PLUGIN_PATH",
    ] {
        cmd.env_remove(key);
    }
    cmd
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && !tag.contains("..")
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn valid_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 140
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn allowed_extension(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".tar.gz") {
        return Some("tar.gz");
    }
    for ext in ["exe", "msi", "deb", "rpm", "appimage", "dmg"] {
        if lower.ends_with(&format!(".{ext}")) {
            return Some(ext);
        }
    }
    None
}

pub(crate) fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    (2..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|c| c.is_ascii_digit()))
}

fn valid_release_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    if !valid_version(core) {
        return false;
    }
    match pre {
        None => true,
        Some(raw) => {
            !raw.is_empty()
                && raw.len() <= 32
                && !raw.contains("..")
                && raw
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        }
    }
}

pub(crate) fn newer_version(candidate: &str, current: &str) -> bool {
    if !valid_version(candidate) || !valid_version(current) {
        return false;
    }
    parse_core(candidate) > parse_core(current)
}

fn newer_release_version(candidate: &str, current: &str) -> bool {
    if !valid_release_version(candidate) || !valid_release_version(current) {
        return false;
    }
    let (cand_core, cand_pre) = split_pre(candidate);
    let (curr_core, curr_pre) = split_pre(current);
    let a = parse_core(cand_core);
    let b = parse_core(curr_core);
    if a != b {
        return a > b;
    }
    match (cand_pre, curr_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (Some(x), Some(y)) => x > y,
        (None, None) => false,
    }
}

fn split_pre(v: &str) -> (&str, Option<&str>) {
    match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    }
}

fn parse_core(s: &str) -> [u32; 3] {
    let mut numbers = [0u32; 3];
    for (index, part) in s.split('.').take(3).enumerate() {
        numbers[index] = part.parse().unwrap_or(0);
    }
    numbers
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_are_strict_and_must_increase() {
        assert!(newer_version("1.2.10", "1.2.9"));
        assert!(!newer_version("1.2.9", "1.2.9"));
        assert!(!newer_version("1.3.0-evil/../../x", "1.2.9"));
        assert!(valid_version("1.2"));
        assert!(newer_version("1.0", "0.1.0"));
        assert!(newer_version("1.0.1", "1.0"));
        assert!(!newer_version("1.0", "1.0.0"));
        assert!(!newer_version("1.0.0", "1.0"));
        for invalid in ["1", "1.", "1.0.0.0", "1.0-beta", "1.0/evil", "1234567.0"] {
            assert!(!valid_version(invalid));
        }
        assert!(newer_release_version("1.1.0-beta.1", "1.0.1"));
        assert!(!newer_release_version("1.0.1-beta.1", "1.0.1"));
        assert!(valid_asset_name("Comet_1.0.2_amd64.deb"));
        assert!(!valid_asset_name("../Comet.deb"));
    }
}
