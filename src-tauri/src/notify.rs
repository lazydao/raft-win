//! New-message notifications: Windows toasts, the unread mark on each
//! window's taskbar button, and the tray icon and tooltip.
//!
//! notify.js reports messages from two sources. The main window keeps a
//! socket that receives Raft's own `notification:push` events, the server's
//! decision of who to notify (DMs, channels you are in, threads you follow,
//! minus what you muted). While that socket is down, every window also reports
//! DMs and @mentions from its page's own socket (`fallback`).
//!
//! A message for a window you are looking at changes nothing. Otherwise the
//! window gets an unread count on its taskbar button and flashes, the tray
//! icon gets a dot, and a toast is shown unless toasts are turned off in the
//! tray menu. Focusing the window clears its count.

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType, WebviewWindow};

use crate::contract::{is_canonical_uuid, FRONTEND_ORIGIN};
use crate::{server_window, shell};

const SETTINGS_FILE: &str = "notifications.json";
/// How long the push socket counts as live after its last sign of life. The
/// server pings every 25 seconds.
const PUSH_LIVE_FOR: Duration = Duration::from_secs(70);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Settings {
    /// Show a Windows notification for new messages.
    #[serde(default = "yes")]
    toasts: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings { toasts: true }
    }
}

#[derive(Default)]
pub struct NotifyState {
    settings: Mutex<Settings>,
    /// New messages per server window since it was last focused.
    unread: Mutex<HashMap<String, u32>>,
    /// When the main window's push socket last showed it is connected.
    push_alive: Mutex<Option<Instant>>,
}

/// Message IDs already handled. A message can arrive from the push socket and
/// from several windows' own sockets.
static SEEN: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

/// True the first time `id` is seen.
fn first_sighting(id: &str) -> bool {
    let id: String = id.chars().take(64).collect();
    let mut seen = SEEN.lock().unwrap();
    if seen.contains(&id) {
        return false;
    }
    if seen.len() >= 500 {
        seen.pop_front();
    }
    seen.push_back(id);
    true
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

/// Reads the saved settings at startup and makes sure Windows will show
/// Pontoon's toasts.
pub fn load(app: &AppHandle) {
    let saved = settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default();
    *app.state::<NotifyState>().settings.lock().unwrap() = saved;
    #[cfg(windows)]
    if let Err(e) = toast::register_app_id(app) {
        log(app, &format!("register-app-id-failed {e}"));
    }
}

pub fn toasts_enabled(app: &AppHandle) -> bool {
    app.state::<NotifyState>().settings.lock().unwrap().toasts
}

/// The tray menu's "消息通知" switch.
pub fn toggle_toasts(app: &AppHandle) {
    let settings = {
        let state = app.state::<NotifyState>();
        let mut s = state.settings.lock().unwrap();
        s.toasts = !s.toasts;
        *s
    };
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::to_vec_pretty(&settings).unwrap());
    }
    shell::refresh_tray(app);
}

/// Appends one line to notifications.log in the app's log folder, so a
/// missing notification can be traced on the user's machine. Never logs
/// message content.
fn log(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("notifications.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512 * 1024) {
        let _ = std::fs::rename(&path, dir.join("notifications.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default();
        let _ = writeln!(f, "{secs} {line}");
    }
}

fn push_live(app: &AppHandle) -> bool {
    matches!(*app.state::<NotifyState>().push_alive.lock().unwrap(), Some(t) if t.elapsed() < PUSH_LIVE_FOR)
}

/// notify.js in the main window reports its push socket: `live` when it
/// connects and on every server ping, not `live` when it drops.
#[tauri::command]
pub fn notify_push_state(app: AppHandle, window: WebviewWindow, live: bool) {
    if window.label() != shell::MAIN_WINDOW {
        return;
    }
    let was_live = {
        let state = app.state::<NotifyState>();
        let mut alive = state.push_alive.lock().unwrap();
        let was_live = matches!(*alive, Some(t) if t.elapsed() < PUSH_LIVE_FOR);
        *alive = live.then(Instant::now);
        was_live
    };
    if was_live != live {
        log(&app, if live { "push-socket connected" } else { "push-socket down" });
    }
}

/// A Raft link a notification may open: only app.raft.build pages.
fn is_app_url(url: &str) -> bool {
    url.starts_with(&format!("{FRONTEND_ORIGIN}/")) && url.len() <= 2048
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max - 1).chain(std::iter::once('…')).collect()
    }
}

/// The window a message belongs to: the one showing its server, else the
/// main window. `fallback` reports come from the window itself.
fn target_window(app: &AppHandle, caller: &WebviewWindow, server_id: Option<&str>) -> Option<WebviewWindow> {
    match server_id {
        Some(id) => server_window::find_bound(app, id).or_else(|| shell::main_window(app)),
        None => Some(caller.clone()),
    }
}

