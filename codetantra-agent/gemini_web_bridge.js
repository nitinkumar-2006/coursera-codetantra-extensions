// CodeTantra AI Agent v9.3 — Runs on https://gemini.google.com/* (Classic + Neon UI + Shadow DOM)
(function () {
  if (window.__ctGeminiWebBridgeV93) return;
  window.__ctGeminiWebBridgeV93 = true;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch {}
      try {
        for (const el of node.querySelectorAll("*")) {
          if (el.shadowRoot) visit(el.shadowRoot);
        }
      } catch {}
    };
    visit(root);
    return out;
  }

  function findPromptInput() {
    const selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][aria-label*="Gemini" i]',
      'div[contenteditable="true"][data-placeholder]',
      'textarea[aria-label*="prompt" i]',
      "textarea"
    ];
    for (const sel of selectors) {
      const el = queryAllDeep(sel).find(isVisible);
      if (el) return el;
    }
    return (
      queryAllDeep('[contenteditable="true"]').find((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 160 && r.height >= 16;
      }) || null
    );
  }

  function isNonSendButton(btn) {
    const meta = [
      btn.getAttribute("aria-label") || "",
      btn.getAttribute("title") || "",
      btn.getAttribute("mattooltip") || "",
      btn.innerText || ""
    ]
      .join(" ")
      .toLowerCase();
    return /(mic|microphone|voice|record|attach|upload|add|plus|neon|model|chat|task|stop|menu|search|settings)/i.test(meta);
  }

  function findSendButton() {
    const selectors = [
      'button[aria-label*="Send message" i]',
      'button[aria-label="Send" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[mattooltip*="Send" i]',
      'button[title*="Send" i]',
      'button.send-button',
      'button[data-test-id*="send" i]'
    ];
    for (const sel of selectors) {
      const btn = queryAllDeep(sel).find(
        (b) => isVisible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isNonSendButton(b)
      );
      if (btn) return btn;
    }
    return null;
  }

  function isGeneratingNow() {
    const stopSelectors = [
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label="Stop" i]',
      'button[mattooltip*="Stop" i]',
      '.stop-icon',
      'mat-icon[fonticon="stop"]'
    ];
    for (const sel of stopSelectors) {
      if (queryAllDeep(sel).find(isVisible)) return true;
    }
    return false;
  }

  function getResponseNodes() {
    const selectors = [
      "model-response message-content",
      "model-response .markdown",
      "model-response",
      '[data-message-author-role="model"]',
      ".response-container-content .markdown",
      '[data-test-id="model-response-text"]',
      "message-content"
    ];
    for (const sel of selectors) {
      const nodes = queryAllDeep(sel).filter((n) => (n.innerText || "").trim().length > 0);
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  function getJsonBlocks() {
    return queryAllDeep("pre code, code-block code, pre").filter((el) => {
      const t = (el.innerText || el.textContent || "").trim();
      return t.includes("{") && t.includes("}") && (t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"'));
    });
  }

  function extractBestTextFromResponse(node) {
    if (!node) return "";
    const codeBlocks = Array.from(node.querySelectorAll("pre code, code-block code, pre"));
    for (let i = codeBlocks.length - 1; i >= 0; i--) {
      const t = (codeBlocks[i].innerText || codeBlocks[i].textContent || "").trim();
      if (t.includes("{") && t.includes("}")) return t;
    }
    return (node.innerText || node.textContent || "").trim();
  }

  function getInputLength(inputEl) {
    if (!inputEl) return 0;
    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      return (inputEl.value || "").trim().length;
    }
    return (inputEl.innerText || inputEl.textContent || "").trim().length;
  }

  async function insertPromptText(inputEl, text) {
    inputEl.click();
    inputEl.focus();
    await sleep(120);

    if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(inputEl, text);
      else inputEl.value = text;
      inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return getInputLength(inputEl) >= 10;
    }

    // Method 1: execCommand insertText (updates Angular/Quill form state immediately when focused!)
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, text);
      await sleep(180);
    } catch {}

    if (getInputLength(inputEl) >= 10) return true;

    // Method 2: Simulated Paste
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      inputEl.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt })
      );
      await sleep(180);
    } catch {}

    return getInputLength(inputEl) >= 10;
  }

  async function handleSubmitPrompt(prompt) {
    let inputEl = null;
    for (let i = 0; i < 10; i++) {
      inputEl = findPromptInput();
      if (inputEl) break;
      await sleep(300);
    }
    if (!inputEl) {
      return { ok: false, error: "gemini.google.com par chat box nahi mila (check karo login hai)." };
    }

    const beforeNodes = getResponseNodes();
    const beforeCount = beforeNodes.length;
    const beforeLastText = beforeCount > 0 ? extractBestTextFromResponse(beforeNodes[beforeCount - 1]) : "";
    const beforeJsonCount = getJsonBlocks().length;

    const inserted = await insertPromptText(inputEl, prompt);
    if (!inserted) {
      return { ok: false, error: "Gemini chat box mein prompt paste nahi ho paya — ek baar 'Web' dabakar 'API' mode try karo." };
    }

    // Wait up to 1.5s for real Send button to appear (replacing Mic icon!)
    let sendBtn = null;
    for (let i = 0; i < 6; i++) {
      sendBtn = findSendButton();
      if (sendBtn) break;
      await sleep(250);
    }

    if (sendBtn) {
      sendBtn.click();
    } else {
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true }));
    }

    // Verify input cleared or generating started within 2s
    await sleep(1000);
    if (getInputLength(inputEl) > 25 && !isGeneratingNow()) {
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true }));
      await sleep(700);
    }

    if (getInputLength(inputEl) > 25 && !isGeneratingNow() && getResponseNodes().length === beforeCount) {
      return {
        ok: false,
        error: "Gemini Web par prompt type hua par Send nahi hua — 'Web' dabakar 'API' mode use karo (Key ..vnJw already active hai!)."
      };
    }

    return { ok: true, beforeCount, beforeLastText, beforeJsonCount };
  }

  function handlePollResponse({ beforeCount = 0, beforeLastText = "", beforeJsonCount = 0 }) {
    const generating = isGeneratingNow();
    const nodes = getResponseNodes();
    const hasNewNode = nodes.length > beforeCount;
    const latestNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
    const latestText = latestNode ? extractBestTextFromResponse(latestNode) : "";
    const changed = Boolean(latestText && latestText !== beforeLastText);

    if (hasNewNode || changed) {
      return { ok: true, hasNew: true, generating, text: latestText };
    }

    const jsonBlocks = getJsonBlocks();
    if (jsonBlocks.length > beforeJsonCount) {
      const txt = (jsonBlocks[jsonBlocks.length - 1].innerText || jsonBlocks[jsonBlocks.length - 1].textContent || "").trim();
      return { ok: true, hasNew: true, generating, text: txt };
    }

    return { ok: true, hasNew: false, generating, text: "" };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === "CT_GEMINI_WEB_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "CT_GEMINI_WEB_SUBMIT") {
      handleSubmitPrompt(msg.prompt || "")
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    if (msg.type === "CT_GEMINI_WEB_POLL") {
      try {
        sendResponse(handlePollResponse(msg));
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return false;
    }
    return false;
  });
})();
