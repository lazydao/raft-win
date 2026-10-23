// Checks font.js and the font settings window in Chromium, without Windows:
//   1. font.js turns each choice into the font lists Raft's text ends up with,
//      Latin font first and Chinese font second, with the documented fallbacks
//      (chat follows the interface, Chinese in code follows the chat);
//   2. settings from before the Chinese fonts existed render as they did;
//   3. the settings window shows only Chinese-capable fonts for the Chinese
//      half of a part, and saves all six choices.
//
// Usage: node tests/font.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fontJs = readFileSync(join(root, "src-tauri/src/font.js"), "utf8");
const settingsHtml = readFileSync(join(root, "dist/settings.html"), "utf8");

const RAFT_PAGE = `<!doctype html><html><head>
<style>:root{--sans-font:"Space Grotesk",sans-serif}body{font-family:var(--font-sans,var(--sans-font))}</style>
</head><body>
<nav id="ui">频道 Channels</nav>
<div data-raft-markdown-content=""><p id="chat">你好 hello</p><pre><code id="block">let a = 1; // 注释</code></pre></div>
<span class="font-mono" id="mono">abc</span>
</body></html>`;

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

const page = await browser.newPage();
await page.route("https://app.raft.build/**", (r) => r.fulfill({ contentType: "text/html", body: RAFT_PAGE }));
await page.addInitScript(fontJs);
await page.goto("https://app.raft.build/");
// Chromium quotes only names that need it, so lists are compared unquoted.
const unquote = (s) => s.replace(/"/g, "");
const families = (fonts) =>
  page.evaluate((fonts) => {
    window.__pontoonSetFont(fonts);
    const f = (id) => getComputedStyle(document.getElementById(id)).fontFamily.replace(/"/g, "");
    return { ui: f("ui"), chat: f("chat"), code: f("block"), mono: f("mono") };
  }, fonts);
const RAFT_CJK = "PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans SC";

console.log("== font.js");
await check("nothing chosen leaves Raft's fonts alone", async () => {
  const f = await families({});
  assert.equal(f.ui, "Space Grotesk, sans-serif");
  assert.equal(await page.evaluate(() => document.getElementById("pontoon-font")), null);
});
await check("a 0.5 setting renders as before, with Raft's Chinese fonts behind it", async () => {
  const f = await families({ ui: "Segoe UI", chat: null, code: "Consolas" });
  assert.equal(f.ui, `Segoe UI, ${RAFT_CJK}, sans-serif`);
  assert.equal(f.chat, f.ui);
  assert.equal(f.code, "Consolas, monospace");
  assert.equal(f.mono, f.code);
});
await check("each part splits Latin and Chinese", async () => {
  const f = await families({
    ui: "Segoe UI", uiCjk: "Microsoft YaHei",
    chat: "Georgia", chatCjk: "LXGW WenKai",
    code: "Cascadia Code", codeCjk: "Sarasa Mono SC",
  });
  assert.equal(f.ui, "Segoe UI, Microsoft YaHei, sans-serif");
  assert.equal(f.chat, "Georgia, LXGW WenKai, sans-serif");
  assert.equal(f.code, "Cascadia Code, Sarasa Mono SC, monospace");
});
await check("chat follows the interface, code's Chinese follows the chat", async () => {
  const f = await families({ ui: "Segoe UI", uiCjk: "KaiTi", code: "Consolas" });
  assert.equal(f.chat, "Segoe UI, KaiTi, sans-serif");
  assert.equal(f.code, "Consolas, KaiTi, monospace");
  const g = await families({ uiCjk: "Microsoft YaHei", chatCjk: "KaiTi" });
  assert.equal(g.ui, "Space Grotesk, Microsoft YaHei, sans-serif");
  assert.equal(g.chat, "Space Grotesk, KaiTi, sans-serif");
  assert.equal(g.code, "Space Mono, KaiTi, monospace");
});
await check("only a Chinese code font keeps Raft's Latin code font", async () => {
  const f = await families({ codeCjk: "Sarasa Mono SC" });
  assert.equal(f.code, "Space Mono, Sarasa Mono SC, monospace");
  assert.equal(f.ui, "Space Grotesk, sans-serif");
});
await check("unsafe names are dropped", async () => {
  const f = await families({ ui: "Segoe UI", uiCjk: 'x"}body{display:none' });
  assert.equal(f.ui, `Segoe UI, ${RAFT_CJK}, sans-serif`);
});
await check("the choice survives a reload", async () => {
  await families({ chat: "Georgia", chatCjk: "KaiTi" });
  await page.reload();
  const f = await page.evaluate(() => getComputedStyle(document.getElementById("chat")).fontFamily);
  assert.equal(unquote(f), "Georgia, KaiTi, sans-serif");
});

console.log("== settings window");
const settings = await browser.newPage();
await settings.route("https://pontoon.test/**", (r) => r.fulfill({ contentType: "text/html", body: settingsHtml }));
await settings.addInitScript(() => {
  const FONTS = [
    { family: "Consolas", display: "Consolas", mono: true, cjk: false },
    { family: "KaiTi", display: "楷体", mono: false, cjk: true },
    { family: "Microsoft YaHei", display: "微软雅黑", mono: false, cjk: true },
    { family: "Segoe UI", display: "Segoe UI", mono: false, cjk: false },
  ];
  window.__saved = [];
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "font_list") return Promise.resolve(FONTS);
      if (cmd === "font_get") return Promise.resolve({ ui: "Segoe UI", chat: null, code: null });
      if (cmd === "font_set") { window.__saved.push(args.fonts); return Promise.resolve(); }
      return Promise.reject("unknown " + cmd);
    },
  };
});
await settings.goto("https://pontoon.test/settings.html");
const options = () => settings.$$eval('#list [role="option"]', (li) => li.map((l) => l.dataset.family || "-"));
await check("Latin list shows every font, Chinese list only Chinese-capable ones", async () => {
  await settings.waitForSelector('#list [role="option"]');
  assert.deepEqual(await options(), ["-", "Consolas", "KaiTi", "Microsoft YaHei", "Segoe UI"]);
  await settings.click('[data-lang="cjk"]');
  assert.deepEqual(await options(), ["-", "KaiTi", "Microsoft YaHei"]);
  assert.equal(await settings.textContent('#list [role="option"]'), "Raft 默认中文字体");
});
await check("picking a Chinese font shows on the tab and in the preview", async () => {
  await settings.click('#list [data-family="Microsoft YaHei"]');
  assert.equal(await settings.textContent("#tab-ui small"), "Segoe UI · 微软雅黑");
  assert.equal(await settings.$eval("#preview", (p) => p.style.fontFamily), '"Segoe UI", "Microsoft YaHei", sans-serif');
  await settings.click("#tab-code");
  assert.equal(await settings.$eval("#preview", (p) => p.style.fontFamily), '"Microsoft YaHei", monospace');
  assert.equal(await settings.textContent('#list [role="option"]'), "跟随对话中文字体");
  assert.ok(await settings.$eval("label.mono", (l) => l.hidden), "monospace filter shown for Chinese fonts");
  await settings.click('[data-lang="latin"]');
  assert.deepEqual(await options(), ["-", "Consolas"]);
});
await check("apply saves all six fonts", async () => {
  await settings.click("#tab-chat");
  await settings.click('[data-lang="cjk"]');
  await settings.click('#list [data-family="KaiTi"]');
  await settings.click("#apply");
  await settings.waitForFunction(() => window.__saved.length === 1);
  assert.deepEqual(await settings.evaluate(() => window.__saved[0]), {
    ui: "Segoe UI", chat: null, code: null, uiCjk: "Microsoft YaHei", chatCjk: "KaiTi", codeCjk: null,
  });
});

await browser.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("All font checks passed");
