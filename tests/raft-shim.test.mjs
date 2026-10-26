// Checks raft_shim.js in Chromium against stand-ins for Raft's start page
// that behave like the current web client: it ignores raftDesktopServerId,
// loads its server list with XHR and then opens slock_last_server_slug.
//   1. a window for a server not yet in Pontoon's list opens that server,
//      taking the slug from the web client's own server list request;
//   2. if the web client opened another server first, the page loads once
//      more and lands on the right one;
//   3. with the list saved, it opens the server straight away;
//   4. the shared slock_last_server_slug is never written, so windows
//      starting together don't steer each other;
//   5. if the web client's request is not seen, it asks the API itself;
//   6. an unknown server or a page without raftDesktopServerId is left alone;
//   7. moving to a server binds the window to it and sets the window title;
//   8. Raft's "Open in Raft Desktop?" choice is preset to "web", unless the
//      user already chose.
//
// Usage: node tests/raft-shim.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "src-tauri/src/raft_shim.js"), "utf8");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SERVERS = [{ id: A, slug: "alpha", name: "Alpha" }, { id: B, slug: "beta", name: "Beta Team" }];
const CACHED = SERVERS.map((s) => ({ ...s, id: s.id.toLowerCase() }));

// Raft's "/" route. ?mode= picks how the stand-in behaves:
//   xhr   load the server list (retrying once after a 401), then open the last server
//   early open the last server before the server list arrives
//   none  never load the server list; open the last server after 300 ms
const RAFT_PAGE = `<!doctype html><html><body><script>
  window.__loads = (Number(sessionStorage.getItem("loads")) || 0) + 1;
  sessionStorage.setItem("loads", window.__loads);
  const mode = sessionStorage.getItem("mode");
  const go = () => {
    const slug = localStorage.getItem("slock_last_server_slug");
    if (location.pathname === "/" && slug) history.replaceState(null, "", "/s/" + slug + "/channel/general");
  };
  const load = (attempt) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.raft.build/api/servers");
    xhr.setRequestHeader("Authorization", "Bearer " + localStorage.getItem("slock_access_token"));
    xhr.onloadend = () => {
      if (xhr.status === 401 && attempt === 0) {
        localStorage.setItem("slock_access_token", "token-1");
        return load(1);
      }
      if (mode === "xhr") Promise.resolve().then(go);
    };
    xhr.send();
  };
  if (location.pathname === "/") {
    if (mode !== "none") load(0);
    if (mode === "early") setTimeout(go, 50);
    if (mode === "none") setTimeout(go, 300);
  }
</script></body></html>`;

const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
}

const context = await browser.newContext();
let apiCalls = 0;
await context.route("https://app.raft.build/**", (r) => r.fulfill({ contentType: "text/html", body: RAFT_PAGE }));
await context.route("https://api.raft.build/api/servers", async (r) => {
  if (r.request().method() === "OPTIONS") {
    return r.fulfill({ headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" } });
  }
  apiCalls++;
  await new Promise((done) => setTimeout(done, 300));
  const auth = r.request().headers().authorization;
  if (auth !== "Bearer token-1") {
    return r.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" }, body: "{}" });
  }
  return r.fulfill({
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization" },
    body: JSON.stringify(SERVERS),
  });
});
await context.addInitScript(script);

const setup = await context.newPage();
await setup.goto("https://app.raft.build/s/alpha");
await setup.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("slock_access_token", "token-1");
  localStorage.setItem("slock_last_server_slug", "alpha");
});

async function openWindow(serverId, mode = "xhr", { clearList = false, token = "token-1" } = {}) {
  await setup.evaluate(([clearList, token]) => {
    if (clearList) localStorage.removeItem("pontoon.servers");
    localStorage.setItem("slock_access_token", token);
  }, [clearList, token]);
  const page = await context.newPage();
  await page.addInitScript((mode) => sessionStorage.setItem("mode", mode), mode);
  await page.goto(`https://app.raft.build/${serverId ? `?raftDesktopServerId=${serverId}` : ""}`);
  await page.waitForFunction(() => location.pathname.startsWith("/s/"), null, { timeout: 15_000 });
  await page.waitForTimeout(mode === "none" ? 7_000 : 1_500);
  await page.waitForFunction(() => location.pathname.startsWith("/s/"), null, { timeout: 15_000 });
  const r = await page.evaluate(() => ({
    path: location.pathname,
    loads: window.__loads,
    cache: JSON.parse(localStorage.getItem("pontoon.servers")),
  }));
  await page.close();
  return r;
}

