//! Window, tray, navigation policy and notifications.

use std::collections::VecDeque;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::contract::{self, FRONTEND_ORIGIN};
use crate::font;
use crate::server_window;

pub const MAIN_WINDOW: &str = "server-main";
pub const TRAY_ID: &str = "main-tray";
pub const HIDDEN_ARG: &str = "--hidden";

const AUTH_HOSTS: &[&str] = &["accounts.google.com", "appleid.apple.com", "idmsa.apple.com"];

/// When a sign-in started at `api.raft.build/api/auth/<provider>/start`.
/// Providers hop through hosts we cannot list exactly ahead of time (regional
/// Google domains, accounts.youtube.com, GitHub 2FA, Apple ID pages), and
/// sending one hop to the system browser breaks the flow. So for a limited time
/// after a sign-in starts, the provider's own domains stay in the window. Other
/// sites still go to the browser, and none of them can call native commands.
static SIGN_IN_STARTED: Mutex<Option<Instant>> = Mutex::new(None);
const SIGN_IN_WINDOW: Duration = Duration::from_secs(10 * 60);

fn is_sign_in_start(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("api.raft.build")
        && url.path().starts_with("/api/auth/")
        && url.path().ends_with("/start")
}

fn in_sign_in_flow() -> bool {
    matches!(*SIGN_IN_STARTED.lock().unwrap(), Some(t) if t.elapsed() < SIGN_IN_WINDOW)
}

/// Domains owned by the sign-in providers Raft offers (Google, GitHub, Apple).
fn is_provider_domain(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    under("google.com")
        || host.starts_with("accounts.google.")
        || under("youtube.com")
        || under("gstatic.com")
        || under("googleusercontent.com")
        || under("github.com")
        || under("apple.com")
}

/// Decides whether a top-level navigation stays in the window, tracking the
/// sign-in flow as it goes.
fn allow_navigation(url: &Url) -> bool {
    if is_sign_in_start(url) {
        *SIGN_IN_STARTED.lock().unwrap() = Some(Instant::now());
        return true;
    }
    if url.scheme() == "https" && url.host_str() == Some("app.raft.build") {
        *SIGN_IN_STARTED.lock().unwrap() = None;
        return true;
    }
    if is_local(url) || is_raft(url) || is_auth(url) {
        return true;
    }
    in_sign_in_flow() && is_provider_domain(url)
}

/// Appends to navigation.log in the app's log folder, so a broken flow can be
/// diagnosed on the user's machine.
fn log_navigation(app: &AppHandle, verdict: &str, url: &Url) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("navigation.log")) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        // Query strings can carry auth codes; log only origin and path.
        let _ = writeln!(f, "{secs} {verdict} {}://{}{}", url.scheme(), url.host_str().unwrap_or_default(), url.path());
    }
}

fn local_url(path: &str) -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).unwrap().join(path).unwrap()
}

fn is_local(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data")
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}

fn is_raft(url: &Url) -> bool {
    url.scheme() == "https" && matches!(url.host_str(), Some("app.raft.build") | Some("api.raft.build"))
}

/// Third-party sign-in pages the login flow may pass through.
fn is_auth(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default();
    if AUTH_HOSTS.contains(&host) {
        return true;
    }
    host == "github.com"
        && (url.path().starts_with("/login") || url.path().starts_with("/sessions") || url.path().starts_with("/session"))
}

fn open_external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

pub fn show_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Check that app.raft.build is reachable, then load it; otherwise show the
/// local recovery page, whose retry button calls back into here.
pub fn load_remote(app: AppHandle, window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        let reachable = match reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
            Ok(client) => client
                .get(format!("{FRONTEND_ORIGIN}/"))
                .send()
                .await
                .map(|r| r.status().is_success() || r.status().is_redirection())
                .unwrap_or(false),
            Err(_) => false,
        };
        let target = if reachable {
            start_url(server_window::home(&app, window.label()).as_deref())
        } else {
            local_url("recovery.html")
        };
        let _ = window.navigate(target);
    });
}

/// Where a window loads Raft: its own server when it has one (the web client
/// reads `raftDesktopServerId` and opens that server's last page), otherwise
/// the web client's own choice.
fn start_url(server_id: Option<&str>) -> Url {
    let mut url = Url::parse(&format!("{FRONTEND_ORIGIN}/")).unwrap();
    if let Some(id) = server_id {
        url.query_pairs_mut().append_pair("raftDesktopServerId", id);
    }
    url
}

/// Builds a server window (`server-*`): the bundled loading page first, then
/// app.raft.build once it is reachable.
pub fn create_server_window(app: &AppHandle, label: &str, visible: bool) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Raft")
        .inner_size(1280.0, 820.0)
        .min_inner_size(420.0, 560.0)
        .visible(false)
        .zoom_hotkeys_enabled(true)
        .initialization_script(contract::environment_init_script())
        .initialization_script(include_str!("notify.js"))
        .initialization_script(include_str!("font.js"))
        .on_navigation(move |url| {
            if allow_navigation(url) {
                log_navigation(&nav_app, "in-app", url);
                true
            } else {
                log_navigation(&nav_app, "external", url);
                open_external(&nav_app, url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            if is_auth(&url) || (in_sign_in_flow() && is_provider_domain(&url)) {
                log_navigation(&popup_app, "popup", &url);
                NewWindowResponse::Allow
            } else {
                // Links that would open a new tab go to the system browser,
                // including app.raft.build share links.
                open_external(&popup_app, &url);
                NewWindowResponse::Deny
            }
        })
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished && is_raft(payload.url()) {
                contract::issue_document_identity(&window);
                font::sync_window(&window);
            }
        })
        .build()?;

    if visible {
        show_window(&window);
    }
    load_remote(app.clone(), window.clone());
    Ok(window)
}

