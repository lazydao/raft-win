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
  await check("native notification command", async () => {
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("shell_notify", { title: "Pontoon E2E", body: "Test notification" }));
  });
  await check("notification hook installed", async () => {
    assert.equal(await page.evaluate(() => window.__PONTOON_NOTIFY__), true);
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
}

// The font chosen before the test, restored by the relaunch scenario.
const savedFontFile = join(tmpdir(), "pontoon-e2e-font.json");
// A font every Chinese Windows install has, and that looks clearly different.
const TEST_FONTS = ["KaiTi", "SimSun", "FangSong", "Consolas"];
const bodyFont = (page) => page.evaluate(() => getComputedStyle(document.body).fontFamily);

if (scenario === "font") {
  const settings = await waitForPage((u) => u.endsWith("/settings.html"), 30_000);
  const main = await waitForPage((u) => u.startsWith("https://app.raft.build/"));
  await settings.waitForLoadState("load");
  const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a).then(
    (value) => ({ value }), (e) => ({ error: String(e) })), [cmd, args]);
  let family;

  await check("settings window lists the installed fonts", async () => {
    await settings.waitForFunction(() => document.querySelectorAll("#list li").length > 10, null, { timeout: 15_000 });
    const families = await settings.$$eval("#list li", (els) => els.map((e) => e.dataset.family));
    assert.ok(families.includes("Microsoft YaHei"), "Microsoft YaHei missing from the list");
    family = TEST_FONTS.find((f) => families.includes(f));
    assert.ok(family, "none of the test fonts is installed");
  });
  await check("current choice is readable", async () => {
    const r = await invoke(settings, "font_get", {});
    assert.ok(!r.error, r.error);
    writeFileSync(savedFontFile, JSON.stringify({ family: r.value ?? null }));
  });
  await check(`choosing ${family} applies it to Raft right away`, async () => {
    await settings.locator(`#list li[data-family="${family}"]`).click();
    await settings.getByRole("button", { name: "应用" }).click();
    await settings.locator("#status", { hasText: "已应用" }).waitFor({ timeout: 10_000 });
    await main.waitForFunction((f) => getComputedStyle(document.body).fontFamily.includes(f), family, { timeout: 10_000 });
    const inApp = await main.evaluate(() => {
      const el = [...document.querySelectorAll("#root *")].find((e) => e.childElementCount === 0 && e.textContent.trim() && !e.closest("code, pre, .font-mono"));
      return el ? getComputedStyle(el).fontFamily : "";
    });
    assert.ok(inApp.includes(family), `Raft text uses ${inApp}`);
  });
  await check("code keeps a monospace font", async () => {
    const f = await main.evaluate(() => {
      const c = document.createElement("code");
      c.textContent = "x";
      document.getElementById("root").appendChild(c);
      const v = getComputedStyle(c).fontFamily;
      c.remove();
      return v;
    });
    assert.ok(!f.includes(family), f);
  });
  await check("font survives a reload", async () => {
    await main.reload();
    await main.waitForLoadState("domcontentloaded");
    assert.ok((await bodyFont(main)).includes(family), await bodyFont(main));
  });
  await check("app.raft.build cannot change the font", async () => {
    const r = await invoke(main, "font_set", { family: "Arial" });
    assert.ok(r.error, "font_set from the remote page should be denied");
  });
  await check("unsafe font names are rejected", async () => {
    const r = await invoke(settings, "font_set", { family: 'x"} body{display:none' });
    assert.ok(r.error, "an unsafe name was accepted");
    assert.ok((await bodyFont(main)).includes(family));
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
  // Started with --font-settings: check the font from the font scenario
  // survived the restart, then put back what was chosen before the test.
  const settings = await waitForPage((u) => u.endsWith("/settings.html"), 30_000);
  await settings.waitForLoadState("load");
  const saved = JSON.parse(readFileSync(savedFontFile, "utf8")).family;
  const tested = await settings.evaluate(() => window.__TAURI_INTERNALS__.invoke("font_get", {}));
  await check("font choice survives an app restart", async () => {
    assert.ok(TEST_FONTS.includes(tested), `saved font is ${tested}`);
    assert.ok((await bodyFont(page)).includes(tested), await bodyFont(page));
  });
  await check("restoring the previous font", async () => {
    await settings.evaluate((f) => window.__TAURI_INTERNALS__.invoke("font_set", { family: f }), saved);
    if (saved) await page.waitForFunction((f) => getComputedStyle(document.body).fontFamily.includes(f), saved, { timeout: 10_000 });
    else await page.waitForFunction(() => !document.getElementById("pontoon-font"), null, { timeout: 10_000 });
  });
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
const setTitle = async (page, title) => {
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
    await check(`window.openServer opens ${target.slug} in a new window`, async () => {
      const d = await identity(main);
      const r = await invokeIn(main, "window_open_server", { serverId: target.id, documentGeneration: d.generation, documentNonce: d.nonce });
      assert.equal(r.status, "ok", JSON.stringify(r));
      assert.equal(r.result.disposition, "opened");
      second = await waitForPage((u) => u.startsWith(`https://app.raft.build/s/${target.slug}`), 90_000);
    });
    await check("the new window completes the desktop handshake, signed in", async () => {
      await identity(second);
      await second.waitForTimeout(5_000);
      assert.equal(await second.locator("#raft-desktop-handshake-recovery").count(), 0);
      assert.ok(await second.evaluate(() => !!localStorage.getItem("slock_access_token")), "second window is signed out");
    });
    await check("the first window stays on its own server", async () => {
      if (currentSlug) assert.ok(new URL(main.url()).pathname.startsWith(`/s/${currentSlug}`), main.url());
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
