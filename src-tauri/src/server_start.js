// Opens a server window on its own server. Runs at document start in every
// server window.
//
// Pontoon starts a server window at /?raftDesktopServerId=<id>. The web client
// used to read that and open the server's last page itself; since late
// October 2026 it ignores it and opens the last server you used instead. Its
// start page does still follow slock_last_server_slug, so in this page only,
// reading that key gives the window's server while the page is still on the
// start page. (Writing it instead would race with other windows starting at
// the same time, since they share localStorage.) The slug comes from a small
// id → slug list kept in localStorage; when the server is not in it yet, the
// list is fetched from Raft's API and the page is loaded again.
(() => {
  if (location.origin !== "https://app.raft.build" || location.pathname !== "/") return;
  const serverId = new URLSearchParams(location.search).get("raftDesktopServerId");
  if (!serverId) return;

  const API = "https://api.raft.build/api";
  const CACHE = "pontoon.serverSlugs";
  const LAST_SERVER = "slock_last_server_slug";
  const id = serverId.toLowerCase();
  const start = location.href;

  const readCache = () => {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE));
      return c && typeof c === "object" ? c : {};
    } catch {
      return {};
    }
  };
  const cached = readCache()[id];
  const known = typeof cached === "string" && cached ? cached : null;
  if (known) {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (this === window.localStorage && key === LAST_SERVER && location.pathname === "/") return known;
      return getItem.call(this, key);
    };
  }

  // Refresh the list either way, so renamed servers are picked up next time.
  // A token that has just expired is refreshed by the web client, so one
  // later retry is enough.
  const fetchServers = (retry) => {
    let token = null;
    try {
      token = localStorage.getItem("slock_access_token");
    } catch {}
    if (!token) return retry ? null : later();
    return fetch(`${API}/servers`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : retry ? null : later()))
      .catch(() => (retry ? null : later()));
  };
  const later = () => new Promise((r) => setTimeout(r, 3000)).then(() => fetchServers(true));

  fetchServers(false).then((servers) => {
    if (!Array.isArray(servers)) return;
    const slugs = {};
    for (const s of servers) {
      if (s && typeof s.id === "string" && typeof s.slug === "string" && s.slug) slugs[s.id.toLowerCase()] = s.slug;
    }
    try {
      localStorage.setItem(CACHE, JSON.stringify(slugs));
    } catch {}
    const slug = slugs[id];
    if (!slug || slug === known) return;
    // The web client may already have opened another server; start over now
    // that the slug is in the list. The next load finds it there, so this
    // happens once per server (and again only if it is renamed).
    location.replace(start);
  });
})();
