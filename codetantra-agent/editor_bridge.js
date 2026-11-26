// Runs in MAIN world across ALL frames (top + nested iframes) on *.codetantra.com
(function () {
  if (window.__ctBridgeLoaded) return;
  window.__ctBridgeLoaded = true;

  const isTop = window === window.top;
  let stopTypingFlag = false;
  let activeTypingSessionId = 0;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randMs(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  const BLOCKED_QUESTION_PATTERNS = [];
  function isBlockedQuestionText(str) {
    const t = (str || "").replace(/\s+/g, " ").trim();
    return BLOCKED_QUESTION_PATTERNS.some((re) => re.test(t));
  }

  function normalizeText(str) {
    return (str || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCM6View(cmEditorEl, cmContentEl) {
    const candidates = [cmContentEl, cmEditorEl, cmContentEl?.querySelector(".cm-line")].filter(Boolean);
    for (const el of candidates) {
      if (el.cmView && el.cmView.view) return el.cmView.view;
      if (el.cmView && el.cmView.rootView && el.cmView.rootView.view) return el.cmView.rootView.view;
      if (el.view && el.view.state && el.view.dispatch) return el.view;
    }
    return null;
  }

  function detectEditorInDoc(doc, win) {
    if (!doc) return null;

    // 1. CodeMirror 6 (Primary editor on CodeTantra)
    const cmContent = doc.querySelector(".cm-editor .cm-content") || doc.querySelector(".cm-content");
    if (cmContent) {
      const cmEditor = cmContent.closest(".cm-editor") || cmContent.parentElement;
      const view = findCM6View(cmEditor, cmContent);
      return { type: "cm6", editor: view, el: cmEditor, contentEl: cmContent, doc, win };
    }

    // 2. Ace Editor
    const aceEl = doc.querySelector(".ace_editor");
    if (aceEl) {
      let editor = aceEl.env?.editor || null;
      if (!editor && win?.ace && typeof win.ace.edit === "function") {
        try {
          editor = win.ace.edit(aceEl);
        } catch {
          editor = null;
        }
      }
      if (editor && editor.session) {
        return { type: "ace", editor, el: aceEl, doc, win };
      }
    }

    // 3. Monaco Editor
    if (win?.monaco && win.monaco.editor) {
      const models = win.monaco.editor.getModels?.() || [];
      const editors = win.monaco.editor.getEditors?.() || [];
      if (editors.length && models.length) {
        return { type: "monaco", editor: editors[0], model: editors[0].getModel() || models[0], doc, win };
      }
      if (models.length) {
        return { type: "monaco", editor: null, model: models[0], doc, win };
      }
    }

    // 4. CodeMirror 5
    const cmEl = doc.querySelector(".CodeMirror");
    if (cmEl && cmEl.CodeMirror) {
      return { type: "codemirror", editor: cmEl.CodeMirror, el: cmEl, doc, win };
    }

    return null;
  }

  function detectEditorRecursive(doc = document, win = window, depth = 0) {
    if (depth > 4) return null;
    const local = detectEditorInDoc(doc, win);
    if (local) return local;

    const iframes = Array.from(doc.querySelectorAll("iframe"));
    for (const frame of iframes) {
      try {
        if (frame.contentDocument && frame.contentWindow) {
          const found = detectEditorRecursive(frame.contentDocument, frame.contentWindow, depth + 1);
          if (found) return found;
        }
      } catch {
        // cross-origin iframe handled via postMessage broadcast
      }
    }
    return null;
  }

  function hasMultiLangDropdownInDoc(doc) {
    if (!doc || !doc.body) return false;
    const win = doc.defaultView || window;
    const minX = Math.floor((win.innerWidth || 1200) * 0.42);
    const triggers = Array.from(doc.querySelectorAll("button, [role='button'], select")).filter((el) => {
      if (el.closest("#ct-helper-panel") || !isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.top >= 220 || r.left < minX || r.width < 22 || r.width >= 165 || r.height < 16 || r.height > 54) return false;
      const t = (el.innerText || el.textContent || "").replace(/[^a-z0-9+]/gi, "").toLowerCase();
      return t === "c" || t === "c++" || t === "cpp" || t === "java" || t === "python" || t === "python3";
    });
    return triggers.length > 0;
  }

  function detectLanguageFromDoc(doc) {
    // 1. Check top-right CodeTantra language dropdown button (Java / Python / C++ / C / WebTech) first!
    const topBtns = Array.from(doc.querySelectorAll("button, [role='button'], select")).filter(
      (el) => !el.closest("#ct-helper-panel") && isVisible(el)
    );
    for (const el of topBtns) {
      const r = el.getBoundingClientRect();
      if (r.top < 170 && r.width < 165) {
        const t = (el.innerText || el.textContent || "").replace(/[^a-z0-9+]/gi, "").toLowerCase();
        if (t === "java") return "java";
        if (t === "python" || t === "python3") return "python";
        if (t === "c++" || t === "cpp") return "cpp";
        if (t === "c") return "c";
        if (t === "html" || t === "html5") return "html";
        if (t === "css" || t === "css3") return "css";
        if (t === "javascript" || t === "js") return "javascript";
      }
    }

    // 2. Check file tab extensions (.java, .py, .c, .cpp, .html, .css, .js) OR CodeTantra prefixes
    const els = Array.from(doc.querySelectorAll("[role='tab'], .tab, button, span, div"));
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length < 48 && /\.(py|java|c|cpp|cc|cxx|js|jsx|ts|sql|html|htm|css)$/i.test(t)) {
        const ext = t.split(".").pop().toLowerCase();
        const map = {
          py: "python",
          java: "java",
          c: "c",
          cpp: "cpp",
          cc: "cpp",
          cxx: "cpp",
          js: "javascript",
          jsx: "javascript",
          ts: "typescript",
          sql: "sql",
          html: "html",
          htm: "html",
          css: "css"
        };
        if (map[ext]) return map[ext];
      }
      if (t.length >= 4 && t.length < 25) {
        if (/^CTJ\d+/i.test(t)) return "java";
        if (/^CTP\d+/i.test(t)) return "python";
        if (/^CTCPP\d+/i.test(t)) return "cpp";
        if (/^CTC\d+/i.test(t)) return "c";
        if (/^CTW\d+/i.test(t)) return "html";
      }
    }
    return "";
  }

  async function expandSingleAccordionInDoc(doc, titleRegex) {
    if (!doc || !doc.body) return false;
    try {
      const els = Array.from(doc.querySelectorAll("button, h1, h2, h3, h4, h5, h6, div, span, p, a, summary")).filter(
        (el) =>
          !el.closest("#ct-helper-panel") &&
          !el.closest(".cm-editor") &&
          !el.closest(".ace_editor") &&
          isVisible(el)
      );
      const matches = els.filter((el) => {
        const t = normalizeText(el.innerText || el.textContent || "");
        return titleRegex.test(t) && (el.innerText || "").trim().length < 55;
      });
      const header = matches.find((el) => !matches.some((other) => other !== el && el.contains(other))) || matches[0];
      if (!header) return false;

      header.scrollIntoView({ behavior: "instant", block: "center" });
      await sleep(220);

      // Check if accordion is already expanded via aria-expanded or minus icon
      const toggleBtn =
        header.closest("button, [role='button'], summary") ||
        header.parentElement?.closest("button, [role='button']") ||
        header.parentElement ||
        header;

      const ariaExp = toggleBtn.getAttribute("aria-expanded") || header.getAttribute("aria-expanded");
      if (ariaExp === "true") return true;

      // Measure ENTIRE doc visible text length (handles sibling accordion bodies!)
      const beforeLen = (doc.body.innerText || "").length;

      // Click ONCE on toggleBtn with full mouse events — NEVER double-toggle!
      dispatchReliableClick(toggleBtn);
      await sleep(500);

      const afterLen1 = (doc.body.innerText || "").length;
      if (afterLen1 > beforeLen + 20) {
        return true; // Opened cleanly!
      }
      if (afterLen1 < beforeLen - 20) {
        // It was already open and we accidentally closed it — click ONCE to re-open!
        dispatchReliableClick(toggleBtn);
        await sleep(450);
        return true;
      }

      // If toggleBtn had no effect at all, try clicking header itself ONCE
      if (header !== toggleBtn) {
        dispatchReliableClick(header);
        await sleep(500);
        const afterLen2 = (doc.body.innerText || "").length;
        if (afterLen2 > beforeLen + 20) return true;
        if (afterLen2 < beforeLen - 20) {
          dispatchReliableClick(header);
          await sleep(450);
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  async function expandSampleTestCasesInDoc(doc, depth = 0) {
    if (!doc || !doc.body || depth > 3) return false;
    const s1 = await expandSingleAccordionInDoc(doc, /^sample test cases?/i);
    const s2 = await expandSingleAccordionInDoc(doc, /^question hints?/i);
    if (s1 || s2) return true;

    // Also check same-origin child iframes
    for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
      try {
        if (frame.contentDocument) {
          const childOpened = await expandSampleTestCasesInDoc(frame.contentDocument, depth + 1);
          if (childOpened) return true;
        }
      } catch {
        // cross-origin handled via postMessage
      }
    }
    return false;
  }

  function extractProblemTextFromDoc(doc) {
    if (!doc || !doc.body) return "";
    const clone = doc.body.cloneNode(true);
    // NEVER strip [class*="course-content"] — CodeTantra's left Problem Statement pane uses that class!
    clone
      .querySelectorAll(
        '#ct-helper-panel, aside, nav, header, .navbar, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i], .cm-editor, .ace_editor, .monaco-editor, .CodeMirror, script, style, [aria-hidden="true"], .hidden, .d-none, [style*="display: none"], [style*="display:none"]'
      )
      .forEach((el) => el.remove());
    // Strip any hidden OR open CodeTantra TOC / search-modal container that wasn't caught by class names
    Array.from(clone.querySelectorAll("div, ul, section, nav")).forEach((el) => {
      const t = (el.innerText || "").trim();
      if (
        t.length > 60 &&
        (/search content|minimum 3 characters required for search|1\.1\.1\.\s*what is data structure|36\.1\.1\.\s*rat in a maze/i.test(t) ||
          (t.match(/\b\d+\.\d+\.\d+\./g) || []).length >= 4)
      ) {
        el.remove();
      }
    });
    let text = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

    // Fallback: if class-based stripping removed too much, read directly from the visible left-half problem pane!
    if (text.length < 80) {
      try {
        const win = doc.defaultView || window;
        const maxLeftX = Math.floor((win.innerWidth || 1200) * 0.48);
        const chunks = [];
        const seen = new Set();
        for (const el of Array.from(doc.querySelectorAll("h1, h2, h3, h4, p, li, pre, div"))) {
          if (el.closest("#ct-helper-panel, header, nav, .navbar, .cm-editor, .ace_editor")) continue;
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.top < 55 || r.left > maxLeftX || r.width < 120 || r.height < 14) continue;
          if (el.children.length > 0 && el.tagName === "DIV") continue;
          const t = (el.innerText || "").trim();
          if (t && t.length < 1200 && !seen.has(t)) {
            seen.add(t);
            chunks.push(t);
          }
        }
        const leftText = chunks.join("\n").trim();
        if (leftText.length > text.length) text = leftText;
      } catch {}
    }

    return text.slice(0, 9000);
  }

  // Auto-switch editor language dropdown (e.g. C -> Java / Python / C++) when user sets preferred language
  async function switchEditorLanguageInDoc(doc, targetLang) {
    if (!doc || !doc.body || !targetLang || targetLang === "auto") return { ok: false };
    const want = targetLang.toLowerCase();
    const langLabels = { java: "java", python: "python", c: "c", cpp: "c++" };
    const targetLabel = langLabels[want] || want;

    // Find top-right editor language dropdown button (shows C / C++ / Java / Python near Submit)
    const rawTriggers = Array.from(doc.querySelectorAll("button, [role='button'], select, div, span")).filter((el) => {
      if (el.closest("#ct-helper-panel")) return false;
      if (!isVisible(el)) return false;
      const win = doc.defaultView || window;
      const r = el.getBoundingClientRect();
      if (r.top >= 220 || r.left < Math.floor((win.innerWidth || 1200) * 0.42) || r.width < 22 || r.width >= 150 || r.height < 16 || r.height > 52) return false;
      const t = (el.innerText || el.textContent || "").replace(/[^a-z0-9+]/gi, "").toLowerCase();
      return t === "c" || t === "c++" || t === "java" || t === "python" || t === "python3";
    });
    const triggers = rawTriggers.filter((el) => !rawTriggers.some((other) => other !== el && el.contains(other)));
    const langTriggerEl = triggers[0];
    if (!langTriggerEl) return { ok: false };
    const langTrigger = langTriggerEl.closest("button, [role='button']") || langTriggerEl;

    const curText = (langTrigger.innerText || langTrigger.textContent || "").replace(/[^a-z0-9+]/gi, "").toLowerCase();
    if (curText === targetLabel || (want === "python" && curText.startsWith("python"))) {
      return { ok: true, already: true };
    }

    const triggerRect = langTrigger.getBoundingClientRect();
    dispatchReliableClick(langTrigger);
    await sleep(400);

    // Pick ONLY actual dropdown menu options BELOW the trigger (never langTrigger's own child span!)
    const rawMenuItems = Array.from(doc.querySelectorAll("button, li, a, div, span, [role='menuitem'], [role='option']")).filter(
      (el) => {
        if (el.closest("#ct-helper-panel")) return false;
        if (el === langTrigger || langTrigger.contains(el)) return false;
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.top < triggerRect.bottom - 5 || r.height < 16 || r.height > 60 || r.width > 240) return false;
        const t = (el.innerText || el.textContent || "").replace(/[^a-z0-9+]/gi, "").toLowerCase();
        return t === targetLabel || (want === "python" && t.startsWith("python"));
      }
    );
    const pick = rawMenuItems.find((el) => !rawMenuItems.some((other) => other !== el && el.contains(other))) || rawMenuItems[0];
    if (pick) {
      const host = pick.closest("button, li, [role='menuitem'], [role='option']") || pick;
      dispatchReliableClick(host);
      if (host !== pick) dispatchReliableClick(pick);
      await sleep(1100);
      try {
        doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } catch {}
      return { ok: true, switchedTo: targetLabel };
    }
    try {
      doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch {}
    return { ok: false };
  }

  // Auto-open first uncompleted item card on "About this unit" / module overview pages
  function openUnitItemInDoc(doc) {
    if (!doc || !doc.body) return { ok: false };
    const win = doc.defaultView || window;
    let currentHash = "";
    try {
      currentHash = (win.top?.location?.hash || win.location.hash || "").toLowerCase();
    } catch {
      currentHash = (win.location.hash || "").toLowerCase();
    }
    const currentIdSeg = currentHash.split("/").filter(Boolean).pop() || "";

    // Find "About this unit" / "About this module" heading so we ONLY pick cards BELOW it (never sidebar/banner!)
    const allEls = Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6, div, span, p"));
    const aboutHeading = allEls.find((el) => {
      if (el.closest("#ct-helper-panel, header, nav, aside")) return false;
      if (!isVisible(el)) return false;
      const t = normalizeText(el.innerText || el.textContent || "");
      return (
        (t === "about this unit" || t === "about this module" || t === "about this chapter" || t === "about this section") &&
        (el.innerText || "").trim().length < 40
      );
    });
    const minTopY = aboutHeading ? aboutHeading.getBoundingClientRect().bottom + 4 : 110;

    const rawCandidates = Array.from(
      doc.querySelectorAll('a[href*="contents"], [role="button"], button, li, .card, div')
    ).filter((el) => {
      if (
        el.closest(
          '#ct-helper-panel, header, nav, aside, .navbar, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i], [class*="menu" i]'
        )
      ) {
        return false;
      }
      if (!isVisible(el)) return false;

      const rect = el.getBoundingClientRect();
      if (rect.top < minTopY) return false;
      if (rect.width < 260 || rect.height < 42 || rect.height > 200) return false;

      const rawText = (el.innerText || "").trim();
      const lines = rawText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 1 || rawText.length < 5 || rawText.length > 260) return false;

      // Never click the current unit's own link again
      const anchor = el.tagName === "A" ? el : el.closest("a") || el.querySelector("a[href]");
      const href = (anchor?.getAttribute("href") || "").toLowerCase();
      if (href && currentIdSeg && href.endsWith(currentIdSeg)) return false;

      const isDifferentContentLink = Boolean(
        anchor && href.includes("contents") && (!currentIdSeg || !href.endsWith(currentIdSeg))
      );
      const hasSubtitleType = lines.some((l) =>
        /^(question|lesson|video|quiz|lab|practice|reading|exercise|assessment|coding|objective|mcq|unit|module|topic|sub-unit|project|assignment|test)(\s|$)/i.test(
          l
        )
      );
      const isPointer = win.getComputedStyle(el).cursor === "pointer";
      const hasBorder =
        parseFloat(win.getComputedStyle(el).borderTopWidth || "0") > 0 ||
        (win.getComputedStyle(el).boxShadow || "none") !== "none";

      return isDifferentContentLink || (hasSubtitleType && (isPointer || hasBorder || Boolean(aboutHeading)));
    });

    // Keep innermost matching cards so we don't click a giant wrapper div
    const cards = rawCandidates.filter((el) => !rawCandidates.some((other) => other !== el && el.contains(other)));
    if (!cards.length) return { ok: false };

    function hasGreenTickColor(el) {
      const st = win.getComputedStyle(el);
      for (const prop of [st.color, st.fill, st.stroke, st.backgroundColor]) {
        const m = (prop || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = parseInt(m[1], 10);
          const g = parseInt(m[2], 10);
          const b = parseInt(m[3], 10);
          if (g >= 115 && g - r >= 25 && g - b >= 15) return true;
        }
      }
      return false;
    }

    function isCardCompleted(card) {
      const txt = normalizeText(card.innerText || "");
      if (txt.includes("completed") || txt.includes("100%")) return true;
      const doneEl = card.querySelector(
        '.text-success, .text-green, .completed, .fa-check, .fa-check-circle, [class*="check" i][class*="green" i], [class*="complete" i]'
      );
      if (doneEl) return true;
      const icons = Array.from(card.querySelectorAll("svg, path, circle, i, span"));
      return icons.some((ic) => hasGreenTickColor(ic));
    }

    const incomplete = cards.find((c) => !isCardCompleted(c) && !isBlockedQuestionText(c.innerText || ""));
    if (!incomplete) {
      return { ok: false, allCompleted: true };
    }
    const target = incomplete;
    const titleLines = (target.innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== "</>");
    const title = (titleLines[0] || "First item").slice(0, 80);

    target.scrollIntoView({ behavior: "instant", block: "center" });

    // Click the actual link/button or clickable card ancestor
    const clickable =
      target.closest('a[href], button, [role="button"]') ||
      target.querySelector('a[href], button, [role="button"]') ||
      target;

    clickable.click();
    if (clickable !== target) {
      try {
        target.click();
      } catch {}
    } else if (target.parentElement && win.getComputedStyle(target.parentElement).cursor === "pointer") {
      try {
        target.parentElement.click();
      } catch {}
    }

    return { ok: true, title };
  }

  // Open left Table-of-Contents sidebar if closed and scan STRICTLY TOP-TO-BOTTOM for the first incomplete (pink/non-green) item
  async function openNextIncompleteFromSidebar(doc) {
    if (!doc || !doc.body) return { ok: false };
    const win = doc.defaultView || window;
    let currentHash = "";
    try {
      currentHash = (win.top?.location?.hash || win.location.hash || "").toLowerCase();
    } catch {
      currentHash = (win.location.hash || "").toLowerCase();
    }
    const currentIdSeg = currentHash.split("/").filter(Boolean).pop() || "";

    function getSidebarRows(pattern) {
      const raw = Array.from(doc.querySelectorAll("a, button, li, div, [role='button'], [role='treeitem']")).filter((el) => {
        if (el.closest("#ct-helper-panel, header, .navbar")) return false;
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        // Left sidebar column on CodeTantra sits strictly on x = 0..410
        if (rect.left < 0 || rect.right > 410 || rect.top < 70) return false;
        if (rect.width < 90 || rect.height < 20 || rect.height > 72) return false;
        const t = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length < 5 || t.length > 150) return false;
        return pattern.test(t);
      });
      const innermost = raw.filter((el) => !raw.some((other) => other !== el && el.contains(other)));
      // Strictly sort top-to-bottom by screen Y coordinate
      return innermost.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    }

    function getSidebarIconStatus(row) {
      const scope = row.querySelector("svg, path, i") ? row : row.parentElement || row;
      const icons = Array.from(scope.querySelectorAll("svg, path, circle, i, span"));
      let hasGreen = false;
      let hasPink = false;
      for (const ic of icons) {
        const st = win.getComputedStyle(ic);
        for (const prop of [st.color, st.fill, st.stroke]) {
          const m = (prop || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
          if (m) {
            const r = parseInt(m[1], 10);
            const g = parseInt(m[2], 10);
            const b = parseInt(m[3], 10);
            if (g >= 110 && g > r + 18) hasGreen = true;
            if (r >= 150 && r > g + 25) hasPink = true;
          }
        }
      }
      return { hasGreen, hasPink };
    }

    function findSidebarScroller(sampleRow) {
      let cur = sampleRow?.parentElement;
      while (cur && cur !== doc.body) {
        const st = win.getComputedStyle(cur);
        if ((st.overflowY === "auto" || st.overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 20) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }

    const anyNumberedPattern = /(?:^|\s)\d+(?:\.\d+){0,2}\.?\s+\S/;
    const leafPattern = /(?:^|\s)\d+\.\d+\.\d+\.?\s+\S/;
    const unitPattern = /(?:^|\s)\d+\.\d+\.?\s+\S/;
    const modulePattern = /(?:^|\s)\d+\.\s+\S/;

    let allRows = getSidebarRows(anyNumberedPattern);
    if (!allRows.length) {
      // Open sidebar via the left-edge toggle button (≡)
      const toggleBtn = Array.from(doc.querySelectorAll("button, [role='button'], div, span")).find((el) => {
        if (el.closest("#ct-helper-panel, header, .navbar")) return false;
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left <= 30 && r.top >= 120 && r.top <= 480 && r.width >= 18 && r.width <= 48 && r.height >= 18 && r.height <= 60;
      });
      if (toggleBtn) {
        toggleBtn.click();
        await sleep(550);
        allRows = getSidebarRows(anyNumberedPattern);
      }
    }

    if (!allRows.length) return { ok: false };

    // ALWAYS scroll the sidebar to the VERY TOP first so we never skip earlier units like 9.4.2!
    const scroller = findSidebarScroller(allRows[0]);
    if (scroller) {
      scroller.scrollTop = 0;
      await sleep(250);
    }

    function clickSidebarRow(row) {
      const title = (row.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
      row.scrollIntoView({ behavior: "instant", block: "center" });
      const target = row.closest("a, button, [role='button']") || row.querySelector("a, button") || row;
      target.click();
      if (target !== row) {
        try {
          row.click();
        } catch {}
      }
      return { ok: true, title };
    }

    function isSamePage(row) {
      const a = row.tagName === "A" ? row : row.closest("a") || row.querySelector("a[href]");
      const href = (a?.getAttribute("href") || "").toLowerCase();
      return Boolean(href && currentIdSeg && href.endsWith(currentIdSeg));
    }

    // Sweep top-to-bottom across the sidebar
    const maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    const step = scroller ? Math.max(180, Math.floor(scroller.clientHeight * 0.7)) : 1;

    for (let y = 0; y <= maxScroll + step; y += step) {
      if (scroller) {
        scroller.scrollTop = Math.min(y, maxScroll);
        await sleep(160);
      }

      const rowsNow = getSidebarRows(anyNumberedPattern);
      // Find topmost non-green row (preferring pink-marked items first)
      for (let idx = 0; idx < rowsNow.length; idx++) {
        const row = rowsNow[idx];
        const txt = (row.innerText || "").replace(/\s+/g, " ").trim();
        const { hasGreen, hasPink } = getSidebarIconStatus(row);
        if (hasGreen) continue;

        // Skip explicitly blocked questions (e.g. 29.1.6)
        if (isBlockedQuestionText(txt)) continue;

        // Is it a leaf question (e.g. "9.4.2. Implementation...")?
        if (leafPattern.test(txt)) {
          if (!isSamePage(row)) {
            return clickSidebarRow(row);
          }
          continue;
        }

        // Is it a collapsed parent unit/module (no child items immediately following it in DOM/visual list)?
        const nextRow = rowsNow[idx + 1];
        const nextTxt = nextRow ? (nextRow.innerText || "").replace(/\s+/g, " ").trim() : "";
        const isModule = modulePattern.test(txt) && !unitPattern.test(txt) && !leafPattern.test(txt);
        const isUnit = unitPattern.test(txt) && !leafPattern.test(txt);

        if (isModule && (!nextRow || !unitPattern.test(nextTxt)) && (hasPink || !hasGreen)) {
          // Expand collapsed module (e.g. "9. Unit 2...")
          clickSidebarRow(row);
          await sleep(450);
          const expandedLeaves = getSidebarRows(leafPattern).filter(
            (r) => !getSidebarIconStatus(r).hasGreen && !isSamePage(r) && !isBlockedQuestionText(r.innerText || "")
          );
          if (expandedLeaves.length) return clickSidebarRow(expandedLeaves[0]);
        } else if (isUnit && (!nextRow || !leafPattern.test(nextTxt)) && (hasPink || !hasGreen)) {
          // Expand collapsed sub-unit (e.g. "9.4. Circular Queue..." or "9.6. Deque")
          clickSidebarRow(row);
          await sleep(450);
          const expandedLeaves = getSidebarRows(leafPattern).filter(
            (r) => !getSidebarIconStatus(r).hasGreen && !isSamePage(r) && !isBlockedQuestionText(r.innerText || "")
          );
          if (expandedLeaves.length) return clickSidebarRow(expandedLeaves[0]);
        }
      }

      if (!scroller || y >= maxScroll) break;
    }

    return { ok: false };
  }

  // Safety guardrail: detect if a coding/quiz page is still loading so we NEVER skip it with Next >!
  function hasPendingTaskInDoc(doc) {
    if (!doc || !doc.body) return false;
    if (doc.querySelector('.cm-editor, .cm-content, .ace_editor, .monaco-editor, .CodeMirror, input[type="radio"], input[type="checkbox"]')) {
      return true;
    }
    const btns = Array.from(doc.querySelectorAll("button, a, [role='button'], span, div, input[type='button'], input[type='submit']")).filter(
      (el) => !el.closest("#ct-helper-panel") && isVisible(el) && el.getBoundingClientRect().height < 64 && el.getBoundingClientRect().width < 220
    );
    const hasCodingOrQuizBtn = btns.some((el) => {
      const t = normalizeText(el.innerText || el.value || el.textContent || "");
      return t === "submit" || t === "reset" || t === "submit code" || t === "test cases" || t === "terminal" || t === "compile & run" || t === "explorer" || t === "debugger";
    });
    if (hasCodingOrQuizBtn) return true;

    const bodyTxt = normalizeText(doc.body.innerText || "");
    if (
      bodyTxt.includes("setting up environment") ||
      bodyTxt.includes("loading environment") ||
      bodyTxt.includes("sample test cases") ||
      bodyTxt.includes("sample input") ||
      bodyTxt.includes("sample output") ||
      bodyTxt.includes("shown test case") ||
      bodyTxt.includes("hidden test case") ||
      bodyTxt.includes("write a code") ||
      bodyTxt.includes("write a program") ||
      (bodyTxt.includes("input format") && bodyTxt.includes("output format"))
    ) {
      return true;
    }
    return false;
  }

  // Auto-expand EVERY collapsed FAILED 'Test case N' accordion (Test case 1, 2, 3...) AND collect each one's exact Expected vs Actual diff!
  // Works even when CodeTantra's accordion closes Test case 1 upon opening Test case 2!
  async function expandFailedTestCasesInDoc(doc) {
    if (!doc || !doc.body) return "";
    const collectedReports = [];
    try {
      const win = doc.defaultView || window;
      const minRightX = Math.floor((win.innerWidth || 1200) * 0.35);

      function getIconColorFlags(container) {
        let hasRed = false;
        let hasGreen = false;
        const icons = Array.from(container.querySelectorAll("svg, path, circle, i, span"));
        for (const ic of icons) {
          const st = win.getComputedStyle(ic);
          for (const prop of [st.color, st.fill, st.stroke, st.backgroundColor]) {
            const m = (prop || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
            if (!m) continue;
            const r = parseInt(m[1], 10);
            const g = parseInt(m[2], 10);
            const b = parseInt(m[3], 10);
            if (r >= 150 && r > g + 35 && r > b + 35) hasRed = true;
            if (g >= 115 && g > r + 25) hasGreen = true;
          }
        }
        return { hasRed, hasGreen };
      }

      const rawHeaders = Array.from(doc.querySelectorAll("button, [role='button'], div, span, h3, h4, h5")).filter((el) => {
        if (el.closest('#ct-helper-panel, .cm-editor, .ace_editor, aside, nav, header, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i]')) {
          return false;
        }
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.left < minRightX || r.height > 75 || r.width < 55) return false;
        const t = normalizeText(el.innerText || el.textContent || "");
        return /^test case\s*\d+\b/i.test(t) && t.length < 40;
      });
      const headers = rawHeaders.filter((el) => !rawHeaders.some((other) => other !== el && el.contains(other)));
      const seenCaseLabels = new Set();

      for (const hdr of headers) {
        const caseLabel = ((hdr.innerText || hdr.textContent || "").match(/test case\s*\d+/i) || ["Test case"])[0].trim();
        if (seenCaseLabels.has(caseLabel.toLowerCase())) continue;
        seenCaseLabels.add(caseLabel.toLowerCase());

        // Walk up to this single Test Case's own accordion card (stop before enclosing multiple Test Cases)
        let card = hdr.parentElement || hdr;
        for (let up = 0; up < 5 && card && card.parentElement && card.parentElement !== doc.body; up++) {
          const parentTxt = card.parentElement.innerText || "";
          const tcMatches = parentTxt.match(/test case\s*\d+/gi) || [];
          if (tcMatches.length <= 1) {
            card = card.parentElement;
          } else {
            break;
          }
        }

        const headerRow = hdr.closest("button, [role='button']") || hdr.parentElement || hdr;
        const { hasRed, hasGreen } = getIconColorFlags(card);
        // Skip clearly passed (green-only) test cases!
        if (hasGreen && !hasRed) continue;

        const isCardOpenNow = () => {
          const cTxt = normalizeText(card.innerText || "");
          return (
            ((cTxt.includes("expected output") && cTxt.includes("actual output")) ||
              cTxt.includes("error:") ||
              cTxt.includes("exception") ||
              cTxt.includes("traceback") ||
              cTxt.includes("reading more inputs") ||
              cTxt.includes("time limit exceeded")) &&
            card.getBoundingClientRect().height > 95
          );
        };

        if (!isCardOpenNow()) {
          hdr.scrollIntoView({ behavior: "instant", block: "center" });
          await sleep(140);
          // Try clicking the accordion row AND/OR right-side chevron button
          const chevronBtn = Array.from(headerRow.querySelectorAll("button, [role='button'], svg")).pop();
          dispatchReliableClick(headerRow);
          await sleep(420);
          if (!isCardOpenNow() && chevronBtn && chevronBtn !== headerRow) {
            dispatchReliableClick(chevronBtn.closest("button, [role='button']") || chevronBtn);
            await sleep(420);
          }
          if (!isCardOpenNow() && headerRow !== hdr) {
            dispatchReliableClick(hdr);
            await sleep(420);
          }
        }

        // Immediately extract THIS test case's diff while it is expanded (before opening the next one!)
        const cardDiff = extractExpectedVsActualDiffs(doc, card);
        if (cardDiff) {
          collectedReports.push(`=== ${caseLabel} ===\n${cardDiff}`);
        } else {
          const rawCard = (card.innerText || "").replace(/\u00B7/g, " ").replace(/\u21B5/g, "").trim();
          if (rawCard.length > 20) {
            collectedReports.push(`=== ${caseLabel} ===\n${rawCard.slice(0, 1200)}`);
          }
        }
      }
    } catch {}
    return collectedReports.join("\n\n");
  }

  // Parse CodeTantra's side-by-side 'Expected output' vs 'Actual output' diff (scoped to a single test-case card or whole doc)
  function extractExpectedVsActualDiffs(doc, scopeRoot = null) {
    const root = scopeRoot || doc?.body;
    if (!doc || !root) return "";
    const win = doc.defaultView || window;
    const minRightX = Math.floor((win.innerWidth || 1200) * 0.35);
    const cleanCell = (str) =>
      (str || "")
        .replace(/\u00B7/g, " ")
        .replace(/\u21B5/g, "")
        .replace(/\u00A0/g, " ")
        .replace(/\r\n/g, "\n")
        .replace(/\s+\n/g, "\n")
        .trim();

    const diffLines = [];
    const pushDiffRows = (rows) => {
      let lastEmittedIdx = -1;
      let diffCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const { exp, act } = rows[i];
        if (exp === act) continue;
        diffCount++;
        if (diffCount > 12) {
          diffLines.push(`... (+more mismatched rows omitted)`);
          break;
        }
        if (i > 0 && lastEmittedIdx < i - 1) {
          diffLines.push(`Context Row ${i}: ${rows[i - 1].exp}`);
        }
        diffLines.push(`MISMATCH Row ${i + 1}:\n  EXPECTED: ${JSON.stringify(exp)}\n  ACTUAL:   ${JSON.stringify(act)}`);
        lastEmittedIdx = i;
      }
    };

    // Strategy 1: Standard <table> containing Expected output / Actual output (read ALL rows, even scrolled-off!)
    try {
      const tables = Array.from(root.querySelectorAll("table")).filter((tb) => {
        if (tb.closest('#ct-helper-panel, aside, nav, [class*="sidebar" i]') || !isVisible(tb)) return false;
        const r = tb.getBoundingClientRect();
        if (r.left < minRightX) return false;
        const txt = normalizeText(tb.innerText || "");
        return txt.includes("expected output") && txt.includes("actual output");
      });
      for (const tb of tables) {
        const trs = Array.from(tb.querySelectorAll("tr"));
        const parsed = [];
        for (const tr of trs) {
          const cells = Array.from(tr.querySelectorAll("td, th"));
          if (cells.length < 2) continue;
          const c0 = cleanCell(cells[0].innerText || cells[0].textContent || "");
          const c1 = cleanCell(cells[1].innerText || cells[1].textContent || "");
          if (normalizeText(c0) === "expected output" || normalizeText(c1) === "actual output") continue;
          if (cells.length >= 3 && /^\d+$/.test(c0)) {
            parsed.push({ exp: c1, act: cleanCell(cells[2].innerText || cells[2].textContent || "") });
          } else {
            parsed.push({ exp: c0, act: c1 });
          }
        }
        if (parsed.length) pushDiffRows(parsed);
      }
    } catch {}

    // Strategy 2: Flex/Grid 2-column div layout under 'Expected output' | 'Actual output' (handles scrolled-off & multi-child rows!)
    if (!diffLines.length) {
      try {
        const expHeaders = Array.from(root.querySelectorAll("div, span, th, p")).filter((el) => {
          if (el.closest('#ct-helper-panel, aside, nav, [class*="sidebar" i]') || !isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.left >= minRightX && normalizeText(el.innerText || "") === "expected output";
        });
        for (const expHdr of expHeaders) {
          const expX = expHdr.getBoundingClientRect().left;
          let box = expHdr.parentElement;
          let foundBox = null;
          for (let up = 0; up < 6 && box && box !== doc.body; up++) {
            const txt = normalizeText(box.innerText || "");
            if (txt.includes("expected output") && txt.includes("actual output")) {
              foundBox = box;
              if ((box.innerText || "").length > 120) break;
            }
            box = box.parentElement;
          }
          if (!foundBox) continue;

          // 2a: Direct 2-column flex/grid rows
          const rowEls = Array.from(foundBox.querySelectorAll("div, li")).filter((el) => {
            if (el.children.length !== 2) return false;
            const r0 = el.children[0].getBoundingClientRect();
            const r1 = el.children[1].getBoundingClientRect();
            return r0.width > 40 && r1.width > 40 && Math.abs(r0.top - r1.top) < 22 && r1.left > r0.left + 60 && Math.abs(r0.left - expX) < 80;
          });
          const parsed = [];
          for (const row of rowEls) {
            const exp = cleanCell(row.children[0].innerText || row.children[0].textContent || "");
            const act = cleanCell(row.children[1].innerText || row.children[1].textContent || "");
            if (normalizeText(exp) === "expected output" && normalizeText(act) === "actual output") continue;
            if (!exp && !act) continue;
            parsed.push({ exp, act });
          }
          if (parsed.length) {
            pushDiffRows(parsed);
            continue;
          }

          // 2b: Tab-separated lines in foundBox.innerText (works even when CodeTantra uses CSS grid / nested wrappers!)
          const tabLines = (foundBox.innerText || "").split("\n");
          const tabParsed = [];
          for (const rawLine of tabLines) {
            if (!rawLine.includes("\t")) continue;
            const parts = rawLine.split("\t").map(cleanCell);
            if (parts.length < 2) continue;
            if (normalizeText(parts[0]) === "expected output" || normalizeText(parts[1]) === "actual output") continue;
            tabParsed.push({ exp: parts[0], act: parts[1] });
          }
          if (tabParsed.length) {
            pushDiffRows(tabParsed);
            continue;
          }

          // 2c: Fallback — extract red-highlighted mismatch elements inside foundBox (CodeTantra colors wrong output red/pink!)
          const redRows = [];
          for (const el of Array.from(foundBox.querySelectorAll("div, span, td, p, pre"))) {
            const t = cleanCell(el.innerText || "");
            if (!t || t.length > 260) continue;
            const st = win.getComputedStyle(el);
            const isRed = [st.color, st.backgroundColor].some((c) => {
              const m = (c || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
              if (!m) return false;
              const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
              if (a < 0.08) return false;
              const r = parseInt(m[1], 10);
              const g = parseInt(m[2], 10);
              const b = parseInt(m[3], 10);
              return r >= 150 && r > g + 35 && r > b + 35;
            });
            if (isRed && !redRows.includes(t)) redRows.push(t);
          }
          if (redRows.length) {
            diffLines.push(`HIGHLIGHTED MISMATCH LINES:\n${redRows.slice(0, 24).join("\n")}`);
          } else {
            // Last resort: send the BOTTOM 2200 chars of the diff box (where output mismatches appear!)
            const tail = cleanCell(foundBox.innerText || "").slice(-2200);
            if (tail.length > 30) diffLines.push(`TEST CASE OUTPUT (BOTTOM):\n${tail}`);
          }
        }
      } catch {}
    }

    return diffLines.length ? `EXACT EXPECTED vs ACTUAL MISMATCHES:\n${diffLines.join("\n")}` : "";
  }

  // Extract dedicated 'Compilation Error' panel text in FULL (never cutting off 'symbol: method ...' or 'location: class ...'!)
  function extractCompilationErrorBlock(doc) {
    if (!doc || !doc.body) return "";
    const win = doc.defaultView || window;
    const minRightX = Math.floor((win.innerWidth || 1200) * 0.35);
    try {
      const headings = Array.from(doc.querySelectorAll("div, span, h1, h2, h3, h4, h5, p")).filter((el) => {
        if (el.closest('#ct-helper-panel, .cm-editor, .ace_editor, aside, nav, [class*="sidebar" i]') || !isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.left < minRightX) return false;
        const t = normalizeText(el.innerText || el.textContent || "");
        return t === "compilation error" || t === "runtime error" || t === "compile error";
      });
      for (const h of headings) {
        let bestText = "";
        let box = h.parentElement;
        for (let up = 0; up < 5 && box && box !== doc.body; up++) {
          const r = box.getBoundingClientRect();
          const t = (box.innerText || "").trim();
          const low = normalizeText(t);
          // Stay strictly inside the right-side error drawer (never climb up into Sample Test Cases / left pane!)
          if (r.left < minRightX - 20 || low.includes("sample test cases") || t.length > 3200) break;
          if (t.length > bestText.length) bestText = t;
          box = box.parentElement;
        }
        if (bestText.length > 25) {
          return `COMPILATION / RUNTIME ERROR:\n${bestText}`;
        }
      }
    } catch {}
    return "";
  }

  // Exact CodeTantra Test-Case Pass / Fail Evaluation Parser!
  async function evaluateTestResultsInDoc(doc) {
    if (!doc || !doc.body) return { status: "unknown", summary: "" };
    const text = (doc.body.innerText || "").replace(/\s+/g, " ");

    // Match CodeTantra's exact badges: "2 out of 2 shown test case(s) passed", "2 out of 2 hidden test case(s) passed"
    const shownMatch = text.match(/(\d+)\s+out\s+of\s+(\d+)\s+shown\s+test\s+case\(s\)\s+passed/i);
    const hiddenMatch = text.match(/(\d+)\s+out\s+of\s+(\d+)\s+hidden\s+test\s+case\(s\)\s+passed/i);
    const genericMatch = text.match(/(\d+)\s+out\s+of\s+(\d+)\s+test\s+case\(s\)\s+passed/i);

    if (shownMatch || hiddenMatch) {
      const shownOk = !shownMatch || (parseInt(shownMatch[1], 10) === parseInt(shownMatch[2], 10) && parseInt(shownMatch[2], 10) > 0);
      const hiddenOk = !hiddenMatch || (parseInt(hiddenMatch[1], 10) === parseInt(hiddenMatch[2], 10) && parseInt(hiddenMatch[2], 10) > 0);
      const summary = [shownMatch?.[0], hiddenMatch?.[0]].filter(Boolean).join(" | ");

      if (shownOk && hiddenOk) {
        return { status: "passed", summary };
      }
      const perCaseDiffs = await expandFailedTestCasesInDoc(doc);
      const extraErr = readFailureSnippetFromDoc(doc);
      const combined = perCaseDiffs ? `${perCaseDiffs}\n---\n${extraErr}` : extraErr;
      return { status: "failed", summary: `${summary}\n${combined}`.slice(0, 6200) };
    }

    if (genericMatch) {
      const passedNum = parseInt(genericMatch[1], 10);
      const totalNum = parseInt(genericMatch[2], 10);
      if (totalNum > 0 && passedNum === totalNum) {
        return { status: "passed", summary: genericMatch[0] };
      }
      const perCaseDiffs = await expandFailedTestCasesInDoc(doc);
      const extraErr = readFailureSnippetFromDoc(doc);
      const combined = perCaseDiffs ? `${perCaseDiffs}\n---\n${extraErr}` : extraErr;
      return { status: "failed", summary: `${genericMatch[0]}\n${combined}`.slice(0, 6200) };
    }

    // Check explicit compilation/runtime error panels
    const errText = readFailureSnippetFromDoc(doc);
    const normErr = normalizeText(errText);
    if (
      normErr.includes("compilation error") ||
      normErr.includes("compile error") ||
      normErr.includes("runtime error") ||
      normErr.includes("error in ") ||
      normErr.includes("cannot be applied to") ||
      normErr.includes("cannot find symbol") ||
      normErr.includes("incompatible types") ||
      normErr.includes("traceback") ||
      normErr.includes("syntaxerror") ||
      normErr.includes("indentationerror") ||
      normErr.includes("nameerror") ||
      normErr.includes("typeerror") ||
      normErr.includes("test case failed") ||
      normErr.includes("output mismatch")
    ) {
      return { status: "failed", summary: errText };
    }

    return { status: "unknown", summary: errText };
  }

  function readFailureSnippetFromDoc(doc) {
    if (!doc) return "";
    const win = doc.defaultView || window;
    const minRightX = Math.floor((win.innerWidth || 1200) * 0.35);
    const unique = [];
    const seen = new Set();

    const isTocNoise = (s) =>
      /search content|cmd\+k|minimum 3 characters|what is data structure|introduction to data structures/i.test(s || "");

    // PRIORITY 0: Dedicated Compilation / Runtime Error panel (e.g. "error in Hashing.java, line no: 16 ...")
    const compileBlock = extractCompilationErrorBlock(doc);
    if (compileBlock) {
      seen.add(compileBlock);
      unique.push(compileBlock);
    }

    // PRIORITY 1: Exact mismatched Expected vs Actual diff rows at the VERY TOP (never truncated by identical prompt rows!)
    const smartDiff = extractExpectedVsActualDiffs(doc);
    if (smartDiff) {
      seen.add(smartDiff);
      unique.push(smartDiff);
    }

    // PRIORITY 2: Explicit compiler / runtime error lines from visible right-side / main page text (excluding sidebar/TOC!)
    try {
      const clone = doc.body.cloneNode(true);
      clone
        .querySelectorAll('#ct-helper-panel, .cm-editor, .ace_editor, aside, nav, header, .navbar, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i], script, style')
        .forEach((el) => el.remove());
      const lines = (clone.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const errLines = lines.filter(
        (l) =>
          !isTocNoise(l) &&
          /(compilation error|error in .*line no:|error:|caused by:|exception|wrong name:|cannot be applied to|cannot find symbol|incompatible types|expected|traceback|syntaxerror|indentationerror|output mismatch|reading more inputs|time limit exceeded|out of \d+ .*test case)/i.test(l)
      );
      for (const eline of errLines) {
        if (!seen.has(eline)) {
          seen.add(eline);
          unique.push(eline);
        }
      }
    } catch {}

    // PRIORITY 3: Only scrape generic right-side output containers if neither compileBlock nor smartDiff was found
    if (!compileBlock && !smartDiff) {
      const candidates = Array.from(
        doc.querySelectorAll(
          '[class*="output" i], [class*="result" i], [class*="console" i], [class*="error" i], [class*="test" i], [class*="traceback" i], [class*="text-red" i], [class*="danger" i], [class*="mono" i], [class*="alert" i], pre'
        )
      ).filter((el) => {
        if (el.closest('#ct-helper-panel, .cm-editor, .ace_editor, aside, nav, header, .navbar, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i]') || !isVisible(el)) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.left >= minRightX;
      });

      for (const el of candidates) {
        const t = (el.innerText || "").trim();
        if (t.length > 0 && t.length < 2200 && !/^sample test cases/i.test(t) && !isTocNoise(t) && !seen.has(t)) {
          seen.add(t);
          unique.push(t);
        }
      }
    }

    return unique.join("\n---\n").slice(0, 4500);
  }

  // ---------------- Auto-Dismiss CodeTantra AI Tutor & Provider-Key Popups ----------------
  function dismissTutorPopupsInDoc(doc) {
    if (!doc || !doc.body) return false;
    let dismissed = false;

    // 0. Auto-click "Cancel" on "AI Provider Key Required" / "Add your AI provider key..." modal
    const modalBoxes = Array.from(doc.querySelectorAll("div, section, [role='dialog'], [role='alertdialog']")).filter((el) => {
      if (el.closest("#ct-helper-panel") || el === doc.body) return false;
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 220 || rect.width > 760 || rect.height < 90 || rect.height > 420) return false;
      const txt = normalizeText(el.innerText || "");
      return (
        txt.includes("ai provider key required") ||
        txt.includes("add your ai provider key") ||
        txt.includes("ai feedback on your code")
      );
    });
    const innerModals = modalBoxes.filter((el) => !modalBoxes.some((other) => other !== el && el.contains(other)));
    for (const modal of innerModals) {
      const cancelBtn = Array.from(modal.querySelectorAll("button, a, [role='button'], span, div")).find((el) => {
        if (!isVisible(el)) return false;
        const t = normalizeText(el.innerText || el.textContent || "");
        return t === "cancel" || t === "close" || t === "dismiss" || t === "no thanks";
      });
      if (cancelBtn) {
        dispatchReliableClick(cancelBtn.closest("button, a, [role='button']") || cancelBtn);
        dismissed = true;
      }
    }

    // 1. Dismiss "Want help fixing them?" -> click "No, I'll fix it myself" / "No, I'll try myself"
    const btns = Array.from(doc.querySelectorAll("button, a, [role='button']")).filter(
      (el) => !el.closest("#ct-helper-panel") && isVisible(el)
    );
    for (const btn of btns) {
      const t = normalizeText(btn.innerText || btn.textContent || "");
      if (
        t.includes("fix it myself") ||
        t.includes("try myself") ||
        t === "no, i'll fix it myself" ||
        t === "no, i'll try myself"
      ) {
        btn.click();
        dismissed = true;
      }
    }

    // 2. Dismiss "selected ..." / "Need help with ..." / "Are you stuck?" floating AI popups (click their X close button)
    const containers = Array.from(doc.querySelectorAll("div, section, aside, [role='dialog']")).filter((el) => {
      if (el.closest("#ct-helper-panel") || el === doc.body) return false;
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 140 || rect.width > 560 || rect.height < 60 || rect.height > 460) return false;
      const txt = normalizeText(el.innerText || "");
      const isStuckPopup = txt.includes("are you stuck") || txt.includes("help me move forward") || txt.includes("want help fixing");
      const hasExplainAndVis = txt.includes("explain") && txt.includes("visualize");
      const hasCardKeywords =
        txt.includes("selected ") ||
        txt.includes("need help with") ||
        txt.includes("concepts") ||
        txt.includes("resources") ||
        txt.includes("practice");
      return isStuckPopup || (hasExplainAndVis && hasCardKeywords);
    });

    // Pick innermost matching popup container
    const popups = containers.filter((el) => !containers.some((other) => other !== el && el.contains(other)));
    for (const popup of popups) {
      const pRect = popup.getBoundingClientRect();
      const closeCandidates = Array.from(popup.querySelectorAll("button, [role='button'], span, a, i, svg")).filter(
        (el) => isVisible(el)
      );
      const closeBtn = closeCandidates.find((el) => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
        const r = el.getBoundingClientRect();
        const nearTopRight = r.right >= pRect.right - 45 && r.top <= pRect.top + 45 && r.width <= 42 && r.height <= 42;
        return t === "×" || t === "x" || t === "✕" || aria.includes("close") || nearTopRight;
      });
      if (closeBtn) {
        (closeBtn.closest("button, [role='button']") || closeBtn).click();
        dismissed = true;
      }
    }

    return dismissed;
  }

  // Continuously keep both annoying tutor popups closed in every frame!
  setInterval(() => {
    try {
      dismissTutorPopupsInDoc(document);
    } catch {}
  }, 1500);

  // ---------------- Objective / MCQ Question Support (across top + iframes) ----------------
  function detectMcqInDoc(doc) {
    if (!doc) return null;
    // NEVER confuse a coding problem page (that happens to have UI checkboxes) with an MCQ!
    if (doc.querySelector(".cm-editor, .cm-content, .ace_editor, .monaco-editor, .CodeMirror")) {
      return null;
    }
    const inputs = Array.from(doc.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter((inp) => {
      if (inp.closest("#ct-helper-panel, header, nav, aside")) return false;
      if (inp.disabled) return false;
      const wrap = inp.closest("label, li, .form-check, .option, [class*='option' i], div") || inp.parentElement;
      return isVisible(inp) || (wrap && isVisible(wrap));
    });
    if (inputs.length < 2) return null;

    const options = [];
    for (const inp of inputs) {
      const label =
        inp.closest("label") ||
        (inp.id ? doc.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null) ||
        inp.closest("li, .form-check, .option, [class*='option' i], div") ||
        inp.parentElement;
      const txt = (label?.innerText || label?.textContent || inp.value || "").replace(/\s+/g, " ").trim();
      // Ignore UI toggle labels like "Question Hints" or "Sample Test Cases"
      if (txt && !/^(question hints|sample test cases|terminal|test cases)$/i.test(txt)) {
        options.push({ text: txt, input: inp, label });
      }
    }
    if (options.length < 2) return null;

    return {
      found: true,
      doc,
      isMultiSelect: inputs.some((i) => i.type === "checkbox"),
      questionText: extractProblemTextFromDoc(doc),
      options: options.map((o) => o.text),
      optionRefs: options
    };
  }

  function detectMcqRecursive(doc = document, depth = 0) {
    if (depth > 4) return null;
    const local = detectMcqInDoc(doc);
    if (local) return local;
    for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
      try {
        if (frame.contentDocument) {
          const found = detectMcqRecursive(frame.contentDocument, depth + 1);
          if (found) return found;
        }
      } catch {
        // cross-origin
      }
    }
    return null;
  }

  function setOptionChecked(opt, shouldBeChecked) {
    if (!opt || !opt.input) return;
    if (Boolean(opt.input.checked) === shouldBeChecked) return;
    (opt.label || opt.input).click();
    if (Boolean(opt.input.checked) !== shouldBeChecked) {
      opt.input.click();
    }
    if (Boolean(opt.input.checked) !== shouldBeChecked) {
      opt.input.checked = shouldBeChecked;
      opt.input.dispatchEvent(new Event("input", { bubbles: true }));
      opt.input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function tickMcqAnswersInDoc(answers) {
    const mcq = detectMcqRecursive(document);
    if (!mcq) return { ok: false, ticked: 0, selected: [] };

    // Clear any previously checked checkboxes so old wrong selections don't stay ticked
    if (mcq.isMultiSelect) {
      for (const opt of mcq.optionRefs) {
        if (opt.input.type === "checkbox" && opt.input.checked) {
          setOptionChecked(opt, false);
        }
      }
    }

    const selected = [];
    const usedInputs = new Set();

    const stripDunder = (s) => (s || "").replace(/^_+|_+$/g, "");

    for (const ans of answers || []) {
      const target = normalizeText(ans);
      if (!target) continue;
      const targetCore = stripDunder(target);

      let match = mcq.optionRefs.find((o) => !usedInputs.has(o.input) && normalizeText(o.text) === target);
      if (!match && targetCore) {
        match = mcq.optionRefs.find((o) => !usedInputs.has(o.input) && stripDunder(normalizeText(o.text)) === targetCore);
      }
      if (!match && target.length >= 2) {
        match = mcq.optionRefs.find((o) => {
          if (usedInputs.has(o.input)) return false;
          const ot = normalizeText(o.text);
          const otCore = stripDunder(ot);
          return (
            ot === target ||
            (targetCore.length >= 2 && otCore === targetCore) ||
            (target.length >= 3 && ot.includes(target)) ||
            (ot.length >= 3 && target.includes(ot))
          );
        });
      }

      if (match) {
        usedInputs.add(match.input);
        setOptionChecked(match, true);
        selected.push(match.text);
        // Single-choice radio: tick ONLY ONE option
        if (!mcq.isMultiSelect) break;
      }
    }

    return { ok: selected.length > 0, ticked: selected.length, selected };
  }

  // Inspect EACH option's own isolated container (never leaking into sibling options!) for CodeTantra's green "Correct" / red "Incorrect" labels
  function inspectMcqOptionFeedbackInDoc(doc) {
    const mcq = detectMcqRecursive(doc);
    if (!mcq || !mcq.optionRefs.length) {
      return { hasLabels: false, correctOptions: [], incorrectOptions: [], allRightSelected: false };
    }

    const correctOptions = [];
    const incorrectOptions = [];
    let allRightSelected = true;
    let labeledCount = 0;

    for (const opt of mcq.optionRefs) {
      // Walk UP to the largest wrapper that contains ONLY THIS ONE option's <input> (never other options!)
      let ownBox = opt.input.parentElement || opt.label || opt.input;
      while (ownBox && ownBox.parentElement && ownBox.parentElement !== doc.body) {
        const parentInputs = ownBox.parentElement.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        if (parentInputs.length === 1) {
          ownBox = ownBox.parentElement;
        } else {
          break;
        }
      }

      // Check text inside ownBox + immediate next sibling (if next sibling has no <input>, e.g. a feedback <p>Correct</p> below the row)
      let ownText = (ownBox?.innerText || "").trim();
      const nextSib = ownBox?.nextElementSibling;
      if (nextSib && !nextSib.querySelector('input[type="radio"], input[type="checkbox"]') && (nextSib.innerText || "").trim().length < 40) {
        ownText += "\n" + (nextSib.innerText || "").trim();
      }

      const lines = ownText.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
      const isIncorrect = lines.some((l) => l === "incorrect" || l === "wrong" || l === "wrong answer");
      const isCorrect = !isIncorrect && lines.some((l) => l === "correct" || l === "right" || l === "correct answer");

      if (isCorrect) {
        labeledCount++;
        correctOptions.push(opt.text);
        if (!opt.input.checked) allRightSelected = false;
      } else if (isIncorrect) {
        labeledCount++;
        incorrectOptions.push(opt.text);
        if (opt.input.checked) allRightSelected = false;
      }
    }

    return {
      hasLabels: labeledCount > 0,
      correctOptions,
      incorrectOptions,
      allRightSelected: correctOptions.length > 0 && allRightSelected
    };
  }

  // Evaluate CodeTantra Quiz / Objective Right vs Wrong — checks toast + exact isolated per-option Correct/Incorrect labels!
  function evaluateMcqResultInDoc(doc) {
    if (!doc || !doc.body) return { status: "unknown", feedback: "", correctOptions: [] };

    const perOpt = inspectMcqOptionFeedbackInDoc(doc);

    // PRIORITY 1: Any visible toast/snackbar/pill near bottom (300px) or top (180px) or with alert/toast role/class
    const winH = (doc.defaultView || window).innerHeight || 900;
    const allSmallEls = Array.from(
      doc.querySelectorAll('[role="alert"], [role="status"], .toast, .snackbar, [class*="toast" i], [class*="notify" i], [class*="alert" i], div, span, p')
    ).filter((el) => {
      if (el.closest("#ct-helper-panel")) return false;
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.height > 95 || r.width > 460 || r.width < 40) return false;
      const inToastZone = r.top >= winH - 300 || r.top <= 180;
      const cls = (el.className || "").toString().toLowerCase();
      const isToastEl =
        el.getAttribute("role") === "alert" ||
        el.getAttribute("role") === "status" ||
        cls.includes("toast") ||
        cls.includes("snack") ||
        cls.includes("notify");
      return inToastZone || isToastEl;
    });

    for (const el of allSmallEls) {
      const t = normalizeText(el.innerText || "").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if (!t || t.length > 100) continue;
      if (t === "success" || t.includes("success!") || t === "correct answer" || t.includes("well done")) {
        return { status: "right", feedback: (el.innerText || "").trim() || "Success", correctOptions: perOpt.correctOptions };
      }
      if (t === "wrong answer" || t.includes("wrong answer") || t.includes("no option selected") || t.includes("please select")) {
        return { status: "wrong", feedback: (el.innerText || "").trim(), correctOptions: perOpt.correctOptions };
      }
    }

    // PRIORITY 2: Exact isolated per-option Correct/Incorrect labels printed by CodeTantra!
    if (perOpt.hasLabels) {
      if (perOpt.allRightSelected) {
        return { status: "right", feedback: "All Correct options selected ✓", correctOptions: perOpt.correctOptions };
      }
      return { status: "wrong", feedback: "Correct/Incorrect labels detected on screen", correctOptions: perOpt.correctOptions };
    }

    return { status: "unknown", feedback: "", correctOptions: [] };
  }

  // ---------------- Video / Play Button Slide Support ----------------
  function handleVideoInDoc(doc) {
    if (!doc) return { found: false };
    const video = doc.querySelector("video");
    if (video) {
      video.muted = true;
      if (video.playbackRate !== 2.0) video.playbackRate = 2.0;
      if (video.paused && !video.ended) video.play().catch(() => {});
      if (video.duration && !isNaN(video.duration) && video.duration > 6 && !video.ended) {
        if (video.currentTime < video.duration - 4) {
          video.currentTime = Math.max(0, video.duration - 3);
        }
      }
      return { found: true, ended: Boolean(video.ended) };
    }
    return { found: false };
  }

  function dispatchReliableClick(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    } catch {}
    el.click();
  }

  function clickCodeSubmitInDoc(doc) {
    if (!doc) return false;
    const candidates = Array.from(
      doc.querySelectorAll("button, a, [role='button'], span, div, input[type='button'], input[type='submit']")
    ).filter((el) => {
      if (el.closest("#ct-helper-panel")) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 36 || r.width > 200 || r.height < 18 || r.height > 62) return false;
      const t = normalizeText(el.innerText || el.value || el.textContent || "");
      return t === "submit" || t === "submit code" || t === "compile & run";
    });
    const innermost = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    // Prioritize the top-right green '▶ Submit' button (r.top < 220) over the bottom bar!
    const topSubmit = innermost.find((el) => el.getBoundingClientRect().top < 220);
    const pick = topSubmit || innermost[0];
    if (!pick) return false;
    const host = pick.closest("button, a, [role='button']") || pick;
    dispatchReliableClick(host);
    if (host !== pick) dispatchReliableClick(pick);
    return true;
  }

  function clickButtonInDoc(doc, targets, { exactFirst = true } = {}) {
    if (!doc) return false;

    const isClickableBtn = (el) => {
      if (
        el.closest(
          '#ct-helper-panel, header, nav, aside, .navbar, [class*="sidebar" i], [class*="drawer" i], [class*="toc" i]'
        )
      ) {
        return false;
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      return isVisible(el);
    };

    // 1. Standard buttons/links first (NEVER sidebar/nav links!)
    const els = Array.from(
      doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
    ).filter(isClickableBtn);

    if (exactFirst) {
      const exact = els.find((el) => {
        const txt = normalizeText(el.innerText || el.value || el.textContent || "");
        return txt && targets.includes(txt);
      });
      if (exact) {
        dispatchReliableClick(exact);
        return true;
      }
    }

    // NEVER do substring .includes() for short words like "ok", "yes", "next" (prevents "ok" matching "Koko Eating Bananas"!)
    const longTargets = targets.filter((t) => t.length >= 5);
    if (longTargets.length) {
      const partial = els.find((el) => {
        if (el.tagName === "A" && (el.getAttribute("href") || "").includes("#/contents")) return false;
        const txt = normalizeText(el.innerText || el.value || el.textContent || "");
        return txt && txt.length < 40 && longTargets.some((t) => txt.includes(t));
      });
      if (partial) {
        dispatchReliableClick(partial);
        return true;
      }
    }

    // 2. Fallback for CodeTantra bottom bar pills (< Prev, Reset, Submit, Next >) which may be <span> / <div> elements!
    const customEls = Array.from(doc.querySelectorAll("span, div, li")).filter((el) => {
      if (!isClickableBtn(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 26 || r.width > 230 || r.height < 14 || r.height > 66) return false;
      const txt = normalizeText(el.innerText || el.textContent || "");
      return txt && targets.includes(txt);
    });
    // Pick innermost matching pill
    const innerPill = customEls.find((el) => !customEls.some((other) => other !== el && el.contains(other))) || customEls[0];
    if (innerPill) {
      const host = innerPill.closest("button, a, [role='button']") || innerPill;
      dispatchReliableClick(host);
      if (host !== innerPill) dispatchReliableClick(innerPill);
      return true;
    }

    return false;
  }

  function isPinkLockedBg(colorStr) {
    const m = (colorStr || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m) return false;
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a < 0.05) return false;
    // CodeTantra highlights read-only/locked lines in pink/rose tint
    return r >= 180 && r - g >= 12 && r - b >= 10;
  }

  // Scan ALL lines in CodeMirror 6 (even off-screen virtualized lines!) using scroll sweeps + posAtDOM
  async function scanAllLockedLinesCM6(ed) {
    const lockedSet = new Set();
    const view = ed.editor;
    const scroller = ed.el?.querySelector(".cm-scroller") || ed.contentEl?.parentElement;

    function collectVisible() {
      const lineEls = Array.from(ed.contentEl.querySelectorAll(".cm-line"));
      lineEls.forEach((el, idx) => {
        const cls = (el.className || "").toLowerCase();
        const bg = ed.win.getComputedStyle(el).backgroundColor || "";
        const hasPinkBg = isPinkLockedBg(bg);
        const hasPinkChild = Array.from(el.querySelectorAll("span")).some((sp) =>
          isPinkLockedBg(ed.win.getComputedStyle(sp).backgroundColor || "")
        );
        const isExplicitReadOnly =
          cls.includes("readonly") ||
          cls.includes("locked") ||
          Boolean(el.querySelector('[class*="readOnly" i], [class*="locked" i]'));
        if (isExplicitReadOnly || hasPinkBg || hasPinkChild) {
          let lineNum = idx + 1;
          if (view && typeof view.posAtDOM === "function" && view.state?.doc) {
            try {
              const pos = view.posAtDOM(el);
              lineNum = view.state.doc.lineAt(pos).number;
            } catch {}
          }
          lockedSet.add(lineNum);
        }
      });
    }

    if (scroller && scroller.scrollHeight > scroller.clientHeight + 40) {
      const origScrollTop = scroller.scrollTop;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      const step = Math.max(200, Math.floor(scroller.clientHeight * 0.75));
      for (let y = 0; y <= maxScroll + step; y += step) {
        scroller.scrollTop = Math.min(y, maxScroll);
        await sleep(35);
        collectVisible();
        if (y >= maxScroll) break;
      }
      scroller.scrollTop = origScrollTop;
      await sleep(25);
    } else {
      collectVisible();
    }

    return Array.from(lockedSet).sort((a, b) => a - b);
  }

  async function readEditorStateLocal({ light = false } = {}) {
    const ed = detectEditorRecursive(document, window);
    if (!ed) return { found: false, type: "none", code: "", language: "", lockedLines: [], problemText: "" };

    let code = "";
    let language = detectLanguageFromDoc(ed.doc);
    let lockedLines = [];

    if (ed.type === "cm6") {
      if (ed.editor && ed.editor.state && ed.editor.state.doc) {
        code = ed.editor.state.doc.toString();
      } else {
        const lineEls = Array.from(ed.contentEl.querySelectorAll(".cm-line"));
        code = lineEls.map((l) => (l.textContent || "").replace(/\u200B/g, "")).join("\n");
      }
      if (!light) {
        lockedLines = await scanAllLockedLinesCM6(ed);
      }
    } else if (ed.type === "ace") {
      code = ed.editor.getValue() || "";
      const modeId = ed.editor.session.getMode?.()?.$id || "";
      language = modeId.split("/").pop() || language;
    } else if (ed.type === "monaco") {
      code = ed.model.getValue() || "";
      language = ed.model.getLanguageId?.() || language;
    } else if (ed.type === "codemirror") {
      code = ed.editor.getValue() || "";
      const mode = ed.editor.getOption?.("mode");
      language = (typeof mode === "string" ? mode : mode?.name) || language;
    }

    const problemText = extractProblemTextFromDoc(ed.doc);
    const hasMultiLangDropdown = hasMultiLangDropdownInDoc(ed.doc);
    return { found: true, type: ed.type, code, language, lockedLines, problemText, hasMultiLangDropdown };
  }

  function emitProgressToTop(pct, doneChars, totalChars) {
    try {
      window.top.postMessage({ source: "CT_BRIDGE", type: "TYPE_PROGRESS", pct, doneChars, totalChars }, "*");
    } catch {
      window.postMessage({ source: "CT_BRIDGE", type: "TYPE_PROGRESS", pct, doneChars, totalChars }, "*");
    }
  }

  async function typeIntoCM6(ed, edits, targetTotalMs, sessionId, passedLockedLines = []) {
    const view = ed.editor;
    const liveLocked = passedLockedLines && passedLockedLines.length ? passedLockedLines : await scanAllLockedLinesCM6(ed);
    const lockedSet = new Set(liveLocked);

    // Normalize mode: if start_line >= 1, ALWAYS treat as replace_lines (never accidentally replace_all!)
    const normalizedEdits = edits.map((e) => ({
      ...e,
      mode: e.start_line >= 1 && e.mode !== "replace_all" ? "replace_lines" : e.mode || (e.start_line >= 1 ? "replace_lines" : "replace_all")
    }));

    const totalDocLines = view?.state?.doc?.lines || ed.contentEl?.querySelectorAll(".cm-line")?.length || 0;
    function getEditableRangesHint() {
      if (!totalDocLines) return "";
      const ranges = [];
      let rStart = -1;
      for (let ln = 1; ln <= totalDocLines; ln++) {
        if (!lockedSet.has(ln)) {
          if (rStart === -1) rStart = ln;
        } else if (rStart !== -1) {
          ranges.push(rStart === ln - 1 ? `L${rStart}` : `L${rStart}-L${ln - 1}`);
          rStart = -1;
        }
      }
      if (rStart !== -1) ranges.push(rStart === totalDocLines ? `L${rStart}` : `L${rStart}-L${totalDocLines}`);
      return ranges.length ? ` Allowed [EDITABLE] ranges: ${ranges.join(", ")}` : "";
    }

    // HARD LOCKED-LINE PROTECTION: NEVER wipe a file that has pink [LOCKED] lines!
    const rawSorted = [...normalizedEdits].sort((a, b) => (a.start_line || 1) - (b.start_line || 1));
    const sortedEdits = [];
    let lastOrigEnd = 0;
    for (const e of rawSorted) {
      if (e.mode === "replace_all") {
        if (lockedSet.size > 0) {
          return { ok: false, error: `Blocked replace_all: file mein pink [LOCKED] lines hain!${getEditableRangesHint()}` };
        }
        sortedEdits.length = 0;
        sortedEdits.push(e);
        break;
      }
      let s = e.start_line || 1;
      let end = Math.max(s, e.end_line || s);
      // Trim any locked lines from the start/end of this edit block so pink lines are NEVER erased!
      while (s <= end && lockedSet.has(s)) s++;
      while (end >= s && lockedSet.has(end)) end--;
      if (s > end) continue;
      let touchesLocked = false;
      for (let ln = s; ln <= end; ln++) {
        if (lockedSet.has(ln)) { touchesLocked = true; break; }
      }
      if (touchesLocked) continue;
      if (s <= lastOrigEnd) continue;
      sortedEdits.push({ ...e, mode: "replace_lines", start_line: s, end_line: end });
      lastOrigEnd = end;
    }

    if (!sortedEdits.length) {
      return { ok: false, error: `Koi safe editable block nahi mila (pink locked lines protected).${getEditableRangesHint()}` };
    }

    // ALWAYS type strictly 1 character per CM6 dispatch!
    // CodeTantra's CodeMirror 6 has an anti-paste transactionFilter that silently rejects any multi-character insert (piece.length > 1),
    // which caused 95% of code to drop and left random single chars like 'd', ')', ':'.
    const totalChars = Math.max(1, sortedEdits.reduce((sum, e) => sum + (e.code || "").length, 0));
    const baseCharMs = Math.max(3, Math.min(90, Math.floor((targetTotalMs * 0.85) / totalChars)));
    let doneChars = 0;

    if (view && view.state && typeof view.dispatch === "function") {
      view.focus();
      let lineDelta = 0;

      for (const edit of sortedEdits) {
        if (stopTypingFlag || sessionId !== activeTypingSessionId) {
          return { ok: false, error: "Typing stopped by user." };
        }

        const doc = view.state.doc;
        let from = 0;
        let to = doc.length;
        let oldLineCount = doc.lines;

        if (edit.mode === "replace_lines" && edit.start_line >= 1) {
          const adjStart = Math.max(1, Math.min(edit.start_line + lineDelta, doc.lines));
          const adjEnd = Math.max(adjStart, Math.min((edit.end_line || edit.start_line) + lineDelta, doc.lines));
          from = doc.line(adjStart).from;
          to = doc.line(adjEnd).to;
          oldLineCount = adjEnd - adjStart + 1;
        }

        if (to > from) {
          const beforeDelLen = view.state.doc.length;
          view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from }, userEvent: "delete.selection", scrollIntoView: true });
          await sleep(randMs(70, 140));

          // If CodeTantra's CM6 readOnly filter silently rejected the whole-range delete,
          // clear line-by-line from bottom to top so any hidden read-only boundary line is skipped cleanly
          // instead of dumping new code on top of old code!
          if (view.state.doc.length === beforeDelLen && edit.mode === "replace_lines" && edit.start_line >= 1) {
            const adjStart = Math.max(1, Math.min(edit.start_line + lineDelta, view.state.doc.lines));
            const adjEnd = Math.max(adjStart, Math.min((edit.end_line || edit.start_line) + lineDelta, view.state.doc.lines));
            let clearedAny = false;
            let firstEditableFrom = -1;
            for (let ln = adjEnd; ln >= adjStart; ln--) {
              if (ln > view.state.doc.lines) continue;
              const lineObj = view.state.doc.line(ln);
              const delFrom = lineObj.from;
              const delTo = ln < adjEnd && lineObj.to < view.state.doc.length ? lineObj.to + 1 : lineObj.to;
              if (delTo <= delFrom) {
                firstEditableFrom = delFrom;
                continue;
              }
              const lenBefore = view.state.doc.length;
              view.dispatch({ changes: { from: delFrom, to: delTo, insert: "" }, userEvent: "delete.selection" });
              if (view.state.doc.length < lenBefore) {
                clearedAny = true;
                firstEditableFrom = delFrom;
              }
            }
            if (!clearedAny) {
              return { ok: false, error: `CM6 readOnly filter ne L${adjStart}-L${adjEnd} delete nahi hone diya (locked boundary).` };
            }
            if (firstEditableFrom >= 0) from = firstEditableFrom;
            await sleep(randMs(70, 120));
          }
        }

        const text = (edit.code || "").replace(/\r\n/g, "\n");
        let cursor = Math.max(0, Math.min(from, view.state.doc.length));
        let acceptedChars = 0;
        // Auto-detected winning strategy: "dispatch" -> "exec" -> "unfiltered"
        let typingMode = "dispatch";

        function placeDomCaretAt(pos) {
          try {
            const safeP = Math.max(0, Math.min(pos, view.state.doc.length));
            view.focus();
            view.dispatch({ selection: { anchor: safeP }, scrollIntoView: true });
            ed.contentEl?.focus();
            if (typeof view.domAtPos === "function") {
              const domPos = view.domAtPos(safeP);
              if (domPos && domPos.node) {
                const sel = ed.win.getSelection();
                const range = ed.doc.createRange();
                range.setStart(domPos.node, domPos.offset);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          } catch {}
        }

        async function insertCharExec(pos, ch) {
          const safeP = Math.max(0, Math.min(pos, view.state.doc.length));
          const beforeLen = view.state.doc.length;
          try {
            placeDomCaretAt(safeP);
            ed.contentEl?.dispatchEvent(new KeyboardEvent("keydown", { key: ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch, bubbles: true, cancelable: true }));
            ed.doc.execCommand("insertText", false, ch);
            ed.contentEl?.dispatchEvent(new KeyboardEvent("keyup", { key: ch === "\n" ? "Enter" : ch === "\t" ? "Tab" : ch, bubbles: true }));
          } catch {}
          // Wait for CodeMirror 6's MutationObserver to flush DOM edit into view.state.doc!
          await sleep(14);
          return Math.max(0, view.state.doc.length - beforeLen);
        }

        function insertCharDispatch(pos, ch, bypassFilter = false) {
          const safeP = Math.max(0, Math.min(pos, view.state.doc.length));
          const beforeLen = view.state.doc.length;
          const spec = {
            changes: { from: safeP, to: safeP, insert: ch },
            selection: { anchor: safeP + ch.length },
            userEvent: "input.type",
            scrollIntoView: true
          };
          if (bypassFilter) spec.filter = false;
          try {
            view.dispatch(spec);
          } catch {}
          return Math.max(0, view.state.doc.length - beforeLen);
        }

        for (let i = 0; i < text.length; i++) {
          if (stopTypingFlag || sessionId !== activeTypingSessionId) {
            return { ok: false, error: "Typing stopped by user." };
          }
          const ch = text[i];
          const safePos = Math.max(0, Math.min(cursor, view.state.doc.length));
          let actualInserted = 0;

          if (typingMode === "dispatch") {
            actualInserted = insertCharDispatch(safePos, ch, false);
            if (actualInserted === 0) {
              actualInserted = await insertCharExec(safePos, ch);
              if (actualInserted > 0 && ch !== "\n" && ch !== "\t") typingMode = "exec";
            }
            if (actualInserted === 0) {
              actualInserted = insertCharDispatch(safePos, ch, true);
              if (actualInserted > 0 && ch !== "\n" && ch !== "\t") typingMode = "unfiltered";
            }
          } else if (typingMode === "exec") {
            actualInserted = await insertCharExec(safePos, ch);
            if (actualInserted === 0) {
              actualInserted = insertCharDispatch(safePos, ch, true);
              if (actualInserted > 0 && ch !== "\n" && ch !== "\t") typingMode = "unfiltered";
            }
          } else {
            actualInserted = insertCharDispatch(safePos, ch, true);
          }

          // If CM6 rejected '\t' at this position, fall back to 4 single-space inserts
          if (actualInserted === 0 && ch === "\t") {
            let spPos = safePos;
            for (let s = 0; s < 4; s++) {
              let got = typingMode === "exec" ? await insertCharExec(spPos, " ") : insertCharDispatch(spPos, " ", typingMode === "unfiltered");
              if (got === 0) got = insertCharDispatch(spPos, " ", true);
              spPos += got;
              actualInserted += got;
            }
          }

          if (actualInserted > 0) acceptedChars++;
          cursor = safePos + actualInserted;
          doneChars++;
          if (doneChars % 12 === 0 || doneChars >= totalChars) {
            emitProgressToTop(Math.min(100, Math.round((doneChars / totalChars) * 100)), doneChars, totalChars);
          }

          let delay = randMs(Math.floor(baseCharMs * 0.7), Math.floor(baseCharMs * 1.3));
          if (ch === "\n") delay += randMs(8, 20);
          await sleep(delay);
        }

        // Integrity check: never silently succeed if CodeTantra's CM6 filter dropped the code!
        if (text.length > 15 && acceptedChars < Math.floor(text.length * 0.8)) {
          return {
            ok: false,
            error: `CodeTantra editor ne typing block kar di (sirf ${acceptedChars}/${text.length} chars accept hue).`
          };
        }

        const newLineCount = text.split("\n").length;
        lineDelta += newLineCount - oldLineCount;
        await sleep(randMs(80, 160));
      }

      return { ok: true, type: "cm6-view" };
    }

    // DOM fallback
    ed.contentEl.focus();
    const sel = ed.win.getSelection();
    for (const edit of sortedEdits) {
      if (stopTypingFlag || sessionId !== activeTypingSessionId) {
        return { ok: false, error: "Typing stopped by user." };
      }
      const lineEls = Array.from(ed.contentEl.querySelectorAll(".cm-line"));
      if (!lineEls.length) return { ok: false, error: "CM6 lines not found." };
      const sIdx = edit.mode === "replace_lines" && edit.start_line >= 1 ? Math.max(0, Math.min(edit.start_line - 1, lineEls.length - 1)) : 0;
      const targetEl = lineEls[sIdx];
      const range = ed.doc.createRange();
      range.selectNodeContents(targetEl);
      sel.removeAllRanges();
      sel.addRange(range);

      const text = (edit.code || "").replace(/\r\n/g, "\n");
      let built = "";
      for (let i = 0; i < text.length; i++) {
        if (stopTypingFlag || sessionId !== activeTypingSessionId) {
          return { ok: false, error: "Typing stopped by user." };
        }
        built += text[i];
        targetEl.textContent = built;
        doneChars++;
        if (doneChars % 3 === 0 || doneChars === totalChars) {
          emitProgressToTop(Math.min(100, Math.round((doneChars / totalChars) * 100)), doneChars, totalChars);
        }
        await sleep(randMs(Math.floor(baseCharMs * 0.72), Math.floor(baseCharMs * 1.48)));
      }
    }
    return { ok: true, type: "cm6-dom" };
  }

  async function humanTypeLocal({ edits = [], targetTotalMs = 10000, lockedLines = [] }) {
    const ed = detectEditorRecursive(document, window);
    if (!ed) return { ok: false, error: "Code editor nahi mila." };
    if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "Koi code edit nahi mila." };

    stopTypingFlag = false;
    const mySession = ++activeTypingSessionId;
    if (ed.type === "cm6") return await typeIntoCM6(ed, edits, targetTotalMs, mySession, lockedLines);

    const sortedEdits = [...edits].sort((a, b) => (b.start_line || 1) - (a.start_line || 1));
    const totalChars = Math.max(1, sortedEdits.reduce((sum, e) => sum + (e.code || "").length, 0));
    const baseCharMs = Math.max(5, Math.min(28, Math.floor(targetTotalMs / totalChars)));
    let doneChars = 0;

    if (ed.type === "ace") {
      const session = ed.editor.session;
      const AceRange = ed.win.ace?.require?.("ace/range")?.Range;
      ed.editor.focus();
      const prevBehaviours = ed.editor.getBehavioursEnabled?.();
      if (typeof ed.editor.setBehavioursEnabled === "function") ed.editor.setBehavioursEnabled(false);

      try {
        for (const edit of sortedEdits) {
          if (edit.mode === "replace_lines" && edit.start_line >= 1 && AceRange) {
            const sRow = Math.max(0, edit.start_line - 1);
            const eRow = Math.min(session.getLength() - 1, (edit.end_line || edit.start_line) - 1);
            session.replace(new AceRange(sRow, 0, eRow, session.getLine(eRow).length), "");
            ed.editor.moveCursorTo(sRow, 0);
          } else {
            session.setValue("");
            ed.editor.moveCursorTo(0, 0);
          }
          const text = (edit.code || "").replace(/\r\n/g, "\n");
          for (let i = 0; i < text.length; i++) {
            if (stopTypingFlag) return { ok: false, error: "Typing stopped by user." };
            session.insert(ed.editor.getCursorPosition(), text[i]);
            doneChars++;
            if (doneChars % 5 === 0 || doneChars === totalChars) {
              emitProgressToTop(Math.min(100, Math.round((doneChars / totalChars) * 100)), doneChars, totalChars);
            }
            await sleep(randMs(Math.floor(baseCharMs * 0.65), Math.floor(baseCharMs * 1.45)));
          }
        }
      } finally {
        if (typeof ed.editor.setBehavioursEnabled === "function" && prevBehaviours !== undefined) {
          ed.editor.setBehavioursEnabled(prevBehaviours);
        }
      }
      return { ok: true, type: "ace" };
    }

    if (ed.type === "monaco") {
      const model = ed.model;
      for (const edit of sortedEdits) {
        let row = 1;
        let col = 1;
        if (edit.mode === "replace_lines" && edit.start_line >= 1) {
          const sLine = Math.max(1, Math.min(edit.start_line, model.getLineCount()));
          const eLine = Math.max(sLine, Math.min(edit.end_line || sLine, model.getLineCount()));
          model.pushEditOperations(
            [],
            [{ range: { startLineNumber: sLine, startColumn: 1, endLineNumber: eLine, endColumn: model.getLineMaxColumn(eLine) }, text: "" }],
            () => null
          );
          row = sLine;
        } else {
          model.setValue("");
        }
        const text = (edit.code || "").replace(/\r\n/g, "\n");
        for (let i = 0; i < text.length; i++) {
          if (stopTypingFlag) return { ok: false, error: "Typing stopped by user." };
          const ch = text[i];
          model.pushEditOperations(
            [],
            [{ range: { startLineNumber: row, startColumn: col, endLineNumber: row, endColumn: col }, text: ch }],
            () => null
          );
          if (ch === "\n") {
            row++;
            col = 1;
          } else {
            col++;
          }
          doneChars++;
          if (doneChars % 5 === 0 || doneChars === totalChars) {
            emitProgressToTop(Math.min(100, Math.round((doneChars / totalChars) * 100)), doneChars, totalChars);
          }
          await sleep(randMs(Math.floor(baseCharMs * 0.65), Math.floor(baseCharMs * 1.45)));
        }
      }
      return { ok: true, type: "monaco" };
    }

    return { ok: false, error: "Unsupported editor type." };
  }

  function broadcastToChildFrames(msg) {
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        frame.contentWindow?.postMessage(msg, "*");
      } catch {
        // ignore
      }
    }
  }

  const crossFrameWaiters = new Map();

  function askChildFrames(id, type, payload, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        crossFrameWaiters.delete(id);
        resolve(null);
      }, timeoutMs);

      crossFrameWaiters.set(id, (res) => {
        clearTimeout(timer);
        crossFrameWaiters.delete(id);
        resolve(res);
      });

      broadcastToChildFrames({ source: "CT_TOP_TO_FRAME", id, type, payload });
    });
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data) return;

    if (isTop && data.source === "CT_FRAME_TO_TOP" && data.id) {
      const waiter = crossFrameWaiters.get(data.id);
      if (waiter) waiter(data.payload);
      return;
    }

    if (isTop && event.source === window && data.source === "CT_CONTENT") {
      const { id, type, payload } = data;

      if (type === "STOP_TYPING") {
        stopTypingFlag = true;
        activeTypingSessionId++;
        broadcastToChildFrames({ source: "CT_TOP_TO_FRAME", id, type: "STOP_TYPING", payload: {} });
        window.postMessage({ source: "CT_BRIDGE", id, type: "STOP_TYPING_RES", payload: { ok: true } }, "*");
        return;
      }

      if (type === "EXPAND_PROBLEM_PANELS") {
        const localExpanded = await expandSampleTestCasesInDoc(document);
        const localText = extractProblemTextFromDoc(document);
        const looksLikeProblem = (t) => /(input format|output format|sample test cases|fill the missing code|constraints|write a (?:program|function|code)|you are given)/i.test(t || "");
        if (localText.length > 120 && looksLikeProblem(localText)) {
          window.postMessage(
            { source: "CT_BRIDGE", id, type: "EXPAND_PROBLEM_PANELS_RES", payload: { expanded: localExpanded, problemText: localText } },
            "*"
          );
          return;
        }
        const remote = await askChildFrames(id, "EXPAND_PROBLEM_PANELS", {}, 4500);
        const remoteText = remote?.problemText || "";
        const bestText =
          looksLikeProblem(remoteText) || remoteText.length > localText.length ? remoteText : localText;
        window.postMessage(
          {
            source: "CT_BRIDGE",
            id,
            type: "EXPAND_PROBLEM_PANELS_RES",
            payload: { expanded: Boolean(localExpanded || remote?.expanded), problemText: bestText }
          },
          "*"
        );
        return;
      }

      if (type === "SWITCH_LANG") {
        const local = await switchEditorLanguageInDoc(document, payload?.lang);
        if (local.ok) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "SWITCH_LANG_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "SWITCH_LANG", payload || {}, 3000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "SWITCH_LANG_RES", payload: remote || { ok: false } }, "*");
        return;
      }

      if (type === "READ_EDITOR") {
        const local = await readEditorStateLocal(payload || {});
        if (local.found) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "READ_EDITOR_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "READ_EDITOR", payload || {}, 9000);
        window.postMessage(
          {
            source: "CT_BRIDGE",
            id,
            type: "READ_EDITOR_RES",
            payload: remote || { found: false, type: "none", code: "", language: "", lockedLines: [], problemText: "" }
          },
          "*"
        );
        return;
      }

      if (type === "READ_MCQ") {
        const local = detectMcqRecursive(document);
        if (local) {
          window.postMessage(
            {
              source: "CT_BRIDGE",
              id,
              type: "READ_MCQ_RES",
              payload: { found: true, isMultiSelect: local.isMultiSelect, questionText: local.questionText, options: local.options }
            },
            "*"
          );
          return;
        }
        const remote = await askChildFrames(id, "READ_MCQ", {}, 2000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "READ_MCQ_RES", payload: remote || { found: false } }, "*");
        return;
      }

      if (type === "TICK_MCQ") {
        const local = tickMcqAnswersInDoc(payload?.answers || []);
        if (local.ok) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "TICK_MCQ_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "TICK_MCQ", payload || {}, 2500);
        window.postMessage({ source: "CT_BRIDGE", id, type: "TICK_MCQ_RES", payload: remote || { ok: false, ticked: 0 } }, "*");
        return;
      }

      if (type === "CHECK_VIDEO") {
        const local = handleVideoInDoc(document);
        if (local.found) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "CHECK_VIDEO_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "CHECK_VIDEO", {}, 1500);
        window.postMessage({ source: "CT_BRIDGE", id, type: "CHECK_VIDEO_RES", payload: remote || { found: false } }, "*");
        return;
      }

      if (type === "TYPE_CODE") {
        const localEd = detectEditorRecursive(document, window);
        if (localEd) {
          const res = await humanTypeLocal(payload || {});
          window.postMessage({ source: "CT_BRIDGE", id, type: "TYPE_CODE_RES", payload: res }, "*");
          return;
        }
        const remote = await askChildFrames(id, "TYPE_CODE", payload || {}, 300000);
        window.postMessage(
          { source: "CT_BRIDGE", id, type: "TYPE_CODE_RES", payload: remote || { ok: false, error: "Editor iframe mein nahi mila." } },
          "*"
        );
        return;
      }

      if (type === "CLICK_BUTTON") {
        const targets = payload?.targets || [];
        const preferEditor = Boolean(payload?.preferEditorSubmit);
        const ed = detectEditorRecursive(document, window);

        // For coding problems, ALWAYS click the top-right green '▶ Submit' button inside the editor FIRST!
        if (preferEditor) {
          if (ed && clickCodeSubmitInDoc(ed.doc)) {
            window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: true, where: "editor-top" } }, "*");
            return;
          }
          const remote = await askChildFrames(id, "CLICK_BUTTON", payload || {}, 2000);
          if (remote && remote.ok) {
            window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: remote }, "*");
            return;
          }
          if (clickCodeSubmitInDoc(document) || clickButtonInDoc(document, targets)) {
            window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: true, where: "top-fallback" } }, "*");
            return;
          }
          window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: false } }, "*");
          return;
        }

        if (clickButtonInDoc(document, targets)) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: true } }, "*");
          return;
        }
        if (ed && clickButtonInDoc(ed.doc, targets)) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: true } }, "*");
          return;
        }
        const remote = await askChildFrames(id, "CLICK_BUTTON", payload || {}, 2000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: remote || { ok: false } }, "*");
        return;
      }

      if (type === "CHECK_PENDING_TASK") {
        if (hasPendingTaskInDoc(document)) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "CHECK_PENDING_TASK_RES", payload: { hasTask: true } }, "*");
          return;
        }
        const remote = await askChildFrames(id, "CHECK_PENDING_TASK", {}, 2000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "CHECK_PENDING_TASK_RES", payload: remote || { hasTask: false } }, "*");
        return;
      }

      if (type === "OPEN_UNIT_ITEM") {
        const local = openUnitItemInDoc(document);
        if (local.ok || local.allCompleted) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "OPEN_UNIT_ITEM_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "OPEN_UNIT_ITEM", {}, 2500);
        window.postMessage({ source: "CT_BRIDGE", id, type: "OPEN_UNIT_ITEM_RES", payload: remote || { ok: false } }, "*");
        return;
      }

      if (type === "OPEN_NEXT_SIDEBAR_ITEM") {
        const local = await openNextIncompleteFromSidebar(document);
        if (local.ok) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "OPEN_NEXT_SIDEBAR_ITEM_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "OPEN_NEXT_SIDEBAR_ITEM", {}, 3000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "OPEN_NEXT_SIDEBAR_ITEM_RES", payload: remote || { ok: false } }, "*");
        return;
      }

      if (type === "EVAL_MCQ") {
        const local = evaluateMcqResultInDoc(document);
        if (local.status !== "unknown") {
          window.postMessage({ source: "CT_BRIDGE", id, type: "EVAL_MCQ_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "EVAL_MCQ", {}, 2000);
        window.postMessage({ source: "CT_BRIDGE", id, type: "EVAL_MCQ_RES", payload: remote || local }, "*");
        return;
      }

      if (type === "EVAL_TESTS") {
        const ed = detectEditorRecursive(document, window);
        if (ed) {
          const evalRes = await evaluateTestResultsInDoc(ed.doc);
          window.postMessage({ source: "CT_BRIDGE", id, type: "EVAL_TESTS_RES", payload: evalRes }, "*");
          return;
        }
        const remote = await askChildFrames(id, "EVAL_TESTS", {}, 11000);
        window.postMessage(
          { source: "CT_BRIDGE", id, type: "EVAL_TESTS_RES", payload: remote || (await evaluateTestResultsInDoc(document)) },
          "*"
        );
        return;
      }
    }

    if (!isTop && data.source === "CT_TOP_TO_FRAME") {
      const { id, type, payload } = data;

      if (type === "STOP_TYPING") {
        stopTypingFlag = true;
        activeTypingSessionId++;
        broadcastToChildFrames(data);
        return;
      }

      if (type === "EXPAND_PROBLEM_PANELS") {
        const localExpanded = await expandSampleTestCasesInDoc(document);
        const localText = extractProblemTextFromDoc(document);
        const hasProblem = /(input format|output format|sample test cases|fill the missing code|constraints|write a (?:program|function|code)|you are given)/i.test(localText);
        if (localExpanded || (hasProblem && localText.length > 80)) {
          window.top.postMessage(
            { source: "CT_FRAME_TO_TOP", id, type, payload: { expanded: localExpanded, problemText: localText } },
            "*"
          );
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "SWITCH_LANG") {
        const local = await switchEditorLanguageInDoc(document, payload?.lang);
        if (local.ok) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "READ_EDITOR") {
        const local = await readEditorStateLocal(payload || {});
        if (local.found) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "CHECK_PENDING_TASK") {
        if (hasPendingTaskInDoc(document)) {
          window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: { hasTask: true } }, "*");
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "OPEN_UNIT_ITEM") {
        const local = openUnitItemInDoc(document);
        if (local.ok || local.allCompleted) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "OPEN_NEXT_SIDEBAR_ITEM") {
        const local = await openNextIncompleteFromSidebar(document);
        if (local.ok) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "READ_MCQ") {
        const local = detectMcqRecursive(document);
        if (local) {
          window.top.postMessage(
            {
              source: "CT_FRAME_TO_TOP",
              id,
              type,
              payload: { found: true, isMultiSelect: local.isMultiSelect, questionText: local.questionText, options: local.options }
            },
            "*"
          );
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "TICK_MCQ") {
        const local = tickMcqAnswersInDoc(payload?.answers || []);
        if (local.ok) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "CHECK_VIDEO") {
        const local = handleVideoInDoc(document);
        if (local.found) window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        else broadcastToChildFrames(data);
        return;
      }

      if (type === "TYPE_CODE") {
        const localEd = detectEditorRecursive(document, window);
        if (localEd) {
          const res = await humanTypeLocal(payload || {});
          window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: res }, "*");
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "CLICK_BUTTON") {
        const hit = payload?.preferEditorSubmit
          ? clickCodeSubmitInDoc(document)
          : clickButtonInDoc(document, payload?.targets || []);
        if (hit) {
          window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: { ok: true } }, "*");
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "EVAL_MCQ") {
        const local = evaluateMcqResultInDoc(document);
        if (local.status !== "unknown") {
          window.top.postMessage({ source: "CT_FRAME_TO_TOP", id, type, payload: local }, "*");
        } else {
          broadcastToChildFrames(data);
        }
        return;
      }

      if (type === "EVAL_TESTS") {
        const localEd = detectEditorRecursive(document, window);
        if (localEd) {
          window.top.postMessage(
            { source: "CT_FRAME_TO_TOP", id, type, payload: await evaluateTestResultsInDoc(localEd.doc) },
            "*"
          );
        } else {
          broadcastToChildFrames(data);
        }
      }
    }
  });
})();
