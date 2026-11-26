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

async function getOrCreateGeminiTab() {
  const tabs = await withTimeout(chrome.tabs.query({ url: "https://gemini.google.com/*" }), 4000, "tabs.query");
  if (tabs && tabs.length > 0) {
    const picked = tabs.find((t) => !t.discarded && t.status === "complete") || tabs[0];
    if (picked.status !== "complete") {
      await waitForTabComplete(picked.id, 10000);
    }
    return picked;
  }

  const created = await withTimeout(
    chrome.tabs.create({ url: "https://gemini.google.com/app", active: true }),
    5000,
    "tabs.create"
  );
  await waitForTabComplete(created.id, 12000);
  await sleep(1500);
  return created;
}

// Executed directly inside https://gemini.google.com/* via chrome.scripting.executeScript
async function submitPromptDirect(promptText, screenshot = null) {
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

  // Keep chat fast & clean: if current Gemini chat already has >= 4 replies, click 'New chat' in the SAME tab (never spawn a duplicate tab!)
  const initialNodes = getRespNodes();
  if (initialNodes.length >= 4) {
    const newChatBtn = qDeep('a, button, [role="button"]').find((el) => {
      if (!isVis(el)) return false;
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
      return t === "new chat" || t.startsWith("new chat");
    });
    if (newChatBtn) {
      if (newChatBtn.tagName === "A") newChatBtn.removeAttribute("target");
      newChatBtn.click();
      await wait(900);
    }
  }

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

    // Attach live screenshot directly to Gemini Web chat box when provided!
    if (screenshot && screenshot.base64) {
      try {
        const bin = atob(screenshot.base64);
        const bytes = new Uint8Array(bin.length);
        for (let bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
        const imgFile = new File([bytes], "codetantra_error.jpg", { type: screenshot.mimeType || "image/jpeg" });
        const imgDt = new DataTransfer();
        imgDt.items.add(imgFile);
        inputEl.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: imgDt })
        );
        await wait(1100);
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
      if (t.includes("{") && t.includes("}") && (t.includes('"slots"') || t.includes('"edits"') || t.includes('"answers"') || t.includes('"verified"'))) {
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

async function askGeminiWebTab(prompt, callerTabId, screenshot = null) {
  const keepAlive = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {}
  }, 15000);

  let switchedToGemini = false;
  try {
    notifyProgress(callerTabId, "1/4 Gemini tab par jaa raha hoon...");
    const tab = await getOrCreateGeminiTab();
    if (!tab || !tab.id) {
      return { ok: false, error: "gemini.google.com tab open nahi ho paya." };
    }

    notifyProgress(callerTabId, screenshot ? "2/4 Live screenshot + question Gemini Web mein paste kar raha hoon..." : "2/4 Pura question + code Gemini mein paste kar raha hoon...");
    await withTimeout(chrome.tabs.update(tab.id, { active: true }), 3000, "tabs.update");
    switchedToGemini = true;
    await sleep(250);

    let submitRes = null;
    try {
      const execArr = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: submitPromptDirect,
          args: [prompt, screenshot]
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
          ? `3/4 Gemini answer likh raha hai (${lastSeen.length} chars, ${elapsed}s)...`
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
      if (poll.hasNew && curText && (poll.isNewNode || curText !== prevText)) {
        const hasFullSlot = /<<<SLOT\s*\d+>>>/i.test(curText) && /<<<END_SLOT\s*\d+>>>/i.test(curText);
        if (hasFullSlot) {
          // Closing <<<END_SLOT N>>> tag is already written — wait 1 short tick and return IMMEDIATELY (zero 60s+ hangs!)
          await sleep(600);
          notifyProgress(callerTabId, "4/4 Answer mil gaya ✓ — CodeTantra par wapas aa raha hoon...");
          return { ok: true, model: "Gemini Web (Free)", rawText: curText };
        }
        if (curText === lastSeen) {
          unchangedTicks++;
          if ((!poll.generating && unchangedTicks >= 2) || unchangedTicks >= 5) {
            notifyProgress(callerTabId, "4/4 Answer mil gaya ✓ — CodeTantra par wapas aa raha hoon...");
            return { ok: true, model: "Gemini Web (Free)", rawText: curText };
          }
        } else {
          lastSeen = curText;
          unchangedTicks = 0;
        }
      }
    }

    if (lastSeen && lastSeen !== beforeLastText) {
      return { ok: true, model: "Gemini Web (Free)", rawText: lastSeen };
    }
    return { ok: false, error: "Gemini Web se 120s mein reply nahi aaya — Gemini tab mein 'Neon' ko 'Fast' par switch karo ya green 'Web' dabakar 'API' mode chalao." };
  } catch (err) {
    return { ok: false, error: `Gemini Web error: ${err?.message || err}` };
  } finally {
    clearInterval(keepAlive);
    if (switchedToGemini && callerTabId) {
      try {
        await chrome.tabs.update(callerTabId, { active: true });
      } catch {}
    }
  }
}

