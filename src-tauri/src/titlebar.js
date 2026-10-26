// Pontoon's own title bar. Server windows have no Windows title bar, like the
// official Raft Desktop on Windows. Runs at document start in every page of a
// server window.
//
// - Raft's top bar (data-testid="app-top-bar") becomes the title bar. The
//   official app has Raft mark it data-raft-titlebar, which the web client
//   at app.raft.build does not do, so this script marks it and adds the rules
//   Raft's stylesheet has for it: the bar is a drag region (WebView2 treats
//   -webkit-app-region: drag as the window's title bar: drag to move or snap,
//   double-click to maximize, right-click for the window menu), its buttons,
//   links and fields stay clickable, and it keeps 138px free at its right end.
// - Pontoon puts its minimize, maximize and close buttons in that corner, in
//   the colour of the bar's text, which follows each server's theme.
// - A page without Raft's top bar (the loading and recovery pages, Raft
//   before it has drawn anything, a sign-in provider's page) gets a plain drag
//   strip along its top.
(() => {
  if (window.top !== window) return;
  // Native commands are only open to Raft and the bundled pages; elsewhere
  // (a sign-in provider's page) the window can still be moved, not closed.
  const native = location.origin === "https://app.raft.build" || location.hostname === "tauri.localhost" || location.protocol === "tauri:";

  const raft = location.origin === "https://app.raft.build";
  const TOP_BAR = '[data-testid="app-top-bar"]';
  const BAR = `[data-raft-titlebar], [data-raft-overlay-titlebar], ${TOP_BAR}`;
  const HEIGHT = 48;
  const RESERVED = 138;
  // As in Raft's stylesheet for the official app (October 2026), plus open
  // dialogs, so nothing in a dialog over the bar is taken for the title bar.
  const CSS = `
html[data-title-bar=overlay] [data-raft-titlebar] {
  -webkit-app-region: drag; app-region: drag;
  padding-right: ${RESERVED}px; --raft-titlebar-inset-end: ${RESERVED}px;
}
[data-raft-titlebar] :is(button, a, input, select, textarea, [role=button], [contenteditable=true]),
[data-testid=desktop-search-overlay], html[data-raft-layer-open] [data-raft-titlebar], [data-dismiss-layer], [role=dialog] {
  -webkit-app-region: no-drag; app-region: no-drag;
}`;
  const GLYPH = { minimize: "\uE921", maximize: "\uE922", restore: "\uE923", close: "\uE8BB" };

  const invoke = (action) => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return Promise.resolve(null);
    return internals.invoke("window_caption", { params: { action } }).catch(() => null);
  };

  const fixed = (el, css) => {
    el.style.cssText = `position:fixed;top:0;margin:0;padding:0;border:0;z-index:2147483647;${css}`;
    return el;
  };

  let caption = null;
  let maximize = null;
  let strip = null;

  function build() {
    const root = document.documentElement;
    root.dataset.titleBar = "overlay";
    const style = document.createElement("style");
    style.id = "pontoon-titlebar-style";
    style.textContent = CSS;
    root.appendChild(style);
    // Kept outside <body>, where the page's own rendering never replaces it.
    strip = fixed(document.createElement("div"), `left:0;right:${native ? RESERVED : 0}px;height:32px;-webkit-app-region:drag;app-region:drag;display:none`);
    strip.id = "pontoon-drag-strip";
    root.appendChild(strip);
    if (!native) return;

    caption = fixed(document.createElement("div"), `right:0;width:${RESERVED}px;height:${HEIGHT}px;-webkit-app-region:no-drag;app-region:no-drag`);
    caption.id = "pontoon-caption";
    const shadow = caption.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
  :host { color: inherit; }
  .bar { display: flex; height: 100%; }
  button { all: unset; box-sizing: border-box; width: 46px; height: 100%; display: flex; align-items: center; justify-content: center;
    font: 10px "Segoe Fluent Icons", "Segoe MDL2 Assets"; color: var(--pontoon-caption-fg, CanvasText); cursor: default; }
  button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }
  button:active { background: color-mix(in srgb, currentColor 18%, transparent); }
  button.close:hover { background: #c42b1c; color: #fff; }
  button.close:active { background: #c84031; color: #fff; }
  :host([data-inactive]) button:not(:hover) { opacity: 0.5; }
</style>
<div class="bar">
  <button class="minimize" data-action="minimize" title="最小化" aria-label="最小化">${GLYPH.minimize}</button>
  <button class="maximize" data-action="toggleMaximize" title="最大化" aria-label="最大化">${GLYPH.maximize}</button>
  <button class="close" data-action="close" title="关闭" aria-label="关闭">${GLYPH.close}</button>
</div>`;
    maximize = shadow.querySelector(".maximize");
    shadow.addEventListener("click", (e) => {
      const action = e.target.closest && e.target.closest("button")?.dataset.action;
      if (action) invoke(action);
    });
    root.appendChild(caption);

    window.addEventListener("focus", () => caption.removeAttribute("data-inactive"));
    window.addEventListener("blur", () => caption.setAttribute("data-inactive", ""));
    if (!document.hasFocus()) caption.setAttribute("data-inactive", "");

    // Maximizing, restoring and snapping all resize the page.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncMaximized, 100);
    });
    syncMaximized();
  }

  function syncMaximized() {
    invoke("state").then((r) => {
      if (!r || !maximize) return;
      const label = r.maximized ? "向下还原" : "最大化";
      maximize.textContent = r.maximized ? GLYPH.restore : GLYPH.maximize;
      maximize.title = label;
      maximize.setAttribute("aria-label", label);
    });
  }

  // The buttons take the colour of the top bar's text, as the official app's
  // do. The topmost overlay title bar (a full-page view) wins over the main
  // one, as in the official app.
  function topBar() {
    const overlays = document.querySelectorAll("[data-raft-overlay-titlebar]:not([data-raft-overlay-titlebar-covered])");
    return overlays.length ? overlays[overlays.length - 1] : document.querySelector("[data-raft-titlebar]");
  }
  let lastColor = "";
  function sync() {
    if (!strip) return;
    for (const bar of document.querySelectorAll(TOP_BAR)) {
      if (!bar.hasAttribute("data-raft-titlebar")) bar.setAttribute("data-raft-titlebar", "");
    }
    // On Raft, only until it draws: its other pages have their own content
    // at the top, which a drag strip would make unclickable.
    const root = document.getElementById("root");
    const bare = !raft || !root || root.childElementCount === 0;
    strip.style.display = !document.querySelector(BAR) && bare ? "block" : "none";
    if (!caption) return;
    // Pages Raft has not drawn yet use the page's own text colour.
    const source = topBar() || document.body;
    const color = source ? getComputedStyle(source).color : "";
    if (color && color !== lastColor) {
      lastColor = color;
      caption.style.setProperty("--pontoon-caption-fg", color);
    }
  }
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      sync();
    }, 150);
  }

  function start() {
    if (document.getElementById("pontoon-drag-strip")) return;
    build();
    sync();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-raft-overlay-titlebar-covered"],
    });
    // Raft's theme can follow the system's light or dark mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
    // The attribute that reserves the buttons' corner must stay on.
    new MutationObserver(() => {
      if (document.documentElement.dataset.titleBar !== "overlay") document.documentElement.dataset.titleBar = "overlay";
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-title-bar"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
