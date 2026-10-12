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
//   5. notify.js turns DMs and @mentions into shell_notify calls (and nothing else).
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
let socket;
await page.routeWebSocket(/api\.raft\.build/, (ws) => { socket = ws; });

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

// Notifications from Socket.IO frames.
await page.evaluate(() => {
  document.hasFocus = () => false;
  new WebSocket("wss://api.raft.build/socket.io/?EIO=4&transport=websocket");
});
await page.waitForFunction(() => true);
for (let i = 0; i < 50 && !socket; i++) await page.waitForTimeout(20);
assert.ok(socket, "socket was not opened");
const frame = (msg) => socket.send(`42${JSON.stringify(["message:new", msg])}`);
const base = { channelId: "c", content: "hi", createdAt: new Date().toISOString(), senderType: "user" };
frame({ ...base, id: "m1", senderId: OTHER, senderName: "Alice", conversationContext: { channelType: "dm" }, content: "**hello** there" });
frame({ ...base, id: "m1", senderId: OTHER, senderName: "Alice", conversationContext: { channelType: "dm" } }); // duplicate
frame({ ...base, id: "m2", senderId: OTHER, senderName: "Bob", conversationContext: { channelType: "channel" } }); // no mention
frame({ ...base, id: "m3", senderId: OTHER, senderName: "Bob", conversationContext: { channelType: "channel" }, mentions: [{ type: "user", id: ME, name: "me" }], content: "look" });
frame({ ...base, id: "m4", senderId: ME, senderName: "Me", conversationContext: { channelType: "dm" } }); // own message
socket.send(`42${JSON.stringify(["message:updated", { id: "m5" }])}`);
await page.waitForTimeout(300);
const notes = (await page.evaluate(() => window.__CALLS__)).filter((c) => c.command === "shell_notify").map((c) => c.args);
assert.deepEqual(notes, [
  { title: "Alice", body: "hello there", id: "m1" },
  { title: "Bob 提到了你", body: "look", id: "m3" },
]);
console.log("ok   DMs and mentions notify; duplicates, own messages and plain channel messages do not");

// Focused window: no notification.
await page.evaluate(() => { document.hasFocus = () => true; });
frame({ ...base, id: "m6", senderId: OTHER, senderName: "Alice", conversationContext: { channelType: "dm" } });
await page.waitForTimeout(200);
const after = (await page.evaluate(() => window.__CALLS__)).filter((c) => c.command === "shell_notify").length;
assert.equal(after, 2);
console.log("ok   no notification while the window is focused");

await browser.close();
