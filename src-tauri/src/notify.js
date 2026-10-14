// Desktop notifications for app.raft.build.
//
// Raft's server decides who to notify about each message: everyone in a DM,
// the members of a channel, the followers of a thread, minus whatever they
// muted. It sends that decision as `notification:push` events, but only to
// sockets that identify as Raft's mobile app; the web client itself relies on
// Web Push, which WebView2 does not have. So the main window opens one such
// socket of its own (one for all servers) and hands each event to the native
// side, which shows the Windows notification and marks the window unread.
//
// While that socket is down, every window also watches its page's own
// Socket.IO frames for `message:new` and reports DMs and @mentions, the
// cases that matter most. The native side ignores those reports while the
// push socket is live and drops a message it has already handled.
(function () {
  if (window.location.origin !== "https://app.raft.build") return;
  if (window.__PONTOON_NOTIFY__) return;
  window.__PONTOON_NOTIFY__ = true;

  var API = "https://api.raft.build/api";
  var PUSH_SOCKET = "wss://api.raft.build/socket.io/?EIO=4&transport=websocket";
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

  function accessToken() {
    try { return window.localStorage.getItem("slock_access_token"); } catch (e) { return null; }
  }

  function text(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  // ---- Raft's own notification events (main window only) ----

  // The server writes these few bodies in English.
  function previewText(p) {
    var s = text(p.messagePreview);
    var n = /^Sent (\d+) attachments$/.exec(s);
    if (s === "Sent an attachment") return "[附件]";
    if (n) return "[" + n[1] + " 个附件]";
    if (s === "(no text)") return "新消息";
    return s;
  }

  // What a notification says, from the event's fields; the server's own
  // English title and body are the fallback.
  function describe(p) {
    var sender = text(p.senderName);
    var preview = previewText(p);
    var channel = text(p.channelName);
    if (!sender) return { title: text(p.title) || "Raft", body: text(p.body) || preview || "新消息" };
    var title;
    if (p.kind === "dm") title = sender;
    else if (p.kind === "thread") title = sender + " · " + (p.parentChannelKind === "dm" ? "私信" : "#" + channel) + " 的话题";
    else if (p.mentioned === true) title = sender + " 在 #" + channel + " 提到了你";
    else title = sender + " · #" + channel;
    return { title: title, body: preview || "新消息" };
  }

  function onPush(p) {
    if (!p || typeof p !== "object" || typeof p.messageId !== "string") return;
    var d = describe(p);
    invoke("shell_notify", {
      title: d.title,
      body: d.body,
      id: p.messageId,
      serverId: typeof p.serverId === "string" ? p.serverId : null,
      url: typeof p.url === "string" ? p.url : null,
      attribution: text(p.serverName) || null,
      // By default only DMs and @mentions count (the native side decides).
      important: p.kind === "dm" || p.mentioned === true,
    });
  }

  // A minimal Socket.IO v4 client over a plain WebSocket: open, connect to
  // the default namespace with the access token, answer pings, read events.
  var push = { ws: null, token: null, retry: 0, timer: null };

  function schedulePush(ms) {
    clearTimeout(push.timer);
    push.timer = setTimeout(connectPush, ms);
  }

  function retryDelay() {
    var ms = Math.min(60000, 2000 * Math.pow(2, push.retry++));
    return ms / 2 + Math.random() * ms / 2;
  }

  function connectPush() {
    if (push.ws) return;
    var token = accessToken();
    if (!token) { schedulePush(5000); return; }
    var ws;
    try { ws = new NativeWebSocket(PUSH_SOCKET); } catch (e) { schedulePush(retryDelay()); return; }
    push.ws = ws;
    push.token = token;
    ws.onmessage = function (event) {
      var data = event.data;
      if (typeof data !== "string" || !data) return;
      if (data.charAt(0) === "0") {
        // Engine.IO is open; join the default namespace as a mobile client,
        // the kind the server sends notification events to.
        ws.send("40" + JSON.stringify({ token: token, clientKind: "mobile" }));
      } else if (data === "2") {
        ws.send("3");
        invoke("notify_push_state", { live: true });
      } else if (data.slice(0, 2) === "40") {
        push.retry = 0;
        invoke("notify_push_state", { live: true });
      } else if (data.slice(0, 2) === "44" || data.slice(0, 2) === "41") {
        // Refused (an expired token, usually) or disconnected by the server.
        ws.close();
      } else if (data.slice(0, 2) === "42") {
        var packet = parseEvent(data);
        if (packet && packet[0] === "notification:push") onPush(packet[1]);
      }
    };
    ws.onclose = function () {
      if (push.ws !== ws) return;
      push.ws = null;
      invoke("notify_push_state", { live: false });
      schedulePush(retryDelay());
    };
  }

  // The web client refreshes the access token on its own. Follow it, so a
  // sign-out closes the socket and a new sign-in (maybe another account)
  // reconnects with the new token.
  function followToken() {
    var token = accessToken();
    if (push.ws && token !== push.token) {
      push.ws.close();
      if (token) { push.retry = 0; schedulePush(500); }
    }
  }

  if (window.__PONTOON_NOTIFY_PRIMARY__ === true) {
    connectPush();
    setInterval(followToken, 15000);
  }

  // ---- The page's own socket, as a fallback (every window) ----

  function currentUserId() {
    var token = accessToken();
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

  function preview(content) {
    var s = String(content || "")
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
      var sender = msg.senderDisplayName || msg.senderName || "Raft";
      var body = preview(msg.content);
      if (!body && Array.isArray(msg.attachments) && msg.attachments.length) body = "[附件]";
      invoke("shell_notify", {
        title: isDm ? sender : sender + " 提到了你",
        body: body || "新消息",
        // Lets the native side drop the same message from another source.
        id: msg.id,
        fallback: true,
      });
    });
  }

  function parseEvent(data) {
    var m = /^42(?:\/[^,]*,)?\d*(\[[\s\S]*\])$/.exec(data);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function onFrame(data) {
    if (typeof data !== "string" || data.charCodeAt(0) !== 52 /* 4 */ || data.charCodeAt(1) !== 50 /* 2 */) return;
    if (data.indexOf("\"message:new\"") === -1) return;
    var packet = parseEvent(data);
    if (packet && packet[0] === "message:new") handleMessage(packet[1]);
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
