// Drives Pontoon's real WebView2 over CDP. Called by run-e2e.ps1.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const scenario = process.argv[2];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");

async function waitForPage(predicate, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) if (predicate(page.url())) return page;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no page matched; pages: ${browser.contexts().flatMap((c) => c.pages().map((p) => p.url())).join(", ")}`);
}

// Anything thrown outside a check (a page that never appears, say) is
// reported as a failure instead of ending the run silently.
process.on("uncaughtException", (e) => { console.log(`  FAIL ${scenario}: ${e.stack || e}`); process.exit(1); });
process.on("unhandledRejection", (e) => { console.log(`  FAIL ${scenario}: ${e?.stack || e}`); process.exit(1); });

// What titlebar.js shows in a page: Raft's top bar as the drag region, the
// corner it leaves free, and Pontoon's window buttons there.
const titleBarOf = (page) => page.evaluate(() => {
  const bar = document.querySelector("[data-raft-titlebar]");
  const cap = document.getElementById("pontoon-caption");
  const strip = document.getElementById("pontoon-drag-strip");
  const style = bar && getComputedStyle(bar);
  const b = cap?.getBoundingClientRect();
  return {
    bar: !!bar,
    region: style ? style.webkitAppRegion || style.getPropertyValue("-webkit-app-region") : null,
    padRight: style?.paddingRight,
    // + 0 turns -0 into 0, which deepStrictEqual tells apart.
    caption: b ? { right: Math.round(window.innerWidth - b.right) + 0, top: b.top + 0, width: b.width, height: b.height } : null,
    buttons: cap ? [...cap.shadowRoot.querySelectorAll("button")].map((x) => x.getAttribute("aria-label")) : [],
    strip: strip ? getComputedStyle(strip).display : null,
    captionColor: cap ? getComputedStyle(cap).getPropertyValue("--pontoon-caption-fg") : null,
    barColor: style?.color,
    clickables: bar ? bar.querySelectorAll("button, a, input, [role=button]").length : 0,
    clickablesNoDrag: bar ? [...bar.querySelectorAll("button, a, input, [role=button]")].filter((e) => {
      const s = getComputedStyle(e);
      return (s.webkitAppRegion || s.getPropertyValue("-webkit-app-region")) === "no-drag";
    }).length : 0,
    overlapping: bar && b ? [...bar.querySelectorAll("button, a, input, [role=button]")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > b.left && r.top < b.bottom;
    }).map((e) => e.getAttribute("aria-label") || e.textContent.trim().slice(0, 20) || e.tagName) : [],
  };
});
const assertTitleBar = (t) => {
  assert.ok(t.bar, "no [data-raft-titlebar] on the page");
  assert.equal(t.region, "drag");
  assert.ok(t.clickables > 0 && t.clickablesNoDrag === t.clickables, `top bar controls that would drag the window: ${t.clickables - t.clickablesNoDrag} of ${t.clickables}`);
  assert.ok(t.overlapping.length === 0, `top bar controls under the window buttons: ${t.overlapping.join(", ")}`);
  assert.equal(t.padRight, "138px", "Raft's top bar does not leave the buttons' corner free");
  assert.deepEqual(t.caption, { right: 0, top: 0, width: 138, height: 48 });
  assert.equal(t.buttons.length, 3, JSON.stringify(t.buttons));
  assert.equal(t.strip, "none", "the fallback drag strip is showing over Raft's top bar");
  assert.equal(t.captionColor.trim(), t.barColor, "window buttons are not in the top bar's text colour");
};

const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
};

if (scenario === "online") {
  const page = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await page.waitForLoadState("load");

  await check("web client renders", async () => {
    await page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, null, { timeout: 30_000 });
  });
  // James signs in by hand in the app window; everything after this runs logged in.
  const signedIn = () => page.evaluate(() => !!localStorage.getItem("slock_access_token"));
  if (!(await signedIn())) {
    console.log("  ..   waiting for you to sign in in the Pontoon window (up to 15 minutes)");
    const end = Date.now() + 15 * 60_000;
    while (!(await signedIn().catch(() => false)) && Date.now() < end) await page.waitForTimeout(2_000);
  }
  await check("signed in", async () => {
    assert.ok(await signedIn(), "no sign-in within 15 minutes");
    await page.waitForTimeout(5_000);
  });
  await check("signed-in session reaches the API from the app", async () => {
    const status = await page.evaluate(() => fetch("https://api.raft.build/api/auth/me", {
      headers: { Authorization: "Bearer " + localStorage.getItem("slock_access_token") },
    }).then((r) => r.status));
    assert.equal(status, 200);
  });
  await check("web client set a Raft window title after sign-in", async () => {
    await page.waitForFunction(() => document.title === "Raft" || document.title.endsWith(" | Raft"), null, { timeout: 30_000 });
  });

  await check("desktop environment injected", async () => {
    const env = await page.evaluate(() => window.__RAFT_DESKTOP_ENVIRONMENT__);
    assert.equal(env.environmentId, "production");
    assert.equal(env.frontendOrigin, "https://app.raft.build");
  });
  await check("document identity issued", async () => {
    await page.waitForFunction(() => !!window.__RAFT_DESKTOP_DOCUMENT__, null, { timeout: 15_000 });
  });
  await check("web handshake did not fail closed", async () => {
    await page.waitForTimeout(3_000);
    assert.equal(await page.locator("#raft-desktop-handshake-recovery").count(), 0);
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.raftDesktopCompatibility), "recovery");
  });

  const call = (command, params) => page.evaluate(
    ([command, params]) => window.__TAURI_INTERNALS__.invoke(command, params === null ? {} : { params }),
    [command, params],
  );
  const doc = await page.evaluate(() => window.__RAFT_DESKTOP_DOCUMENT__);

  await check("Raft's top bar is the title bar, with Pontoon's window buttons at its right end", async () => {
    await page.waitForSelector("[data-testid=app-top-bar][data-raft-titlebar]", { timeout: 30_000 });
    await page.waitForTimeout(500);
    const t = await titleBarOf(page);
    console.log(`       ${JSON.stringify(t)}`);
    assertTitleBar(t);
  });
  await check("the maximize button maximizes and restores the window", async () => {
    const maximized = () => call("window_caption", { action: "state" }).then((r) => r.maximized);
    const button = page.locator("#pontoon-caption >> button.maximize");
    const before = await maximized();
    await button.click();
    await page.waitForFunction(async (b) => (await window.__TAURI_INTERNALS__.invoke("window_caption", { params: { action: "state" } })).maximized !== b, before, { timeout: 10_000, polling: 300 });
    await page.waitForTimeout(500);
    assert.equal(await button.getAttribute("aria-label"), before ? "最大化" : "向下还原");
    await button.click();
    await page.waitForFunction(async (b) => (await window.__TAURI_INTERNALS__.invoke("window_caption", { params: { action: "state" } })).maximized === b, before, { timeout: 10_000, polling: 300 });
    await page.waitForTimeout(500);
    assert.equal(await button.getAttribute("aria-label"), before ? "向下还原" : "最大化");
  });
  await check("the minimize button minimizes the window", async () => {
    const minimized = () => call("window_caption", { action: "state" }).then((r) => r.minimized);
    await page.locator("#pontoon-caption >> button.minimize").click();
    const end = Date.now() + 10_000;
    while (!(await minimized()) && Date.now() < end) await page.waitForTimeout(300);
    assert.ok(await minimized(), "still not minimized after 10 s");
    await call("window_focus", null);
    await page.waitForTimeout(1_000);
    assert.equal(await minimized(), false, "window_focus did not bring it back");
  });
  await check("window_caption ignores unknown actions", async () => {
    const r = await call("window_caption", { action: "destroy" });
    assert.equal(r.status, "error");
  });
  // Raft's file and image viewer covers the window with a top bar of its own,
  // its close button at the right end. Opens the first file or picture on
  // screen; with none there is nothing to check.
  await check("the file viewer's close button sits left of the window buttons and closes only the viewer", async () => {
    const opened = await page.evaluate(() => {
      const FILE = /\.(md|markdown|txt|pdf|png|jpe?g|gif|webp|svg|docx?|xlsx?|pptx?|csv|json|html?|zip|log)$/i;
      const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 48 && r.bottom <= innerHeight; };
      const pictures = [...document.querySelectorAll("[data-timeline-row-key] img")].filter((e) => seen(e) && e.width >= 64 && e.height >= 48);
      const files = [...document.querySelectorAll("[data-timeline-row-key] :is(button, a, [role=button])")].filter((e) => seen(e) && FILE.test((e.getAttribute("aria-label") || e.textContent || "").trim()));
      const target = files[files.length - 1] || pictures[pictures.length - 1];
      if (!target) return null;
      target.setAttribute("data-pontoon-e2e-open", "");
      return target.tagName === "IMG" ? `picture ${target.alt || target.src.slice(0, 60)}` : (target.getAttribute("aria-label") || target.textContent).trim().slice(0, 60);
    });
    if (!opened) { console.log("       skipped: no file or picture on screen to open"); return; }
    await page.locator("[data-pontoon-e2e-open]").first().click();
    await page.waitForSelector("[data-testid=file-viewer-header]", { timeout: 15_000 });
    await page.waitForTimeout(800);
    const v = await page.evaluate(() => {
      const bar = document.querySelector("[data-testid=file-viewer-header]");
      const cap = document.getElementById("pontoon-caption").getBoundingClientRect();
      const s = getComputedStyle(bar);
      const controls = [...bar.querySelectorAll("button, a, [role=button]")].filter((e) => e.getBoundingClientRect().width > 0);
      const close = controls[controls.length - 1];
      const c = close.getBoundingClientRect();
      const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
      return {
        marked: bar.hasAttribute("data-raft-overlay-titlebar"),
        region: s.webkitAppRegion || s.getPropertyValue("-webkit-app-region"),
        padRight: s.paddingRight,
        captionShown: getComputedStyle(document.getElementById("pontoon-caption")).display !== "none",
        controls: controls.map((e) => e.getAttribute("aria-label")),
        under: controls.filter((e) => e.getBoundingClientRect().right > cap.left).map((e) => e.getAttribute("aria-label")),
        closeLabel: close.getAttribute("aria-label"),
        closeHitsItself: !!hit && close.contains(hit),
        layerOpen: document.documentElement.hasAttribute("data-raft-layer-open"),
      };
    });
    console.log(`       opened ${opened}: ${JSON.stringify(v)}`);
    assert.ok(v.marked, "the viewer's top bar is not marked as a title bar");
    assert.equal(v.padRight, `${16 + 138}px`);
    assert.equal(v.region, "drag");
    assert.ok(v.captionShown, "the window buttons are hidden while the viewer is open");
    assert.deepEqual(v.under, [], "viewer buttons under the window buttons");
    assert.ok(v.closeHitsItself, `the viewer's close button (${v.closeLabel}) is covered`);
    assert.ok(v.layerOpen, "no data-raft-layer-open while the viewer is open");
    const before = await call("window_caption", { action: "state" });
    await page.locator("[data-testid=file-viewer-header] :is(button, a, [role=button])").last().click();
    await page.waitForSelector("[data-testid=file-viewer-header]", { state: "detached", timeout: 10_000 });
    const after = await call("window_caption", { action: "state" });
    assert.equal(after.status, "ok", "the window is gone after closing the viewer");
    assert.equal(after.minimized, before.minimized);
    await page.evaluate(() => document.querySelector("[data-pontoon-e2e-open]")?.removeAttribute("data-pontoon-e2e-open"));
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-raft-layer-open"), null, { timeout: 5_000 });
  });

  await check("native handshake answers ok", async () => {
    const r = await call("desktop_handshake", {
      frontendReleaseId: "e2e", protocolVersion: 1,
      capabilities: ["desktop.handshake", "window.focus", "window.bindServer"],
      documentGeneration: doc.generation, documentNonce: doc.nonce,
      environmentId: "production", environmentGeneration: 1,
    });
    assert.equal(r.status, "ok", JSON.stringify(r));
    assert.equal(r.result.compatibilityState, "readyMinimum");
  });
  await check("stale identity is rejected", async () => {
    const r = await call("window_bind_server", {
      serverId: "123e4567-e89b-12d3-a456-426614174000",
      documentGeneration: doc.generation + 100, documentNonce: "stale",
    });
    assert.equal(r.status, "error");
    assert.equal(r.error.code, "stale_document");
  });
  await check("bindServer and setServerTitle", async () => {
    const b = await call("window_bind_server", {
      serverId: "123e4567-e89b-12d3-a456-426614174000",
      documentGeneration: doc.generation, documentNonce: doc.nonce,
    });
    assert.equal(b.status, "ok", JSON.stringify(b));
    const t = await call("window_set_server_title", {
      documentGeneration: doc.generation, documentNonce: doc.nonce, title: "E2E check | Raft",
    });
    assert.equal(t.status, "ok", JSON.stringify(t));
  });
  await check("window.focus", async () => {
    const r = await call("window_focus", null);
    assert.equal(r.method, "window.focus");
  });
  await check("notification hook installed in the main window", async () => {
    assert.equal(await page.evaluate(() => window.__PONTOON_NOTIFY__), true);
    assert.equal(await page.evaluate(() => window.__PONTOON_NOTIFY_PRIMARY__), true);
  });
  await check("notify_push_state is callable from Raft", async () => {
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("notify_push_state", { live: true }));
  });
  await check("remote page cannot call unlisted native commands", async () => {
    const err = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: "https://example.com" }).then(() => null, (e) => String(e)));
    assert.ok(err, "opener call from the remote page should be denied");
  });
  await check("reload issues a new identity and handshakes again", async () => {
    await page.reload();
    await page.waitForFunction((g) => window.__RAFT_DESKTOP_DOCUMENT__ && window.__RAFT_DESKTOP_DOCUMENT__.generation > g, doc.generation, { timeout: 30_000 });
    await page.waitForTimeout(3_000);
    assert.equal(await page.locator("#raft-desktop-handshake-recovery").count(), 0);
    assert.ok(await signedIn(), "sign-in was lost on reload");
    // Restore the title the PowerShell side checks.
    const d = await page.evaluate(() => window.__RAFT_DESKTOP_DOCUMENT__);
    const t = await call("window_set_server_title", { documentGeneration: d.generation, documentNonce: d.nonce, title: "E2E check | Raft" });
    assert.equal(t.status, "ok");
  });
  await check("same-tab navigation to other sites stays blocked", async () => {
    await page.evaluate(() => { window.location.href = "https://example.com/?pontoon-e2e"; });
    await page.waitForTimeout(3_000);
    assert.ok(page.url().startsWith("https://app.raft.build/"), page.url());
  });
  await check("a chat link (target=_blank) is handed to the default browser", async () => {
    // Chat messages render links as <a target="_blank" rel="noopener noreferrer">.
    // navigation.log keeps only origin and path, so the marker goes in the path.
    const marker = `pontoon-e2e-link-${Date.now()}`;
    const href = `https://example.com/${marker}`;
    const pagesBefore = browser.contexts().flatMap((c) => c.pages()).length;
    await page.evaluate((href) => {
      const a = document.createElement("a");
      a.id = "pontoon-e2e-link";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "e2e link";
      // Over Raft's top bar, which is a drag region now; keep the link clickable.
      a.style.cssText = "position:fixed;top:4px;left:4px;z-index:2147483647;background:#fff;padding:4px;-webkit-app-region:no-drag";
      document.body.append(a);
    }, href);
    await page.click("#pontoon-e2e-link");
    await page.evaluate(() => document.getElementById("pontoon-e2e-link")?.remove());
    const log = join(process.env.LOCALAPPDATA, "build.pontoon.desktop", "logs", "navigation.log");
    const end = Date.now() + 15_000;
    let lines = [];
    while (Date.now() < end) {
      lines = readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.endsWith(href));
      if (lines.some((l) => / browser(-failed\[.*\])? /.test(l))) break;
      await page.waitForTimeout(500);
    }
    assert.ok(lines.some((l) => l.includes(` new-tab ${href}`)), `no new-tab line: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.includes(` browser ${href}`)), `not handed to the browser: ${JSON.stringify(lines)}`);
    assert.ok(page.url().startsWith("https://app.raft.build/"), page.url());
    assert.equal(browser.contexts().flatMap((c) => c.pages()).length, pagesBefore, "the link opened inside Pontoon");
  });
  await check("a blocked navigation leaves the page's identity valid", async () => {
    // WebView2 reports the blocked load as finished; the page must still be
    // able to open server windows afterwards.
    const d = await page.evaluate(() => window.__RAFT_DESKTOP_DOCUMENT__);
    const t = await call("window_set_server_title", { documentGeneration: d.generation, documentNonce: d.nonce, title: "E2E check | Raft" });
    assert.equal(t.status, "ok", JSON.stringify(t));
  });
}

// run-e2e.ps1 backs up settings.json before the font scenario and puts it
// back byte for byte at the end, so these scenarios may change the fonts.
// Fonts every Chinese Windows install has, and that look clearly different.
// The Latin ones have no Chinese characters, so Chinese text has to come
// from the Chinese ones.
const TEST = {
  ui: "Georgia", chat: "Times New Roman", code: "Courier New",
  uiCjk: "KaiTi", chatCjk: "FangSong", codeCjk: "SimSun",
};
// The names Windows may report for the Chinese fonts instead.
const LOCAL_NAME = { KaiTi: "楷体", FangSong: "仿宋", SimSun: "宋体" };

// A message-like element and a code element inside Raft's own markdown
// container, so the checks don't depend on what the open channel shows.
const fontsOnPage = (page) => page.evaluate(() => {
  let probe = document.getElementById("pontoon-e2e-probe");
  if (!probe) {
    probe = document.createElement("div");
    probe.id = "pontoon-e2e-probe";
    probe.innerHTML = '<span id="pontoon-e2e-ui-cjk">设置</span><div data-raft-markdown-content style="display:contents">'
      + '<p id="pontoon-e2e-msg"><span id="pontoon-e2e-msg-latin">hi</span> <code id="pontoon-e2e-code">x</code></p><p id="pontoon-e2e-msg-cjk">你好</p>'
      + '<code id="pontoon-e2e-code-cjk">中文注释</code></div>';
    document.getElementById("root").appendChild(probe);
  }
  const ui = [...document.querySelectorAll("#root *")].find((e) => e.childElementCount === 0 && e.textContent.trim()
    && !e.closest("code, pre, kbd, samp, .font-mono, [data-raft-markdown-content]"));
  const f = (el) => (el ? getComputedStyle(el).fontFamily : "");
  return { ui: f(ui), chat: f(document.getElementById("pontoon-e2e-msg")), code: f(document.getElementById("pontoon-e2e-code")) };
});
const uses = (actual, family) => actual.replace(/"/g, "").startsWith(family);
// The fonts Chromium actually drew an element's text with, as DevTools shows
// them, so a Chinese font listed second is seen to draw the Chinese text.
const drawnWith = async (page, selector) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((f) => f.familyName);
  } finally {
    await cdp.detach().catch(() => {});
  }
};
const drawnIn = (drawn, family) => drawn.length > 0 && drawn.every((f) => f === family || f === LOCAL_NAME[family]);

if (scenario === "font") {
  const settings = await waitForPage((u) => u.endsWith("/settings.html"), 30_000);
  const main = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await settings.waitForLoadState("load");
  const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(
    (value) => ({ value }), (e) => ({ error: String(e) })), [cmd, args]);

  await check("settings window lists the installed fonts", async () => {
    const started = Date.now();
    await settings.waitForFunction(() => document.querySelectorAll("#list li").length > 10, null, { timeout: 30_000 });
    console.log(`  ..   font list shown after ${Date.now() - started} ms`);
    const families = await settings.$$eval("#list li", (els) => els.map((e) => e.dataset.family));
    assert.ok(families.includes("Microsoft YaHei"), "Microsoft YaHei missing from the list");
    for (const f of [TEST.ui, TEST.chat]) assert.ok(families.includes(f), `${f} missing from the list`);
  });
  await check("code tab lists monospace fonts only", async () => {
    await settings.getByRole("tab", { name: /代码字体/ }).click();
    const families = await settings.$$eval("#list li", (els) => els.map((e) => e.dataset.family).filter(Boolean));
    assert.ok(families.includes("Consolas") && families.includes(TEST.code), families.join(", "));
    assert.ok(!families.includes("Microsoft YaHei"), "a proportional font is listed as monospace");
  });
  await check("current choice is readable", async () => {
    const r = await invoke(settings, "font_get", {});
    assert.ok(!r.error, r.error);
    assert.deepEqual(Object.keys(r.value).sort(), ["chat", "chatCjk", "code", "codeCjk", "ui", "uiCjk"]);
  });
  await check("Chinese font list holds only fonts with Chinese characters", async () => {
    await settings.getByRole("tab", { name: /界面字体/ }).click();
    await settings.getByRole("radio", { name: "中文字体" }).click();
    const families = await settings.$$eval("#list li", (els) => els.map((e) => e.dataset.family).filter(Boolean));
    for (const f of ["Microsoft YaHei", TEST.uiCjk, TEST.chatCjk, TEST.codeCjk]) assert.ok(families.includes(f), `${f} missing`);
    for (const f of [TEST.ui, TEST.chat, TEST.code, "Consolas"]) assert.ok(!families.includes(f), `${f} listed as Chinese`);
    await settings.getByRole("radio", { name: "西文字体" }).click();
  });
  await check("interface, chat and code fonts apply separately", async () => {
    for (const [part, tab] of [["ui", "界面字体"], ["chat", "对话字体"], ["code", "代码字体"]]) {
      await settings.getByRole("tab", { name: new RegExp(tab) }).click();
      await settings.getByRole("radio", { name: "西文字体" }).click();
      await settings.locator(`#list li[data-family="${TEST[part]}"]`).click();
      await settings.getByRole("radio", { name: "中文字体" }).click();
      await settings.locator(`#list li[data-family="${TEST[part + "Cjk"]}"]`).click();
    }
    await settings.getByRole("button", { name: "应用" }).click();
    await settings.locator("#status", { hasText: "已应用" }).waitFor({ timeout: 10_000 });
    await main.waitForTimeout(500);
    const f = await fontsOnPage(main);
    assert.ok(uses(f.ui, TEST.ui), `interface text uses ${f.ui}`);
    assert.ok(uses(f.chat, TEST.chat), `chat text uses ${f.chat}`);
    assert.ok(uses(f.code, TEST.code), `code uses ${f.code}`);
  });
  await check("Latin and Chinese text are drawn with their own fonts", async () => {
    const drawn = {};
    for (const [name, sel] of [["chat", "#pontoon-e2e-msg-latin"], ["chatCjk", "#pontoon-e2e-msg-cjk"], ["uiCjk", "#pontoon-e2e-ui-cjk"],
      ["code", "#pontoon-e2e-code"], ["codeCjk", "#pontoon-e2e-code-cjk"]]) {
      drawn[name] = await drawnWith(main, sel);
    }
    console.log(`  ..   drawn with ${JSON.stringify(drawn)}`);
    for (const name of Object.keys(drawn)) assert.ok(drawnIn(drawn[name], TEST[name]), `${name} drawn with ${drawn[name]}`);
  });
  await check("a real message in the open channel uses the chat font", async () => {
    const f = await main.evaluate(() => {
      const el = [...document.querySelectorAll("#root [data-raft-markdown-content] *")]
        .find((e) => e.childElementCount === 0 && e.textContent.trim() && !e.closest("#pontoon-e2e-probe, code, pre, .font-mono"));
      return el ? getComputedStyle(el).fontFamily : null;
    });
    if (f === null) console.log("  ..   no message visible in the open channel; covered by the probe above");
    else assert.ok(uses(f, TEST.chat), f);
  });
  await check("the message box uses the chat font", async () => {
    const box = main.locator('[data-testid="composer-textarea"]').first();
    await box.waitFor({ timeout: 15_000 });
    const f = await box.evaluate((e) => getComputedStyle(e).fontFamily);
    assert.ok(uses(f, TEST.chat), `message box uses ${f}`);
    assert.ok(f.includes(TEST.chatCjk), `message box has no ${TEST.chatCjk}: ${f}`);
  });
  await check("unset chat font follows the interface font", async () => {
    const r = await invoke(settings, "font_set", { fonts: { ui: TEST.ui, uiCjk: TEST.uiCjk, chat: null, code: TEST.code } });
    assert.ok(!r.error, r.error);
    await main.waitForTimeout(500);
    const f = await fontsOnPage(main);
    assert.ok(uses(f.chat, TEST.ui), `chat text uses ${f.chat}`);
    assert.ok(!uses(f.code, TEST.ui), `code uses ${f.code}`);
    assert.ok(drawnIn(await drawnWith(main, "#pontoon-e2e-msg-cjk"), TEST.uiCjk), "chat Chinese does not follow the interface");
    assert.ok(drawnIn(await drawnWith(main, "#pontoon-e2e-code-cjk"), TEST.uiCjk), "code Chinese does not follow the chat");
  });
  await check("fonts survive a reload", async () => {
    const r = await invoke(settings, "font_set", { fonts: TEST });
    assert.ok(!r.error, r.error);
    await main.reload();
    await main.waitForLoadState("domcontentloaded");
    await main.waitForFunction(() => document.getElementById("root")?.childElementCount > 0, null, { timeout: 30_000 });
    const f = await fontsOnPage(main);
    assert.ok(uses(f.ui, TEST.ui) && uses(f.chat, TEST.chat) && uses(f.code, TEST.code), JSON.stringify(f));
  });
  await check("app.raft.build cannot change the fonts", async () => {
    const r = await invoke(main, "font_set", { fonts: { ui: "Arial" } });
    assert.ok(r.error, "font_set from the remote page should be denied");
  });
  await check("unsafe font names are rejected", async () => {
    let r = await invoke(settings, "font_set", { fonts: { ...TEST, code: 'x"} body{display:none' } });
    assert.ok(r.error, "an unsafe name was accepted");
    r = await invoke(settings, "font_set", { fonts: { ...TEST, chatCjk: "x</style>" } });
    assert.ok(r.error, "an unsafe Chinese font name was accepted");
    assert.ok(uses((await fontsOnPage(main)).code, TEST.code));
  });
}

