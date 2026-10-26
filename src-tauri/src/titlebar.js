// Pontoon's own title bar. Server windows have no Windows title bar, like the
// official Raft Desktop on Windows. Runs at document start in every page of a
// server window.
//
// - Raft's top bar is already marked as a drag region (data-raft-titlebar,
//   -webkit-app-region: drag) for the official app, and WebView2 treats such
//   regions as the window's title bar: drag to move or snap, double-click to
//   maximize, right-click for the window menu.
// - html[data-title-bar=overlay] makes Raft keep 138px free at the right end
//   of its top bar, as it does for the official app's caption buttons, and
//   Pontoon puts its own minimize, maximize and close buttons there.
// - A page without Raft's top bar (the loading page, before Raft has drawn
//   it, or a sign-in provider's page) gets a plain drag strip along its top.
(() => {
  if (window.top !== window) return;
  // Native commands are only open to Raft and the bundled pages; elsewhere
  // (a sign-in provider's page) the window can still be moved, not closed.
  const native = location.origin === "https://app.raft.build" || location.hostname === "tauri.localhost" || location.protocol === "tauri:";

  const BAR = "[data-raft-titlebar], [data-raft-overlay-titlebar]";
  const HEIGHT = 48;
  const GLYPH = { minimize: "", maximize: "", restore: "", close: "" };

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
    // Kept outside <body>, where the page's own rendering never replaces it.
    strip = fixed(document.createElement("div"), `left:0;right:${native ? 138 : 0}px;height:32px;-webkit-app-region:drag;app-region:drag;display:none`);
    strip.id = "pontoon-drag-strip";
    root.appendChild(strip);
    if (!native) return;

    caption = fixed(document.createElement("div"), `right:0;width:138px;height:${HEIGHT}px;-webkit-app-region:no-drag;app-region:no-drag`);
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
  // do (Raft's top bar follows each server's theme). The topmost overlay title
  // bar (a full-page view) wins over the main one, as in the official app.
  function topBar() {
    const overlays = document.querySelectorAll("[data-raft-overlay-titlebar]:not([data-raft-overlay-titlebar-covered])");
    return overlays.length ? overlays[overlays.length - 1] : document.querySelector("[data-raft-titlebar]");
  }
  let lastColor = "";
  function sync() {
    if (!strip) return;
    const bar = topBar();
    strip.style.display = document.querySelector(BAR) ? "none" : "block";
    if (!caption) return;
    // Pages Raft has not drawn yet use the page's own text colour.
    const source = bar || document.body;
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
    if (document.getElementById("pontoon-caption") || document.getElementById("pontoon-drag-strip")) return;
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
