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
// - Raft's full-window viewers (a file or an image) have a top bar of their
//   own. The official app marks it data-raft-overlay-titlebar and leaves the
//   same corner free in it; this script does that too, and tracks open
//   dialogs and menus as the official app does, so the bars under them stop
//   being drag regions.
// - Any other control of Raft's that still ends up under the buttons wins:
//   the buttons step aside until it is gone.
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
  // The file and image viewer's top bar, and the top bar of Raft's other
  // lightboxes.
  const OVERLAY_BAR = '[data-testid="file-viewer-header"], [data-slot="lightbox-toolbar"]';
  const BAR = `[data-raft-titlebar], [data-raft-overlay-titlebar], ${TOP_BAR}`;
  const HEIGHT = 48;
  const RESERVED = 138;
  // As in Raft's stylesheet for the official app (October 2026), plus open
  // dialogs, so nothing in a dialog over the bar is taken for the title bar.
  // A viewer's bar keeps its own 16px on the right, as the official app's does.
  const CSS = `
html[data-title-bar=overlay] [data-raft-titlebar] {
  -webkit-app-region: drag; app-region: drag;
  padding-right: ${RESERVED}px; --raft-titlebar-inset-end: ${RESERVED}px;
}
html[data-title-bar=overlay] [data-raft-overlay-titlebar] {
  -webkit-app-region: drag; app-region: drag;
  padding-right: ${16 + RESERVED}px !important; --raft-titlebar-inset-end: ${RESERVED}px;
}
[data-raft-titlebar] :is(button, a, input, select, textarea, [role=button], [contenteditable=true]),
[data-raft-overlay-titlebar] :is(button, a, input, select, textarea, [role=button], [contenteditable=true], [data-raft-overlay-titlebar-no-drag]),
html [data-raft-overlay-titlebar][data-raft-overlay-titlebar-covered],
[data-testid=desktop-search-overlay], html[data-raft-layer-open] [data-raft-titlebar], [data-dismiss-layer], [role=dialog] {
  -webkit-app-region: no-drag; app-region: no-drag;
}`;
  // What the official app counts as an open layer: dialogs, menus, popovers
  // and the like, but not tooltips, toasts or closed ones.
  const LAYER = '[data-dismiss-layer]:not([data-dismiss-layer="false"]), [role="dialog"], [role="alertdialog"], [data-slot$="-content"][data-open], [data-slot$="-popup"][data-open], [data-slot$="-overlay"][data-open], [data-slot$="-backdrop"][data-open]';
  const NOT_LAYER = '[data-dismiss-layer="false"], [data-slot^="tooltip"], [data-slot^="preview-card"], [data-slot^="toast"], [data-closed], [hidden], [aria-hidden="true"]';
  // Things the page means to be clicked.
  const CONTROL = 'button, a[href], input, select, textarea, [role=button], [role=menuitem], [role=tab], [role=checkbox], [role=switch], [contenteditable=true]';
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
  // As the official app does: the page has data-raft-layer-open while a
  // layer is open, and a viewer's bar is covered while another layer is open
  // over it. Layers are portals at the end of the page, so one over the bar
  // comes after it; the viewer's own backdrop comes before.
  function trackLayers() {
    const layers = [...document.querySelectorAll(LAYER)].filter((e) => !e.closest(NOT_LAYER));
    const root = document.documentElement;
    if (root.hasAttribute("data-raft-layer-open") !== layers.length > 0) root.toggleAttribute("data-raft-layer-open", layers.length > 0);
    for (const bar of document.querySelectorAll("[data-raft-overlay-titlebar]")) {
      const covered = layers.some((l) => !l.contains(bar) && bar.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (bar.hasAttribute("data-raft-overlay-titlebar-covered") !== covered) bar.toggleAttribute("data-raft-overlay-titlebar-covered", covered);
    }
  }

  // A control of the page's own under the buttons: Raft drew something there
  // that this script does not know to move (a side panel's close button, say).
  function controlUnderneath() {
    const w = window.innerWidth;
    for (const x of [w - RESERVED + 23, w - 69, w - 23]) {
      for (const y of [12, HEIGHT / 2, HEIGHT - 12]) {
        const el = document.elementsFromPoint(x, y).find((e) => e !== caption && e !== strip);
        const control = el && el.closest(CONTROL);
        if (control) return control;
      }
    }
    return null;
  }

  let lastColor = "";
  function sync() {
    if (!strip) return;
    for (const bar of document.querySelectorAll(TOP_BAR)) {
      if (!bar.hasAttribute("data-raft-titlebar")) bar.setAttribute("data-raft-titlebar", "");
    }
    for (const bar of document.querySelectorAll(OVERLAY_BAR)) {
      if (!bar.hasAttribute("data-raft-overlay-titlebar")) bar.setAttribute("data-raft-overlay-titlebar", "");
    }
    trackLayers();
    // On Raft, only until it draws: its other pages have their own content
    // at the top, which a drag strip would make unclickable.
    const root = document.getElementById("root");
    const bare = !raft || !root || root.childElementCount === 0;
    strip.style.display = !document.querySelector(BAR) && bare ? "block" : "none";
    if (!caption) return;
    const hide = !!controlUnderneath();
    if ((caption.style.display === "none") !== hide) caption.style.display = hide ? "none" : "";
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
      attributeFilter: ["class", "style", "data-theme", "data-raft-overlay-titlebar-covered", "data-open", "data-closed", "hidden", "aria-hidden", "role", "data-slot", "data-dismiss-layer"],
    });
    // Raft's theme can follow the system's light or dark mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", schedule);
    // Panels slide and fade in after the change that adds them, and the
    // window's size decides what reaches its corner.
    window.addEventListener("transitionend", schedule, true);
    window.addEventListener("animationend", schedule, true);
    window.addEventListener("resize", schedule);
    // The attribute that reserves the buttons' corner must stay on.
    new MutationObserver(() => {
      if (document.documentElement.dataset.titleBar !== "overlay") document.documentElement.dataset.titleBar = "overlay";
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-title-bar"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
