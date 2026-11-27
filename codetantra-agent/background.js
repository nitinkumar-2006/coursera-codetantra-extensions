// CodeTantra AI Agent v10.0 Final — Hardened Multi-Line Gemini Web Bridge (Auto-Fresh Chat, Zero Reload, Zero Hang)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout (${Math.round(ms / 1000)}s)`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function notifyProgress(callerTabId, text) {
  if (!callerTabId) return;
  try {
    chrome.tabs.sendMessage(callerTabId, { type: "GEMINI_WEB_PROGRESS", text }, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t || t.status === "complete") {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

const SUBJECT_CHAT_KEY = "geminiSubjectChats";
const VALID_GEMINI_CHAT_RE = /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{6,}/;

async function getSubjectChats() {
  try {
    const res = await chrome.storage.local.get(SUBJECT_CHAT_KEY);
    return (res && res[SUBJECT_CHAT_KEY] && typeof res[SUBJECT_CHAT_KEY] === "object") ? res[SUBJECT_CHAT_KEY] : {};
  } catch {
    return {};
  }
}

async function getSubjectChatUrl(subject) {
  if (!subject) return "";
  const map = await getSubjectChats();
  const url = map[subject] || "";
  return VALID_GEMINI_CHAT_RE.test(url) ? url : "";
}

async function setSubjectChatUrl(subject, url) {
  if (!subject || !VALID_GEMINI_CHAT_RE.test(url || "")) return;
  try {
    const map = await getSubjectChats();
    if (map[subject] === url) return;
    map[subject] = url;
    await chrome.storage.local.set({ [SUBJECT_CHAT_KEY]: map });
    console.log("[CT-GEMINI] Saved subject chat URL", { subject, url });
  } catch {}
}

async function clearSubjectChatUrl(subject) {
  if (!subject) return;
  try {
    const map = await getSubjectChats();
    if (map[subject]) {
      delete map[subject];
      await chrome.storage.local.set({ [SUBJECT_CHAT_KEY]: map });
      console.log("[CT-GEMINI] Cleared invalid subject chat URL", { subject });
    }
  } catch {}
}

async function getOrCreateGeminiTab(subject = "other") {
  const savedUrl = await getSubjectChatUrl(subject);
  const tabs = await withTimeout(chrome.tabs.query({ url: "https://gemini.google.com/*" }), 4000, "tabs.query");

  if (savedUrl) {
    // 1. Reuse already-open tab on this exact subject's chat URL
    const exactTab = (tabs || []).find((t) => !t.discarded && (t.url || "").startsWith(savedUrl));
    if (exactTab) {
      if (exactTab.status !== "complete") await waitForTabComplete(exactTab.id, 10000);
      return { tab: exactTab, usedSavedUrl: true };
    }
    // 2. Navigate existing Gemini tab (or create one) to the saved subject chat URL
    if (tabs && tabs.length > 0) {
      const targetTab = tabs.find((t) => !t.discarded) || tabs[0];
      await withTimeout(chrome.tabs.update(targetTab.id, { url: savedUrl, active: true }), 4000, "tabs.update");
      await waitForTabComplete(targetTab.id, 12000);
      await sleep(1200);
      const refreshed = await chrome.tabs.get(targetTab.id).catch(() => null);
      if (refreshed && VALID_GEMINI_CHAT_RE.test(refreshed.url || "")) {
        return { tab: refreshed, usedSavedUrl: true };
      }
      // Saved chat was deleted or bounced back to /app -> clear and create fresh primary chat once
      await clearSubjectChatUrl(subject);
      await waitForTabComplete(targetTab.id, 10000);
      await sleep(800);
      return { tab: targetTab, usedSavedUrl: false };
    }
    const created = await withTimeout(chrome.tabs.create({ url: savedUrl, active: true }), 5000, "tabs.create");
    await waitForTabComplete(created.id, 12000);
    await sleep(1500);
    const refreshed = await chrome.tabs.get(created.id).catch(() => created);
    if (!VALID_GEMINI_CHAT_RE.test(refreshed?.url || "")) {
      await clearSubjectChatUrl(subject);
      return { tab: refreshed || created, usedSavedUrl: false };
    }
    return { tab: refreshed || created, usedSavedUrl: true };
  }

  // No saved URL for this subject yet -> use a fresh /app tab (never overwrite another subject's chat!)
  if (tabs && tabs.length > 0) {
    const bareAppTab = tabs.find((t) => !t.discarded && !VALID_GEMINI_CHAT_RE.test(t.url || ""));
    if (bareAppTab) {
      if (bareAppTab.status !== "complete") await waitForTabComplete(bareAppTab.id, 10000);
      return { tab: bareAppTab, usedSavedUrl: false };
    }
    const navTab = tabs.find((t) => !t.discarded) || tabs[0];
    await withTimeout(chrome.tabs.update(navTab.id, { url: "https://gemini.google.com/app", active: true }), 4000, "tabs.update");
    await waitForTabComplete(navTab.id, 12000);
    await sleep(1400);
    return { tab: navTab, usedSavedUrl: false };
  }

  const created = await withTimeout(
    chrome.tabs.create({ url: "https://gemini.google.com/app", active: true }),
    5000,
    "tabs.create"
  );
  await waitForTabComplete(created.id, 12000);
  await sleep(1500);
  return { tab: created, usedSavedUrl: false };
}

// Executed directly inside https://gemini.google.com/* via chrome.scripting.executeScript
async function submitPromptDirect(promptText, screenshot = null, isNewQuestion = true) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVis = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const qDeep = (sel, root = document) => {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch {}
      try {
        for (const el of node.querySelectorAll("*")) {
          if (el.tagName && el.tagName.includes("-") && el.shadowRoot) walk(el.shadowRoot);
        }
      } catch {}
    };
    walk(root);
    return out;
  };

  const findInput = () => {
    const sels = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][aria-label*="Gemini" i]',
      'div[contenteditable="true"][data-placeholder]',
      'textarea[aria-label*="prompt" i]',
      "textarea"
    ];
    for (const s of sels) {
      const hit = qDeep(s).find(isVis);
      if (hit) return hit;
    }
    return (
      qDeep('[contenteditable="true"]').find((el) => {
        if (!isVis(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 160 && r.height >= 16;
      }) || null
    );
  };

  const getRespNodes = () => {
    const sels = [
      "model-response message-content",
      "model-response .markdown",
      "model-response",
      '[data-message-author-role="model"]',
      ".response-container-content .markdown",
      '[data-test-id="model-response-text"]',
      "message-content"
    ];
    for (const s of sels) {
      const nodes = qDeep(s).filter((n) => (n.innerText || "").trim().length > 0);
      if (nodes.length) return nodes;
    }
    return [];
  };

  const extractBest = (node) => {
    if (!node) return "";
    const fullText = (node.innerText || node.textContent || "").trim();
    const blocks = Array.from(node.querySelectorAll("pre code, code-block code, pre"));
    // Priority 1: Tagged <<<SLOT N>>> inside <pre><code> using textContent (preserves 100% Python indentation & __init__!)
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].textContent || blocks[i].innerText || "").replace(/^\n+|\n+$/g, "");
      if (/<<<SLOT\s*\d+>>>/i.test(t)) return t;
    }
    if (/<<<SLOT\s*\d+>>>/i.test(fullText)) return fullText;
    // Priority 2: JSON block containing our schema keys
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].textContent || blocks[i].innerText || "").trim();
      if (t.includes("{") && t.includes("}") && (t.includes('"slots"') || t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"'))) {
        return t;
      }
    }
    // Priority 3: Largest <pre><code> block using textContent (preserves exact Python spaces & __init__!)
    if (blocks.length) {
      const bestBlock = blocks
        .map((b) => (b.textContent || b.innerText || "").replace(/^\n+|\n+$/g, ""))
        .sort((a, b) => b.length - a.length)[0];
      if (bestBlock && bestBlock.trim().length > 20) return "```\n" + bestBlock + "\n```";
    }
    return fullText;
  };

  const getJsonCount = () =>
    qDeep("pre code, code-block code, pre").filter((el) => {
      const t = (el.textContent || el.innerText || "").trim();
      return /<<<SLOT\s*\d+>>>/i.test(t) || (t.includes("{") && t.includes("}") && (t.includes('"slots"') || t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"')));
    }).length;

  // Persistent subject-wise chat: never click 'New chat' inside a saved subject chat!
  // Always capture beforeCount strictly BEFORE clicking Send.

  let inputEl = null;
  for (let i = 0; i < 12; i++) {
    inputEl = findInput();
    if (inputEl) break;
    await wait(250);
  }
  if (!inputEl) {
    return { ok: false, error: "gemini.google.com par chat box nahi mila (page load / login check karo)." };
  }

  const beforeNodes = getRespNodes();
  const beforeCount = beforeNodes.length;
  const beforeLastText = beforeCount > 0 ? extractBest(beforeNodes[beforeCount - 1]) : "";
  const beforeJsonCount = getJsonCount();

  inputEl.click();
  inputEl.focus();
  await wait(120);

  const getLen = () =>
    inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT"
      ? (inputEl.value || "").trim().length
      : (inputEl.innerText || inputEl.textContent || "").trim().length;

  const minExpectedLen = Math.min(250, Math.floor(promptText.length * 0.5));

  if (inputEl.tagName === "TEXTAREA" || inputEl.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(inputEl, promptText);
    else inputEl.value = promptText;
    inputEl.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  } else {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("delete", false, null);
    } catch {}
    await wait(80);

    // Attach live screenshot directly to Gemini Web chat box via drop + paste when provided!
    if (screenshot && screenshot.base64) {
      try {
        const bin = atob(screenshot.base64);
        const bytes = new Uint8Array(bin.length);
        for (let bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
        const imgFile = new File([bytes], "codetantra_error.jpg", { type: screenshot.mimeType || "image/jpeg" });
        const imgDt = new DataTransfer();
        imgDt.items.add(imgFile);
        const dropTarget = inputEl.closest("rich-textarea") || inputEl.parentElement || inputEl;
        dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, dataTransfer: imgDt }));
        dropTarget.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: imgDt }));
        dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: imgDt }));
        inputEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: imgDt }));
        await wait(1000);
      } catch {}
    }

    // METHOD 1: Simulated Clipboard Paste (inserts full multi-line prompt cleanly without Enter-submit on \n!)
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", promptText);
      inputEl.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt })
      );
    } catch {}
    await wait(200);

    // METHOD 2: Quill-native <p> paragraphs + full input/change events so Angular enables Send button!
    if (getLen() < minExpectedLen) {
      try {
        while (inputEl.firstChild) inputEl.removeChild(inputEl.firstChild);
        const lines = promptText.replace(/\r\n/g, "\n").split("\n");
        const frag = document.createDocumentFragment();
        for (const ln of lines) {
          const p = document.createElement("p");
          if (ln) p.textContent = ln;
          else p.appendChild(document.createElement("br"));
          frag.appendChild(p);
        }
        inputEl.appendChild(frag);
        inputEl.classList.remove("ql-blank");
        inputEl.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertFromPaste", data: promptText }));
        inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertFromPaste", data: promptText }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, composed: true }));
      } catch {}
      await wait(200);
    }

    // METHOD 3: Flattened single-line insertText (zero \n so it can never hit Enter early!)
    if (getLen() < minExpectedLen) {
      const flatPrompt = promptText.replace(/\r?\n+/g, "  ");
      try {
        inputEl.focus();
        document.execCommand("insertText", false, flatPrompt);
      } catch {}
      await wait(200);
    }
  }

  const finalLen = getLen();
  if (finalLen < minExpectedLen) {
    return {
      ok: false,
      error: `Gemini chat box mein pura prompt paste nahi hua (${finalLen}/${promptText.length} chars) — 'Web' dabakar 'API' mode try karo.`
    };
  }

  const isNonSend = (b) => {
    const meta = [b.getAttribute("aria-label") || "", b.getAttribute("title") || "", b.getAttribute("mattooltip") || "", b.innerText || ""]
      .join(" ")
      .toLowerCase();
    return /(mic|microphone|voice|record|attach|upload|add|plus|neon|model|chat|task|stop|menu|search|settings)/i.test(meta);
  };
  const findSend = () => {
    const sels = [
      'button[aria-label*="Send message" i]',
      'button[aria-label="Send" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[mattooltip*="Send" i]',
      'button[title*="Send" i]',
      'button.send-button',
      'button[data-test-id*="send" i]'
    ];
    for (const s of sels) {
      const btn = qDeep(s).find((b) => isVis(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isNonSend(b));
      if (btn) return btn;
    }
    return null;
  };

  let sendBtn = null;
  for (let i = 0; i < 7; i++) {
    sendBtn = findSend();
    if (sendBtn) break;
    await wait(200);
  }

  if (sendBtn) {
    sendBtn.click();
  } else {
    inputEl.focus();
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true }));
  }

  await wait(700);
  if (getLen() > 25) {
    inputEl.focus();
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true }));
    await wait(450);
  }

  return { ok: true, beforeCount, beforeLastText, beforeJsonCount, sentChars: finalLen };
}

