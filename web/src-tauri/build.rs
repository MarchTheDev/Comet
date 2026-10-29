use std::{env, fs, path::PathBuf};

fn main() {
    // Release CI supplies the checksum-verified official binary. Keeping it
    // out of Git avoids a large opaque executable in the source tree.
    println!("cargo:rerun-if-env-changed=COMET_RCLONE_BIN");
    println!("cargo:rerun-if-env-changed=COMET_REQUIRE_BUNDLED_RCLONE");
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("comet-rclone");
    if let Some(source) = env::var_os("COMET_RCLONE_BIN") {
        println!("cargo:rerun-if-changed={}", PathBuf::from(&source).display());
        fs::copy(source, &destination).expect("copy bundled rclone");
    } else {
        assert_ne!(env::var("COMET_REQUIRE_BUNDLED_RCLONE").as_deref(), Ok("1"), "A release must bundle the verified rclone binary");
        fs::write(&destination, []).expect("create empty development rclone placeholder");
    }
    tauri_build::build()
}
