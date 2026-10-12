mod contract;
mod font;
mod shell;

use tauri::{Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == font::SETTINGS_ARG) {
                font::open_settings_from_handler(app);
            } else if let Some(w) = shell::main_window(app) {
                shell::show_window(&w);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![shell::HIDDEN_ARG])))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(contract::ContractState::default())
        .manage(font::FontState::default())
        .invoke_handler(tauri::generate_handler![
            contract::desktop_handshake,
            contract::window_focus,
            contract::window_bind_server,
            contract::window_set_server_title,
            contract::recovery_retry,
            contract::recovery_quit,
            shell::shell_notify,
            font::font_get,
            font::font_set,
            font::font_list,
        ])
        .setup(|app| {
            font::load(app.handle());
            let start_hidden = std::env::args().any(|a| a == shell::HIDDEN_ARG);
            shell::create_main_window(app.handle(), start_hidden)?;
            shell::create_tray(app.handle())?;
            if std::env::args().any(|a| a == font::SETTINGS_ARG) {
                font::open_settings(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Raft running in the tray so
            // notifications keep arriving; quit from the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == shell::MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            let _ = window.app_handle();
        })
        .run(tauri::generate_context!())
        .expect("error while running Pontoon");
}