// ---------------- Smart ChatGPT Web Fallback (when Gemini fails 2x on same error) ----------------
async function getOrCreateChatGptTab() {
  const tabs = await withTimeout(chrome.tabs.query({ url: "https://chatgpt.com/*" }), 4000, "tabs.query");
  if (tabs && tabs.length > 0) {
    const picked = tabs.find((t) => !t.discarded && t.status === "complete") || tabs[0];
    if (picked.status !== "complete") await waitForTabComplete(picked.id, 10000);
    return picked;
  }
  const created = await withTimeout(chrome.tabs.create({ url: "https://chatgpt.com/", active: true }), 5000, "tabs.create");
  await waitForTabComplete(created.id, 12000);
  await sleep(1800);
  return created;
}

async function submitChatGptDirect(promptText) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isVis = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const findInput = () => {
    const sels = ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', 'textarea[name="prompt-textarea"]', 'textarea'];
    for (const s of sels) {
      const hit = Array.from(document.querySelectorAll(s)).find(isVis);
      if (hit) return hit;
    }
    return null;
  };
  const getNodes = () => Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter((n) => (n.textContent || "").trim().length > 0);
  let inputEl = null;
  for (let i = 0; i < 12; i++) {
    inputEl = findInput();
    if (inputEl) break;
    await wait(250);
  }
  if (!inputEl) return { ok: false, error: "chatgpt.com par chat box nahi mila (login check karo)." };

  const beforeNodes = getNodes();
  const beforeCount = beforeNodes.length;
  const beforeLastText = beforeCount > 0 ? (beforeNodes[beforeCount - 1].textContent || "").trim() : "";

  inputEl.click();
  inputEl.focus();
  await wait(150);
  const getCurLen = () =>
    inputEl.tagName === "TEXTAREA"
      ? (inputEl.value || "").trim().length
      : (inputEl.innerText || inputEl.textContent || "").trim().length;
  const minLen = Math.min(180, Math.floor(promptText.length * 0.4));

  if (inputEl.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(inputEl, promptText);
    else inputEl.value = promptText;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // Method 1: Native execCommand insertText (works cleanly with ChatGPT ProseMirror!)
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, promptText);
    } catch {}
    await wait(220);
    // Method 2: ClipboardEvent paste
    if (getCurLen() < minLen) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", promptText);
        inputEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
      } catch {}
      await wait(220);
    }
    // Method 3: ProseMirror <p> paragraphs
    if (getCurLen() < minLen) {
      while (inputEl.firstChild) inputEl.removeChild(inputEl.firstChild);
      for (const ln of promptText.replace(/\r\n/g, "\n").split("\n")) {
        const p = document.createElement("p");
        if (ln) p.textContent = ln;
        else p.appendChild(document.createElement("br"));
        inputEl.appendChild(p);
      }
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: promptText, inputType: "insertFromPaste" }));
      await wait(220);
    }
  }
  if (getCurLen() < minLen) {
    return { ok: false, error: `ChatGPT input box mein prompt paste nahi hua (${getCurLen()}/${promptText.length} chars).` };
  }
  let sendBtn = null;
  for (let i = 0; i < 8; i++) {
    sendBtn = Array.from(document.querySelectorAll('button[data-testid="send-button"], button[aria-label*="Send prompt" i], button[aria-label*="Send" i]')).find((b) => isVis(b) && !b.disabled);
    if (sendBtn) break;
    await wait(200);
  }
  if (sendBtn) sendBtn.click();
  else inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  await wait(700);
  return { ok: true, beforeCount, beforeLastText };
}