/// True when the user is looking at `window`, so its own page already shows
/// the message. For a message routed by server, the window must also be
/// showing that server.
fn is_watching(app: &AppHandle, window: &WebviewWindow, server_id: Option<&str>) -> bool {
    let focused = window.is_focused().unwrap_or(false)
        && window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false);
    focused && server_id.map_or(true, |id| server_window::find_bound(app, id).is_some_and(|w| w.label() == window.label()))
}

#[derive(Debug, PartialEq)]
enum Verdict {
    /// The push socket is live and reports this message itself.
    FallbackNotNeeded,
    Duplicate,
    Watching,
    Notify,
}

fn verdict(fallback: bool, push_live: bool, first: impl FnOnce() -> bool, watching: impl FnOnce() -> bool) -> Verdict {
    if fallback && push_live {
        Verdict::FallbackNotNeeded
    } else if !first() {
        Verdict::Duplicate
    } else if watching() {
        Verdict::Watching
    } else {
        Verdict::Notify
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn shell_notify(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    body: String,
    id: Option<String>,
    server_id: Option<String>,
    url: Option<String>,
    attribution: Option<String>,
    fallback: Option<bool>,
) {
    let fallback = fallback.unwrap_or(false);
    let server_id = server_id.filter(|s| is_canonical_uuid(s));
    let url = url.filter(|u| is_app_url(u));
    let source = if fallback { "fallback" } else { "push" };
    let Some(target) = target_window(&app, &window, server_id.as_deref()) else { return };
    let v = verdict(
        fallback,
        push_live(&app),
        || id.as_deref().map_or(true, first_sighting),
        || is_watching(&app, &target, server_id.as_deref()),
    );
    if v != Verdict::Notify {
        log(&app, &format!("{source} skipped {v:?}"));
        return;
    }

    // A focused window showing another server only gets the toast: a count
    // on it would stay until the window is focused again.
    if !target.is_focused().unwrap_or(false) {
        add_unread(&app, target.label());
        let _ = target.request_user_attention(Some(UserAttentionType::Informational));
    }

    if !toasts_enabled(&app) {
        log(&app, &format!("{source} badge-only (toasts off)"));
        return;
    }
    let title = truncate(&title, 120);
    let body = truncate(&body, 300);
    let attribution = attribution.map(|a| truncate(&a, 80)).filter(|a| !a.is_empty());
    #[cfg(windows)]
    {
        let result = toast::show(&app, &title, &body, attribution.as_deref(), target.label().to_string(), url);
        match result {
            Ok(setting) => log(&app, &format!("{source} shown windows-setting={setting}")),
            Err(e) => log(&app, &format!("{source} toast-failed {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body, attribution, url);
        log(&app, &format!("{source} no-toast-on-this-os"));
    }
}

/// Brings up the window a toast was about and opens the message in it,
/// without reloading the page when it is already on Raft.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn open_from_notification(app: &AppHandle, label: &str, url: Option<&str>) {
    let Some(window) = app.get_webview_window(label).or_else(|| shell::main_window(app)) else { return };
    shell::show_window(&window);
    if let Some(url) = url.filter(|u| is_app_url(u)) {
        let _ = window.eval(open_script(url));
    }
}

/// Moves the web client to `url` through its router (React Router follows
/// popstate), or loads it when the page is elsewhere.
fn open_script(url: &str) -> String {
    format!(
        r#"(function (u) {{
  try {{
    var t = new URL(u);
    if (location.origin === t.origin) {{
      history.pushState(null, "", t.pathname + t.search + t.hash);
      dispatchEvent(new PopStateEvent("popstate", {{ state: null }}));
      return;
    }}
  }} catch (e) {{}}
  location.href = u;
}})({});"#,
        serde_json::to_string(url).unwrap()
    )
}

fn add_unread(app: &AppHandle, label: &str) {
    let count = {
        let state = app.state::<NotifyState>();
        let mut unread = state.unread.lock().unwrap();
        let n = unread.entry(label.to_string()).or_insert(0);
        *n = n.saturating_add(1);
        *n
    };
    if let Some(w) = app.get_webview_window(label) {
        set_window_badge(&w, count);
    }
    refresh_tray_badge(app);
}

/// The window was focused (or closed): its messages count as seen.
pub fn clear_unread(app: &AppHandle, label: &str) {
    let had = app.state::<NotifyState>().unread.lock().unwrap().remove(label).is_some();
    if had {
        if let Some(w) = app.get_webview_window(label) {
            set_window_badge(&w, 0);
        }
        refresh_tray_badge(app);
    }
}

/// New messages across all windows.
pub fn total_unread(app: &AppHandle) -> u32 {
    app.state::<NotifyState>().unread.lock().unwrap().values().sum()
}

fn set_window_badge(window: &WebviewWindow, count: u32) {
    #[cfg(windows)]
    {
        let icon = (count > 0).then(|| {
            let (rgba, size) = count_badge(count);
            Image::new_owned(rgba, size, size)
        });
        let result = window.set_overlay_icon(icon);
        let app = window.app_handle();
        match result {
            Ok(()) => log(app, &format!("badge {count}")),
            Err(e) => log(app, &format!("badge {count} failed {e}")),
        }
    }
    #[cfg(not(windows))]
    let _ = (window, count);
}

fn refresh_tray_badge(app: &AppHandle) {
    let total = total_unread(app);
    if let Some(tray) = app.tray_by_id(shell::TRAY_ID) {
        if let Some(icon) = app.default_window_icon() {
            let icon = if total > 0 {
                let mut rgba = icon.rgba().to_vec();
                draw_dot(&mut rgba, icon.width(), icon.height());
                Image::new_owned(rgba, icon.width(), icon.height())
            } else {
                icon.clone().to_owned()
            };
            let _ = tray.set_icon(Some(icon));
        }
    }
    shell::refresh_tray_tooltip(app);
}

const BADGE_RED: [u8; 3] = [0xE5, 0x39, 0x35];

/// 3x5 pixel glyphs for the digits and "+", one row per byte (high bit left).
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b001, 0b001],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        _ => [0b000, 0b010, 0b111, 0b010, 0b000],
    }
}

