// Pontoon global font. Runs at document start in every page of the main
// window. The chosen family replaces Raft's fonts everywhere except code,
// which keeps its monospace font. The native side calls
// window.__pontoonSetFont after every Raft page load and whenever the choice
// changes; localStorage carries the choice to the next page load so text
// doesn't flash in the old font first.
(() => {
  const KEY = "pontoon.fontFamily";
  const STYLE_ID = "pontoon-font";
  // Same rule as font.rs: plain names only, since the name goes into CSS.
  const VALID = /^[\p{L}\p{N} ._&+-]{1,64}$/u;
  const valid = (f) => typeof f === "string" && VALID.test(f) && f.trim() === f;

  function css(family) {
    const f = `"${family}", sans-serif`;
    const code = "code, pre, kbd, samp, .font-mono, code *, pre *, kbd *, samp *, .font-mono *";
    return (
      `:root{--font-sans:${f}!important;--sans-font:${f}!important;` +
      `--font-heading:${f}!important;--heading-font:${f}!important;--font-display:${f}!important}` +
      `html body,html body *:not(${code}){font-family:${f}!important}`
    );
  }

  function apply(family) {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener("readystatechange", () => apply(family), { once: true });
      return;
    }
    let style = document.getElementById(STYLE_ID);
    if (!valid(family)) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
    }
    style.textContent = css(family);
    // Keep it last so it wins over stylesheets added after it.
    (document.head || root).appendChild(style);
  }

  function read() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  Object.defineProperty(window, "__pontoonSetFont", {
    value: (family) => {
      const f = valid(family) ? family : null;
      try {
        if (f) localStorage.setItem(KEY, f);
        else localStorage.removeItem(KEY);
      } catch {}
      apply(f);
    },
  });

  apply(read());
  // Stylesheets added to <head> later would come after ours, and a script
  // could drop ours; either way, move it back to the end.
  document.addEventListener("DOMContentLoaded", () => {
    apply(read());
    new MutationObserver(() => {
      const style = document.getElementById(STYLE_ID);
      if (valid(read()) && (!style || style !== document.head.lastElementChild)) apply(read());
    }).observe(document.head, { childList: true });
  });
})();
