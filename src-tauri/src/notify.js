// Desktop notifications for app.raft.build.
//
// The web client only delivers system notifications through Web Push, which
// WebView2 does not support, and the official desktop shells fire their own
// notifications natively. This script does the same job here: it watches the
// page's Socket.IO frames for `message:new` and asks the native side to show a
// Windows notification when the message is a DM or mentions the signed-in user
// and the window is not focused.
(function () {
  if (window.location.origin !== "https://app.raft.build") return;
  if (window.__PONTOON_NOTIFY__) return;
  window.__PONTOON_NOTIFY__ = true;

  var API = "https://api.raft.build/api";
  var NativeWebSocket = window.WebSocket;
  var seen = new Set();
  var me = null;
  var meToken = null;
  var mePending = null;

  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return Promise.resolve();
    return internals.invoke(cmd, args).catch(function () {});
  }

  function currentUserId() {
    var token = null;
    try { token = window.localStorage.getItem("slock_access_token"); } catch (e) {}
    if (!token) return Promise.resolve(null);
    if (me && meToken === token) return Promise.resolve(me);
    if (mePending) return mePending;
    mePending = fetch(API + "/auth/me", { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        me = data && typeof data.id === "string" ? data.id : null;
        meToken = token;
        return me;
      })
      .catch(function () { return null; })
      .finally(function () { mePending = null; });
    return mePending;
  }

  function preview(text) {
    var s = String(text || "")
      .replace(/<@?[a-z]+:[0-9a-f-]{36}\|?([^>]*)>/gi, "@$1")
      .replace(/[`*_~>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return s.length > 180 ? s.slice(0, 179) + "…" : s;
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;
    if (seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > 2000) seen = new Set(Array.from(seen).slice(-1000));
    if (msg.messageType === "system") return;

    currentUserId().then(function (uid) {
      if (!uid || msg.senderId === uid) return;
      var ctx = msg.conversationContext || {};
      var isDm = ctx.channelType === "dm";
      var mentioned = Array.isArray(msg.mentions) && msg.mentions.some(function (m) {
        return m && m.type === "user" && m.id === uid;
      });
      if (!isDm && !mentioned) return;
      if (document.hasFocus() && document.visibilityState === "visible") return;
      var sender = msg.senderDisplayName || msg.senderName || "Raft";
      var body = preview(msg.content);
      if (!body && Array.isArray(msg.attachments) && msg.attachments.length) body = "[附件]";
      invoke("shell_notify", {
        title: isDm ? sender : sender + " 提到了你",
        body: body || "新消息",
      });
    });
  }

  function onFrame(data) {
    if (typeof data !== "string" || data.charCodeAt(0) !== 52 /* 4 */ || data.charCodeAt(1) !== 50 /* 2 */) return;
    if (data.indexOf("\"message:new\"") === -1) return;
    var m = /^42(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/.exec(data);
    if (!m) return;
    try {
      var packet = JSON.parse(m[1]);
      if (packet[0] === "message:new") handleMessage(packet[1]);
    } catch (e) {}
  }

  function PatchedWebSocket(url, protocols) {
    var ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    try {
      if (String(url).indexOf("api.raft.build") !== -1) {
        ws.addEventListener("message", function (event) { onFrame(event.data); });
      }
    } catch (e) {}
    return ws;
  }
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    Object.defineProperty(PatchedWebSocket, k, { value: NativeWebSocket[k] });
  });
  window.WebSocket = PatchedWebSocket;

})();
