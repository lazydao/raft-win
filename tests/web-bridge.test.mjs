// End-to-end check of the scripts Pontoon injects, against the real desktop
// bridge code of the Raft web client (botiverse/raft-source, packages/web).
//
// It bundles the web client's own desktopHandshake / desktopRuntimeEnvironment
// modules, serves them as https://app.raft.build in Chromium, injects exactly
// the scripts the native shell injects, and checks that:
//   1. the web client accepts our environment and enters desktop mode,
//   2. it performs one handshake with the identity we issue,
//   3. it sees the window.setServerTitle and window.openServer native extensions,
//   4. it binds the window to its server and can open a server in a new window,
//   5. notify.js in the main window opens a push socket as a mobile client and
//      turns Raft's notification:push events into shell_notify calls,
//   6. and every window reports DMs and @mentions from its page's own socket
//      as fallback shell_notify calls (and nothing else).
//
// Usage: RAFT_SOURCE=/path/to/raft-source node tests/web-bridge.test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as esbuild from "esbuild";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.RAFT_SOURCE;
if (!source) {
  console.error("Set RAFT_SOURCE to a checkout of https://github.com/botiverse/raft-source");
  process.exit(2);
}
const web = join(source, "packages/web/src");
const contract = join(source, "packages/desktop-contract/src");

// 1. Envelopes and scripts produced by the Rust code.
const out = join(mkdtempSync(join(tmpdir(), "pontoon-")), "envelopes.json");
execFileSync("cargo", ["test", "--lib", "contract::tests::envelopes_fixture"], {
  cwd: join(root, "src-tauri"),
  env: { CARGO_TARGET_DIR: join(root, "src-tauri/target-linux"), ...process.env, CONTRACT_FIXTURE_OUT: out },
  stdio: "ignore",
});
const envelopes = JSON.parse(readFileSync(out, "utf8"));
const scripts = JSON.parse(readFileSync(`${out}.scripts.json`, "utf8"));
const notifyJs = readFileSync(join(root, "src-tauri/src/notify.js"), "utf8");
const handshakeOk = envelopes.find((e) => e.method === "desktop.handshake" && e.status === "ok");
const titleOk = envelopes.find((e) => e.method === "window.setServerTitle" && e.status === "ok");
const bindOk = envelopes.find((e) => e.method === "window.bindServer" && e.status === "ok");
const openOk = envelopes.find((e) => e.method === "window.openServer" && e.status === "ok" && e.result.disposition === "opened");
const SERVER = bindOk.result.serverId;

// 2. Bundle the web client's real bridge modules with light stubs for i18n.
const stubs = {
  "./buildIdentity": "export const FRONTEND_RELEASE_IDENTITY = Object.freeze({ releaseId: 'web-test' });",
  "react-intl": "export const createIntlCache = () => ({}); export const createIntl = () => ({ formatMessage: ({ id }) => id });",
  "./i18n/locale": "export const DEFAULT_LOCALE = 'en'; export const resolveInitialLocale = () => 'en';",
  "./i18n/messages": "export const mergedMessages = () => ({});",
  // The window's current server, as the web client's server store reports it.
  "./store/serverStore": `export const useServerStore = {
    getState: () => ({ current: { id: ${JSON.stringify(SERVER)} } }),
    subscribe: () => () => {},
  };`,
  "../hooks/useTabRouteMemory": "export const readServerSurfaceMemory = () => null;",
};
const bundle = await esbuild.build({
  stdin: {
    contents: `
      import { bootstrapDesktopHandshake, readDesktopOpenServerCapabilityVersion, readDesktopSetServerTitleCapabilityVersion, renderDesktopHandshakeRecovery } from "./desktopHandshake";
      import { DESKTOP_RUNTIME_ENVIRONMENT, RUNTIME_DESKTOP_ENVIRONMENT_ERROR } from "./desktopRuntimeEnvironment";
      import { installDesktopServerWindowBinding } from "./desktopServerWindow";
      import { openServerSwitcherDesktopTarget } from "./utils/serverSwitcherNavigation";
      // The same two calls the web client's main.tsx makes at startup.
      const handshake = bootstrapDesktopHandshake();
      installDesktopServerWindowBinding(handshake);
      // What a Ctrl-click on a server in the server switcher calls.
      window.__OPEN_SERVER__ = openServerSwitcherDesktopTarget;
      window.__RESULT__ = handshake.then(
        (r) => ({ mode: r.mode, state: r.response && r.response.result.compatibilityState }),
        (e) => { renderDesktopHandshakeRecovery(); return { error: String(e) }; },
      );
      window.__ENV__ = { env: DESKTOP_RUNTIME_ENVIRONMENT, error: RUNTIME_DESKTOP_ENVIRONMENT_ERROR,
        titleExt: readDesktopSetServerTitleCapabilityVersion(window),
        openExt: readDesktopOpenServerCapabilityVersion(window) };
    `,
    resolveDir: web,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  define: { "import.meta.env": "{}" },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^@raft\/desktop-contract\// }, (a) => ({ path: join(contract, a.path.split("/").pop() + ".ts") }));
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    },
  }],
});
const bundleJs = bundle.outputFiles[0].text;