/// How a window is named in the tray menu: its server title without the
/// trailing " | Raft", with `&` escaped so Windows does not read it as an
/// access key.
fn tray_window_name(title: &str) -> String {
    let name = title.strip_suffix(" | Raft").unwrap_or(title).trim();
    let name = if name.is_empty() { "Raft" } else { name };
    name.replace('&', "&&")
}

const WINDOW_ITEM_PREFIX: &str = "window:";

fn tray_menu(app: &AppHandle, closing: Option<&str>) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let mut windows = server_window::all(app);
    windows.retain(|w| Some(w.label()) != closing);
    if windows.len() > 1 {
        // One entry per server window, so any of them can be brought back.
        for w in &windows {
            let name = tray_window_name(&w.title().unwrap_or_default());
            let id = format!("{WINDOW_ITEM_PREFIX}{}", w.label());
            menu.append(&MenuItem::with_id(app, id, name, true, None::<&str>)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    } else {
        menu.append(&MenuItem::with_id(app, "show", "打开 Raft", true, None::<&str>)?)?;
    }
    menu.append(&MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "fonts", "字体设置…", true, None::<&str>)?)?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    menu.append(&CheckMenuItem::with_id(app, "autostart", "开机时启动", true, autostart_enabled, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuilds the tray menu after a server window opens or is renamed.
pub fn refresh_tray(app: &AppHandle) {
    set_tray_menu(app, None);
}

/// Rebuilds the tray menu as `label` is destroyed, which may still be listed.
pub fn refresh_tray_without(app: &AppHandle, label: &str) {
    set_tray_menu(app, Some(label));
}

fn set_tray_menu(app: &AppHandle, closing: Option<&str>) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(app, closing)) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Raft")
        .menu(&tray_menu(app, None)?)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = main_window(app) {
                    show_window(&w);
                }
            }
            "reload" => {
                for w in server_window::all(app) {
                    load_remote(app.clone(), w);
                }
            }
            "fonts" => {
                let _ = font::open_settings(app);
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let enabled = launcher.is_enabled().unwrap_or(false);
                let _ = if enabled { launcher.disable() } else { launcher.enable() };
                refresh_tray(app);
            }
            "quit" => app.exit(0),
            id => {
                if let Some(label) = id.strip_prefix(WINDOW_ITEM_PREFIX) {
                    if let Some(w) = app.get_webview_window(label) {
                        show_window(&w);
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if let Some(w) = main_window(tray.app_handle()) {
                    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        show_window(&w);
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Message IDs already notified. Every server window has its own socket, and
/// some messages (thread replies you follow) reach all of them.
static NOTIFIED: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// True the first time `id` is seen across all windows.
fn first_notification(id: &str) -> bool {
    let mut seen = NOTIFIED.lock().unwrap();
    if seen.iter().any(|s| s == id) {
        return false;
    }
    if seen.len() >= 500 {
        seen.pop_front();
    }
    seen.push_back(id.chars().take(64).collect());
    true
}

#[tauri::command]
pub fn shell_notify(app: AppHandle, window: WebviewWindow, title: String, body: String, id: Option<String>) {
    if let Some(id) = id {
        if !first_notification(&id) {
            return;
        }
    }
    let title: String = title.chars().take(160).collect();
    let body: String = body.chars().take(512).collect();
    let _ = app.notification().builder().title(title).body(body).show();
    if !window.is_focused().unwrap_or(false) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_policy() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(is_raft(&u("https://app.raft.build/s/acme/channel/1")));
        assert!(!is_raft(&u("http://app.raft.build/")));
        assert!(is_auth(&u("https://accounts.google.com/o/oauth2/v2/auth")));
        assert!(is_auth(&u("https://github.com/login/oauth/authorize")));
        assert!(!is_auth(&u("https://github.com/botiverse/raft-source")));
        assert!(is_local(&u("http://tauri.localhost/recovery.html")));
        assert!(!is_local(&u("https://example.com/")));
    }

    #[test]
    fn server_windows_start_on_their_server() {
        assert_eq!(start_url(None).as_str(), "https://app.raft.build/");
        assert_eq!(
            start_url(Some("123e4567-e89b-12d3-a456-426614174000")).as_str(),
            "https://app.raft.build/?raftDesktopServerId=123e4567-e89b-12d3-a456-426614174000"
        );
        assert_eq!(tray_window_name("general · Acme | Raft"), "general · Acme");
        assert_eq!(tray_window_name("R&D | Raft"), "R&&D");
        assert_eq!(tray_window_name("Raft"), "Raft");
    }

    #[test]
    fn notifications_are_deduplicated_across_windows() {
        assert!(first_notification("dedupe-test-1"));
        assert!(!first_notification("dedupe-test-1"));
        assert!(first_notification("dedupe-test-2"));
    }

    #[test]
    fn sign_in_flow_keeps_provider_hops_in_window() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(!allow_navigation(&u("https://example.com/")));
        assert!(allow_navigation(&u("https://api.raft.build/api/auth/google/start?returnTo=%2F")));
        assert!(allow_navigation(&u("https://accounts.google.com.hk/ServiceLogin")));
        assert!(allow_navigation(&u("https://accounts.youtube.com/accounts/SetSID")));
        assert!(allow_navigation(&u("https://github.com/sessions/two-factor")));
        assert!(!allow_navigation(&u("https://evil-google.com/")));
        assert!(!allow_navigation(&u("https://example.com/")));
        assert!(!allow_navigation(&u("http://accounts.google.com/")));
        assert!(allow_navigation(&u("https://app.raft.build/auth/callback?code=x")));
        assert!(!allow_navigation(&u("https://example.com/")));
    }
}