if (scenario === "notify") {
  // run-e2e.ps1 minimizes the window first: a window you are looking at gets
  // no notification. The id is fresh each run, so it is never a duplicate.
  const page = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await check("a plain channel message is left alone by default", async () => {
    await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("shell_notify", {
      title: "Pontoon E2E", body: "普通频道消息测试", id, important: false,
    }), `e2e-plain-${Date.now()}`);
  });
  await check("a notification for a window in the background", async () => {
    await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("shell_notify", {
      title: "Pontoon E2E", body: "测试通知，可以忽略", id, url: "https://app.raft.build/", attribution: "E2E",
    }), `e2e-${Date.now()}`);
  });
  await check("the same message again is dropped", async () => {
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("shell_notify", { title: "Pontoon E2E", body: "重复消息测试", id: "e2e-dup" }));
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("shell_notify", { title: "Pontoon E2E", body: "重复消息测试", id: "e2e-dup" }));
  });
}

if (scenario === "focus") {
  // Brings the window back the way a toast click does; focusing it clears its badge.
  const page = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await check("window.focus brings the window back", async () => {
    const r = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("window_focus", {}));
    assert.equal(r.method, "window.focus");
  });
}

if (scenario === "relaunch") {
  const page = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await page.waitForLoadState("load");
  await check("sign-in survives an app restart", async () => {
    assert.ok(await page.evaluate(() => !!localStorage.getItem("slock_access_token")), "signed out after restart");
  });
  await check("handshake ok after restart", async () => {
    await page.waitForFunction(() => !!window.__RAFT_DESKTOP_DOCUMENT__, null, { timeout: 15_000 });
    await page.waitForTimeout(3_000);
    assert.equal(await page.locator("#raft-desktop-handshake-recovery").count(), 0);
  });
  // Started with --font-settings: check the fonts from the font scenario
  // survived the restart.
  const settings = await waitForPage((u) => u.endsWith("/settings.html"), 30_000);
  await settings.waitForLoadState("load");
  await check("font choices survive an app restart", async () => {
    const tested = await settings.evaluate(() => window.__TAURI_INTERNALS__.invoke("font_get", {}));
    assert.deepEqual(tested, TEST);
    await page.waitForFunction(() => document.getElementById("root")?.childElementCount > 0, null, { timeout: 30_000 });
    const f = await fontsOnPage(page);
    assert.ok(uses(f.ui, TEST.ui) && uses(f.chat, TEST.chat) && uses(f.code, TEST.code), JSON.stringify(f));
    assert.ok(drawnIn(await drawnWith(page, "#pontoon-e2e-msg-cjk"), TEST.chatCjk), "chat Chinese font lost on restart");
  });
  await page.evaluate(() => document.getElementById("pontoon-e2e-probe")?.remove());
}

