fn main() {
    // The app's own commands, each given a permission of its own that
    // capabilities/quick.json grants to the app's two windows alone.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "hide",
            "open_external",
            "begin_sign_in",
            "complete_sign_in",
            "take_sign_in",
            "open_app",
            "show_quick",
            "show_app",
            "copy_images",
            "device_unlock_kind",
            "device_unlock_secret",
            "reminders_state",
            "reminders_turn_on",
            "reminders_turn_off",
            "set_reminders",
            "hotkeys_get",
            "hotkeys_set",
            "hotkeys_recording",
            "sign_out_app",
        ]),
    ))
    .expect("failed to run tauri-build");
}
