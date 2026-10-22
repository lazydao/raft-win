//! Several server windows at once, all signed in to the same account.
//!
//! Ctrl- or middle-clicking a server in the web client's server switcher opens
//! it in a window of its own. Raft 1.21.28 does this as a plain link to the
//! server's page, which [`show_url`] turns into a Pontoon window; older
//! versions used the contract's optional `window.openServer` extension, which
//! still works. Each window is bound to the server it shows (raft_shim.js
//! reports it, as the web client itself used to), so Pontoon can focus it and
//! route that server's notifications to it. The main window hides to the tray
//! when closed; the others close for real. The servers open at quit are
//! reopened at the next start.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, WebviewWindow};

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

/// Where a window opened by [`show_url`] loads first, by label. Taken once.
static START_URLS: Mutex<Vec<(String, Url)>> = Mutex::new(Vec::new());

/// The URL a new window should load first instead of its server's start page.
pub fn take_start_url(label: &str) -> Option<Url> {
    let mut urls = START_URLS.lock().unwrap();
    let i = urls.iter().position(|(l, _)| l == label)?;
    Some(urls.remove(i).1)
}

/// The server a Raft page is on: the slug in `https://app.raft.build/s/<slug>/…`.
pub fn slug_of(url: &Url) -> Option<String> {
    if url.scheme() != "https" || url.host_str() != Some("app.raft.build") {
        return None;
    }
    let mut parts = url.path_segments()?;
    if parts.next() != Some("s") {
        return None;
    }
    let slug = percent_decode(parts.next()?)?;
    (!slug.is_empty() && slug.chars().count() <= 100 && !slug.chars().any(char::is_control)).then_some(slug)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The server window whose page is on `slug` now, the main one first.
fn find_showing(app: &AppHandle, slug: &str) -> Option<WebviewWindow> {
    all(app).into_iter().find(|w| w.url().ok().and_then(|u| slug_of(&u)).as_deref() == Some(slug))
}

/// A label for a new window opened on a link. Labels may hold only ASCII
/// letters, digits and `-_`, so other characters of the slug are dropped.
fn label_for_slug(app: &AppHandle, slug: &str) -> String {
    let clean: String = slug
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(60)
        .collect::<String>()
        .to_ascii_lowercase();
    let base = format!("server-s-{}", if clean.is_empty() { "raft" } else { &clean });
    let mut label = base.clone();
    let mut n = 2;
    while app.get_webview_window(&label).is_some() {
        label = format!("{base}-{n}");
        n += 1;
    }
    label
}

/// Shows a Raft server page asked for in a new window: the window already on
/// that server comes to the front (and goes to the page, when the link points
/// at something in particular, like a message), otherwise a new window opens
/// on the page. Called from the new-window handler, which runs on the main
/// thread, where creating a window deadlocks on Windows; so it works from
/// another thread.
pub fn show_url_from_handler(app: &AppHandle, url: Url) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = show_url(&app, url);
    });
}

fn show_url(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let Some(slug) = slug_of(&url) else { return Ok(()) };
    if let Some(existing) = find_showing(app, &slug) {
        if url.query().is_some() || url.fragment().is_some() {
            existing.navigate(url)?;
        }
        shell::show_window(&existing);
        return Ok(());
    }
    let label = label_for_slug(app, &slug);
    START_URLS.lock().unwrap().push((label.clone(), url));
    if let Err(e) = shell::create_server_window(app, &label, true) {
        take_start_url(&label);
        return Err(e);
    }
    shell::refresh_tray(app);
    Ok(())
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
    fn server_pages_name_their_server() {
        let slug = |s: &str| slug_of(&Url::parse(s).unwrap());
        assert_eq!(slug("https://app.raft.build/s/acme/channel/1?msg=2").as_deref(), Some("acme"));
        assert_eq!(slug("https://app.raft.build/s/will-game-studio").as_deref(), Some("will-game-studio"));
        assert_eq!(slug("https://app.raft.build/s/%E5%B0%8F%E7%BB%84/").as_deref(), Some("小组"));
        assert_eq!(slug("https://app.raft.build/"), None);
        assert_eq!(slug("https://app.raft.build/s/"), None);
        assert_eq!(slug("https://app.raft.build/invite/abc"), None);
        assert_eq!(slug("https://example.com/s/acme"), None);
        assert_eq!(slug("http://app.raft.build/s/acme"), None);
        assert_eq!(slug("https://app.raft.build/s/a%0Ab"), None);
        assert_eq!(slug("https://app.raft.build/s/a%ZZ"), None);
    }

    #[test]
    fn server_window_labels() {
        assert!(is_server_window("server-main"));
        assert!(is_server_window(&format!("server-{A}")));
        assert!(!is_server_window("settings"));
    }
}