// Several server windows. Written by "multiwindow", read by "restore".
const multiFile = join(tmpdir(), "pontoon-e2e-multiwindow.json");
const SECOND_TITLE = "E2E second window | Raft";
const appPages = () => browser.contexts().flatMap((c) => c.pages()).filter((p) => p.url().startsWith("https://app.raft.build/"));
const invokeIn = (page, command, params) => page.evaluate(
  ([command, params]) => window.__TAURI_INTERNALS__.invoke(command, params === null ? {} : { params }),
  [command, params],
);
const identity = async (page) => {
  await page.waitForFunction(() => !!window.__RAFT_DESKTOP_DOCUMENT__, null, { timeout: 30_000 });
  return page.evaluate(() => window.__RAFT_DESKTOP_DOCUMENT__);
};
// The page title too, since raft_shim.js makes the window title follow it.
const setTitle = async (page, title) => {
  await page.evaluate((t) => { document.title = t; }, title);
  const d = await identity(page);
  const r = await invokeIn(page, "window_set_server_title", { documentGeneration: d.generation, documentNonce: d.nonce, title });
  assert.equal(r.status, "ok", JSON.stringify(r));
};

if (scenario === "multiwindow") {
  const main = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  const servers = await main.evaluate(() => fetch("https://api.raft.build/api/servers", {
    headers: { Authorization: "Bearer " + localStorage.getItem("slock_access_token") },
  }).then((r) => r.json()));
  const currentSlug = new URL(main.url()).pathname.match(/^\/s\/([^/]+)/)?.[1];
  const target = Array.isArray(servers) ? servers.find((s) => s.slug !== currentSlug) : null;
  writeFileSync(multiFile, JSON.stringify(target ? { id: target.id, slug: target.slug } : null));

  await check("shell advertises window.openServer", async () => {
    assert.equal(await main.evaluate(() => window.__RAFT_DESKTOP_NATIVE_EXTENSIONS__["window.openServer"]), 1);
  });
  if (!target) {
    console.log("  ..   only one server on this account; skipping the second-window checks");
  } else {
    let second;
    // Raft 1.21.28 opens a server in a new window as a plain link
    // (middle-click runs window.open, Ctrl-click follows the link).
    const openLink = (page, url) => page.evaluate((u) => { window.open(u, "_blank", "noopener,noreferrer"); }, url);
    await check(`a link to ${target.slug} opens it in a new window`, async () => {
      await openLink(main, `https://app.raft.build/s/${target.slug}`);
      second = await waitForPage((u) => u.startsWith(`https://app.raft.build/s/${target.slug}`), 90_000);
    });
    await check("the new window completes the desktop handshake, signed in", async () => {
      await identity(second);
      await second.waitForTimeout(5_000);
      assert.equal(await second.locator("#raft-desktop-handshake-recovery").count(), 0);
      assert.ok(await second.evaluate(() => !!localStorage.getItem("slock_access_token")), "second window is signed out");
    });
    await check("the new window has the same title bar and window buttons", async () => {
      await second.waitForSelector("[data-testid=app-top-bar][data-raft-titlebar]", { timeout: 30_000 });
      await second.waitForTimeout(500);
      assertTitleBar(await titleBarOf(second));
    });
    await check("the first window stays on its own server", async () => {
      if (currentSlug) assert.ok(new URL(main.url()).pathname.startsWith(`/s/${currentSlug}`), main.url());
    });
    await check("the new window is bound to its server", async () => {
      // raft_shim.js binds it once the page is on the server.
      await second.waitForFunction((id) => JSON.parse(localStorage.getItem("pontoon.servers") || "[]").some((s) => s.id === id),
        target.id.toLowerCase(), { timeout: 30_000 });
      await second.waitForTimeout(2_000);
    });
    await check("a link to the same server again focuses the existing window", async () => {
      const before = appPages().length;
      await openLink(main, `https://app.raft.build/s/${target.slug}`);
      await main.waitForTimeout(3_000);
      assert.equal(appPages().length, before);
    });
    await check("opening the same server again focuses the existing window", async () => {
      const before = appPages().length;
      const d = await identity(main);
      const r = await invokeIn(main, "window_open_server", { serverId: target.id, documentGeneration: d.generation, documentNonce: d.nonce });
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.equal(r.result.disposition, "focusedExisting");
      await main.waitForTimeout(3_000);
      assert.equal(appPages().length, before);
    });
    await check("a bad server ID is rejected", async () => {
      const d = await identity(main);
      const r = await invokeIn(main, "window_open_server", { serverId: "../settings", documentGeneration: d.generation, documentNonce: d.nonce });
      assert.equal(r.status, "error");
      assert.equal(r.error.code, "invalid_server_id");
    });
    // Titles the PowerShell side looks the windows up by.
    await check("second window title", () => setTitle(second, SECOND_TITLE));
  }
  await check("main window title", () => setTitle(main, "E2E check | Raft"));
}

