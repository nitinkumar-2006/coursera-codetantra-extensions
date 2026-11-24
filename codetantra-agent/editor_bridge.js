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

  function detectLanguageFromDoc(doc) {
    const els = Array.from(doc.querySelectorAll("[role='tab'], .tab, button, span, div"));
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (t.length > 0 && t.length < 40 && /\.(py|java|c|cpp|cc|cxx|js|ts|sql|html)$/i.test(t)) {
        const ext = t.split(".").pop().toLowerCase();
        const map = {
          py: "python",
          java: "java",
          c: "c",
          cpp: "cpp",
          cc: "cpp",
          cxx: "cpp",
          js: "javascript",
          ts: "typescript",
          sql: "sql"
        };
        if (map[ext]) return map[ext];
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

      // Click ONCE on toggleBtn — NEVER double-toggle!
      toggleBtn.click();
      await sleep(500);

      const afterLen1 = (doc.body.innerText || "").length;
      if (afterLen1 > beforeLen + 20) {
        return true; // Opened cleanly!
      }
      if (afterLen1 < beforeLen - 20) {
        // It was already open and we accidentally closed it — click ONCE to re-open!
        toggleBtn.click();
        await sleep(450);
        return true;
      }

      // If toggleBtn had no effect at all, try clicking header itself ONCE
      if (header !== toggleBtn) {
        header.click();
        await sleep(500);
        const afterLen2 = (doc.body.innerText || "").length;
        if (afterLen2 > beforeLen + 20) return true;
        if (afterLen2 < beforeLen - 20) {
          header.click();
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
    clone
      .querySelectorAll(
        '#ct-helper-panel, .cm-editor, .ace_editor, .monaco-editor, .CodeMirror, script, style, [aria-hidden="true"], .hidden, .d-none, [style*="display: none"], [style*="display:none"]'
      )
      .forEach((el) => el.remove());
    return (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 15000);
  }

  // Auto-switch editor language dropdown (e.g. C -> Java / Python / C++) when user sets preferred language
  async function switchEditorLanguageInDoc(doc, targetLang) {
    if (!doc || !doc.body || !targetLang || targetLang === "auto") return { ok: false };
    const want = targetLang.toLowerCase();
    const langLabels = { java: "java", python: "python", c: "c", cpp: "c++" };
    const targetLabel = langLabels[want] || want;

    // Find top-right editor language dropdown button (shows C / C++ / Java / Python near Submit)
    const btns = Array.from(doc.querySelectorAll("button, [role='button'], select")).filter(
      (el) => !el.closest("#ct-helper-panel") && isVisible(el)
    );
    const langTrigger = btns.find((el) => {
      const t = normalizeText(el.innerText || el.textContent || "");
      const r = el.getBoundingClientRect();
      return (t === "c" || t === "c++" || t === "java" || t === "python" || t === "python3") && r.top < 170 && r.width < 140;
    });
    if (!langTrigger) return { ok: false };

    const curText = normalizeText(langTrigger.innerText || langTrigger.textContent || "");
    if (curText === targetLabel || (want === "python" && curText.startsWith("python"))) {
      return { ok: true, already: true };
    }

    langTrigger.click();
    await sleep(350);

    const menuItems = Array.from(doc.querySelectorAll("button, li, a, div, span, [role='menuitem'], [role='option']")).filter(
      (el) => !el.closest("#ct-helper-panel") && el !== langTrigger && isVisible(el)
    );
    const pick = menuItems.find((el) => {
      const t = normalizeText(el.innerText || el.textContent || "");
      return (t === targetLabel || (want === "python" && t.startsWith("python"))) && el.getBoundingClientRect().height < 60;
    });
    if (pick) {
      pick.click();
      await sleep(950);
      return { ok: true, switchedTo: targetLabel };
    }
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

    const incomplete = cards.find((c) => !isCardCompleted(c));
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
          const expandedLeaves = getSidebarRows(leafPattern).filter((r) => !getSidebarIconStatus(r).hasGreen && !isSamePage(r));
          if (expandedLeaves.length) return clickSidebarRow(expandedLeaves[0]);
        } else if (isUnit && (!nextRow || !leafPattern.test(nextTxt)) && (hasPink || !hasGreen)) {
          // Expand collapsed sub-unit (e.g. "9.4. Circular Queue..." or "9.6. Deque")
          clickSidebarRow(row);
          await sleep(450);
          const expandedLeaves = getSidebarRows(leafPattern).filter((r) => !getSidebarIconStatus(r).hasGreen && !isSamePage(r));
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
    const btns = Array.from(doc.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")).filter(
      (el) => !el.closest("#ct-helper-panel") && isVisible(el)
    );
    const hasCodingOrQuizBtn = btns.some((el) => {
      const t = normalizeText(el.innerText || el.value || el.textContent || "");
      return t === "submit" || t === "reset" || t === "submit code" || t === "test cases" || t === "terminal" || t === "compile & run";
    });
    if (hasCodingOrQuizBtn) return true;

    const bodyTxt = normalizeText(doc.body.innerText || "");
    if (
      bodyTxt.includes("setting up environment") ||
      bodyTxt.includes("loading environment") ||
      bodyTxt.includes("sample test cases") ||
      bodyTxt.includes("shown test case") ||
      bodyTxt.includes("hidden test case") ||
      (bodyTxt.includes("input format") && bodyTxt.includes("output format"))
    ) {
      return true;
    }
    return false;
  }

  // Exact CodeTantra Test-Case Pass / Fail Evaluation Parser!
  function evaluateTestResultsInDoc(doc) {
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
      return { status: "failed", summary: `${summary}\n${readFailureSnippetFromDoc(doc)}` };
    }

    if (genericMatch) {
      const passedNum = parseInt(genericMatch[1], 10);
      const totalNum = parseInt(genericMatch[2], 10);
      if (totalNum > 0 && passedNum === totalNum) {
        return { status: "passed", summary: genericMatch[0] };
      }
      return { status: "failed", summary: `${genericMatch[0]}\n${readFailureSnippetFromDoc(doc)}` };
    }

    // Check explicit compilation/runtime error panels
    const errText = readFailureSnippetFromDoc(doc);
    const normErr = normalizeText(errText);
    if (
      normErr.includes("traceback") ||
      normErr.includes("syntaxerror") ||
      normErr.includes("indentationerror") ||
      normErr.includes("nameerror") ||
      normErr.includes("typeerror") ||
      normErr.includes("compilation error") ||
      normErr.includes("runtime error") ||
      normErr.includes("test case failed")
    ) {
      return { status: "failed", summary: errText };
    }

    return { status: "unknown", summary: errText };
  }

  function readFailureSnippetFromDoc(doc) {
    if (!doc) return "";
    const candidates = Array.from(
      doc.querySelectorAll(
        '[class*="output" i], [class*="result" i], [class*="console" i], [class*="error" i], [class*="test" i], [class*="traceback" i], [class*="text-red" i], [class*="danger" i], [class*="mono" i], [class*="alert" i], code, table, pre'
      )
    ).filter(
      (el) =>
        !el.closest("#ct-helper-panel") &&
        !el.closest(".cm-editor") &&
        !el.closest(".ace_editor") &&
        isVisible(el)
    );

    const unique = [];
    const seen = new Set();
    for (const el of candidates) {
      const t = (el.innerText || "").trim();
      if (t.length > 0 && t.length < 2800 && !seen.has(t)) {
        seen.add(t);
        unique.push(t);
      }
    }

    // Also extract explicit Error / Caused by / Expected vs Actual lines directly from visible body text
    try {
      const clone = doc.body.cloneNode(true);
      clone.querySelectorAll("#ct-helper-panel, .cm-editor, .ace_editor, script, style").forEach((el) => el.remove());
      const lines = (clone.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const errLines = lines.filter((l) =>
        /(error:|caused by:|exception|wrong name:|traceback|syntaxerror|indentationerror|output mismatch|out of \d+ .*test case)/i.test(l)
      );
      for (const eline of errLines) {
        if (!seen.has(eline)) {
          seen.add(eline);
          unique.unshift(eline);
        }
      }
    } catch {}

    return unique.join("\n---\n").slice(0, 4500);
  }

  // ---------------- Auto-Dismiss CodeTantra AI Tutor Popups ----------------
  function dismissTutorPopupsInDoc(doc) {
    if (!doc || !doc.body) return false;
    let dismissed = false;

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

    for (const ans of answers || []) {
      const target = normalizeText(ans);
      if (!target) continue;

      let match = mcq.optionRefs.find((o) => !usedInputs.has(o.input) && normalizeText(o.text) === target);
      if (!match && target.length >= 2) {
        match = mcq.optionRefs.find((o) => {
          if (usedInputs.has(o.input)) return false;
          const ot = normalizeText(o.text);
          return ot === target || (target.length >= 3 && ot.includes(target)) || (ot.length >= 3 && target.includes(ot));
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

  function clickButtonInDoc(doc, targets, { exactFirst = true } = {}) {
    if (!doc) return false;

    const isClickableBtn = (el) => {
      if (el.closest("#ct-helper-panel")) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      return isVisible(el);
    };

    // 1. Standard buttons/links first
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

    const partial = els.find((el) => {
      const txt = normalizeText(el.innerText || el.value || el.textContent || "");
      return txt && targets.some((t) => txt.includes(t));
    });
    if (partial) {
      dispatchReliableClick(partial);
      return true;
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

  async function readEditorStateLocal() {
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
      lockedLines = await scanAllLockedLinesCM6(ed);
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

    await expandSampleTestCasesInDoc(ed.doc);
    const problemText = extractProblemTextFromDoc(ed.doc);
    return { found: true, type: ed.type, code, language, lockedLines, problemText };
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

    // HARD LOCKED-LINE PROTECTION: NEVER wipe a file that has pink [LOCKED] lines!
    const rawSorted = [...normalizedEdits].sort((a, b) => (a.start_line || 1) - (b.start_line || 1));
    const sortedEdits = [];
    let lastOrigEnd = 0;
    for (const e of rawSorted) {
      if (e.mode === "replace_all") {
        if (lockedSet.size > 0) {
          return { ok: false, error: "Blocked replace_all: file mein pink [LOCKED] lines hain!" };
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
      return { ok: false, error: "Koi safe editable block nahi mila (pink locked lines protected)." };
    }

    const totalChars = Math.max(1, sortedEdits.reduce((sum, e) => sum + (e.code || "").length, 0));
    const baseCharMs = Math.max(68, Math.min(145, Math.floor(targetTotalMs / totalChars)));
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
          view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from }, scrollIntoView: true });
          await sleep(randMs(260, 520));
        }

        const text = (edit.code || "").replace(/\r\n/g, "\n");
        let cursor = from;

        for (let i = 0; i < text.length; i++) {
          if (stopTypingFlag || sessionId !== activeTypingSessionId) {
            return { ok: false, error: "Typing stopped by user." };
          }
          const ch = text[i];
          const safePos = Math.max(0, Math.min(cursor, view.state.doc.length));
          view.dispatch({
            changes: { from: safePos, to: safePos, insert: ch },
            selection: { anchor: safePos + ch.length },
            scrollIntoView: true
          });
          cursor = safePos + ch.length;
          doneChars++;
          if (doneChars % 3 === 0 || doneChars === totalChars) {
            emitProgressToTop(Math.min(100, Math.round((doneChars / totalChars) * 100)), doneChars, totalChars);
          }

          let delay = randMs(Math.floor(baseCharMs * 0.72), Math.floor(baseCharMs * 1.42));
          if (ch === "\n") delay += randMs(220, 480);
          else if (ch === " " && Math.random() < 0.20) delay += randMs(110, 240);
          else if (ch === ":" || ch === ";" || ch === "{" || ch === "}" || ch === "(" || ch === ")") delay += randMs(70, 160);
          await sleep(delay);
        }

        const newLineCount = text.split("\n").length;
        lineDelta += newLineCount - oldLineCount;
        await sleep(randMs(320, 620));
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

  async function humanTypeLocal({ edits = [], targetTotalMs = 42000, lockedLines = [] }) {
    const ed = detectEditorRecursive(document, window);
    if (!ed) return { ok: false, error: "Code editor nahi mila." };
    if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "Koi code edit nahi mila." };

    stopTypingFlag = false;
    const mySession = ++activeTypingSessionId;
    if (ed.type === "cm6") return await typeIntoCM6(ed, edits, targetTotalMs, mySession, lockedLines);

    const sortedEdits = [...edits].sort((a, b) => (b.start_line || 1) - (a.start_line || 1));
    const totalChars = Math.max(1, sortedEdits.reduce((sum, e) => sum + (e.code || "").length, 0));
    const baseCharMs = Math.max(68, Math.min(145, Math.floor(targetTotalMs / totalChars)));
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
        broadcastToChildFrames({ source: "CT_TOP_TO_FRAME", id, type: "STOP_TYPING", payload: {} });
        window.postMessage({ source: "CT_BRIDGE", id, type: "STOP_TYPING_RES", payload: { ok: true } }, "*");
        return;
      }

      if (type === "EXPAND_PROBLEM_PANELS") {
        const localExpanded = await expandSampleTestCasesInDoc(document);
        const localText = localExpanded ? extractProblemTextFromDoc(document) : "";
        if (localExpanded && localText.length > 80) {
          window.postMessage(
            { source: "CT_BRIDGE", id, type: "EXPAND_PROBLEM_PANELS_RES", payload: { expanded: true, problemText: localText } },
            "*"
          );
          return;
        }
        const remote = await askChildFrames(id, "EXPAND_PROBLEM_PANELS", {}, 4000);
        window.postMessage(
          {
            source: "CT_BRIDGE",
            id,
            type: "EXPAND_PROBLEM_PANELS_RES",
            payload: remote || { expanded: localExpanded, problemText: localText }
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
        const local = await readEditorStateLocal();
        if (local.found) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "READ_EDITOR_RES", payload: local }, "*");
          return;
        }
        const remote = await askChildFrames(id, "READ_EDITOR", {}, 4000);
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
        if (clickButtonInDoc(document, targets)) {
          window.postMessage({ source: "CT_BRIDGE", id, type: "CLICK_BUTTON_RES", payload: { ok: true } }, "*");
          return;
        }
        const ed = detectEditorRecursive(document, window);
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
          const evalRes = evaluateTestResultsInDoc(ed.doc);
          window.postMessage({ source: "CT_BRIDGE", id, type: "EVAL_TESTS_RES", payload: evalRes }, "*");
          return;
        }
        const remote = await askChildFrames(id, "EVAL_TESTS", {}, 2500);
        window.postMessage(
          { source: "CT_BRIDGE", id, type: "EVAL_TESTS_RES", payload: remote || evaluateTestResultsInDoc(document) },
          "*"
        );
        return;
      }
    }

    if (!isTop && data.source === "CT_TOP_TO_FRAME") {
      const { id, type, payload } = data;

      if (type === "STOP_TYPING") {
        stopTypingFlag = true;
        broadcastToChildFrames(data);
        return;
      }

      if (type === "EXPAND_PROBLEM_PANELS") {
        const localExpanded = await expandSampleTestCasesInDoc(document);
        if (localExpanded) {
          window.top.postMessage(
            { source: "CT_FRAME_TO_TOP", id, type, payload: { expanded: true, problemText: extractProblemTextFromDoc(document) } },
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
        const local = await readEditorStateLocal();
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
        if (clickButtonInDoc(document, payload?.targets || [])) {
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
            { source: "CT_FRAME_TO_TOP", id, type, payload: evaluateTestResultsInDoc(localEd.doc) },
            "*"
          );
        } else {
          broadcastToChildFrames(data);
        }
      }
    }
  });
})();