// 3. Drive it in Chromium as https://app.raft.build.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

await page.route("https://app.raft.build/**", (route) =>
  route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Raft</title><div id="root"></div><script>${bundleJs}</script>` }),
);
await page.route("https://api.raft.build/api/auth/me", (route) =>
  route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: ME }) }),
);
// Every socket the page opens, with what it sent.
const sockets = [];
await page.routeWebSocket(/api\.raft\.build/, (ws) => {
  const entry = { ws, sent: [] };
  ws.onMessage((m) => entry.sent.push(m));
  sockets.push(entry);
});

// Mock of the native bridge: answers with the envelopes the Rust code produced.
await page.addInitScript(({ handshakeOk, titleOk, bindOk, openOk }) => {
  window.__CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.__CALLS__.push({ command, args });
      if (command === "desktop_handshake") return handshakeOk;
      if (command === "window_set_server_title") return titleOk;
      if (command === "window_bind_server") return bindOk;
      if (command === "window_open_server") return { ...openOk, result: { ...openOk.result, serverId: args.params.serverId } };
      return null;
    },
  };
  localStorage.setItem("slock_access_token", "test-token");
  localStorage.setItem("raft_desktop_environment_generation", "1");
}, { handshakeOk, titleOk, bindOk, openOk });
await page.addInitScript(scripts.environment);
// What the native shell injects into the main window before notify.js.
await page.addInitScript("window.__PONTOON_NOTIFY_PRIMARY__ = true;");
await page.addInitScript(notifyJs);

await page.goto("https://app.raft.build/");
const envInfo = await page.evaluate(() => window.__ENV__);
assert.equal(envInfo.error, null, "web client rejected the injected environment");
assert.equal(envInfo.env.environmentId, "production");
assert.equal(envInfo.titleExt, 1, "window.setServerTitle extension not detected");
assert.equal(envInfo.openExt, 1, "window.openServer extension not detected");
console.log("ok   web client accepts the injected desktop environment");

// The native shell publishes the identity after the load finishes.
assert.equal(await page.evaluate(() => window.__CALLS__.length), 0);
await page.evaluate(scripts.identity);
const result = await page.evaluate(() => window.__RESULT__);
assert.deepEqual(result, { mode: "desktop", state: "readyMinimum" }, JSON.stringify(result));
await page.waitForFunction(() => window.__CALLS__.length >= 2);
const calls = await page.evaluate(() => window.__CALLS__);
assert.equal(calls[0].command, "desktop_handshake");
assert.equal(calls[0].args.params.documentGeneration, 7);
assert.equal(calls[0].args.params.environmentGeneration, 1);
assert.equal(calls[0].args.params.openServerCapabilityAck, 1, "handshake did not acknowledge window.openServer");
assert.equal(await page.locator("#raft-desktop-handshake-recovery").count(), 0);
console.log("ok   handshake completes in desktop mode without the recovery screen");
assert.equal(calls[1].command, "window_bind_server");
assert.deepEqual(calls[1].args.params, { serverId: SERVER, documentGeneration: 7, documentNonce: calls[0].args.params.documentNonce });
assert.equal(calls.length, 2);
console.log("ok   the window binds to its current server");

// Ctrl-click on another server in the switcher asks for a new window.
const OTHER_SERVER = "223e4567-e89b-12d3-a456-426614174000";
assert.equal(await page.evaluate((id) => window.__OPEN_SERVER__(id), OTHER_SERVER), true, "web client did not use the desktop new-window path");
await page.waitForFunction(() => window.__CALLS__.some((c) => c.command === "window_open_server"));
const open = (await page.evaluate(() => window.__CALLS__)).find((c) => c.command === "window_open_server");
assert.deepEqual(open.args.params, { serverId: OTHER_SERVER, documentGeneration: 7, documentNonce: calls[0].args.params.documentNonce });
console.log("ok   Ctrl-click on a server opens it through window.openServer");

// Raft's own notification events, through the main window's push socket.
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(20); }
  throw new Error(`timed out waiting for ${what}`);
};
const callsOf = async (command) => (await page.evaluate(() => window.__CALLS__)).filter((c) => c.command === command).map((c) => c.args);
await until(() => sockets.length >= 1, "the push socket");
const push = sockets[0];
assert.match(push.ws.url(), /^wss:\/\/api\.raft\.build\/socket\.io\/\?EIO=4&transport=websocket$/);
push.ws.send('0{"sid":"e","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
await until(() => push.sent.length >= 1, "the namespace connect");
assert.deepEqual(push.sent[0].slice(0, 2), "40");
assert.deepEqual(JSON.parse(push.sent[0].slice(2)), { token: "test-token", clientKind: "mobile" });
push.ws.send('40{"sid":"n"}');
await until(async () => (await callsOf("notify_push_state")).length >= 1, "notify_push_state");
assert.deepEqual(await callsOf("notify_push_state"), [{ live: true }]);
push.ws.send("2");
await until(() => push.sent.includes("3"), "the pong");
console.log("ok   the main window joins as a mobile client and answers pings");

const S1 = "33333333-3333-4333-8333-333333333333";
const ev = (p) => push.ws.send(`42${JSON.stringify(["notification:push", p])}`);
const common = { serverId: S1, serverName: "Acme", senderId: OTHER, senderType: "agent", threadId: null, parentChannelId: null, parentMessageId: null };
ev({ ...common, kind: "dm", channelId: "d1", messageId: "p1", senderName: "Alice", messagePreview: "hello", title: "DM · Acme", body: "Alice: hello", tag: "message:p1", url: "https://app.raft.build/s/acme/dm/d1?msg=p1", mentioned: false });
ev({ ...common, kind: "channel", channelId: "c1", channelName: "general", messageId: "p2", senderName: "Bob", messagePreview: "look", mentioned: true, url: "https://app.raft.build/s/acme/channel/c1?msg=p2" });
ev({ ...common, kind: "channel", channelId: "c1", channelName: "general", messageId: "p3", senderName: "Bob", messagePreview: "Sent 2 attachments", mentioned: false, url: "https://app.raft.build/s/acme/channel/c1?msg=p3" });
ev({ ...common, kind: "thread", channelId: "t1", threadId: "t1", parentChannelKind: "channel", channelName: "dev", messageId: "p4", senderName: "Cat", messagePreview: "done", url: "https://app.raft.build/s/acme/channel/c2?thread=c2%3Am&msg=p4" });
ev({ kind: "dm", messageId: "p5", title: "DM · Acme", body: "Someone: hi" }); // no sender fields
ev({ title: "no message id" });
push.ws.send(`42${JSON.stringify(["dm:new", { messageId: "x" }])}`);
await until(async () => (await callsOf("shell_notify")).length >= 5, "push notifications");
await page.waitForTimeout(200);
const pushed = await callsOf("shell_notify");
const n = (title, body, id, url, important) => ({ title, body, id, serverId: S1, url, attribution: "Acme", important });
assert.deepEqual(pushed, [
  n("Alice", "hello", "p1", "https://app.raft.build/s/acme/dm/d1?msg=p1", true),
  n("Bob 在 #general 提到了你", "look", "p2", "https://app.raft.build/s/acme/channel/c1?msg=p2", true),
  n("Bob · #general", "[2 个附件]", "p3", "https://app.raft.build/s/acme/channel/c1?msg=p3", false),
  n("Cat · #dev 的话题", "done", "p4", "https://app.raft.build/s/acme/channel/c2?thread=c2%3Am&msg=p4", false),
  { title: "DM · Acme", body: "Someone: hi", id: "p5", serverId: null, url: null, attribution: null, important: true },
]);
console.log("ok   notification:push events become notifications for DMs, channels and threads; only DMs and @mentions are important");

// A refused connect closes the socket, which reports itself down and retries.
push.ws.send('44{"message":"Invalid or expired token"}');
await until(async () => (await callsOf("notify_push_state")).some((a) => a.live === false), "the socket to report itself down");
await until(() => sockets.length >= 2, "a reconnect");
assert.match(sockets[1].ws.url(), /EIO=4/);
console.log("ok   a refused push socket reports itself down and reconnects");

// The page's own socket: DMs and mentions, marked as fallback.
const before = (await callsOf("shell_notify")).length;
await page.evaluate(() => { new WebSocket("wss://api.raft.build/socket.io/?EIO=4&transport=websocket&page=1"); });
await until(() => sockets.some((x) => x.ws.url().endsWith("page=1")), "the page socket");
const socket = sockets.find((x) => x.ws.url().endsWith("page=1")).ws;
const frame = (msg) => socket.send(`42${JSON.stringify(["message:new", msg])}`);
const base = { channelId: "c", content: "hi", createdAt: new Date().toISOString(), senderType: "user" };
frame({ ...base, id: "m1", senderId: OTHER, senderName: "Alice", conversationContext: { channelType: "dm" }, content: "**hello** there" });
frame({ ...base, id: "m1", senderId: OTHER, senderName: "Alice", conversationContext: { channelType: "dm" } }); // duplicate
frame({ ...base, id: "m2", senderId: OTHER, senderName: "Bob", conversationContext: { channelType: "channel" } }); // no mention
frame({ ...base, id: "m3", senderId: OTHER, senderName: "Bob", conversationContext: { channelType: "channel" }, mentions: [{ type: "user", id: ME, name: "me" }], content: "look" });
frame({ ...base, id: "m4", senderId: ME, senderName: "Me", conversationContext: { channelType: "dm" } }); // own message
socket.send(`42${JSON.stringify(["message:updated", { id: "m5" }])}`);
await page.waitForTimeout(300);
const notes = (await callsOf("shell_notify")).slice(before);
assert.deepEqual(notes, [
  { title: "Alice", body: "hello there", id: "m1", fallback: true },
  { title: "Bob 提到了你", body: "look", id: "m3", fallback: true },
]);
console.log("ok   the page socket reports DMs and mentions as fallback; duplicates, own messages and plain channel messages do not");

await browser.close();
