//! Several server windows at once, all signed in to the same account.
//!
//! The web client asks for a new window through the contract's optional
//! `window.openServer` extension when you Ctrl-, Shift- or middle-click a
//! server in its server switcher. Each window then binds to its own server, so
//! its socket delivers that server's messages and notifications. The main
//! window hides to the tray when closed; the others close for real. The
//! servers open at quit are reopened at the next start.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::contract::{is_canonical_uuid, ContractState};
use crate::shell;

const STATE_FILE: &str = "windows.json";

/// The server each window last showed, by window label, in opening order.
/// Unlike the contract's per-document binding it survives page loads, so a
/// reload or recovery retry returns the window to its own server.
#[derive(Default)]
pub struct ServerWindows(Mutex<Vec<(String, String)>>);

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Saved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    main: Option<String>,
    #[serde(default)]
    extra: Vec<String>,
}

pub fn is_server_window(label: &str) -> bool {
    label.starts_with("server-")
}

/// Server windows, the main one first, then in opening order.
pub fn all(app: &AppHandle) -> Vec<WebviewWindow> {
    let mut windows: Vec<WebviewWindow> =
        app.webview_windows().into_values().filter(|w| is_server_window(w.label())).collect();
    let order = order(app);
    windows.sort_by_key(|w| {
        if w.label() == shell::MAIN_WINDOW {
            0
        } else {
            1 + order.iter().position(|l| l == w.label()).unwrap_or(usize::MAX - 1)
        }
    });
    windows
}

fn order(app: &AppHandle) -> Vec<String> {
    app.state::<ServerWindows>().0.lock().unwrap().iter().map(|(l, _)| l.clone()).collect()
}

/// The server `label` last showed, if any.
pub fn home(app: &AppHandle, label: &str) -> Option<String> {
    app.state::<ServerWindows>().0.lock().unwrap().iter().find(|(l, _)| l == label).map(|(_, s)| s.clone())
}

/// Records that `label` now shows `server_id` and saves the window list.
pub fn set_home(app: &AppHandle, label: &str, server_id: &str) {
    {
        let state = app.state::<ServerWindows>();
        let mut homes = state.0.lock().unwrap();
        match homes.iter_mut().find(|(l, _)| l == label) {
            Some(entry) => entry.1 = server_id.to_string(),
            None => homes.push((label.to_string(), server_id.to_string())),
        }
    }
    save(app);
}

/// A window the user closed: forget it, so it is not reopened at start.
pub fn forget(app: &AppHandle, label: &str) {
    app.state::<ServerWindows>().0.lock().unwrap().retain(|(l, _)| l != label);
    app.state::<ContractState>().windows.lock().unwrap().remove(label);
    save(app);
}

/// The window currently bound to `server_id`, if one is.
pub fn find_bound(app: &AppHandle, server_id: &str) -> Option<WebviewWindow> {
    let bound: Vec<String> = {
        let state = app.state::<ContractState>();
        let windows = state.windows.lock().unwrap();
        windows
            .iter()
            .filter(|(_, d)| d.server_id.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(server_id)))
            .map(|(l, _)| l.clone())
            .collect()
    };
    all(app).into_iter().find(|w| bound.iter().any(|l| l == w.label()))
}

/// A label for a new window on `server_id`. Labels follow the server so each
/// one gets its own remembered size and position.
fn new_label(app: &AppHandle, server_id: &str) -> String {
    let base = format!("server-{}", server_id.to_ascii_lowercase());
    let mut label = base.clone();
    let mut n = 2;
    while app.get_webview_window(&label).is_some() {
        label = format!("{base}-{n}");
        n += 1;
    }
    label
}

/// Opens a new window on `server_id`.
pub fn open(app: &AppHandle, server_id: &str, visible: bool) -> tauri::Result<WebviewWindow> {
    let label = new_label(app, server_id);
    {
        let state = app.state::<ServerWindows>();
        let mut homes = state.0.lock().unwrap();
        homes.push((label.clone(), server_id.to_string()));
    }
    let window = match shell::create_server_window(app, &label, visible) {
        Ok(w) => w,
        Err(e) => {
            app.state::<ServerWindows>().0.lock().unwrap().retain(|(l, _)| l != &label);
            return Err(e);
        }
    };
    save(app);
    shell::refresh_tray(app);
    Ok(window)
}

fn state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(STATE_FILE))
}

fn snapshot(app: &AppHandle) -> Saved {
    let state = app.state::<ServerWindows>();
    let homes = state.0.lock().unwrap();
    let mut saved = Saved::default();
    for (label, server) in homes.iter() {
        if label == shell::MAIN_WINDOW {
            saved.main = Some(server.clone());
        } else if !saved.extra.contains(server) && saved.main.as_ref() != Some(server) {
            saved.extra.push(server.clone());
        }
    }
    saved
}

fn save(app: &AppHandle) {
    let Some(path) = state_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_vec_pretty(&snapshot(app)).unwrap());
}

fn parse(bytes: &[u8]) -> Saved {
    let mut saved: Saved = serde_json::from_slice(bytes).unwrap_or_default();
    saved.main = saved.main.filter(|s| is_canonical_uuid(s));
    let main = saved.main.clone();
    let mut extra: Vec<String> = Vec::new();
    for s in saved.extra {
        if is_canonical_uuid(&s) && Some(&s) != main.as_ref() && !extra.contains(&s) {
            extra.push(s);
        }
    }
    // A stray file must not open an unbounded number of windows.
    extra.truncate(16);
    saved.extra = extra;
    saved
}

/// Creates the main window and reopens the windows that were open at quit.
pub fn restore(app: &AppHandle, start_hidden: bool) -> tauri::Result<()> {
    let saved = state_path(app).and_then(|p| std::fs::read(p).ok()).map(|b| parse(&b)).unwrap_or_default();
    if let Some(main) = &saved.main {
        app.state::<ServerWindows>().0.lock().unwrap().push((shell::MAIN_WINDOW.to_string(), main.clone()));
    }
    shell::create_server_window(app, shell::MAIN_WINDOW, !start_hidden)?;
    for server in &saved.extra {
        open(app, server, !start_hidden)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "123e4567-e89b-12d3-a456-426614174000";
    const B: &str = "223e4567-e89b-12d3-a456-426614174000";

    #[test]
    fn saved_window_list_is_checked() {
        let s = parse(format!(r#"{{"main":"{A}","extra":["{B}","{A}","{B}","nope"]}}"#).as_bytes());
        assert_eq!(s, Saved { main: Some(A.into()), extra: vec![B.into()] });
        assert_eq!(parse(b"not json"), Saved::default());
        assert_eq!(parse(br#"{"main":"x"}"#), Saved::default());
        let many: Vec<String> = (0..40).map(|i| format!("{i:08x}-e89b-12d3-a456-426614174000")).collect();
        let s = parse(serde_json::to_string(&Saved { main: None, extra: many }).unwrap().as_bytes());
        assert_eq!(s.extra.len(), 16);
    }

    #[test]
    fn server_window_labels() {
        assert!(is_server_window("server-main"));
        assert!(is_server_window(&format!("server-{A}")));
        assert!(!is_server_window("settings"));
    }
}
