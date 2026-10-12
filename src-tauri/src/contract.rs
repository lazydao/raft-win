//! Native side of Raft's public desktop contract (`@raft/desktop-contract` in
//! botiverse/raft-source). The app.raft.build web client detects a Tauri host,
//! waits for a per-document identity, then performs `desktop_handshake` and
//! keeps its window bound to the current server. Response envelopes must match
//! the contract's closed validators exactly, or the web client renders its
//! fail-closed recovery screen.

use std::collections::HashMap;
use std::sync::Mutex;

use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const FRONTEND_ORIGIN: &str = "https://app.raft.build";
pub const API_ORIGIN: &str = "https://api.raft.build";
pub const ENVIRONMENT_ID: &str = "production";
/// Bumping this makes the web client clear its localStorage (forces re-login).
pub const ENVIRONMENT_GENERATION: u64 = 1;
pub const PROTOCOL_VERSION: u64 = 1;

/// Per-window document identity issued after each top-level page load.
#[derive(Default, Clone)]
pub struct DocumentState {
    pub generation: u64,
    pub nonce: String,
    pub handshaken: bool,
    pub server_id: Option<String>,
}

#[derive(Default)]
pub struct ContractState {
    pub windows: Mutex<HashMap<String, DocumentState>>,
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Script injected at document start on app.raft.build. It exposes the runtime
/// environment the web client validates against its production preset and the
/// optional native-extension marker (frozen, non-writable, non-configurable).
pub fn environment_init_script() -> String {
    format!(
        r#"(function () {{
  if (window.location.origin !== {origin:?}) return;
  var env = Object.freeze({{
    environmentId: {env:?},
    generation: {gen},
    frontendOrigin: {origin:?},
    apiOrigin: {api:?},
    socketOrigin: {api:?},
    updateAuthority: "productionHands"
  }});
  Object.defineProperty(window, "__RAFT_DESKTOP_ENVIRONMENT__", {{ value: env, writable: false, configurable: false }});
  Object.defineProperty(window, "__RAFT_DESKTOP_NATIVE_EXTENSIONS__", {{
    value: Object.freeze({{ "window.setServerTitle": 1 }}),
    writable: false,
    configurable: false
  }});
}})();"#,
        origin = FRONTEND_ORIGIN,
        api = API_ORIGIN,
        env = ENVIRONMENT_ID,
        gen = ENVIRONMENT_GENERATION,
    )
}

/// Issue a fresh document identity for `window` and hand it to the page.
pub fn issue_document_identity(window: &WebviewWindow) {
    let state = window.state::<ContractState>();
    let doc = {
        let mut windows = state.windows.lock().unwrap();
        let entry = windows.entry(window.label().to_string()).or_default();
        entry.generation += 1;
        entry.nonce = random_nonce();
        entry.handshaken = false;
        entry.server_id = None;
        entry.clone()
    };
    let script = document_identity_script(&doc);
    let _ = window.eval(&script);
}

/// Script run after a top-level load finishes: publishes the document identity
/// and fires the event the web client waits on.
pub fn document_identity_script(doc: &DocumentState) -> String {
    let detail = json!({ "generation": doc.generation, "nonce": doc.nonce });
    format!(
        r#"(function () {{
  if (window.location.origin !== {origin:?}) return;
  var detail = Object.freeze({detail});
  if (!Object.getOwnPropertyDescriptor(window, "__RAFT_DESKTOP_DOCUMENT__")) {{
    Object.defineProperty(window, "__RAFT_DESKTOP_DOCUMENT__", {{ value: detail, writable: false, configurable: false }});
  }}
  window.dispatchEvent(new CustomEvent("raft:desktop-document-ready", {{ detail: detail }}));
}})();"#,
        origin = FRONTEND_ORIGIN,
        detail = detail,
    )
}

fn ok(method: &str, result: Value) -> Value {
    json!({ "method": method, "status": "ok", "result": result })
}

fn err(method: &str, code: &str, message: &str, retryable: bool) -> Value {
    json!({
        "method": method,
        "status": "error",
        "error": { "code": code, "message": message, "retryable": retryable }
    })
}

fn doc_matches(doc: Option<&DocumentState>, generation: u64, nonce: &str) -> bool {
    matches!(doc, Some(d) if d.generation == generation && d.nonce == nonce)
}

fn current_doc(window: &WebviewWindow) -> Option<DocumentState> {
    let state = window.state::<ContractState>();
    let windows = state.windows.lock().unwrap();
    windows.get(window.label()).cloned()
}

