//! Font settings: the user picks installed font families for three parts of
//! Raft: the interface, chat messages and code. Each part has a Latin font
//! and a Chinese (CJK) font, so English and Chinese text can use different
//! families. Each one left unset keeps Raft's own font; the chat fonts follow
//! the interface fonts when unset, and Chinese in code follows the chat's
//! Chinese font.
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

/// The chosen family for each part; `None` keeps Raft's own font. `ui`,
/// `chat` and `code` come first in the font list, so they draw Latin text
/// (and everything else they cover); the `*_cjk` fonts draw the Chinese text
/// the first ones have no glyphs for. Settings from before 0.6 have only the
/// first three, which keeps them looking the same.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fonts {
    #[serde(default)]
    pub ui: Option<String>,
    #[serde(default)]
    pub chat: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub ui_cjk: Option<String>,
    #[serde(default)]
    pub chat_cjk: Option<String>,
    #[serde(default)]
    pub code_cjk: Option<String>,
}

impl Fonts {
    fn is_valid(&self) -> bool {
        [&self.ui, &self.chat, &self.code, &self.ui_cjk, &self.chat_cjk, &self.code_cjk]
            .iter()
            .all(|f| f.as_deref().map_or(true, is_valid_font_family))
    }
}

#[derive(Default)]
pub struct FontState(Mutex<Fonts>);

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fonts: Option<Fonts>,
    /// The single font of version 0.2, read as the interface font.
    #[serde(rename = "fontFamily", default, skip_serializing)]
    legacy_font_family: Option<String>,
}

impl Settings {
    fn fonts(self) -> Fonts {
        self.fonts.unwrap_or(Fonts { ui: self.legacy_font_family, ..Fonts::default() })
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstalledFont {
    /// The name to put in CSS (the English family name when the font has one).
    pub family: String,
    /// The name to show, in the system language when the font has one.
    pub display: String,
    /// Every character has the same width, which suits code.
    pub mono: bool,
    /// Has Chinese characters, so it can be the Chinese font.
    pub cjk: bool,
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
pub fn apply_script(fonts: &Fonts) -> String {
    format!(
        "window.__pontoonSetFont && window.__pontoonSetFont({});",
        serde_json::to_string(fonts).unwrap()
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
        .map(Settings::fonts)
        .filter(Fonts::is_valid)
        .unwrap_or_default();
    *app.state::<FontState>().0.lock().unwrap() = saved;
}

pub fn current(app: &AppHandle) -> Fonts {
    app.state::<FontState>().0.lock().unwrap().clone()
}

/// Sends the current choice to a server window's page.
pub fn sync_window(window: &WebviewWindow) {
    let _ = window.eval(apply_script(&current(window.app_handle())));
}

/// Opens the settings window from event handlers (the tray menu, a second
/// launch). Those run on the main thread, and creating a webview there
/// deadlocks on Windows (see WebviewWindowBuilder::new), so it is done from
/// another thread.
pub fn open_settings_from_handler(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = open_settings(&app);
    });
}

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(SETTINGS_WINDOW) {
        shell::show_window(&w);
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("settings.html".into()))
        .title("字体设置 · Pontoon")
        .inner_size(480.0, 680.0)
        .min_inner_size(400.0, 480.0)
        .build()?;
    shell::show_window(&w);
    Ok(())
}

#[tauri::command]
pub fn font_get(app: AppHandle) -> Fonts {
    current(&app)
}

/// Saves the choice and applies it right away.
#[tauri::command]
pub fn font_set(app: AppHandle, fonts: Fonts) -> Result<(), String> {
    if !fonts.is_valid() {
        return Err("invalid font family name".into());
    }
    let path = settings_path(&app).ok_or("no config folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&Settings { fonts: Some(fonts.clone()), legacy_font_family: None }).unwrap();
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    *app.state::<FontState>().0.lock().unwrap() = fonts;
    for w in crate::server_window::all(&app) {
        sync_window(&w);
    }
    Ok(())
}

/// Async so the font scan (which opens every font file to check whether it
/// is monospace) runs off the main thread instead of freezing the windows.
#[tauri::command]
pub async fn font_list() -> Vec<InstalledFont> {
    let mut fonts = system_fonts();
    fonts.retain(|f| is_valid_font_family(&f.family));
    fonts.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
    fonts.dedup_by(|a, b| a.family == b.family);
    fonts
}

#[cfg(windows)]
fn system_fonts() -> Vec<InstalledFont> {
    use windows::core::{w, Interface, BOOL, PCWSTR};
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
            let font =
                family.GetFirstMatchingFont(DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL);
            let mono = font
                .as_ref()
                .ok()
                .and_then(|f| f.cast::<IDWriteFont1>().ok())
                .is_some_and(|f| f.IsMonospacedFont().as_bool());
            // 中 and 文: a font with both is taken to cover Chinese.
            let cjk = font.as_ref().is_ok_and(|f| {
                [0x4E2D, 0x6587].iter().all(|&c| f.HasCharacter(c).is_ok_and(|has| has.as_bool()))
            });
            if let (Some(family), Some(display)) = (name_at(&names, english), name_at(&names, shown)) {
                out.push(InstalledFont { family, display, mono, cjk });
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
        let fonts = Fonts {
            ui: Some("Segoe UI".into()),
            code: Some("Consolas".into()),
            ui_cjk: Some("微软雅黑".into()),
            ..Fonts::default()
        };
        assert_eq!(
            apply_script(&fonts),
            "window.__pontoonSetFont && window.__pontoonSetFont({\"ui\":\"Segoe UI\",\"chat\":null,\"code\":\"Consolas\",\
             \"uiCjk\":\"微软雅黑\",\"chatCjk\":null,\"codeCjk\":null});"
        );
    }

    #[test]
    fn every_font_is_checked() {
        assert!(Fonts::default().is_valid());
        assert!(!Fonts { code: Some("x\"}".into()), ..Fonts::default() }.is_valid());
        assert!(!Fonts { chat: Some(" a".into()), ..Fonts::default() }.is_valid());
        assert!(!Fonts { chat_cjk: Some("a</style>".into()), ..Fonts::default() }.is_valid());
    }

    #[test]
    fn version_0_2_setting_becomes_the_interface_font() {
        let old: Settings = serde_json::from_str(r#"{"fontFamily":"KaiTi"}"#).unwrap();
        assert_eq!(old.fonts(), Fonts { ui: Some("KaiTi".into()), ..Fonts::default() });
        let new: Settings = serde_json::from_str(r#"{"fonts":{"ui":null,"chat":"SimSun","code":"Consolas"}}"#).unwrap();
        assert_eq!(new.fonts(), Fonts { chat: Some("SimSun".into()), code: Some("Consolas".into()), ..Fonts::default() });
        let cjk: Settings = serde_json::from_str(r#"{"fonts":{"ui":"Segoe UI","codeCjk":"Sarasa Mono SC"}}"#).unwrap();
        assert_eq!(
            cjk.fonts(),
            Fonts { ui: Some("Segoe UI".into()), code_cjk: Some("Sarasa Mono SC".into()), ..Fonts::default() }
        );
        let saved = serde_json::to_string(&Settings { fonts: Some(Fonts::default()), legacy_font_family: Some("x".into()) }).unwrap();
        assert!(!saved.contains("fontFamily"), "{saved}");
    }
}
