//! Window, tray, navigation policy and notifications.

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
            Url::parse(&format!("{FRONTEND_ORIGIN}/")).unwrap()
        } else {
            local_url("recovery.html")
        };
        let _ = window.navigate(target);
        let _ = app;
    });
}

pub fn create_main_window(app: &AppHandle, start_hidden: bool) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let popup_app = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
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

    if !start_hidden {
        show_window(&window);
    }
    load_remote(app.clone(), window.clone());
    Ok(window)
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 Raft", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?;
    let fonts = MenuItem::with_id(app, "fonts", "字体设置…", true, None::<&str>)?;
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "开机时启动", true, autostart_enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &reload, &fonts, &autostart, &separator, &quit])?;

    let autostart_item = autostart.clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Raft")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = main_window(app) {
                    show_window(&w);
                }
            }
            "reload" => {
                if let Some(w) = main_window(app) {
                    load_remote(app.clone(), w);
                }
            }
            "fonts" => {
                font::open_settings_from_handler(app);
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let enabled = launcher.is_enabled().unwrap_or(false);
                let _ = if enabled { launcher.disable() } else { launcher.enable() };
                let _ = autostart_item.set_checked(launcher.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
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

#[tauri::command]
pub fn shell_notify(app: AppHandle, window: WebviewWindow, title: String, body: String) {
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
