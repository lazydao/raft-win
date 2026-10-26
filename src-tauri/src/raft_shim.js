// Keeps server windows working with the current Raft web client. Runs at
// document start in every server window.
//
// Since Raft 1.21.28 (October 2026) the web client no longer speaks the
// desktop contract Pontoon implements: it ignores raftDesktopServerId, never
// calls window.bindServer or window.setServerTitle, and opens servers in new
// windows as plain links (which shell.rs turns into Pontoon windows). So this
// script does those parts from outside the web client:
//
//   1. A window started at /?raftDesktopServerId=<id> opens that server. The
//      start page follows slock_last_server_slug, so in this page only,
//      reading that key gives the window's server while the page is still on
//      "/". (Writing it instead would race with other windows starting at the
//      same time, since they share localStorage.)
//   2. Whenever the page moves to /s/<slug>, the window is bound to that
//      server, so Pontoon can focus it, route notifications to it and reopen
//      it at the next start.
//   3. The window title follows the page title, with the server's name when
//      the page title is just "Raft".
//   4. Links to Raft stay in Pontoon: Raft's "Open in Raft Desktop?" banner
//      (shown to accounts that used the official app lately) is answered
//      "web" once, unless the user already chose.
//
// Server ids, slugs and names come from the web client's own GET /api/servers
// (or a request of our own if that is not seen) and are kept in localStorage.
(() => {
  if (location.origin !== "https://app.raft.build") return;

  // ---- 4. Open Raft links here, not in Raft Desktop ----

  try {
    if (localStorage.getItem("raft_link_open_preference") === null) localStorage.setItem("raft_link_open_preference", "web");
  } catch {}

  const API = "https://api.raft.build/api";
  const CACHE = "pontoon.servers";
  const LAST_SERVER = "slock_last_server_slug";
  const startId = location.pathname === "/" && new URLSearchParams(location.search).get("raftDesktopServerId");
  const start = location.href;

  let servers = [];
  try {
    const c = JSON.parse(localStorage.getItem(CACHE));
    if (Array.isArray(c)) servers = c;
  } catch {}
  const byId = (id) => servers.find((s) => s.id === String(id).toLowerCase());
  const bySlug = (slug) => servers.find((s) => s.slug === slug);
  const slugOfPath = () => {
    const m = /^\/s\/([^/?#]+)/.exec(location.pathname);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  };

  // ---- 1. Start on the window's own server ----

  let target = startId ? byId(startId)?.slug || null : null;
  if (startId) {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (target && key === LAST_SERVER && this === window.localStorage && location.pathname === "/") return target;
      return getItem.call(this, key);
    };
  }

  // ---- The server list ----

  let learned = false;
  const learn = (list) => {
    if (!Array.isArray(list)) return;
    const fresh = [];
    for (const s of list) {
      if (s && typeof s.id === "string" && typeof s.slug === "string" && s.slug) {
        fresh.push({ id: s.id.toLowerCase(), slug: s.slug, name: typeof s.name === "string" ? s.name : "" });
      }
    }
    servers = fresh;
    try {
      localStorage.setItem(CACHE, JSON.stringify(fresh));
    } catch {}
    const first = !learned;
    learned = true;
    sync();
    if (!first || !startId) return;
    const slug = byId(startId)?.slug;
    if (!slug || slug === target) return;
    target = slug;
    // Usually this lands before the web client reads the key. If it has
    // already opened another server, start over; the next load finds the
    // slug in the list. Not once the page has been up a while, so a server
    // you chose yourself is never taken away.
    const here = location.pathname === "/" || slugOfPath() === slug;
    if (!here && performance.now() < 20_000) location.replace(start);
  };

  const isServerList = (method, url) => {
    try {
      return String(method || "GET").toUpperCase() === "GET" && new URL(url, location.href).href === `${API}/servers`;
    } catch {
      return false;
    }
  };
  // The web client's own requests for the server list (axios, so XHR; fetch
  // too, in case that changes).
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isServerList(method, url)) {
      this.addEventListener("load", () => {
        if (this.status !== 200) return;
        try {
          learn(this.responseType === "json" ? this.response : JSON.parse(this.responseText));
        } catch {}
      });
    }
    return open.apply(this, arguments);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = nativeFetch.apply(this, arguments);
    try {
      const url = input instanceof Request ? input.url : input;
      const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
      if (isServerList(method, url)) p.then((r) => r.ok && r.clone().json().then(learn)).catch(() => {});
    } catch {}
    return p;
  };
  // In case the web client's request is not seen, ask once ourselves.
  setTimeout(() => {
    if (learned) return;
    let token = null;
    try {
      token = localStorage.getItem("slock_access_token");
    } catch {}
    if (!token) return;
    nativeFetch(`${API}/servers`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then(learn)
      .catch(() => {});
  }, 5000);

  // ---- 2 and 3. Tell Pontoon which server the window shows, and its title ----

  const invoke = (cmd, params) => {
    const native = window.__TAURI_INTERNALS__;
    const doc = window.__RAFT_DESKTOP_DOCUMENT__;
    if (!native || typeof native.invoke !== "function" || !doc) return Promise.resolve(null);
    return native
      .invoke(cmd, { params: { ...params, documentGeneration: doc.generation, documentNonce: doc.nonce } })
      .catch(() => null);
  };

  // A refused call (the page's identity not yet issued, or stale) is tried
  // again on the next change, but not more than every few seconds.
  const RETRY_MS = 3000;
  let boundId = null;
  let bindFailed = 0;
  let sentTitle = null;
  let titleFailed = 0;
  function sync() {
    if (!window.__RAFT_DESKTOP_DOCUMENT__) return;
    const now = Date.now();
    const server = bySlug(slugOfPath());
    if (server && server.id !== boundId && now - bindFailed > RETRY_MS) {
      const id = server.id;
      boundId = id;
      invoke("window_bind_server", { serverId: id }).then((r) => {
        if ((!r || r.status !== "ok") && boundId === id) {
          boundId = null;
          bindFailed = Date.now();
        }
      });
    }
    let title = (document.title || "").trim();
    if ((!title || title === "Raft") && server && server.name) title = `${server.name} | Raft`;
    if (title && title !== sentTitle && now - titleFailed > RETRY_MS) {
      sentTitle = title;
      invoke("window_set_server_title", { title }).then((r) => {
        if ((!r || r.status !== "ok") && sentTitle === title) {
          sentTitle = null;
          titleFailed = Date.now();
        }
      });
    }
  }

  // The web client moves between pages with the History API.
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function () {
      const r = original.apply(this, arguments);
      queueMicrotask(sync);
      return r;
    };
  }
  window.addEventListener("popstate", sync);
  window.addEventListener("raft:desktop-document-ready", sync);
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(sync).observe(document.head, { childList: true, subtree: true, characterData: true });
    sync();
  });
})();
