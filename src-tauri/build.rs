fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_handshake",
            "window_focus",
            "window_bind_server",
            "window_set_server_title",
            "recovery_retry",
            "recovery_quit",
            "shell_notify",
        ]),
    ))
    .expect("failed to run tauri-build");
}