await check("a server not in the list yet opens from the web client's own server list", async () => {
  const r = await openWindow(B, "xhr", { clearList: true });
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 1);
  assert.deepEqual(r.cache, CACHED);
});
await check("an expired token: the web client's retry is used", async () => {
  const r = await openWindow(B, "xhr", { clearList: true, token: "expired" });
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 1);
});
await check("if the web client opened another server first, one more load fixes it", async () => {
  const r = await openWindow(B, "early", { clearList: true });
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 2);
});
await check("with the list saved it opens straight away", async () => {
  const r = await openWindow(B.toUpperCase(), "early");
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 1);
});
await check("the shared last-server key is left alone", async () => {
  const last = await setup.evaluate(() => localStorage.getItem("slock_last_server_slug"));
  assert.equal(last, "alpha");
});
await check("without the web client's request it asks the API itself", async () => {
  const before = apiCalls;
  const r = await openWindow(B, "none", { clearList: true });
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 2);
  assert.equal(apiCalls, before + 1);
});
await check("an unknown server is left to the web client, without reloading", async () => {
  const r = await openWindow("33333333-3333-4333-8333-333333333333");
  assert.equal(r.path, "/s/alpha/channel/general");
  assert.equal(r.loads, 1);
});
await check("a page without raftDesktopServerId is left alone", async () => {
  const r = await openWindow(null, "none");
  assert.equal(r.path, "/s/alpha/channel/general");
  assert.equal(r.loads, 1);
});

await check("moving to a server binds the window to it and titles the window", async () => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    sessionStorage.setItem("mode", "none");
    window.__calls = [];
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        window.__calls.push([cmd, args.params]);
        return Promise.resolve({ status: "ok" });
      },
    };
  });
  await page.goto("https://app.raft.build/s/alpha/channel/general");
  const calls = () => page.evaluate(() => window.__calls);
  // Nothing before the page has its identity.
  await page.waitForTimeout(300);
  assert.deepEqual(await calls(), []);
  await page.evaluate(() => {
    Object.defineProperty(window, "__RAFT_DESKTOP_DOCUMENT__", { value: { generation: 3, nonce: "n" } });
    window.dispatchEvent(new CustomEvent("raft:desktop-document-ready"));
  });
  await page.waitForTimeout(100);
  const doc = { documentGeneration: 3, documentNonce: "n" };
  assert.deepEqual(await calls(), [
    ["window_bind_server", { serverId: A, ...doc }],
    ["window_set_server_title", { title: "Alpha | Raft", ...doc }],
  ]);
  await page.evaluate(() => {
    window.__calls = [];
    history.pushState(null, "", "/s/beta/channel/x");
    document.title = "#x · Beta Team | Raft";
  });
  await page.waitForTimeout(100);
  assert.deepEqual(await calls(), [
    ["window_bind_server", { serverId: B, ...doc }],
    ["window_set_server_title", { title: "#x · Beta Team | Raft", ...doc }],
  ]);
  await page.evaluate(() => {
    window.__calls = [];
    history.replaceState(null, "", "/s/beta/channel/y");
  });
  await page.waitForTimeout(100);
  assert.deepEqual(await calls(), [], "same server and title again");
  await page.close();
});

await check("links open in the web client unless the user chose otherwise", async () => {
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("mode", "none"));
  await page.goto("https://app.raft.build/s/alpha/channel/general");
  const pref = () => page.evaluate(() => localStorage.getItem("raft_link_open_preference"));
  await page.evaluate(() => localStorage.removeItem("raft_link_open_preference"));
  await page.reload();
  assert.equal(await pref(), "web");
  await page.evaluate(() => localStorage.setItem("raft_link_open_preference", "app"));
  await page.reload();
  assert.equal(await pref(), "app");
  await page.evaluate(() => localStorage.removeItem("raft_link_open_preference"));
  await page.close();
});

await browser.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All raft shim checks passed");