/// Coverage of pixel (x, y) by a circle, for smooth edges.
fn circle_coverage(x: u32, y: u32, cx: f32, cy: f32, r: f32) -> f32 {
    let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
    (r - d + 0.5).clamp(0.0, 1.0)
}

fn blend(rgba: &mut [u8], i: usize, color: [u8; 3], alpha: f32) {
    if alpha <= 0.0 {
        return;
    }
    let a0 = rgba[i + 3] as f32 / 255.0;
    let a = alpha + a0 * (1.0 - alpha);
    for c in 0..3 {
        let v = (color[c] as f32 * alpha + rgba[i + c] as f32 * a0 * (1.0 - alpha)) / a.max(f32::EPSILON);
        rgba[i + c] = v.round() as u8;
    }
    rgba[i + 3] = (a * 255.0).round() as u8;
}

/// The taskbar overlay: a red disc with the count, "9+" above nine.
fn count_badge(count: u32) -> (Vec<u8>, u32) {
    const S: u32 = 32;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    for y in 0..S {
        for x in 0..S {
            let cov = circle_coverage(x, y, 16.0, 16.0, 15.5);
            blend(&mut rgba, ((y * S + x) * 4) as usize, BADGE_RED, cov);
        }
    }
    let text = if count > 9 { "9+".to_string() } else { count.to_string() };
    let scale: u32 = if text.len() == 1 { 4 } else { 3 };
    let gap = scale - 1;
    let width = text.len() as u32 * 3 * scale + (text.len() as u32 - 1) * gap;
    let (x0, y0) = ((S - width) / 2, (S - 5 * scale) / 2);
    for (n, c) in text.chars().enumerate() {
        let gx = x0 + n as u32 * (3 * scale + gap);
        for (row, bits) in glyph(c).iter().enumerate() {
            for col in 0..3u32 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (x, y) = (gx + col * scale + dx, y0 + row as u32 * scale + dy);
                        blend(&mut rgba, ((y * S + x) * 4) as usize, [255, 255, 255], 1.0);
                    }
                }
            }
        }
    }
    (rgba, S)
}

/// Puts a red dot with a white rim in the top-right corner of an icon.
fn draw_dot(rgba: &mut [u8], w: u32, h: u32) {
    let r = (w.min(h) as f32 * 0.22).max(3.0);
    let rim = (r * 0.25).max(1.0);
    let (cx, cy) = (w as f32 - r - rim, r + rim);
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            blend(rgba, i, [255, 255, 255], circle_coverage(x, y, cx, cy, r + rim));
            blend(rgba, i, BADGE_RED, circle_coverage(x, y, cx, cy, r));
        }
    }
}

#[cfg(windows)]
mod toast {
    use tauri::{AppHandle, Manager};
    use tauri_winrt_notification::Toast;

