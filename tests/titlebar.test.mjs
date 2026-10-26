// Checks titlebar.js in Chromium against a stand-in for Raft's top bar,
// styled with the rules Raft's own stylesheet has for the official app's
// caption buttons (html[data-title-bar=overlay] [data-raft-titlebar]).
//   1. the page is told there is an overlay title bar, and Raft's top bar
//      leaves 138px free at its right end for the window buttons;
//   2. the buttons sit in that corner and call window_caption;
//   3. the maximize button turns into restore when the window is maximized;
//   4. the buttons take the top bar's text colour;
//   5. a page without Raft's top bar gets a drag strip, gone once the bar
//      appears;
//   6. on another site (a sign-in provider) there is only the drag strip.
//
// Usage: node tests/titlebar.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = readFileSync(join(root, "src-tauri/src/titlebar.js"), "utf8");

// Raft's rules, as in its stylesheet (October 2026).
const RAFT_CSS = `
  body { margin: 0; color: rgb(20, 20, 20); }
  [data-raft-titlebar] { -webkit-app-region: drag; display: flex; height: 48px; background: rgb(250, 200, 40); color: rgb(30, 30, 90); }
  [data-raft-titlebar] :is(button, a, input) { -webkit-app-region: no-drag; }
  html[data-title-bar=overlay]:not([data-fullscreen]) [data-raft-titlebar] {
    padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)));
  }`;
const page = (bar) => `<!doctype html><html><head><style>${RAFT_CSS}</style></head><body><div id="root">${
  bar ? `<div data-raft-titlebar data-testid="app-top-bar"><button id="bell">bell</button></div>` : ""
}</div><script>
  window.addBar = () => { document.getElementById("root").innerHTML = '<div data-raft-titlebar><button>bell</button></div>'; };
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

const context = await browser.newContext({ viewport: { width: 1200, height: 700 } });
await context.route("https://app.raft.build/**", (r) =>
  r.fulfill({ contentType: "text/html", body: page(!r.request().url().includes("nobar")) }),
);
await context.route("https://accounts.google.com/**", (r) => r.fulfill({ contentType: "text/html", body: page(false) }));
await context.addInitScript(() => {
  window.__calls = [];
  window.__maximized = false;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      window.__calls.push([cmd, args.params.action]);
      if (args.params.action === "toggleMaximize") window.__maximized = !window.__maximized;
      return Promise.resolve({ status: "ok", maximized: window.__maximized });
    },
  };
});
await context.addInitScript(script);

const raft = await context.newPage();
await raft.goto("https://app.raft.build/s/alpha/channel/general");
await raft.waitForSelector("#pontoon-caption", { state: "attached" });

await check("Raft's top bar leaves the window buttons' corner free", async () => {
  assert.equal(await raft.evaluate(() => document.documentElement.dataset.titleBar), "overlay");
  const pad = await raft.evaluate(() => getComputedStyle(document.querySelector("[data-raft-titlebar]")).paddingRight);
  assert.equal(pad, "138px");
  const bell = await raft.locator("#bell").boundingBox();
  assert.ok(bell.x + bell.width <= 1200 - 138, `bell ends at ${bell.x + bell.width}`);
});

await check("the buttons sit in that corner", async () => {
  const box = await raft.locator("#pontoon-caption").boundingBox();
  assert.deepEqual(box, { x: 1200 - 138, y: 0, width: 138, height: 48 });
});

await check("the buttons minimize, maximize and close the window", async () => {
  await raft.evaluate(() => (window.__calls = []));
  for (const b of ["minimize", "maximize", "close"]) await raft.locator(`#pontoon-caption >> button.${b}`).click();
  const calls = await raft.evaluate(() => window.__calls.map((c) => c[1]).filter((a) => a !== "state"));
  assert.deepEqual(calls, ["minimize", "toggleMaximize", "close"]);
  assert.ok((await raft.evaluate(() => window.__calls)).every((c) => c[0] === "window_caption"));
});

await check("maximized, the middle button restores", async () => {
  // Maximizing resizes the page, which asks for the window state again.
  await raft.setViewportSize({ width: 1210, height: 700 });
  await raft.waitForTimeout(400);
  const max = raft.locator("#pontoon-caption >> button.maximize");
  assert.equal(await max.getAttribute("title"), "向下还原");
  assert.equal(await max.textContent(), "");
  await max.click();
  await raft.setViewportSize({ width: 1200, height: 700 });
  await raft.waitForTimeout(400);
  assert.equal(await max.getAttribute("title"), "最大化");
});

await check("the buttons take the top bar's text colour", async () => {
  await raft.waitForTimeout(300);
  const color = await raft.locator("#pontoon-caption >> button.minimize").evaluate((b) => getComputedStyle(b).color);
  assert.equal(color, "rgb(30, 30, 90)");
  await raft.evaluate(() => (document.querySelector("[data-raft-titlebar]").style.color = "rgb(255, 255, 255)"));
  await raft.waitForTimeout(400);
  const after = await raft.locator("#pontoon-caption >> button.minimize").evaluate((b) => getComputedStyle(b).color);
  assert.equal(after, "rgb(255, 255, 255)");
});

await check("with Raft's top bar there is no extra drag strip", async () => {
  assert.equal(await raft.locator("#pontoon-drag-strip").isVisible(), false);
});

await check("a page without the top bar can still be dragged, until the bar appears", async () => {
  const p = await context.newPage();
  await p.goto("https://app.raft.build/nobar");
  await p.waitForSelector("#pontoon-drag-strip", { state: "visible" });
  const strip = await p.locator("#pontoon-drag-strip").evaluate((s) => [getComputedStyle(s).webkitAppRegion || getComputedStyle(s).getPropertyValue("app-region"), s.getBoundingClientRect().width]);
  assert.equal(strip[0], "drag");
  assert.equal(strip[1], 1200 - 138);
  await p.evaluate(() => window.addBar());
  await p.waitForSelector("#pontoon-drag-strip", { state: "hidden" });
  await p.close();
});

await check("on a sign-in provider's page: a drag strip, no buttons", async () => {
  const p = await context.newPage();
  await p.goto("https://accounts.google.com/signin");
  await p.waitForSelector("#pontoon-drag-strip", { state: "visible" });
  assert.equal(await p.locator("#pontoon-caption").count(), 0);
  assert.equal(await p.locator("#pontoon-drag-strip").evaluate((s) => s.getBoundingClientRect().width), 1200);
  await p.close();
});

await browser.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All title bar checks passed");