function pollResponseDirect(beforeCount, beforeLastText, beforeJsonCount) {
  const isVis = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const qDeep = (sel, root = document) => {
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || !node.querySelectorAll) return;
      try {
        for (const el of node.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      } catch {}
      try {
        for (const el of node.querySelectorAll("*")) {
          if (el.tagName && el.tagName.includes("-") && el.shadowRoot) walk(el.shadowRoot);
        }
      } catch {}
    };
    walk(root);
    return out;
  };

  const stopSels = [
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop response" i]',
    'button[aria-label="Stop" i]',
    'button[mattooltip*="Stop" i]',
    ".stop-icon",
    'mat-icon[fonticon="stop"]'
  ];
  const generating = stopSels.some((s) => qDeep(s).some(isVis));

  const respSels = [
    "model-response message-content",
    "model-response .markdown",
    "model-response",
    '[data-message-author-role="model"]',
    ".response-container-content .markdown",
    '[data-test-id="model-response-text"]',
    "message-content"
  ];
  let nodes = [];
  for (const s of respSels) {
    const found = qDeep(s).filter((n) => (n.innerText || "").trim().length > 0);
    if (found.length) {
      nodes = found;
      break;
    }
  }

  const extractBest = (node) => {
    if (!node) return "";
    const fullText = (node.innerText || node.textContent || "").trim();
    const blocks = Array.from(node.querySelectorAll("pre code, code-block code, pre"));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].textContent || blocks[i].innerText || "").replace(/^\n+|\n+$/g, "");
      if (/<<<SLOT\s*\d+>>>/i.test(t)) return t;
    }
    if (/<<<SLOT\s*\d+>>>/i.test(fullText)) return fullText;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].textContent || blocks[i].innerText || "").trim();
      if (t.includes("{") && t.includes("}") && (/"1"\s*:/.test(t) || t.includes('"slots"') || t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"'))) {
        return t;
      }
    }
    if (blocks.length) {
      const bestBlock = blocks
        .map((b) => (b.textContent || b.innerText || "").replace(/^\n+|\n+$/g, ""))
        .sort((a, b) => b.length - a.length)[0];
      if (bestBlock && bestBlock.trim().length > 20) return "```\n" + bestBlock + "\n```";
    }
    return fullText;
  };

  const hasNewNode = nodes.length > beforeCount;
  const latestNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const latestText = latestNode ? extractBest(latestNode) : "";
  if (hasNewNode || (latestText && latestText !== beforeLastText)) {
    return { ok: true, hasNew: true, isNewNode: hasNewNode, generating, text: latestText };
  }

  const jsonBlocks = qDeep("pre code, code-block code, pre").filter((el) => {
    const t = (el.textContent || el.innerText || "").trim();
    return /<<<SLOT\s*\d+>>>/i.test(t) || (t.includes("{") && t.includes("}") && (t.includes('"slots"') || t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"')));
  });
  if (jsonBlocks.length > beforeJsonCount) {
    const txt = (jsonBlocks[jsonBlocks.length - 1].textContent || jsonBlocks[jsonBlocks.length - 1].innerText || "").replace(/^\n+|\n+$/g, "");
    return { ok: true, hasNew: true, isNewNode: true, generating, text: txt };
  }

  return { ok: true, hasNew: false, isNewNode: false, generating, text: "" };
}

let lastGeminiQuestionUrl = "";

async function askGeminiWebTab(prompt, callerTabId, screenshot = null, questionUrl = "", subject = "other") {
  const keepAlive = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {}
  }, 15000);

  const isNewQuestion = Boolean(questionUrl && lastGeminiQuestionUrl && questionUrl !== lastGeminiQuestionUrl);
  if (questionUrl) lastGeminiQuestionUrl = questionUrl;

  let switchedToGemini = false;
  let activeGeminiTabId = null;
  try {
    notifyProgress(callerTabId, `1/4 Gemini (${subject}) chat par jaa raha hoon...`);
    const tabRes = await getOrCreateGeminiTab(subject);
    const tab = tabRes?.tab;
    if (!tab || !tab.id) {
      return { ok: false, error: "gemini.google.com tab open nahi ho paya." };
    }
    activeGeminiTabId = tab.id;

    notifyProgress(callerTabId, screenshot ? `2/4 Live screenshot + question Gemini (${subject}) mein paste kar raha hoon...` : `2/4 Question Gemini (${subject}) chat mein paste kar raha hoon...`);
    await withTimeout(chrome.tabs.update(tab.id, { active: true }), 3000, "tabs.update");
    switchedToGemini = true;
    await sleep(250);

    let submitRes = null;
    try {
      const execArr = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: submitPromptDirect,
          args: [prompt, screenshot, isNewQuestion]
        }),
        25000,
        "submitPromptDirect"
      );
      submitRes = execArr && execArr[0] ? execArr[0].result : null;
    } catch (err) {
      const msg = String(err?.message || err || "");
      if (/cannot access|permission|host/i.test(msg)) {
        return {
          ok: false,
          error:
            "Chrome ne gemini.google.com par Site Access block kiya hai! Extension Details -> Site access -> 'On all sites' ON karo."
        };
      }
      return { ok: false, error: `Gemini Web inject error: ${msg}` };
    }

    if (!submitRes || !submitRes.ok) {
      return { ok: false, error: submitRes?.error || "Gemini Web par prompt send nahi ho paya." };
    }

    const { beforeCount = 0, beforeLastText = "", beforeJsonCount = 0 } = submitRes;
    let lastSeen = "";
    let unchangedTicks = 0;
    const startTs = Date.now();

    // Give Gemini 1.5s to register the new user turn before polling so it never reads a stale previous reply
    await sleep(1500);

    while (Date.now() - startTs < 120000) {
      await sleep(700);
      const elapsed = Math.round((Date.now() - startTs) / 1000);
      notifyProgress(
        callerTabId,
        lastSeen
          ? `3/4 Gemini (${subject}) answer likh raha hai (${lastSeen.length} chars, ${elapsed}s)...`
          : `3/4 Pura question bhej diya ✓ — reply ka wait (${elapsed}s)...`
      );

      let poll = null;
      try {
        const pollArr = await withTimeout(
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: pollResponseDirect,
            args: [beforeCount, beforeLastText, beforeJsonCount]
          }),
          4000,
          "pollResponseDirect"
        );
        poll = pollArr && pollArr[0] ? pollArr[0].result : null;
      } catch {
        continue;
      }

      if (!poll || !poll.ok) continue;
      const curText = (poll.text || "").trim();
      const prevText = (beforeLastText || "").trim();
      console.log("[CT-GEMINI] poll", { subject, elapsed, hasNew: poll.hasNew, generating: poll.generating, len: curText.length });
      if (poll.hasNew && curText && (poll.isNewNode || curText !== prevText)) {
        const hasFullSlot = /<<<\s*SLOT\s*\d+\s*>>>/i.test(curText) && /<<<\s*END_SLOT\s*\d+\s*>>>/i.test(curText);
        let hasFullJson = false;
        if (!poll.generating && curText.includes("{") && curText.includes("}")) {
          try {
            const parsedCheck = JSON.parse(curText.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim());
            if (parsedCheck && typeof parsedCheck === "object" && Object.keys(parsedCheck).length > 0) hasFullJson = true;
          } catch {}
        }
        if ((hasFullSlot && !poll.generating) || hasFullJson) {
          await sleep(450);
          const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
          if (updatedTab?.url) await setSubjectChatUrl(subject, updatedTab.url);
          notifyProgress(callerTabId, "4/4 Answer mil gaya ✓ — CodeTantra par wapas aa raha hoon...");
          return { ok: true, model: `Gemini Web (${subject})`, rawText: curText };
        }
        if (curText === lastSeen) {
          unchangedTicks++;
          if ((!poll.generating && unchangedTicks >= 2) || unchangedTicks >= 25) {
            const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
            if (updatedTab?.url) await setSubjectChatUrl(subject, updatedTab.url);
            notifyProgress(callerTabId, "4/4 Answer mil gaya ✓ — CodeTantra par wapas aa raha hoon...");
            return { ok: true, model: `Gemini Web (${subject})`, rawText: curText };
          }
        } else {
          lastSeen = curText;
          unchangedTicks = 0;
        }
      }
    }

    if (lastSeen && lastSeen !== beforeLastText) {
      const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (updatedTab?.url) await setSubjectChatUrl(subject, updatedTab.url);
      return { ok: true, model: `Gemini Web (${subject})`, rawText: lastSeen };
    }
    return { ok: false, error: "Gemini Web se 120s mein reply nahi aaya — Gemini tab mein 'Neon' ko 'Fast' par switch karo ya green 'Web' dabakar 'API' mode chalao." };
  } catch (err) {
    return { ok: false, error: `Gemini Web error: ${err?.message || err}` };
  } finally {
    clearInterval(keepAlive);
    if (activeGeminiTabId && subject) {
      try {
        const finalTab = await chrome.tabs.get(activeGeminiTabId);
        if (finalTab?.url) await setSubjectChatUrl(subject, finalTab.url);
      } catch {}
    }
    if (switchedToGemini && callerTabId) {
      try {
        await chrome.tabs.update(callerTabId, { active: true });
      } catch {}
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === "CAPTURE_SCREENSHOT") {
    const winId = sender?.tab?.windowId ?? null;
    try {
      chrome.tabs.captureVisibleTab(winId, { format: "jpeg", quality: 80 }, (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "Screenshot capture failed." });
        } else {
          const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/i, "");
          sendResponse({ ok: true, mimeType: "image/jpeg", base64 });
        }
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true;
  }
  if (msg.type === "GEMINI_WEB_ASK") {
    askGeminiWebTab(msg.prompt || "", sender?.tab?.id, msg.screenshot || null, msg.questionUrl || "", msg.subject || "other")
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});
