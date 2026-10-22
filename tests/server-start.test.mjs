// Checks server_start.js in Chromium against a stand-in for Raft's start page
// that behaves like the current web client: it ignores raftDesktopServerId
// and, once its server list is loaded, opens slock_last_server_slug.
//   1. a window for a server not yet in Pontoon's list ends up on that server
//      after one extra load, and the list is saved;
//   2. with the list saved, it opens that server straight away;
//   3. the shared slock_last_server_slug is never written, so windows
//      starting together don't steer each other;
//   4. an unknown server or a page without raftDesktopServerId is left alone.
//
// Usage: node tests/server-start.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "src-tauri/src/server_start.js"), "utf8");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SERVERS = [{ id: A, slug: "alpha" }, { id: B, slug: "beta" }];

// Raft's "/" route: wait for the server list, then go to the last server.
const RAFT_PAGE = `<!doctype html><html><body><script>
  window.__loads = (Number(sessionStorage.getItem("loads")) || 0) + 1;
  sessionStorage.setItem("loads", window.__loads);
  if (location.pathname === "/") setTimeout(() => {
    const slug = localStorage.getItem("slock_last_server_slug");
    if (slug) history.replaceState(null, "", "/s/" + slug + "/channel/general");
  }, 300);
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
await context.route("https://api.raft.build/api/servers", (r) => {
  apiCalls++;
  const auth = r.request().headers().authorization;
  if (auth !== "Bearer token-1") return r.fulfill({ status: 401, body: "{}" });
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

async function openWindow(serverId) {
  const page = await context.newPage();
  await page.goto(`https://app.raft.build/${serverId ? `?raftDesktopServerId=${serverId}` : ""}`);
  await page.waitForFunction(() => location.pathname.startsWith("/s/"), null, { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  const r = await page.evaluate(() => ({
    path: location.pathname,
    loads: window.__loads,
    last: localStorage.getItem("slock_last_server_slug"),
    cache: JSON.parse(localStorage.getItem("pontoon.serverSlugs")),
  }));
  await page.close();
  return r;
}

await check("a server not in the list yet opens after one extra load", async () => {
  const r = await openWindow(B);
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 2);
  assert.deepEqual(r.cache, { [A]: "alpha", [B]: "beta" });
});
await check("with the list saved it opens straight away", async () => {
  const r = await openWindow(B.toUpperCase());
  assert.equal(r.path, "/s/beta/channel/general");
  assert.equal(r.loads, 1);
});
await check("the shared last-server key is left alone", async () => {
  const last = await setup.evaluate(() => localStorage.getItem("slock_last_server_slug"));
  assert.equal(last, "alpha");
});
await check("an unknown server is left to the web client, without reloading", async () => {
  const r = await openWindow("33333333-3333-4333-8333-333333333333");
  assert.equal(r.path, "/s/alpha/channel/general");
  assert.equal(r.loads, 1);
});
await check("a page without raftDesktopServerId is left alone", async () => {
  const before = apiCalls;
  const r = await openWindow(null);
  assert.equal(r.path, "/s/alpha/channel/general");
  assert.equal(apiCalls, before);
});
await check("an expired token is retried once the web client refreshes it", async () => {
  await setup.evaluate(() => {
    localStorage.removeItem("pontoon.serverSlugs");
    localStorage.setItem("slock_access_token", "expired");
    setTimeout(() => localStorage.setItem("slock_access_token", "token-1"), 1_000);
  });
  const page = await context.newPage();
  await page.goto(`https://app.raft.build/?raftDesktopServerId=${B}`);
  await page.waitForFunction(() => location.pathname.startsWith("/s/beta"), null, { timeout: 10_000 });
});

await browser.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All server start checks passed");