if (scenario === "restore") {
  const target = JSON.parse(readFileSync(multiFile, "utf8"));
  if (!target) {
    console.log("  ..   only one server on this account; nothing to restore");
  } else {
    await check(`the ${target.slug} window comes back after a restart`, async () => {
      const page = await waitForPage((u) => u.startsWith(`https://app.raft.build/s/${target.slug}`), 90_000);
      await identity(page);
      await page.waitForTimeout(3_000);
      assert.equal(await page.locator("#raft-desktop-handshake-recovery").count(), 0);
      await setTitle(page, SECOND_TITLE);
    });
  }
}

if (scenario === "offline") {
  const page = await waitForPage((u) => u.endsWith("/recovery.html"), 45_000);
  await check("recovery page shown when Raft is unreachable", async () => {
    await page.getByRole("button", { name: "重试" }).waitFor({ timeout: 10_000 });
  });
  await check("the recovery page can be dragged and has the window buttons", async () => {
    const t = await titleBarOf(page);
    assert.equal(t.strip, "block", JSON.stringify(t));
    assert.equal(t.buttons.length, 3, JSON.stringify(t));
  });
  await check("retry stays on recovery while still offline", async () => {
    await page.getByRole("button", { name: "重试" }).click();
    // The retry probe fails fast here, so the page may pass through index.html
    // too quickly to observe; what matters is that it settles on recovery again.
    await page.waitForTimeout(3_000);
    await page.waitForURL(/\/recovery\.html$/, { timeout: 45_000 });
    await page.getByRole("button", { name: "重试" }).waitFor({ timeout: 10_000 });
  });
  await check("quit button exits", async () => {
    await page.getByRole("button", { name: "退出" }).click({ timeout: 10_000 }).catch((e) => {
      // The click can race the process exit; only a missing button is a failure.
      if (!/closed|Target|disconnected/i.test(String(e))) throw e;
    });
  });
}

await browser.close().catch(() => {});