function pollChatGptDirect(beforeCount, beforeLastText) {
  const generating = Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]'));
  const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter((n) => (n.textContent || "").trim().length > 0);
  const hasNewNode = nodes.length > beforeCount;
  const latest = nodes.length ? nodes[nodes.length - 1] : null;
  let text = "";
  if (latest) {
    const blocks = Array.from(latest.querySelectorAll("pre code, pre"));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const t = (blocks[i].textContent || "").replace(/^\n+|\n+$/g, "");
      if (/<<<SLOT\s*\d+>>>/i.test(t)) { text = t; break; }
    }
    if (!text) {
      const full = (latest.innerText || latest.textContent || "").trim();
      if (/<<<SLOT\s*\d+>>>/i.test(full)) text = full;
      else if (blocks.length) {
        const best = blocks.map((b) => (b.textContent || "").replace(/^\n+|\n+$/g, "")).sort((a, b) => b.length - a.length)[0];
        if (best && best.trim().length > 20) text = "```\n" + best + "\n```";
      } else text = full;
    }
  }
  return { ok: true, hasNew: hasNewNode || (Boolean(text) && text !== beforeLastText), isNewNode: hasNewNode, generating, text };
}

async function askChatGptWebTab(prompt, callerTabId) {
  let switched = false;
  try {
    notifyProgress(callerTabId, "Fallback: ChatGPT (chatgpt.com) se second-opinion le raha hoon...");
    const tab = await getOrCreateChatGptTab();
    if (!tab || !tab.id) return { ok: false, error: "chatgpt.com tab open nahi hua." };
    await withTimeout(chrome.tabs.update(tab.id, { active: true }), 3000, "tabs.update");
    switched = true;
    await sleep(300);
    const subArr = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: submitChatGptDirect, args: [prompt] }), 12000, "submitChatGptDirect");
    const subRes = subArr?.[0]?.result;
    if (!subRes || !subRes.ok) return { ok: false, error: subRes?.error || "ChatGPT submit failed." };
    const { beforeCount = 0, beforeLastText = "" } = subRes;
    let lastSeen = "";
    let unchanged = 0;
    const startTs = Date.now();
    await sleep(1500);
    while (Date.now() - startTs < 95000) {
      await sleep(750);
      const elapsed = Math.round((Date.now() - startTs) / 1000);
      notifyProgress(callerTabId, `ChatGPT reply (${lastSeen.length} chars, ${elapsed}s)...`);
      let poll = null;
      try {
        const pArr = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pollChatGptDirect, args: [beforeCount, beforeLastText] }), 4000, "pollChatGptDirect");
        poll = pArr?.[0]?.result;
      } catch { continue; }
      if (!poll || !poll.ok) continue;
      const curText = (poll.text || "").trim();
      if (poll.hasNew && curText && (poll.isNewNode || curText !== beforeLastText.trim())) {
        if (/<<<SLOT\s*\d+>>>/i.test(curText) && /<<<END_SLOT\s*\d+>>>/i.test(curText)) {
          await sleep(600);
          return { ok: true, model: "ChatGPT Web (Fallback)", rawText: curText };
        }
        if (curText === lastSeen) {
          unchanged++;
          if ((!poll.generating && unchanged >= 2) || unchanged >= 5) {
            return { ok: true, model: "ChatGPT Web (Fallback)", rawText: curText };
          }
        } else {
          lastSeen = curText;
          unchanged = 0;
        }
      }
    }
    return lastSeen ? { ok: true, model: "ChatGPT Web (Fallback)", rawText: lastSeen } : { ok: false, error: "ChatGPT timeout." };
  } catch (err) {
    return { ok: false, error: `ChatGPT fallback error: ${err?.message || err}` };
  } finally {
    if (switched && callerTabId) {
      try { await chrome.tabs.update(callerTabId, { active: true }); } catch {}
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
    askGeminiWebTab(msg.prompt || "", sender?.tab?.id, msg.screenshot || null)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === "CHATGPT_WEB_ASK") {
    askChatGptWebTab(msg.prompt || "", sender?.tab?.id)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});
