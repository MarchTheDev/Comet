use std::{env, fs, path::PathBuf};

fn main() {
    // The retired cloud engine is compiled only by regression tests. Its
    // include_bytes! still needs an empty placeholder; releases ship no rclone.
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("comet-rclone");
    fs::write(destination, []).expect("create test placeholder");
    tauri_build::build()
}
