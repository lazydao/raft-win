//! Window buttons for server windows, which have no Windows title bar
//! (titlebar.js draws minimize, maximize and close in Raft's top bar).

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::WebviewWindow;

#[derive(Deserialize)]
pub struct CaptionParams {
    action: String,
}

/// Minimizes, maximizes or restores, or closes the calling window, and says
/// whether it is maximized (and minimized). Closing goes through the usual close request, so
/// the main window still hides to the tray. Async, because closing a window
/// cannot be done from the main thread.
#[tauri::command]
pub async fn window_caption(window: WebviewWindow, params: CaptionParams) -> Value {
    let result = match params.action.as_str() {
        "minimize" => window.minimize(),
        "toggleMaximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "state" => Ok(()),
        other => return json!({ "status": "error", "error": format!("unknown action {other}") }),
    };
    json!({
        "status": if result.is_ok() { "ok" } else { "error" },
        "maximized": window.is_maximized().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
    })
}
