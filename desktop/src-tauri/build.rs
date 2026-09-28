fn main() {
    // The app's own commands, each given a permission of its own that
    // capabilities/quick.json grants to the quick note's window alone.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "hide",
            "open_external",
            "begin_sign_in",
            "complete_sign_in",
            "take_sign_in",
        ]),
    ))
    .expect("failed to run tauri-build");
}