fn is_canonical_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts
            .iter()
            .zip(lens)
            .all(|(p, l)| p.len() == l && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Mirrors `validateServerTitle` in the contract: trimmed, `Raft` or `<x> | Raft`,
/// at most 200 UTF-8 bytes, no control or bidi code points.
pub fn is_valid_server_title(title: &str) -> bool {
    if title.is_empty() || title != title.trim() || title.len() > 200 {
        return false;
    }
    let bad = |c: char| {
        let u = c as u32;
        u <= 0x1f
            || (0x7f..=0x9f).contains(&u)
            || (0x202a..=0x202e).contains(&u)
            || (0x2066..=0x2069).contains(&u)
            || u == 0x200e
            || u == 0x200f
    };
    if title.chars().any(bad) {
        return false;
    }
    if title == "Raft" {
        return true;
    }
    match title.strip_suffix(" | Raft") {
        Some(prefix) => !prefix.trim().is_empty(),
        None => false,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeParams {
    #[allow(dead_code)]
    pub frontend_release_id: String,
    protocol_version: u64,
    capabilities: Vec<String>,
    document_generation: u64,
    document_nonce: String,
    environment_id: String,
    environment_generation: u64,
    #[allow(dead_code)]
    open_server_capability_ack: Option<u64>,
}

pub fn handshake_envelope(params: &HandshakeParams, doc: Option<&DocumentState>) -> Value {
    const M: &str = "desktop.handshake";
    if params.protocol_version != PROTOCOL_VERSION {
        return err(M, "protocol_mismatch", "Unsupported desktop protocol version", false);
    }
    if params.environment_id != ENVIRONMENT_ID || params.environment_generation != ENVIRONMENT_GENERATION {
        return err(M, "environment_mismatch", "Desktop environment mismatch", false);
    }
    let required = ["desktop.handshake", "window.focus", "window.bindServer"];
    if !required.iter().all(|c| params.capabilities.iter().any(|p| p == c)) {
        return err(M, "capability_mismatch", "Required desktop capability missing", false);
    }
    if !doc_matches(doc, params.document_generation, &params.document_nonce) {
        return err(M, "stale_document", "Document identity is stale", true);
    }
    ok(
        M,
        json!({
            // An unofficial shell has no Full manifest identity, so it runs in
            // the contract's Minimum mode.
            "compatibilityState": "readyMinimum",
            "documentGeneration": params.document_generation,
            "environmentId": ENVIRONMENT_ID,
            "environmentGeneration": ENVIRONMENT_GENERATION,
        }),
    )
}

#[tauri::command]
pub fn desktop_handshake(window: WebviewWindow, params: HandshakeParams) -> Value {
    let response = handshake_envelope(&params, current_doc(&window).as_ref());
    if response["status"] == "ok" {
        let state = window.state::<ContractState>();
        let mut windows = state.windows.lock().unwrap();
        if let Some(doc) = windows.get_mut(window.label()) {
            doc.handshaken = true;
        }
    }
    response
}

#[tauri::command]
pub fn window_focus(window: WebviewWindow) -> Value {
    crate::shell::show_window(&window);
    ok("window.focus", json!({ "focused": window.is_focused().unwrap_or(false) }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindServerParams {
    server_id: String,
    document_generation: u64,
    document_nonce: String,
}

pub fn bind_envelope(params: &BindServerParams, doc: Option<&DocumentState>) -> Value {
    const M: &str = "window.bindServer";
    if !is_canonical_uuid(&params.server_id) {
        return err(M, "invalid_server_id", "Server ID is not canonical", false);
    }
    if !doc_matches(doc, params.document_generation, &params.document_nonce) {
        return err(M, "stale_document", "Document identity is stale", true);
    }
    ok(M, json!({ "serverId": params.server_id, "disposition": "bound" }))
}

#[tauri::command]
pub fn window_bind_server(window: WebviewWindow, params: BindServerParams) -> Value {
    let response = bind_envelope(&params, current_doc(&window).as_ref());
    if response["status"] == "ok" {
        let state = window.state::<ContractState>();
        let mut windows = state.windows.lock().unwrap();
        if let Some(doc) = windows.get_mut(window.label()) {
            doc.server_id = Some(params.server_id.clone());
        }
    }
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTitleParams {
    document_generation: u64,
    document_nonce: String,
    title: String,
}

pub fn title_envelope(params: &SetTitleParams, doc: Option<&DocumentState>) -> Value {
    const M: &str = "window.setServerTitle";
    if !is_valid_server_title(&params.title) {
        return err(M, "invalid_title", "Server title violates the contract", false);
    }
    if !doc_matches(doc, params.document_generation, &params.document_nonce) {
        return err(M, "stale_document", "Document identity is stale", true);
    }
    ok(M, json!({}))
}

#[tauri::command]
pub fn window_set_server_title(window: WebviewWindow, params: SetTitleParams) -> Value {
    let response = title_envelope(&params, current_doc(&window).as_ref());
    if response["status"] == "ok" {
        let _ = window.set_title(&params.title);
        if let Some(tray) = window.app_handle().tray_by_id(crate::shell::TRAY_ID) {
            let _ = tray.set_tooltip(Some(&params.title));
        }
    }
    response
}

#[tauri::command]
pub fn recovery_retry(app: AppHandle, window: WebviewWindow) -> Value {
    crate::shell::load_remote(app, window);
    ok("recovery.retry", json!({}))
}

#[tauri::command]
pub fn recovery_quit(app: AppHandle) -> Value {
    app.exit(0);
    ok("recovery.quit", json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_contract() {
        assert!(is_valid_server_title("Raft"));
        assert!(is_valid_server_title("general · Acme | Raft"));
        assert!(!is_valid_server_title(" | Raft"));
        assert!(!is_valid_server_title("Acme"));
        assert!(!is_valid_server_title(" Acme | Raft"));
        assert!(!is_valid_server_title("A\u{202e}b | Raft"));
    }

    fn doc() -> DocumentState {
        DocumentState { generation: 7, nonce: "6edbdb72a0024b13".into(), handshaken: false, server_id: None }
    }

    /// Request params exactly as the web client sends them (`args.params`).
    fn handshake_params(nonce: &str) -> HandshakeParams {
        serde_json::from_value(json!({
            "frontendReleaseId": "web-2026.10.06",
            "protocolVersion": 1,
            "capabilities": ["desktop.handshake", "window.focus", "window.bindServer"],
            "documentGeneration": 7,
            "documentNonce": nonce,
            "environmentId": "production",
            "environmentGeneration": 1
        }))
        .unwrap()
    }

    #[test]
    fn handshake_accepts_current_document_only() {
        let d = doc();
        let okv = handshake_envelope(&handshake_params("6edbdb72a0024b13"), Some(&d));
        assert_eq!(okv["status"], "ok");
        assert_eq!(okv["result"]["documentGeneration"], 7);
        let stale = handshake_envelope(&handshake_params("other"), Some(&d));
        assert_eq!(stale["error"]["code"], "stale_document");
        assert_eq!(handshake_envelope(&handshake_params("6edbdb72a0024b13"), None)["status"], "error");
    }

    /// Writes every envelope shape to CONTRACT_FIXTURE_OUT so
    /// `tests/contract-check.mts` can run them through the official validators.
    #[test]
    fn envelopes_fixture() {
        let d = doc();
        let bind: BindServerParams = serde_json::from_value(json!({
            "serverId": "123e4567-e89b-12d3-a456-426614174000",
            "documentGeneration": 7, "documentNonce": "6edbdb72a0024b13"
        })).unwrap();
        let bad_bind: BindServerParams = serde_json::from_value(json!({
            "serverId": "nope", "documentGeneration": 7, "documentNonce": "6edbdb72a0024b13"
        })).unwrap();
        let title: SetTitleParams = serde_json::from_value(json!({
            "documentGeneration": 7, "documentNonce": "6edbdb72a0024b13", "title": "general · Acme | Raft"
        })).unwrap();
        let bad_title: SetTitleParams = serde_json::from_value(json!({
            "documentGeneration": 7, "documentNonce": "6edbdb72a0024b13", "title": "Acme"
        })).unwrap();
        let all = json!([
            handshake_envelope(&handshake_params("6edbdb72a0024b13"), Some(&d)),
            handshake_envelope(&handshake_params("other"), Some(&d)),
            bind_envelope(&bind, Some(&d)),
            bind_envelope(&bad_bind, Some(&d)),
            title_envelope(&title, Some(&d)),
            title_envelope(&bad_title, Some(&d)),
            ok("window.focus", json!({ "focused": true })),
            ok("recovery.retry", json!({})),
            ok("recovery.quit", json!({})),
        ]);
        if let Ok(path) = std::env::var("CONTRACT_FIXTURE_OUT") {
            std::fs::write(&path, serde_json::to_string_pretty(&all).unwrap()).unwrap();
            let scripts = json!({
                "environment": environment_init_script(),
                "identity": document_identity_script(&d),
            });
            std::fs::write(format!("{path}.scripts.json"), scripts.to_string()).unwrap();
        }
    }

    #[test]
    fn init_script_is_valid_shape() {
        let s = environment_init_script();
        assert!(s.contains(r#"environmentId: "production""#));
        assert!(s.contains(r#"frontendOrigin: "https://app.raft.build""#));
        assert!(s.contains("generation: 1,"));
    }

    #[test]
    fn uuids_are_canonical() {
        assert!(is_canonical_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(!is_canonical_uuid("123e4567e89b12d3a456426614174000"));
        assert!(!is_canonical_uuid("123e4567-e89b-12d3-a456-42661417400g"));
    }
}
