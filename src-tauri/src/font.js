// Pontoon font settings. Runs at document start in every page of the main
// window. Three families can be chosen: the interface font, the chat font
// (message text, which Raft renders inside [data-raft-markdown-content]) and
// the code font. An unset chat font follows the interface font; anything
// else unset keeps Raft's own font. The native side calls
// window.__pontoonSetFont after every Raft page load and whenever the choice
// changes; localStorage carries the choice to the next page load so text
// doesn't flash in the old font first.
(() => {
  const KEY = "pontoon.fonts";
  const STYLE_ID = "pontoon-font";
  // Same rule as font.rs: plain names only, since the names go into CSS.
  const VALID = /^[\p{L}\p{N} ._&+-]{1,64}$/u;
  const valid = (f) => typeof f === "string" && VALID.test(f) && f.trim() === f;
  const clean = (fonts) => {
    const f = fonts && typeof fonts === "object" ? fonts : {};
    return {
      ui: valid(f.ui) ? f.ui : null,
      chat: valid(f.chat) ? f.chat : null,
      code: valid(f.code) ? f.code : null,
    };
  };

  const CODE = "code, pre, kbd, samp, .font-mono";
  const IN_CODE = `${CODE}, :is(${CODE}) *`;
  const CHAT = "[data-raft-markdown-content]";

  function css({ ui, chat, code }) {
    const rules = [];
    chat = chat || ui;
    if (ui) {
      const f = `"${ui}", sans-serif`;
      rules.push(
        `:root{--font-sans:${f}!important;--sans-font:${f}!important;` +
          `--font-heading:${f}!important;--heading-font:${f}!important;--font-display:${f}!important}`,
        `html body,html body *:not(${IN_CODE}){font-family:${f}!important}`,
      );
    }
    if (chat) {
      // Higher specificity than the interface rule, so it wins inside messages.
      rules.push(`html body ${CHAT},html body ${CHAT} *:not(${IN_CODE}){font-family:"${chat}", sans-serif!important}`);
    }
    if (code) {
      const f = `"${code}", monospace`;
      rules.push(
        `:root{--font-mono:${f}!important;--mono-font:${f}!important}`,
        `html body :is(${CODE}),html body :is(${CODE}) *{font-family:${f}!important}`,
      );
    }
    return rules.join("\n");
  }

  function apply(fonts) {
    const root = document.documentElement;
    if (!root) {
      document.addEventListener("readystatechange", () => apply(fonts), { once: true });
      return;
    }
    let style = document.getElementById(STYLE_ID);
    const text = css(fonts);
    if (!text) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
    }
    style.textContent = text;
    // Keep it last so it wins over stylesheets added after it.
    (document.head || root).appendChild(style);
  }

  function read() {
    try {
      return clean(JSON.parse(localStorage.getItem(KEY)));
    } catch {
      return clean(null);
    }
  }

  Object.defineProperty(window, "__pontoonSetFont", {
    value: (fonts) => {
      const f = clean(fonts);
      try {
        if (f.ui || f.chat || f.code) localStorage.setItem(KEY, JSON.stringify(f));
        else localStorage.removeItem(KEY);
        localStorage.removeItem("pontoon.fontFamily"); // version 0.2
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
      if (css(read()) && (!style || style !== document.head.lastElementChild)) apply(read());
    }).observe(document.head, { childList: true });
  });
})();