    /// Toasts from an app outside the Store need its AppUserModelID known to
    /// Windows. The installer's Start menu shortcut carries it, but that
    /// shortcut can be missing (moved, deleted, a portable copy), so the ID is
    /// also registered with a display name and icon, as unpackaged apps do.
    pub fn register_app_id(app: &AppHandle) -> Result<(), String> {
        let id = &app.config().identifier;
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let icon = dir.join("notification-icon.png");
        let bytes: &[u8] = include_bytes!("../icons/128x128.png");
        if std::fs::read(&icon).ok().as_deref() != Some(bytes) {
            std::fs::write(&icon, bytes).map_err(|e| e.to_string())?;
        }
        let key = windows_registry::CURRENT_USER
            .create(format!(r"Software\Classes\AppUserModelId\{id}"))
            .map_err(|e| e.to_string())?;
        key.set_string("DisplayName", &app.package_info().name).map_err(|e| e.to_string())?;
        key.set_string("IconUri", icon.to_string_lossy().as_ref()).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Shows the toast; returns whether Windows lets Pontoon show toasts at
    /// all (Enabled, DisabledForApplication, DisabledForUser, ...), for the log.
    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        attribution: Option<&str>,
        label: String,
        url: Option<String>,
    ) -> Result<String, String> {
        let id = app.config().identifier.clone();
        let handle = app.clone();
        let mut toast = Toast::new(&id).title(title).text1(body);
        if let Some(a) = attribution {
            toast = toast.text2(a);
        }
        toast
            .on_activated(move |_| {
                // Called on a Windows thread pool thread.
                let (app, label, url) = (handle.clone(), label.clone(), url.clone());
                let _ = handle.run_on_main_thread(move || super::open_from_notification(&app, &label, url.as_deref()));
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())?;
        Ok(setting(&id))
    }

    fn setting(id: &str) -> String {
        use windows::UI::Notifications::ToastNotificationManager;
        ToastNotificationManager::CreateToastNotifierWithId(&windows::core::HSTRING::from(id))
            .and_then(|n| n.Setting())
            .map(|s| match s.0 {
                0 => "Enabled".to_string(),
                1 => "DisabledForApplication".to_string(),
                2 => "DisabledForUser".to_string(),
                3 => "DisabledByGroupPolicy".to_string(),
                4 => "DisabledByManifest".to_string(),
                n => n.to_string(),
            })
            .unwrap_or_else(|e| format!("unknown({e})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_and_fallbacks() {
        assert!(first_sighting("notify-test-1"));
        assert!(!first_sighting("notify-test-1"));
        assert!(first_sighting("notify-test-2"));

        let t = || true;
        let f = || false;
        assert_eq!(verdict(false, true, t, f), Verdict::Notify);
        assert_eq!(verdict(false, false, t, f), Verdict::Notify);
        // Page-socket reports only count while the push socket is down.
        assert_eq!(verdict(true, true, t, f), Verdict::FallbackNotNeeded);
        assert_eq!(verdict(true, false, t, f), Verdict::Notify);
        assert_eq!(verdict(false, true, f, f), Verdict::Duplicate);
        assert_eq!(verdict(false, true, t, t), Verdict::Watching);
    }

    #[test]
    fn notification_links_stay_on_raft() {
        assert!(is_app_url("https://app.raft.build/s/acme/dm/1?msg=2"));
        assert!(!is_app_url("https://app.raft.build.evil.com/"));
        assert!(!is_app_url("javascript:alert(1)"));
        assert!(!is_app_url("http://app.raft.build/s/acme"));
        let s = open_script("https://app.raft.build/s/a/channel/1?msg=\"x\"");
        assert!(s.contains(r#"("https://app.raft.build/s/a/channel/1?msg=\"x\"")"#));
    }

    #[test]
    fn long_text_is_cut() {
        assert_eq!(truncate("  hi  ", 5), "hi");
        assert_eq!(truncate(&"长".repeat(10), 5), "长长长长…");
    }

    #[test]
    fn settings_default_to_toasts_on() {
        assert_eq!(serde_json::from_str::<Settings>("{}").unwrap(), Settings { toasts: true });
        assert_eq!(serde_json::from_str::<Settings>(r#"{"toasts":false}"#).unwrap(), Settings { toasts: false });
    }

    fn pixel(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * w + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn badges() {
        let (one, s) = count_badge(1);
        assert_eq!(one.len(), (s * s * 4) as usize);
        assert_eq!(pixel(&one, s, 0, 0)[3], 0, "corners stay transparent");
        assert_eq!(pixel(&one, s, 16, 4), [0xE5, 0x39, 0x35, 255], "red disc");
        assert_eq!(pixel(&one, s, 16, 14), [255, 255, 255, 255], "white digit");
        let (many, _) = count_badge(42);
        assert_ne!(many, count_badge(9).0);
        assert_eq!(many, count_badge(100).0, "everything above nine reads 9+");

        let (w, h) = (32, 32);
        let mut icon = vec![0u8; (w * h * 4) as usize];
        draw_dot(&mut icon, w, h);
        assert_eq!(pixel(&icon, w, 0, h - 1)[3], 0, "the rest of the icon is untouched");
        let r = 32.0f32 * 0.22;
        let rim = r * 0.25;
        let (cx, cy) = ((32.0 - r - rim) as u32, (r + rim) as u32);
        assert_eq!(pixel(&icon, w, cx, cy), [0xE5, 0x39, 0x35, 255]);
    }
}
