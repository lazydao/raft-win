//! Window, tray and navigation policy.

use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;

use crate::contract::{self, FRONTEND_ORIGIN};
use crate::font;
use crate::notify;
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

/// Hands a link to the default browser (or mail app) and records the outcome
/// in navigation.log.
fn open_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        log_navigation(app, "dropped", url);
        return;
    }
    match app.opener().open_url(url.as_str(), None::<&str>) {
        Ok(()) => log_navigation(app, "browser", url),
        Err(e) => log_navigation(app, &format!("browser-failed[{e}]"), url),
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

/// Where a window loads Raft: its own server when it has one
/// (`raftDesktopServerId`, which server_start.js turns into that server's last
/// page), otherwise the web client's own choice.
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
        // The main window keeps the socket for Raft's own notification events.
        .initialization_script(format!("window.__PONTOON_NOTIFY_PRIMARY__ = {};", label == MAIN_WINDOW))
        .initialization_script(include_str!("notify.js"))
        .initialization_script(include_str!("font.js"))
        .initialization_script(include_str!("server_start.js"))
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
                log_navigation(&popup_app, "new-tab", &url);
                open_external(&popup_app, &url);
                NewWindowResponse::Deny
            }
        })
        .on_page_load(|window, payload| {
            if !is_raft(payload.url()) {
                return;
            }
            match payload.event() {
                PageLoadEvent::Started => contract::begin_document(&window),
                PageLoadEvent::Finished => {
                    contract::publish_document_identity(&window);
                    font::sync_window(&window);
                }
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

/// "Pontoon 0.4.1": the installed version, shown in the tray menu and tooltip.
fn version_label(version: &str) -> String {
    format!("Pontoon {version}")
}

/// The tray tooltip: how many new messages are waiting, if any, then the
/// main window's server title, if it has one, then the version. Windows cuts
/// tray tooltips at 127 characters, so a long title is shortened first and
/// the other lines always fit.
fn tooltip_text(version: &str, title: Option<&str>, unread: u32) -> String {
    let mut lines = Vec::new();
    if unread > 0 {
        lines.push(format!("{unread} 条新消息"));
    }
    let version = version_label(version);
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        let used: usize = lines.iter().map(|l: &String| l.chars().count() + 1).sum();
        let room = 127 - used - version.chars().count() - 1;
        let t: String = if t.chars().count() > room {
            t.chars().take(room - 1).chain(std::iter::once('…')).collect()
        } else {
            t.to_string()
        };
        lines.push(t);
    }
    lines.push(version);
    lines.join("\n")
}

/// The main window's server title, as the tooltip shows it.
static TRAY_TITLE: Mutex<Option<String>> = Mutex::new(None);

/// Updates the tray tooltip; `title` is the main window's server title.
pub fn set_tray_tooltip(app: &AppHandle, title: Option<&str>) {
    *TRAY_TITLE.lock().unwrap() = title.map(str::to_string);
    refresh_tray_tooltip(app);
}

/// Redraws the tray tooltip, after the title or the unread count changed.
pub fn refresh_tray_tooltip(app: &AppHandle) {
    let title = TRAY_TITLE.lock().unwrap().clone();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let text = tooltip_text(&app.package_info().version.to_string(), title.as_deref(), notify::total_unread(app));
        let _ = tray.set_tooltip(Some(text));
    }
}

fn tray_menu(app: &AppHandle, closing: Option<&str>) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    // Not clickable; it only tells you which version is installed.
    let version = version_label(&app.package_info().version.to_string());
    menu.append(&MenuItem::with_id(app, "version", version, false, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
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
    let all = notify::all_messages(app);
    let which = Submenu::with_id_and_items(
        app,
        "notify-scope",
        "提醒哪些消息",
        true,
        &[
            &CheckMenuItem::with_id(app, "notify-important", "只提醒私信和 @我", true, !all, None::<&str>)?,
            &CheckMenuItem::with_id(app, "notify-all", "所有新消息", true, all, None::<&str>)?,
        ],
    )?;
    menu.append(&which)?;
    menu.append(&CheckMenuItem::with_id(app, "notifications", "弹出 Windows 通知", true, notify::toasts_enabled(app), None::<&str>)?)?;
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
        .tooltip(tooltip_text(&app.package_info().version.to_string(), None, 0))
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
                font::open_settings_from_handler(app);
            }
            "notifications" => notify::toggle_toasts(app),
            "notify-important" => notify::set_all_messages(app, false),
            "notify-all" => notify::set_all_messages(app, true),
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
    fn version_shows_in_the_tray() {
        assert_eq!(version_label("0.4.1"), "Pontoon 0.4.1");
        assert_eq!(tooltip_text("0.4.1", None, 0), "Pontoon 0.4.1");
        assert_eq!(tooltip_text("0.4.1", Some("  "), 0), "Pontoon 0.4.1");
        assert_eq!(tooltip_text("0.4.1", Some("general · Acme | Raft"), 0), "general · Acme | Raft\nPontoon 0.4.1");
        assert_eq!(tooltip_text("0.4.1", None, 3), "3 条新消息\nPontoon 0.4.1");
        let unread = tooltip_text("0.4.1", Some(&"长".repeat(200)), 12);
        assert_eq!(unread.chars().count(), 127);
        assert!(unread.starts_with("12 条新消息\n长"));
        let long = tooltip_text("0.4.1", Some(&"长".repeat(200)), 0);
        assert_eq!(long.chars().count(), 127);
        assert!(long.ends_with("…\nPontoon 0.4.1"));
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
