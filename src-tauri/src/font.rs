//! Global font: the user picks one installed font family, and Pontoon uses it
//! for all of Raft's text except code, which stays monospace.
//!
//! The choice lives in settings.json in the app's config folder. font.js
//! applies it at document start from localStorage, and the native side
//! re-sends it after every Raft page load so the two never drift apart.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::shell;

pub const SETTINGS_WINDOW: &str = "settings";
/// `pontoon.exe --font-settings` opens the font settings window.
pub const SETTINGS_ARG: &str = "--font-settings";
const SETTINGS_FILE: &str = "settings.json";

#[derive(Default)]
pub struct FontState(Mutex<Option<String>>);

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(rename = "fontFamily", default, skip_serializing_if = "Option::is_none")]
    font_family: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstalledFont {
    /// The name to put in CSS (the English family name when the font has one).
    pub family: String,
    /// The name to show, in the system language when the font has one.
    pub display: String,
}

/// Font family names go into CSS, so only plain names are accepted: letters
/// and digits in any script, spaces and `- _ . & +`.
pub fn is_valid_font_family(name: &str) -> bool {
    let n = name.chars().count();
    (1..=64).contains(&n)
        && name.trim() == name
        && name.chars().all(|c| c.is_alphanumeric() || " -_.&+".contains(c))
}

/// The call that hands the current choice to font.js in a page.
pub fn apply_script(family: Option<&str>) -> String {
    format!(
        "window.__pontoonSetFont && window.__pontoonSetFont({});",
        serde_json::to_string(&family).unwrap()
    )
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETTINGS_FILE))
}

/// Reads the saved choice into state at startup.
pub fn load(app: &AppHandle) {
    let saved = settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .and_then(|s| s.font_family)
        .filter(|f| is_valid_font_family(f));
    *app.state::<FontState>().0.lock().unwrap() = saved;
}

pub fn current(app: &AppHandle) -> Option<String> {
    app.state::<FontState>().0.lock().unwrap().clone()
}

/// Sends the current choice to a server window's page.
pub fn sync_window(window: &WebviewWindow) {
    let _ = window.eval(apply_script(current(window.app_handle()).as_deref()));
}

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS_WINDOW) {
        shell::show_window(&w);
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("settings.html".into()))
        .title("字体设置 · Pontoon")
        .inner_size(460.0, 600.0)
        .min_inner_size(380.0, 420.0)
        .build()?;
    shell::show_window(&w);
    Ok(())
}

#[tauri::command]
pub fn font_get(app: AppHandle) -> Option<String> {
    current(&app)
}

/// Saves the choice (`None` means Raft's own fonts) and applies it right away.
#[tauri::command]
pub fn font_set(app: AppHandle, family: Option<String>) -> Result<(), String> {
    if let Some(f) = &family {
        if !is_valid_font_family(f) {
            return Err("invalid font family name".into());
        }
    }
    let path = settings_path(&app).ok_or("no config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&Settings { font_family: family.clone() }).unwrap();
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    *app.state::<FontState>().0.lock().unwrap() = family;
    for w in crate::server_window::all(&app) {
        sync_window(&w);
    }
    Ok(())
}

#[tauri::command]
pub fn font_list() -> Vec<InstalledFont> {
    let mut fonts = system_fonts();
    fonts.retain(|f| is_valid_font_family(&f.family));
    fonts.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
    fonts.dedup_by(|a, b| a.family == b.family);
    fonts
}

#[cfg(windows)]
fn system_fonts() -> Vec<InstalledFont> {
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    use windows::Win32::Graphics::DirectWrite::*;

    fn name_at(names: &IDWriteLocalizedStrings, index: u32) -> Option<String> {
        unsafe {
            let len = names.GetStringLength(index).ok()?;
            let mut buf = vec![0u16; len as usize + 1];
            names.GetString(index, &mut buf).ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }
    fn find(names: &IDWriteLocalizedStrings, locale: PCWSTR) -> Option<u32> {
        let (mut index, mut exists) = (0u32, BOOL(0));
        unsafe { names.FindLocaleName(locale, &mut index, &mut exists).ok()? };
        exists.as_bool().then_some(index)
    }

    let mut out = Vec::new();
    unsafe {
        let Ok(factory) = DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) else { return out };
        let mut collection = None;
        if factory.GetSystemFontCollection(&mut collection, false).is_err() {
            return out;
        }
        let Some(collection) = collection else { return out };
        let mut locale = [0u16; 85];
        let user_locale = (GetUserDefaultLocaleName(&mut locale) > 0).then(|| PCWSTR(locale.as_ptr()));
        for i in 0..collection.GetFontFamilyCount() {
            let Ok(family) = collection.GetFontFamily(i) else { continue };
            let Ok(names) = family.GetFamilyNames() else { continue };
            let english = find(&names, w!("en-us")).unwrap_or(0);
            let shown = user_locale.and_then(|l| find(&names, l)).unwrap_or(english);
            if let (Some(family), Some(display)) = (name_at(&names, english), name_at(&names, shown)) {
                out.push(InstalledFont { family, display });
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn system_fonts() -> Vec<InstalledFont> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_names_are_checked_before_reaching_css() {
        assert!(is_valid_font_family("Microsoft YaHei"));
        assert!(is_valid_font_family("微软雅黑"));
        assert!(is_valid_font_family("Source Han Sans SC"));
        assert!(is_valid_font_family("HarmonyOS_Sans_SC"));
        assert!(!is_valid_font_family(""));
        assert!(!is_valid_font_family(" Arial"));
        assert!(!is_valid_font_family("Arial\"; } body { display:none"));
        assert!(!is_valid_font_family("a\\62 c"));
        assert!(!is_valid_font_family("x</style>"));
        assert!(!is_valid_font_family(&"a".repeat(65)));
    }

    #[test]
    fn apply_script_passes_json() {
        assert_eq!(apply_script(Some("微软雅黑")), "window.__pontoonSetFont && window.__pontoonSetFont(\"微软雅黑\");");
        assert_eq!(apply_script(None), "window.__pontoonSetFont && window.__pontoonSetFont(null);");
    }
}
