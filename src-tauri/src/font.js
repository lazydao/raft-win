// Pontoon font settings. Runs at document start in every page of the main
// window. Three parts get their own fonts: the interface, the chat (message
// text, which Raft renders inside [data-raft-markdown-content], and the
// message box you type it in) and code.
// Each part has a Latin font and a Chinese (CJK) font. Unset chat fonts
// follow the interface fonts, Chinese in code follows the chat's Chinese
// font, and anything else unset keeps Raft's own font. The native side calls
// window.__pontoonSetFont after every Raft page load and whenever the choice
// changes; localStorage carries the choice to the next page load so text
// doesn't flash in the old font first.
(() => {
  const KEY = "pontoon.fonts";
  const STYLE_ID = "pontoon-font";
  const PARTS = ["ui", "chat", "code", "uiCjk", "chatCjk", "codeCjk"];
  // Same rule as font.rs: plain names only, since the names go into CSS.
  const VALID = /^[\p{L}\p{N} ._&+-]{1,64}$/u;
  const valid = (f) => typeof f === "string" && VALID.test(f) && f.trim() === f;
  const clean = (fonts) => {
    const f = fonts && typeof fonts === "object" ? fonts : {};
    return Object.fromEntries(PARTS.map((p) => [p, valid(f[p]) ? f[p] : null]));
  };

  // Raft's own fonts (raft-ui fonts.css), for the half of a part that is
  // left unset while the other half is chosen.
  const RAFT_LATIN = '"Space Grotesk"';
  const RAFT_CJK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC"';
  const RAFT_MONO = '"Space Mono"';

  const CODE = "code, pre, kbd, samp, .font-mono";
  const IN_CODE = `${CODE}, :is(${CODE}) *`;
  // The composer is a plain <textarea>; it takes the chat font so a message
  // looks the same while you type it as after it is sent.
  const CHAT = '[data-raft-markdown-content], [data-testid="composer-textarea"]';

  // The browser takes each character from the first font in the list that
  // has it. Latin fonts have no Chinese characters, so putting the Latin
  // font first and the Chinese font second splits text between the two.
  function stack(latin, cjk, raftLatin, raftCjk, generic) {
    if (!latin && !cjk) return null;
    const list = [latin ? `"${latin}"` : raftLatin];
    if (cjk) list.push(`"${cjk}"`);
    else if (raftCjk) list.push(raftCjk);
    return `${list.join(", ")}, ${generic}`;
  }

  function css(f) {
    const rules = [];
    const ui = stack(f.ui, f.uiCjk, RAFT_LATIN, RAFT_CJK, "sans-serif");
    const chatCjk = f.chatCjk || f.uiCjk;
    const chat = stack(f.chat || f.ui, chatCjk, RAFT_LATIN, RAFT_CJK, "sans-serif");
    const code = stack(f.code, f.codeCjk || chatCjk, RAFT_MONO, null, "monospace");
    if (ui) {
      rules.push(
        `:root{--font-sans:${ui}!important;--sans-font:${ui}!important;` +
          `--font-heading:${ui}!important;--heading-font:${ui}!important;--font-display:${ui}!important}`,
        `html body,html body *:not(${IN_CODE}){font-family:${ui}!important}`,
      );
    }
    if (chat) {
      // Higher specificity than the interface rule, so it wins inside messages.
      rules.push(`html body :is(${CHAT}),html body :is(${CHAT}) *:not(${IN_CODE}){font-family:${chat}!important}`);
    }
    if (code) {
      rules.push(
        `:root{--font-mono:${code}!important;--mono-font:${code}!important}`,
        `html body :is(${CODE}),html body :is(${CODE}) *{font-family:${code}!important}`,
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
        if (PARTS.some((p) => f[p])) localStorage.setItem(KEY, JSON.stringify(f));
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
