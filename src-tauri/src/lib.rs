mod contract;
mod font;
mod notify;
mod server_window;
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
        .plugin(tauri_plugin_opener::init())
        .manage(contract::ContractState::default())
        .manage(font::FontState::default())
        .manage(notify::NotifyState::default())
        .manage(server_window::ServerWindows::default())
        .invoke_handler(tauri::generate_handler![
            contract::desktop_handshake,
            contract::window_focus,
            contract::window_bind_server,
            contract::window_open_server,
            contract::window_set_server_title,
            contract::recovery_retry,
            contract::recovery_quit,
            notify::shell_notify,
            notify::notify_push_state,
            font::font_get,
            font::font_set,
            font::font_list,
        ])
        .setup(|app| {
            font::load(app.handle());
            notify::load(app.handle());
            let start_hidden = std::env::args().any(|a| a == shell::HIDDEN_ARG);
            shell::create_tray(app.handle())?;
            server_window::restore(app.handle(), start_hidden)?;
            shell::refresh_tray(app.handle());
            if std::env::args().any(|a| a == font::SETTINGS_ARG) {
                font::open_settings(app.handle())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window keeps Raft running in the tray so
            // notifications keep arriving; quit from the tray menu. Other
            // server windows close for real and are not reopened at start.
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == shell::MAIN_WINDOW {
                    api.prevent_close();
                    let _ = window.hide();
                } else if server_window::is_server_window(window.label()) {
                    server_window::forget(window.app_handle(), window.label());
                }
            }
            // Looking at a window counts its new messages as seen.
            WindowEvent::Focused(true) if server_window::is_server_window(window.label()) => {
                notify::clear_unread(window.app_handle(), window.label());
            }
            WindowEvent::Destroyed if server_window::is_server_window(window.label()) => {
                notify::clear_unread(window.app_handle(), window.label());
                shell::refresh_tray_without(window.app_handle(), window.label());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Pontoon");
}
