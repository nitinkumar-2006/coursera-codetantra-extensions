const DEFAULT_GEMINI_API_KEY = "";

// Dynamic model discovery (same fast engine as CodeTantra Agent) + fallback list
const FALLBACK_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-2.5-flash"
];

let cachedWorkingModels = null;

function getApiKey() {
  return (localStorage.getItem("cs_gemini_api_key") || DEFAULT_GEMINI_API_KEY).trim();
}

const RETRYABLE_HTTP_CODES = new Set([400, 403, 404, 408, 429, 500, 502, 503, 504]);
const MIN_PASS_PERCENT = 80;
const MAX_QUIZ_RETRIES = 4;

let autoMode = sessionStorage.getItem("cs_auto_mode") === "true";
let autoInterval = null;

// Per-page state
let lastUrl = window.location.href;
let pageEnteredAt = Date.now();
let currentVideoKey = null;
let videoJumpStage = 0; // 0=init, 1=25%, 2=50%, 3=75%, 4=end-3s, 5=ended-verifying-tick
let videoEndedAt = 0;
let videoRetryCount = 0;
let lastJumpTime = 0;
let nextJumpDwellMs = 6800;
let readingScrollStep = 0;
let actionLock = false;
let quizSolvingInProgress = false;
let quizTickedUrls = new Set();
let quizSubmittedUrls = new Set();
let quizFailedUrls = new Set();
let quizRetryCounts = {};
let quizSolveErrorCounts = {};
let quizCooldownUntil = {};
let sidebarBacktrackAttempts = {};
let sidebarSkippedUrls = new Set();
let labCompletedUrls = new Set();
let readingMarkedUrls = new Set();

function randMs(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

// ---------------- UI (Crisp Apple Dark Glassmorphism) ----------------
function createPanel() {
  if (document.getElementById("cs-helper-panel")) return;

  if (!document.getElementById("cs-glass-styles")) {
    const styleTag = document.createElement("style");
    styleTag.id = "cs-glass-styles";
    styleTag.textContent = `
      #cs-helper-panel {
        transition: box-shadow 0.2s ease, border-color 0.2s ease;
      }
      #cs-helper-panel:hover {
        border-color: rgba(255, 255, 255, 0.34);
      }
      .cs-glass-btn {
        flex: 1;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(10, 12, 18, 0.74);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.24);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 2px 8px rgba(0, 0, 0, 0.25);
        color: #ffffff;
        cursor: pointer;
        font-weight: 600;
        font-size: 12px;
        letter-spacing: 0.15px;
        transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease;
      }
      .cs-glass-btn:hover {
        background: rgba(18, 22, 32, 0.88);
        border-color: rgba(255, 255, 255, 0.42);
      }
      .cs-glass-btn:active {
        transform: scale(0.97);
      }
      .cs-glass-btn-running {
        background: rgba(58, 16, 22, 0.78);
        border-color: rgba(248, 113, 113, 0.48);
        color: #ffffff;
      }
      .cs-glass-btn-running:hover {
        background: rgba(82, 20, 28, 0.90);
        border-color: rgba(248, 113, 113, 0.68);
      }
      .cs-icon-btn {
        background: rgba(10, 12, 18, 0.62);
        border: 1px solid rgba(255, 255, 255, 0.20);
        color: #e5e7eb;
        border-radius: 6px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
      }
      .cs-icon-btn:hover {
        border-color: rgba(255, 255, 255, 0.45);
        color: #ffffff;
      }
    `;
    document.head.appendChild(styleTag);
  }

  const panel = document.createElement("div");
  panel.id = "cs-helper-panel";
  panel.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    background: rgba(16, 18, 26, 0.62);
    backdrop-filter: blur(10px) saturate(150%);
    -webkit-backdrop-filter: blur(10px) saturate(150%);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 16px; padding: 13px; width: 320px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28);
    font-size: 12.5px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center;">
      <span style="display:flex; align-items:center; gap:6px;">
        <span style="color:#ffffff;">Coursera Agent</span>
        <span style="font-size:10px; background:rgba(10,12,18,0.65); border:1px solid rgba(255,255,255,0.22); color:#e5e7eb; padding:2px 6px; border-radius:6px;">v30</span>
        <button id="cs-set-key" class="cs-icon-btn" title="Set custom Gemini API Key">Key</button>
      </span>
      <span id="cs-status" style="color:#e5e7eb; font-size:11px; font-weight:500; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Idle</span>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:2px;">
      <button id="cs-toggle-auto" class="cs-glass-btn">
        Start Auto
      </button>
      <button id="cs-solve-quiz" class="cs-glass-btn">
        Solve Quiz
      </button>
    </div>
    <div id="cs-output" style="margin-top:9px; max-height:200px; overflow-y:auto; background:rgba(10, 12, 18, 0.72); color:#f3f4f6; border:1px solid rgba(255, 255, 255, 0.16); padding:8px 10px; border-radius:10px; font-size:11.5px; line-height:1.45; white-space:pre-wrap; display:none;"></div>
  `;

  document.body.appendChild(panel);
  document.getElementById("cs-toggle-auto").addEventListener("click", () => setAutoMode(!autoMode));
  document.getElementById("cs-solve-quiz").addEventListener("click", () => {
    if (getPageType() === "graded_lab" && window.location.pathname.toLowerCase().includes("/lab")) {
      solveGradedLabWithAI();
      return;
    }
    const baseKey = window.location.pathname.toLowerCase().replace(/\/(attempt|view-submission|view-feedback).*$/i, "");
    quizFailedUrls.delete(baseKey);
    quizTickedUrls.delete(baseKey);
    quizSubmittedUrls.delete(baseKey);
    quizSolveErrorCounts[baseKey] = 0;
    delete quizCooldownUntil[baseKey];
    quizSolvingInProgress = false;
    solveQuiz({ autoSubmit: true, baseQuizKey: baseKey, useStrongModel: false });
  });
  document.getElementById("cs-set-key").addEventListener("click", () => {
    const newKey = prompt("Coursera Agent ke liye apna Gemini API Key paste karo:", getApiKey());
    if (newKey && newKey.trim()) {
      localStorage.setItem("cs_gemini_api_key", newKey.trim());
      cachedWorkingModels = null;
      quizCooldownUntil = {};
      quizFailedUrls.clear();
      setStatus("Key saved ✓", "#86efac");
      setOutput("Naya Gemini API Key save ho gaya.");
    }
  });

  syncAutoUI();
}

function setStatus(text, color = "#e5e7eb") {
  const el = document.getElementById("cs-status");
  if (el) {
    el.innerText = text;
    el.style.color = color;
  }
}

function setOutput(text) {
  const out = document.getElementById("cs-output");
  if (!out) return;
  out.style.display = "block";
  out.innerText = text;
}

function clearOutput() {
  const out = document.getElementById("cs-output");
  if (!out) return;
  out.style.display = "none";
  out.innerText = "";
}

function syncAutoUI() {
  const btn = document.getElementById("cs-toggle-auto");
  if (!btn) return;
  if (autoMode) {
    btn.innerText = "Stop Auto";
    btn.classList.add("cs-glass-btn-running");
    setStatus("Running...", "#86efac");
  } else {
    btn.innerText = "Start Auto";
    btn.classList.remove("cs-glass-btn-running");
    setStatus("Stopped", "#d1d5db");
  }
}

function setAutoMode(enabled) {
  autoMode = enabled;
  sessionStorage.setItem("cs_auto_mode", enabled ? "true" : "false");
  syncAutoUI();

  if (autoInterval) {
    clearInterval(autoInterval);
    autoInterval = null;
  }

  if (autoMode) {
    quizFailedUrls.clear();
    quizSolveErrorCounts = {};
    sidebarBacktrackAttempts = {};
    sidebarSkippedUrls.clear();
    expandedModulesOnce = false;
    resetPageState();
    autoInterval = setInterval(runAutoTick, 2000);
    runAutoTick();
  }
}

function resetPageState() {
  pageEnteredAt = Date.now();
  currentVideoKey = null;
  videoJumpStage = 0;
  videoEndedAt = 0;
  videoRetryCount = 0;
  lastJumpTime = 0;
  nextJumpDwellMs = randMs(6000, 8500);
  readingScrollStep = 0;
  actionLock = false;
  quizSolvingInProgress = false;
  clearOutput();
}

// ---------------- Page Type Detection ----------------
function getPageType() {
  const path = window.location.pathname.toLowerCase();

  if (path.includes("/lecture/")) return "video";
  if (path.includes("/supplement/")) return "reading";
  // Separate Graded Programming Labs (/programming/) from Ungraded Labs (/ungradedLab/)!
  if (path.includes("/programming/")) return "graded_lab";
  if (path.includes("/ungradedlab/") || path.includes("/lab/")) return "ungraded_lab";
  if (
    path.includes("/assignment-submission/") ||
    path.includes("/exam/") ||
    path.includes("/quiz/") ||
    path.includes("/graded-assessment/")
  ) {
    return "quiz";
  }
  if (
    path.includes("/ungradedlti/") ||
    path.includes("/ungradedwidget/") ||
    path.includes("/plugin/")
  ) {
    return "plugin";
  }
  if (path.includes("/discussionprompt/") || path.includes("/dialogue/")) {
    return "optional";
  }

  if (document.querySelector("video")) return "video";
  return "other";
}

// ---------------- DOM & Smooth Scroll Helpers ----------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeText(str) {
  return (str || "")
    .replace(/\s+/g, " ")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019\u2032\u0060]/g, "'")
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .trim()
    .toLowerCase();
}

function normalizeMathLoose(str) {
  return normalizeText(str).replace(/[\s.,;]+/g, "");
}

// Reads visible text ONLY from the right-side main content pane (never contaminated by the left sidebar!)
function getMainContentText() {
  const sidebarOpen = getSidebarItemLinks().length > 0;
  const root = document.querySelector("main") || document.querySelector('[role="main"]') || document.body;
  if (!sidebarOpen) {
    return (root.innerText || "").slice(0, 8000);
  }
  const blocks = Array.from(root.querySelectorAll("h1, h2, h3, h4, p, div, section, article, span, button")).filter((el) => {
    if (el.closest("#cs-helper-panel, nav, aside, [role='navigation']")) return false;
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    // Strictly right of the left sidebar (which ends around x=300..420)
    return rect.left >= 280 && rect.width > 40;
  });
  // Keep top-level right-pane containers so text isn't duplicated
  const topBlocks = blocks.filter((el) => !blocks.some((other) => other !== el && other.contains(el)));
  if (topBlocks.length) {
    return topBlocks.map((el) => el.innerText || "").join("\n").slice(0, 8000);
  }
  return (root.innerText || "").slice(0, 8000);
}

function findButtonsByText(targets, root = document, { partial = false, allowDisabled = false } = {}) {
  const elements = Array.from(root.querySelectorAll("button, a[role='button'], a"));
  return elements.filter((el) => {
    if (el.closest("#cs-helper-panel")) return false;
    if (!allowDisabled && (el.disabled || el.getAttribute("aria-disabled") === "true")) return false;
    if (!isVisible(el)) return false;
    const txt = normalizeText(el.innerText || el.textContent || "");
    if (!txt) return false;
    return partial ? targets.some((t) => txt.includes(t)) : targets.includes(txt);
  });
}

function findButtonByText(targets, root = document, opts = {}) {
  const list = findButtonsByText(targets, root, opts);
  return list.length ? list[0] : null;
}

function getVisibleModals() {
  return Array.from(
    document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], .MuiDialog-paper, .cds-Modal-container, [data-testid*="modal" i]'
    )
  ).filter((el) => !el.closest("#cs-helper-panel") && isVisible(el));
}

function silenceAllMedia({ pauseAudio = true } = {}) {
  const audios = document.querySelectorAll("audio");
  for (const a of audios) {
    a.muted = true;
    a.volume = 0;
    if (pauseAudio && !a.paused) {
      try {
        a.pause();
      } catch {
        // ignore
      }
    }
  }
  const videos = document.querySelectorAll("video");
  for (const v of videos) {
    if (!v.muted) v.muted = true;
  }
}

function scrollReadingStep(fraction = 1.0) {
  const docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  window.scrollTo({ top: Math.floor(docHeight * fraction), behavior: "smooth" });

  const main = document.querySelector("main") || document.querySelector('[role="main"]');
  if (main) {
    main.scrollTo({ top: Math.floor(main.scrollHeight * fraction), behavior: "smooth" });
  }

  const scrollables = Array.from(document.querySelectorAll("div, section, article, main")).filter((el) => {
    if (el.closest("#cs-helper-panel")) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 420 || rect.height < 200) return false;
    if (el.scrollHeight <= el.clientHeight + 40) return false;
    const oy = window.getComputedStyle(el).overflowY;
    return oy === "auto" || oy === "scroll" || oy === "overlay";
  });

  for (const sc of scrollables) {
    sc.scrollTo({ top: Math.floor(sc.scrollHeight * fraction), behavior: "smooth" });
  }

  if (fraction >= 0.95) {
    const anchorBtn =
      findButtonByText(["mark as completed", "mark complete"], document, { partial: true }) ||
      findButtonByText(["report an issue"], main || document, { partial: true });
    if (anchorBtn) {
      anchorBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function setReactInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// ---------------- Sidebar & Green-Tick Verification Gatekeeper ----------------
function getSidebarItemLinks() {
  const allLinks = Array.from(document.querySelectorAll('a[href*="/learn/"]')).filter((a) => {
    if (a.closest("#cs-helper-panel")) return false;
    if (!isVisible(a)) return false;
    const rect = a.getBoundingClientRect();
    return rect.left < 430 && rect.height >= 24;
  });

  const seen = new Set();
  const unique = [];
  for (const link of allLinks) {
    try {
      const p = new URL(link.href).pathname;
      if (
        !seen.has(p) &&
        /\/(lecture|supplement|ungradedlab|lab|programming|assignment-submission|exam|quiz|graded-assessment|discussionprompt|ungradedlti|ungradedwidget|dialogue)\//i.test(p)
      ) {
        seen.add(p);
        unique.push({ el: link, path: p });
      }
    } catch {
      // ignore invalid href
    }
  }
  return unique;
}

function isRgbGreen(colorStr) {
  const m = (colorStr || "").match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const r = parseInt(m[1], 10);
  const g = parseInt(m[2], 10);
  const b = parseInt(m[3], 10);
  return g > 80 && g > r + 25 && g > b + 15;
}

function getCurrentBasePath() {
  return window.location.pathname.replace(/\/(attempt|view-submission|view-feedback|lab).*$/i, "").replace(/\/+$/, "");
}

function extractCourseraItemId(path) {
  const m = (path || "").match(
    /\/(?:lecture|supplement|ungradedlab|lab|programming|assignment-submission|exam|quiz|graded-assessment|discussionprompt|ungradedlti|ungradedwidget|dialogue)\/([^/?#]+)/i
  );
  return m ? m[1].toLowerCase() : null;
}

function isSameSidebarItem(pathA, pathB) {
  const idA = extractCourseraItemId(pathA);
  const idB = extractCourseraItemId(pathB);
  if (idA && idB) return idA === idB;
  return (pathA || "").replace(/\/+$/, "") === (pathB || "").replace(/\/+$/, "");
}

// Expand collapsed previous modules ("Module 1", "Module 2", ...) in the left sidebar so missed items there are detected too
let expandedModulesOnce = false;
function expandCollapsedSidebarModules() {
  if (expandedModulesOnce) return;
  const buttons = Array.from(document.querySelectorAll('button[aria-expanded="false"]')).filter((btn) => {
    if (btn.closest("#cs-helper-panel")) return false;
    if (!isVisible(btn)) return false;
    const rect = btn.getBoundingClientRect();
    if (rect.left > 420) return false;
    const txt = normalizeText(btn.innerText || btn.textContent || "");
    return /^module\s+\d+/i.test(txt);
  });
  if (buttons.length > 0) {
    expandedModulesOnce = true;
    buttons.forEach((btn, idx) => {
      setTimeout(() => {
        if (btn.getAttribute("aria-expanded") === "false") {
          btn.click();
        }
      }, idx * 450);
    });
  }
}

// Returns the tightest container strictly for THIS single sidebar item (never a parent section <li> with sibling items!)
function getSidebarItemRow(link) {
  if (!link) return null;
  const li = link.closest("li");
  if (li && li.querySelectorAll('a[href*="/learn/"]').length === 1) {
    return li;
  }
  let cur = link;
  for (let i = 0; i < 3 && cur.parentElement; i++) {
    const parent = cur.parentElement;
    if (parent.querySelectorAll('a[href*="/learn/"]').length === 1) {
      cur = parent;
    } else {
      break;
    }
  }
  return cur;
}

function isSidebarItemLocked(item) {
  if (!item || !item.el) return false;
  const container = getSidebarItemRow(item.el);
  if (
    item.el.getAttribute("aria-disabled") === "true" ||
    container.getAttribute("aria-disabled") === "true"
  ) {
    return true;
  }
  const metaText = normalizeText(
    [
      container.getAttribute("aria-label") || "",
      item.el.getAttribute("aria-label") || "",
      ...Array.from(container.querySelectorAll("[aria-label], [data-testid], title")).map(
        (el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`
      )
    ].join(" ")
  );
  return /\blocked\b/.test(metaText) || metaText.includes("lock-icon");
}

// Returns true ONLY if THIS specific sidebar row actually has a green checkmark!
function isSidebarItemGreenTicked(item) {
  if (!item || !item.el) return false;
  const container = getSidebarItemRow(item.el);

  // 0. If row text shows a failing grade (< 80%), it is NEVER green-ticked
  const rowText = normalizeText(container.innerText || "");
  const rowGradeMatch = rowText.match(/grade:\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (rowGradeMatch && parseFloat(rowGradeMatch[1]) < MIN_PASS_PERCENT) {
    return false;
  }

  // 1. Check aria-label / title / data-testid for completed/passed/check, excluding negative phrases
  const metaText = normalizeText(
    [
      container.getAttribute("aria-label") || "",
      item.el.getAttribute("aria-label") || "",
      ...Array.from(container.querySelectorAll("[aria-label], [data-testid], title")).map(
        (el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""} ${el.textContent || ""}`
      )
    ].join(" ")
  );

  const hasNegativeMarker =
    metaText.includes("not completed") ||
    metaText.includes("not-complete") ||
    metaText.includes("uncomplete") ||
    metaText.includes("incomplete") ||
    metaText.includes("not passed") ||
    /didn.?t\s+pass|did\s+not\s+pass|failed/.test(metaText);

  if (
    !hasNegativeMarker &&
    (/\bcompleted\b/.test(metaText) ||
      /\bpassed\b/.test(metaText) ||
      /(?:^|[\s_-])complete-icon\b/.test(metaText) ||
      metaText.includes("checkmark") ||
      metaText.includes("check-circle"))
  ) {
    return true;
  }

  // 2. Check if any SVG icon element inside THIS single sidebar row is rendered in Coursera green
  const icons = container.querySelectorAll("svg, path, circle, polyline");
  for (const ic of icons) {
    const style = window.getComputedStyle(ic);
    if (
      isRgbGreen(style.color) ||
      isRgbGreen(style.fill) ||
      isRgbGreen(style.stroke) ||
      isRgbGreen(ic.getAttribute("fill")) ||
      isRgbGreen(ic.getAttribute("stroke"))
    ) {
      return true;
    }
  }

  return false;
}

function getCurrentSidebarItem() {
  const currentBasePath = getCurrentBasePath();
  const items = getSidebarItemLinks();
  return items.find((item) => isSameSidebarItem(item.path, currentBasePath)) || null;
}

function isCurrentSidebarItemGreenTicked() {
  return isSidebarItemGreenTicked(getCurrentSidebarItem());
}

function isSidebarItemAutoCompletable(item) {
  if (!item || !item.path) return false;
  const p = item.path.toLowerCase();
  // Skip Graded Programming Labs (noVNC IDE) and optional Discussions/Dialogue
  if (p.includes("/programming/") || p.includes("/discussionprompt/") || p.includes("/dialogue/")) {
    return false;
  }
  const id = extractCourseraItemId(p) || p;
  if (quizFailedUrls.has(p) || sidebarSkippedUrls.has(p) || sidebarSkippedUrls.has(id)) {
    return false;
  }
  if (isSidebarItemLocked(item)) {
    return false;
  }
  return true;
}

function findFirstIncompleteSidebarItem({ excludePath = null, onlyBeforePath = null } = {}) {
  const items = getSidebarItemLinks();
  for (const item of items) {
    if (onlyBeforePath && isSameSidebarItem(item.path, onlyBeforePath)) {
      // Reached the current item — stop scanning (we only wanted missed items ABOVE us)
      break;
    }
    if (excludePath && isSameSidebarItem(item.path, excludePath)) continue;
    if (!isSidebarItemAutoCompletable(item)) continue;
    if (!isSidebarItemGreenTicked(item)) {
      return item;
    }
  }
  return null;
}

function findNextSidebarLink() {
  const currentBasePath = getCurrentBasePath();
  const items = getSidebarItemLinks();
  const idx = items.findIndex((item) => isSameSidebarItem(item.path, currentBasePath));

  if (idx !== -1 && idx + 1 < items.length) {
    return items[idx + 1].el;
  }
  return null;
}

function goToNextItem(delayMs = 5200, statusText = "Next item...") {
  if (actionLock) return;
  actionLock = true;
  // Always keep human-like unhurried pace before navigating to the next item
  const humanDelay = Math.max(delayMs, randMs(4500, 6800));
  setStatus(statusText, "#60a5fa");

  setTimeout(() => {
    actionLock = false;
    if (!autoMode) return;

    const currentBasePath = getCurrentBasePath();
    const items = getSidebarItemLinks();
    const currentIdx = items.findIndex((item) => isSameSidebarItem(item.path, currentBasePath));

    // 1. Sidebar Backtrack Sweep: if ANY earlier (or other) auto-completable item has no green tick, go complete it first!
    const missedItem = findFirstIncompleteSidebarItem({ excludePath: currentBasePath });
    if (missedItem) {
      const missedIdx = items.findIndex((item) => isSameSidebarItem(item.path, missedItem.path));
      const missKey = extractCourseraItemId(missedItem.path) || missedItem.path;
      const attempts = sidebarBacktrackAttempts[missKey] || 0;
      if (attempts < 4) {
        sidebarBacktrackAttempts[missKey] = attempts + 1;
        const isBacktrack = currentIdx !== -1 && missedIdx !== -1 && missedIdx < currentIdx;
        setStatus(isBacktrack ? "Backtrack -> unticked" : "Sidebar -> unticked", "#facc15");
        missedItem.el.scrollIntoView({ behavior: "smooth", block: "center" });
        missedItem.el.click();
        resetPageState();
        return;
      } else {
        sidebarSkippedUrls.add(missKey);
        sidebarSkippedUrls.add(missedItem.path);
      }
    }

    // 2. Otherwise advance normally to the next item (avoid clicking random bare "Next" buttons outside <main>)
    const mainArea = document.querySelector("main") || document.querySelector('[role="main"]');
    const nextBtn =
      findButtonByText(["go to next item", "next item"], document) ||
      (mainArea ? findButtonByText(["next"], mainArea) : null);
    if (nextBtn) {
      nextBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      nextBtn.click();
      resetPageState();
      return;
    }

    const sidebarNext = findNextSidebarLink();
    if (sidebarNext) {
      setStatus("Sidebar -> Next", "#86efac");
      sidebarNext.scrollIntoView({ behavior: "smooth", block: "center" });
      sidebarNext.click();
      resetPageState();
      return;
    }

    const nextModBtn = findButtonByText(["next module", "go to next module"], document, { partial: true });
    if (nextModBtn) {
      nextModBtn.click();
      resetPageState();
      return;
    }

    setStatus("Module/Course end?", "#facc15");
  }, humanDelay);
}

// ---------------- GLOBAL MODAL / POPUP HANDLER ----------------
function dismissStandaloneGoalPopup() {
  const continueLearningBtn = findButtonByText(["continue learning", "keep learning"], document);
  if (continueLearningBtn && !continueLearningBtn.closest("nav, aside, [role='navigation']")) {
    setStatus("Continue learning...", "#60a5fa");
    continueLearningBtn.focus();
    continueLearningBtn.click();
    return true;
  }
  return false;
}

function handleGlobalModals() {
  // 1. Always catch "Continue learning" / "Keep learning" goal popups FIRST (even if not role="dialog"!)
  if (dismissStandaloneGoalPopup()) {
    return true;
  }

  const modals = getVisibleModals();
  if (!modals.length) return false;

  for (let i = modals.length - 1; i >= 0; i--) {
    const modal = modals[i];
    const text = normalizeText(modal.innerText || modal.textContent || "");
    if (!text) continue;

    if (text.includes("submission successful")) {
      const viewGradesBtn = findButtonByText(["view grades"], modal);
      if (viewGradesBtn) {
        setStatus("Viewing grades...", "#86efac");
        viewGradesBtn.focus();
        viewGradesBtn.click();
        return true;
      }
    }

    if (text.includes("ready to submit") || text.includes("submit your assignment") || text.includes("confirm submission") || (text.includes("submit assignment") && text.includes("honor code"))) {
      // Auto-tick Honor Code checkbox inside the Graded Lab / Quiz submit modal if present
      const modalCheckboxes = Array.from(modal.querySelectorAll('input[type="checkbox"]')).filter((cb) => !cb.checked);
      for (const cb of modalCheckboxes) {
        const lbl = cb.closest("label") || (cb.id ? modal.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
        if (lbl && isVisible(lbl)) lbl.click();
        else if (isVisible(cb)) cb.click();
      }
      const modalSubmit = findButtonByText(["submit", "yes, submit", "confirm", "submit assignment"], modal);
      if (modalSubmit) {
        setStatus("Confirming Submit...", "#86efac");
        modalSubmit.click();
        const baseQuizKey = window.location.pathname.toLowerCase().replace(/\/(attempt|view-submission|view-feedback).*$/i, "");
        quizSubmittedUrls.add(baseQuizKey);
        return true;
      }
    }

    // Timed Graded Quiz ("You have 30 minutes to submit...") OR any unpassed/retrying quiz -> click Continue!
    if (text.includes("start new attempt")) {
      const baseQuizKey = window.location.pathname.toLowerCase().replace(/\/(attempt|view-submission|view-feedback).*$/i, "");
      const isRetrying = (quizRetryCounts[baseQuizKey] || 0) > 0;
      const isTimedNewAttempt = text.includes("minutes to submit") || !text.includes("replace your previous submission");
      const notPassedYet = !isCurrentSidebarItemGreenTicked();
      const shouldContinue = isRetrying || isTimedNewAttempt || notPassedYet;
      const targetBtn = findButtonByText(shouldContinue ? ["continue", "start", "yes"] : ["cancel"], modal);
      if (targetBtn) {
        setStatus(shouldContinue ? "Starting attempt..." : "Closing retry modal", "#60a5fa");
        targetBtn.click();
        return true;
      }
    }

    if (text.includes("leave this lab")) {
      const leaveBtn = findButtonByText(["leave lab"], modal);
      if (leaveBtn) {
        setStatus("Leaving Lab...", "#c084fc");
        leaveBtn.click();
        labCompletedUrls.add(window.location.pathname);
        return true;
      }
    }

    if (text.includes("reset my deadlines") || text.includes("push end date")) {
      const resetBtn = findButtonByText(["reset my deadlines", "push end date", "reset deadlines"], modal);
      if (resetBtn) {
        setStatus("Resetting deadlines...", "#60a5fa");
        resetBtn.click();
        return true;
      }
    }

    if (
      text.includes("today's goal") ||
      text.includes("todays goal") ||
      text.includes("daily goal") ||
      text.includes("weekly goal") ||
      text.includes("learning goal") ||
      text.includes("set a goal") ||
      text.includes("momentum") ||
      text.includes("streak") ||
      text.includes("great progress") ||
      text.includes("rate this") ||
      text.includes("feedback") ||
      text.includes("survey") ||
      text.includes("welcome back") ||
      text.includes("keep learning") ||
      text.includes("continue learning") ||
      text.includes("still watching") ||
      text.includes("still there") ||
      text.includes("meet coach") ||
      text.includes("what's new") ||
      text.includes("module complete") ||
      text.includes("completed module")
    ) {
      const dismissBtn = findButtonByText(
        [
          "continue learning",
          "keep learning",
          "continue watching",
          "next module",
          "go to next module",
          "continue",
          "resume",
          "got it",
          "okay",
          "ok",
          "done",
          "skip",
          "not now",
          "maybe later",
          "dismiss",
          "close",
          "no thanks"
        ],
        modal
      );
      if (dismissBtn) {
        setStatus("Dismissing popup...", "#60a5fa");
        dismissBtn.focus();
        dismissBtn.click();
        return true;
      }
      const closeIconBtn = modal.querySelector(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], [data-testid*="close" i]'
      );
      if (closeIconBtn && isVisible(closeIconBtn)) {
        setStatus("Closing popup...", "#60a5fa");
        closeIconBtn.click();
        return true;
      }
    }
  }

  return false;
}

// Fast 1-second watchdog while Auto is ON so repeated "You've completed today's goals!" popups vanish instantly
setInterval(() => {
  if (autoMode) {
    dismissStandaloneGoalPopup();
  }
}, 1000);

// ---------------- Main Auto Loop ----------------
function runAutoTick() {
  if (!autoMode) return;
  createPanel();
  silenceAllMedia({ pauseAudio: true });

  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    resetPageState();
  }

  if (handleGlobalModals()) {
    return;
  }

  if (actionLock || quizSolvingInProgress) return;

  // Expand collapsed previous modules once so missed items in earlier modules are visible to backtrack
  expandCollapsedSidebarModules();

  const pageType = getPageType();

  // PROACTIVE UPWARD BACKTRACK GUARD:
  // Even if Coursera's built-in Autoplay jumped ahead before a previous video/reading/quiz got a green tick,
  // detect ANY unticked item ABOVE the current item in the sidebar and immediately go back to finish it first!
  const onActiveQuizAttempt =
    window.location.pathname.toLowerCase().includes("/attempt") ||
    window.location.pathname.toLowerCase().includes("/view-feedback") ||
    window.location.pathname.toLowerCase().includes("/view-submission");

  if (!onActiveQuizAttempt && pageType !== "graded_lab" && Date.now() - pageEnteredAt >= 2800) {
    const currentBasePath = getCurrentBasePath();
    const missedAbove = findFirstIncompleteSidebarItem({ onlyBeforePath: currentBasePath });
    if (missedAbove) {
      const missKey = extractCourseraItemId(missedAbove.path) || missedAbove.path;
      const attempts = sidebarBacktrackAttempts[missKey] || 0;
      if (attempts < 4) {
        sidebarBacktrackAttempts[missKey] = attempts + 1;
        actionLock = true;
        setStatus("Missed above -> going back", "#facc15");
        missedAbove.el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => {
          missedAbove.el.click();
          resetPageState();
        }, randMs(1200, 1800));
        return;
      } else {
        sidebarSkippedUrls.add(missKey);
        sidebarSkippedUrls.add(missedAbove.path);
      }
    }
  }

  if (pageType === "video") {
    handleVideoPage();
  } else if (pageType === "reading") {
    handleReadingPage();
  } else if (pageType === "ungraded_lab") {
    handleUngradedLabPage();
  } else if (pageType === "graded_lab") {
    handleGradedLabPage();
  } else if (pageType === "quiz") {
    handleQuizPage();
  } else if (pageType === "plugin") {
    handlePluginPage();
  } else {
    handleOptionalOrFallbackPage();
  }
}

// 1. VIDEO PAGE (Green-Tick Gatekeeper: won't advance until sidebar green tick is confirmed!)
function handleVideoPage() {
  const elapsed = Date.now() - pageEnteredAt;

  // Auto-skip in-video Question / Quiz / Prompt popups overlaid on the video player
  const skipInVideo = findButtonByText(
    ["skip", "skip question", "continue", "resume", "resume video"],
    document
  );
  if (skipInVideo && !skipInVideo.closest("nav, aside, [role='navigation']")) {
    const btnTxt = normalizeText(skipInVideo.innerText || skipInVideo.textContent || "");
    // Climb up to 6 ancestor levels to catch Coursera's in-video Question card context
    let ancestor = skipInVideo;
    let contextText = "";
    for (let lvl = 0; lvl < 6 && ancestor.parentElement; lvl++) {
      ancestor = ancestor.parentElement;
      contextText = normalizeText(ancestor.innerText || "");
      if (
        contextText.includes("question") ||
        contextText.includes("quiz") ||
        contextText.includes("submit") ||
        contextText.includes("resume") ||
        ancestor.querySelector('input[type="radio"], input[type="checkbox"]')
      ) {
        break;
      }
    }
    const isInVideoPrompt =
      btnTxt === "skip" ||
      btnTxt === "skip question" ||
      btnTxt === "resume video" ||
      contextText.includes("question") ||
      contextText.includes("quiz") ||
      contextText.includes("submit") ||
      contextText.includes("resume") ||
      Boolean(ancestor.querySelector('input[type="radio"], input[type="checkbox"]'));

    if (isInVideoPrompt) {
      actionLock = true;
      setStatus("Skipping video quiz...", "#facc15");
      setTimeout(() => {
        skipInVideo.focus();
        skipInVideo.click();
        setTimeout(() => {
          actionLock = false;
        }, 1200);
      }, randMs(800, 1400));
      return;
    }
  }

  // Cancel Coursera's built-in Autoplay countdown if current video isn't green-ticked yet
  if (!isCurrentSidebarItemGreenTicked()) {
    const cancelAutoplay = findButtonByText(["cancel"], document);
    if (cancelAutoplay) {
      const parentTxt = normalizeText(cancelAutoplay.parentElement?.parentElement?.innerText || "");
      if (parentTxt.includes("up next") || parentTxt.includes("next video") || parentTxt.includes("auto")) {
        cancelAutoplay.click();
        setStatus("Cancelled autoplay...", "#facc15");
        return;
      }
    }
  }

  // If this video ALREADY has a green tick in sidebar, move on naturally after 3s
  if (elapsed > 3000 && isCurrentSidebarItemGreenTicked() && videoJumpStage === 0) {
    goToNextItem(randMs(2000, 3000), "Already ticked -> Next");
    return;
  }

  const video = document.querySelector("video");
  if (!video) {
    setStatus("Waiting video...", "#9ca3af");
    return;
  }

  const key = `${window.location.pathname}::${video.currentSrc || video.src || "vid"}`;
  if (key !== currentVideoKey) {
    currentVideoKey = key;
    videoJumpStage = 0;
    videoEndedAt = 0;
    videoRetryCount = 0;
    lastJumpTime = 0;
    nextJumpDwellMs = randMs(4500, 6200);
  }

  video.muted = true;
  if (videoRetryCount < 3 && video.playbackRate !== 2.0) {
    video.playbackRate = 2.0;
  }

  if (video.paused && !video.ended) {
    video.play().catch(() => {});
  }

  const duration = video.duration;
  if (!duration || isNaN(duration) || duration <= 0) {
    setStatus("Loading video...", "#9ca3af");
    return;
  }

  if (elapsed < 3000) {
    setStatus("Starting video...", "#9ca3af");
    return;
  }

  // Strict Green-Tick Verification after video ends: NEVER skip if sidebar shows it's unticked!
  if (video.ended) {
    if (videoJumpStage < 5) {
      videoJumpStage = 5;
      videoEndedAt = Date.now();
      setStatus("Waiting green tick...", "#60a5fa");
      return;
    }

    if (isCurrentSidebarItemGreenTicked()) {
      goToNextItem(randMs(1800, 2600), "Green tick ✓ -> Next");
      return;
    }

    const sidebarItemExists = Boolean(getCurrentSidebarItem());
    const waitedAfterEnd = Date.now() - videoEndedAt;

    if (waitedAfterEnd > 6000) {
      if (videoRetryCount === 0) {
        videoRetryCount = 1;
        videoJumpStage = 4;
        videoEndedAt = 0;
        video.playbackRate = 1.5;
        video.currentTime = Math.max(0, duration - 5);
        video.play().catch(() => {});
        setStatus("Re-trigger tick (1/3)", "#facc15");
        return;
      }
      if (videoRetryCount === 1) {
        videoRetryCount = 2;
        videoJumpStage = 1;
        videoEndedAt = 0;
        lastJumpTime = Date.now();
        nextJumpDwellMs = randMs(5500, 7000);
        video.playbackRate = 2.0;
        video.currentTime = duration * 0.20;
        video.play().catch(() => {});
        setStatus("Re-watching video (2/3)", "#facc15");
        return;
      }
      if (videoRetryCount === 2) {
        videoRetryCount = 3;
        videoJumpStage = 4;
        videoEndedAt = 0;
        video.playbackRate = 1.0;
        video.currentTime = Math.max(0, duration - 6);
        video.play().catch(() => {});
        setStatus("1x end-play tick (3/3)", "#facc15");
        return;
      }

      // Only fall back to advancing without green tick if sidebar is hidden/collapsed
      if (!sidebarItemExists && waitedAfterEnd > 12000) {
        goToNextItem(1500, "Ended -> Next");
        return;
      }

      // Sidebar is visible & still unticked: keep re-triggering end-play until green tick appears
      if (waitedAfterEnd > 10000) {
        videoJumpStage = 4;
        videoEndedAt = 0;
        video.playbackRate = 1.0;
        video.currentTime = Math.max(0, duration - 5);
        video.play().catch(() => {});
        setStatus("Waiting green tick...", "#facc15");
        return;
      }
    }

    setStatus("Waiting green tick...", "#60a5fa");
    return;
  }

  if (duration < 12) {
    if (videoJumpStage < 4) {
      video.currentTime = Math.max(0, duration - 3);
      videoJumpStage = 4;
      setStatus("Short video end...", "#86efac");
    }
    return;
  }

  const now = Date.now();

  if (videoJumpStage === 0) {
    video.currentTime = duration * 0.25;
    videoJumpStage = 1;
    lastJumpTime = now;
    nextJumpDwellMs = randMs(6000, 8500);
    setStatus("Video 25% (1/4)", "#86efac");
  } else if (videoJumpStage === 1 && now - lastJumpTime >= nextJumpDwellMs) {
    video.currentTime = duration * 0.50;
    videoJumpStage = 2;
    lastJumpTime = now;
    nextJumpDwellMs = randMs(6000, 8500);
    setStatus("Video 50% (2/4)", "#86efac");
  } else if (videoJumpStage === 2 && now - lastJumpTime >= nextJumpDwellMs) {
    video.currentTime = duration * 0.75;
    videoJumpStage = 3;
    lastJumpTime = now;
    nextJumpDwellMs = randMs(6000, 8500);
    setStatus("Video 75% (3/4)", "#86efac");
  } else if (videoJumpStage === 3 && now - lastJumpTime >= nextJumpDwellMs) {
    video.currentTime = Math.max(0, duration - 6);
    videoJumpStage = 4;
    lastJumpTime = now;
    setStatus("Video -6s (4/4)", "#86efac");
  }
}

// 2. READING PAGE (Smooth step-scroll -> MUST click Mark as completed & confirm green tick before Next!)
function handleReadingPage() {
  const readKey = window.location.pathname;
  const elapsed = Date.now() - pageEnteredAt;
  const main = document.querySelector("main") || document.querySelector('[role="main"]');

  silenceAllMedia({ pauseAudio: true });

  // Progressive human-like scrolling across 3 ticks (~6 seconds total)
  if (readingScrollStep === 0) {
    scrollReadingStep(0.35);
    readingScrollStep = 1;
    setStatus("Reading (scroll 1/3)", "#9ca3af");
    return;
  }
  if (readingScrollStep === 1) {
    scrollReadingStep(0.70);
    readingScrollStep = 2;
    setStatus("Reading (scroll 2/3)", "#9ca3af");
    return;
  }
  if (readingScrollStep === 2) {
    scrollReadingStep(1.0);
    readingScrollStep = 3;
    setStatus("Reading (scroll 3/3)", "#9ca3af");
    return;
  }

  scrollReadingStep(1.0);

  // 1. Always click "Mark as completed" if present!
  const markBtn = findButtonByText(["mark as completed", "mark complete"], document, { partial: true });
  if (markBtn) {
    actionLock = true;
    readingMarkedUrls.add(readKey);
    setStatus("Reading: Marking...", "#86efac");
    markBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      markBtn.click();
      setTimeout(() => {
        actionLock = false;
      }, 2400);
    }, 600);
    return;
  }

  // 2. Advance ONLY when green tick OR "Go to next item" inside <main> is confirmed!
  const goNextInMain = main ? findButtonByText(["go to next item"], main) : null;
  if (isCurrentSidebarItemGreenTicked() || Boolean(goNextInMain)) {
    goToNextItem(randMs(2000, 3000), "Reading ✓ -> Next");
    return;
  }

  // Never skip an unticked reading prematurely — keep waiting/scrolling
  if (elapsed < 15000) {
    setStatus("Waiting green tick...", "#60a5fa");
    return;
  }

  // If sidebar is collapsed/hidden so tick can't be read, advance after 15s
  if (!getCurrentSidebarItem()) {
    goToNextItem(2000, "Reading -> Next");
    return;
  }

  setStatus("Mark btn not found", "#facc15");
}

// 3A. UNGRADED LAB PAGE (Launch -> Exit -> Leave -> Mark as completed -> Verify green tick -> Sidebar Next)
function handleUngradedLabPage() {
  const labKey = window.location.pathname;
  const elapsed = Date.now() - pageEnteredAt;

  const exitLabBtn = findButtonByText(["exit lab"], document, { partial: true });
  if (exitLabBtn) {
    actionLock = true;
    setStatus("Lab open (4.5s)...", "#c084fc");
    setTimeout(() => {
      setStatus("Exiting Lab...", "#c084fc");
      exitLabBtn.click();
      setTimeout(() => {
        actionLock = false;
      }, 1500);
    }, randMs(3800, 5000));
    return;
  }

  const markBtn = findButtonByText(["mark as completed", "mark complete"], document, { partial: true });
  if (markBtn) {
    actionLock = true;
    setStatus("Lab: Marking done...", "#86efac");
    markBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      markBtn.click();
      labCompletedUrls.add(labKey);
      setTimeout(() => {
        actionLock = false;
      }, 2200);
    }, 600);
    return;
  }

  if (elapsed < 2500) {
    setStatus("Lab loading...", "#9ca3af");
    return;
  }

  const main = document.querySelector("main") || document.body;
  const headerText = normalizeText((main.innerText || "").slice(0, 600));
  const isCompleted =
    isCurrentSidebarItemGreenTicked() ||
    (headerText.includes("resume lab") && headerText.includes("completed") && !headerText.includes("mark as completed"));

  if (isCompleted) {
    goToNextItem(randMs(2200, 3200), "Lab ✓ -> Next");
    return;
  }

  const agreeBox = main.querySelector('input[type="checkbox"]:not(:checked)');
  if (agreeBox) {
    const lbl = agreeBox.closest("label");
    if (lbl && isVisible(lbl)) lbl.click();
    else if (isVisible(agreeBox)) agreeBox.click();
  }

  const launchBtn = findButtonByText(["launch lab", "resume lab", "open tool", "launch app", "open lab"]);
  if (launchBtn) {
    actionLock = true;
    setStatus("Launching Lab...", "#c084fc");

    try {
      chrome.runtime.sendMessage({ type: "ARM_LAB_TAB_CLOSE", delayMs: 8000 });
    } catch {
      // ignore
    }

    launchBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    launchBtn.click();

    setTimeout(() => {
      actionLock = false;
    }, 3500);
    return;
  }

  setStatus("Lab waiting...", "#facc15");
}

let labAiLastErrorSignature = {};
let labAiLastRunAt = 0;
let labGradesCheckedForPath = new Set();

function getLabErrorSignature(text) {
  const norm = normalizeText(text || "");
  if (norm.includes("loading...") || norm.includes("lab files")) return "";
  const errIdx = norm.indexOf("error:");
  if (errIdx !== -1) return norm.slice(errIdx, errIdx + 220);
  const compIdx = norm.indexOf("compilation errors");
  if (compIdx !== -1) return norm.slice(compIdx, compIdx + 220);
  const gradeIdx = norm.indexOf("grade received:");
  if (gradeIdx !== -1) return norm.slice(gradeIdx, gradeIdx + 120);
  return "instructions_done";
}

async function solveGradedLabWithAI() {
  if (quizSolvingInProgress) return;
  if (Date.now() - labAiLastRunAt < 15000) return;
  quizSolvingInProgress = true;
  labAiLastRunAt = Date.now();

  try {
    setStatus("AI fixing Lab error...", "#60a5fa");
    setOutput("Lab instructions aur compile errors padh kar Gemini se exact root-cause fix bana raha hoon...");

    const rightPaneText = (getMainContentText() || document.body.innerText || "").slice(0, 14000);
    const sig = getLabErrorSignature(rightPaneText) || "default";
    labAiLastErrorSignature[window.location.pathname] = sig;

    const prompt = `You are a senior Java/Linux engineer fixing a Coursera Graded Programming Lab inside a Linux container (/home/coder/...).

Read the visible Lab Instructions / Grades / Compilation Errors below:
${rightPaneText}

Return ONLY valid JSON:
{
  "summary": "Short 2-line Hinglish explanation of the root cause and fix",
  "bash_command": "Single self-contained bash one-liner that fixes the root cause in /home/coder/... so the autograder passes 100%."
}

Strict Rules:
- Always dynamically locate the starter folder (e.g. STARTER=$(find /home/coder -maxdepth 4 -type d -name '*STARTER*' | head -n 1)) and Solution folder if present (SOL=$(find /home/coder -maxdepth 4 -type d -name 'Solution' | head -n 1)).
- If a Solution folder exists, force-overwrite (cp -rvf) its src files into "$STARTER/src/" WITHOUT deleting required starter files like Main.java.
- If the error says 'file not found: Main.java', recreate "$STARTER/src/Main.java" with a valid public class Main { public static void main(String[] args) {} }.
- End the command with 'ls -la "$STARTER/src/"' so the user immediately sees all files in place.
- Keep bash_command clean, single-line, and directly pasteable into noVNC Terminal. No markdown fences outside JSON.`;

    const apiRes = await callGeminiWithFallback(prompt, true);
    if (!apiRes.ok) {
      setStatus("Lab AI Error", "#f87171");
      setOutput(`Gemini Error:\n${apiRes.error}`);
      return;
    }

    const stripped = apiRes.rawText.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const jsonMatch = stripped.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : stripped);
    const cmd = (parsed.bash_command || "").trim();
    const summary = (parsed.summary || "AI ne lab fix ready kar diya hai.").trim();

    let copied = false;
    if (cmd && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(cmd);
        copied = true;
      } catch {
        // clipboard may require user focus
      }
    }

    setStatus(copied ? "Fix copied ✓ Paste in Terminal" : "Lab Fix Ready ✓", "#86efac");
    setOutput(
      `${summary}\n${copied ? "✓ Command clipboard mein copy ho gaya hai! Left desktop -> Applications -> Terminal Emulator mein paste karke Enter dabao, phir 'Submit assignment' click karo." : "Niche wala command copy karke noVNC Terminal mein run karo, phir 'Submit assignment' dabao:"}\n\n${cmd}`
    );
  } catch (err) {
    setStatus("Lab AI Error", "#f87171");
    setOutput(`Error: ${err.message}`);
  } finally {
    setTimeout(() => {
      quizSolvingInProgress = false;
    }, 2000);
  }
}

// 3B. GRADED PROGRAMMING LAB (/programming/)
// Automates the full DOM side: Launch lab -> Step through all right-side Instructions (Mark as completed -> Go to next instruction)
// -> Calls Gemini AI to generate & auto-copy a ready-to-paste Terminal fix -> Auto-checks Honor Code & View Grades when submitted -> Exits once grade >= 80%!
function handleGradedLabPage() {
  const path = window.location.pathname.toLowerCase();
  const elapsed = Date.now() - pageEnteredAt;

  // 1. If already green-ticked on cover page, advance to Next
  if (!path.includes("/lab") && isCurrentSidebarItemGreenTicked()) {
    goToNextItem(randMs(2500, 3500), "Graded Lab ✓ -> Next");
    return;
  }

  // 2. Inside the launched Graded Lab workspace (/programming/.../lab)
  if (path.includes("/lab")) {
    const pageText = normalizeText((document.body.innerText || "").slice(0, 8000));

    // If still booting up container ("Preparing your lab..." / "Connecting...")
    if (pageText.includes("preparing your lab") || pageText.includes("connecting...")) {
      setStatus("Lab starting...", "#9ca3af");
      return;
    }

    // If grading is currently in progress
    if (pageText.includes("grading your submission") || pageText.includes("grading in progress")) {
      setStatus("Grading submission...", "#60a5fa");
      return;
    }

    // Check if Grades panel shows a passing grade >= 80%
    const gradeRecMatch = pageText.match(/grade\s+received:\s*(\d{1,3}(?:\.\d+)?)\s*%/i);
    if (gradeRecMatch) {
      const pct = parseFloat(gradeRecMatch[1]);
      if (pct >= MIN_PASS_PERCENT) {
        const exitBtn = findButtonByText(["exit lab"], document, { partial: true });
        if (exitBtn) {
          actionLock = true;
          setStatus(`Lab Passed (${pct}%) -> Exit`, "#86efac");
          setTimeout(() => {
            exitBtn.click();
            setTimeout(() => {
              const leaveBtn = findButtonByText(["leave lab"], document);
              if (leaveBtn) leaveBtn.click();
              actionLock = false;
            }, 1500);
          }, 1200);
          return;
        }
      } else {
        const sig = getLabErrorSignature(getMainContentText() || pageText);
        if (sig && labAiLastErrorSignature[window.location.pathname] !== sig) {
          solveGradedLabWithAI();
          return;
        }
        setStatus(`Lab Grade: ${pct}% (paste fix)`, "#f87171");
        return;
      }
    }

    // Step through right-side Instructions: scroll down -> Mark as completed -> Go to next instruction
    const markBtn = findButtonByText(["mark as completed", "mark complete"], document, { partial: true });
    if (markBtn) {
      actionLock = true;
      setStatus("Lab step: Marking...", "#86efac");
      markBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        markBtn.click();
        setTimeout(() => {
          actionLock = false;
        }, 1600);
      }, randMs(900, 1400));
      return;
    }

    const nextInstrBtn = findButtonByText(["go to next instruction", "next instruction"], document, { partial: true });
    if (nextInstrBtn) {
      actionLock = true;
      setStatus("Lab -> Next instruction", "#60a5fa");
      nextInstrBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        nextInstrBtn.click();
        setTimeout(() => {
          actionLock = false;
        }, 1600);
      }, randMs(1000, 1600));
      return;
    }

    // Scroll the right-side Instructions container down to reveal "Mark as completed" if not yet visible
    const scrollables = Array.from(document.querySelectorAll("div, section, article")).filter((el) => {
      if (el.closest("#cs-helper-panel")) return false;
      const rect = el.getBoundingClientRect();
      if (rect.left < window.innerWidth * 0.45 || rect.height < 200) return false;
      if (el.scrollHeight <= el.clientHeight + 40) return false;
      const oy = window.getComputedStyle(el).overflowY;
      return oy === "auto" || oy === "scroll" || oy === "overlay";
    });
    for (const sc of scrollables) {
      if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 20) {
        sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
        setStatus("Scrolling lab instructions...", "#9ca3af");
        return;
      }
    }

    // All right-side instructions done! First click the "Grades" button once to verify if we already passed (>= 80%)!
    const isGradesPanelOpen =
      pageText.includes("grade received:") ||
      pageText.includes("submit your assignment to receive a grade") ||
      pageText.includes("submissions");

    if (!isGradesPanelOpen && !labGradesCheckedForPath.has(window.location.pathname)) {
      const gradesBtn = findButtonByText(["grades"], document);
      if (gradesBtn) {
        labGradesCheckedForPath.add(window.location.pathname);
        actionLock = true;
        setStatus("Checking Lab Grades...", "#60a5fa");
        gradesBtn.click();
        setTimeout(() => {
          actionLock = false;
        }, 2500);
        return;
      }
    }

    // Don't re-trigger AI while user is browsing Lab Files
    if (pageText.includes("lab files") && pageText.includes("download all files")) {
      setStatus("Lab Files open...", "#9ca3af");
      return;
    }

    // Not passed yet — automatically ask Gemini AI once, then in unattended Auto mode Exit & skip to keep finishing the course!
    const sig = getLabErrorSignature(getMainContentText() || pageText);
    if (sig && labAiLastErrorSignature[window.location.pathname] !== sig) {
      solveGradedLabWithAI();
      return;
    }

    if (elapsed > 25000) {
      const baseP = getCurrentBasePath();
      const baseId = extractCourseraItemId(baseP) || baseP;
      sidebarSkippedUrls.add(baseP);
      sidebarSkippedUrls.add(baseId);
      const exitBtn = findButtonByText(["exit lab"], document, { partial: true });
      if (exitBtn) {
        actionLock = true;
        setStatus("IDE Lab -> Skipping to Next", "#facc15");
        exitBtn.click();
        setTimeout(() => {
          const leaveBtn = findButtonByText(["leave lab"], document);
          if (leaveBtn) leaveBtn.click();
          setTimeout(() => {
            actionLock = false;
            goToNextItem(2000, "Skipping IDE Lab -> Next");
          }, 1800);
        }, 1200);
        return;
      }
    }

    setStatus("IDE Lab (auto-skip soon)...", "#facc15");
    return;
  }

  // 3. On Graded Lab cover page (/programming/... without /lab):
  if (elapsed < 2200) {
    setStatus("Lab loading...", "#9ca3af");
    return;
  }

  const baseP = getCurrentBasePath();
  const baseId = extractCourseraItemId(baseP) || baseP;
  // If we already tried/skipped this Graded IDE Lab, move straight to the next item so Auto never loops!
  if (sidebarSkippedUrls.has(baseP) || sidebarSkippedUrls.has(baseId)) {
    goToNextItem(randMs(2500, 3500), "IDE Lab skipped -> Next");
    return;
  }

  const launchBtn = findButtonByText(["launch lab", "resume lab", "open lab"], document);
  if (launchBtn) {
    actionLock = true;
    setStatus("Launching Graded Lab...", "#c084fc");
    launchBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      launchBtn.click();
      setTimeout(() => {
        actionLock = false;
      }, 3500);
    }, randMs(1200, 2000));
    return;
  }

  setStatus("Graded Lab waiting...", "#facc15");
}

// 4. UNGRADED PLUGIN / LTI PAGE
function handlePluginPage() {
  const elapsed = Date.now() - pageEnteredAt;
  scrollReadingStep(1.0);

  const main = document.querySelector("main") || document.body;
  const agreeBox = main.querySelector('input[type="checkbox"]:not(:checked)');
  if (agreeBox) {
    const lbl = agreeBox.closest("label");
    if (lbl && isVisible(lbl)) lbl.click();
    else if (isVisible(agreeBox)) agreeBox.click();
  }

  const markBtn = findButtonByText(["mark as completed", "mark complete"], document, { partial: true });
  if (markBtn) {
    actionLock = true;
    setStatus("Plugin: Marking...", "#86efac");
    markBtn.click();
    setTimeout(() => {
      actionLock = false;
      goToNextItem(randMs(2200, 3200), "Plugin ✓ -> Next");
    }, 2000);
    return;
  }

  if (isCurrentSidebarItemGreenTicked()) {
    goToNextItem(randMs(2000, 3000), "Plugin ✓ -> Next");
    return;
  }

  if (elapsed < 5000) {
    setStatus("Plugin loading...", "#9ca3af");
    return;
  }

  goToNextItem(2500, "Plugin -> Next");
}

// 5. QUIZ / ASSIGNMENT PAGE (Timed Graded Quiz + Dynamic Pass% Check + /view-feedback + Smart Retry)
function getRequiredPassPercent(text) {
  const m = (text || "").match(
    /(?:to pass[^.\n]*?|at least|minimum(?:\s+grade)?|required(?:\s+grade)?|passing\s+grade[^.\n]*?)(\d{1,3}(?:\.\d+)?)\s*%/i
  );
  if (m) {
    const val = parseFloat(m[1]);
    if (val >= 50 && val <= 100) return val;
  }
  return MIN_PASS_PERCENT;
}

function stripPassThresholdText(text) {
  // Remove threshold phrases like "To pass you need a grade of at least 80%." so we never mistake 80% for the user's score!
  return (text || "").replace(
    /(?:to pass[^.\n]*?|at least|minimum(?:\s+grade)?|required(?:\s+grade)?|passing\s+grade[^.\n]*?)\d{1,3}(?:\.\d+)?\s*%/gi,
    " "
  );
}

function extractScorePercent(text) {
  const cleaned = stripPassThresholdText(text);
  const matches = Array.from(cleaned.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g));
  if (!matches.length) return null;
  for (const m of matches) {
    const val = parseFloat(m[1]);
    if (val >= 0 && val <= 100) return val;
  }
  return null;
}

function isQuizFailedText(normText) {
  return /(?:you\s+didn.?t\s+pass|you\s+did\s+not\s+pass|did\s+not\s+pass|didn.?t\s+pass|try\s+again\s+to\s+pass)/i.test(
    normText || ""
  );
}

// ---------------- Smart Quiz Feedback Memory & Clean Math/LaTeX Extractor ----------------
let quizFeedbackScrapedUrls = new Set();

function loadQuizMemory() {
  try {
    return JSON.parse(sessionStorage.getItem("cs_quiz_memory_v1") || "{}");
  } catch {
    return {};
  }
}

function saveQuizMemory(mem) {
  try {
    sessionStorage.setItem("cs_quiz_memory_v1", JSON.stringify(mem));
  } catch {
    // ignore storage quota errors
  }
}

function getQuizMemoryFor(baseQuizKey) {
  const all = loadQuizMemory();
  if (!all[baseQuizKey]) {
    all[baseQuizKey] = { correct: {}, wrong: {}, partial: {} };
  }
  if (!all[baseQuizKey].partial) all[baseQuizKey].partial = {};
  return { all, entry: all[baseQuizKey] };
}

// Converts KaTeX / MathJax rendered nodes into clean LaTeX so Gemini reads equations/matrices accurately!
function extractCleanTextWithMath(el) {
  if (!el) return "";
  try {
    const clone = el.cloneNode(true);
    // Replace KaTeX blocks with their exact TeX annotation
    clone.querySelectorAll(".katex").forEach((k) => {
      const ann = k.querySelector('annotation[encoding="application/x-tex"]');
      if (ann && ann.textContent) {
        k.replaceWith(document.createTextNode(` ${ann.textContent.trim()} `));
      }
    });
    // Remove hidden assistive MathML duplicates that scramble innerText
    clone.querySelectorAll(".katex-mathml, mjx-assistive-mml").forEach((m) => m.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  } catch {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
}

function getQuestionFingerprint(promptText, options = []) {
  const cleanPrompt = normalizeText(promptText || "")
    .replace(/\b\d+\s*\/\s*\d+\s*point[s]?\b/g, "")
    .replace(/\b\d+\s*point[s]?\b/g, "")
    .slice(0, 140);
  const optSig = options.map((o) => normalizeText(o).slice(0, 30)).sort().join("|").slice(0, 120);
  return `${cleanPrompt}::${optSig}`;
}

function scrapeQuizFeedback(baseQuizKey) {
  const { all, entry } = getQuizMemoryFor(baseQuizKey);
  const containers = Array.from(
    document.querySelectorAll('[data-testid^="part-Submission_"], .rc-FormPartsQuestion, [role="radiogroup"], [role="group"]')
  ).filter((el) => {
    if (el.closest("#cs-helper-panel, nav, aside")) return false;
    if (!isVisible(el)) return false;
    return el.querySelectorAll('input[type="radio"], input[type="checkbox"]').length >= 2;
  });
  const topContainers = containers.filter((el) => !containers.some((o) => o !== el && o.contains(el)));

  let savedCorrect = 0;
  let savedWrong = 0;
  let savedPartial = 0;

  for (const container of topContainers) {
    let qRoot = container;
    for (let up = 0; up < 4 && qRoot.parentElement; up++) {
      const p = qRoot.parentElement;
      const pInputs = p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
      const cInputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
      if (pInputs === cInputs && !p.closest("#cs-helper-panel")) {
        qRoot = p;
      } else {
        break;
      }
    }

    const labels = Array.from(container.querySelectorAll("label")).filter((l) => isVisible(l));
    const options = labels.map((l) => (l.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    if (options.length < 2) continue;

    const selectedOpts = [];
    for (const lbl of labels) {
      const inp =
        lbl.querySelector('input[type="radio"], input[type="checkbox"]') ||
        (lbl.htmlFor ? document.getElementById(lbl.htmlFor) : null);
      if (inp && inp.checked) {
        const txt = (lbl.innerText || "").replace(/\s+/g, " ").trim();
        if (txt) selectedOpts.push(txt);
      }
    }
    if (!selectedOpts.length) continue;

    const qText = normalizeText(qRoot.innerText || "");
    const qKey = getQuestionFingerprint(extractCleanTextWithMath(qRoot), options);

    // Parse exact earned/total points (e.g. "0.5 / 1 point" vs "1 / 1 point" vs "0 / 1 point")
    const ptsMatch = qText.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*point/);
    const earnedPts = ptsMatch ? parseFloat(ptsMatch[1]) : null;
    const totalPts = ptsMatch ? parseFloat(ptsMatch[2]) : null;
    const hasFullPoints = earnedPts !== null && totalPts !== null && totalPts > 0 && earnedPts >= totalPts;
    const hasPartialPoints = earnedPts !== null && totalPts !== null && earnedPts > 0 && earnedPts < totalPts;
    const hasZeroPoints = earnedPts !== null && earnedPts === 0;

    const missedSomeAnswers =
      hasPartialPoints ||
      /didn.?t\s+select\s+all|did\s+not\s+select\s+all|not\s+all\s+correct|partially\s+correct/.test(qText);

    const isIncorrect =
      !missedSomeAnswers &&
      (hasZeroPoints ||
        qText.includes("incorrect") ||
        qText.includes("not quite") ||
        qText.includes("wrong"));

    const isFullCorrect =
      !missedSomeAnswers &&
      !isIncorrect &&
      (hasFullPoints || /\bcorrect\b/.test(qText) || qText.includes("nice work"));

    if (isFullCorrect) {
      entry.correct[qKey] = selectedOpts;
      delete entry.partial[qKey];
      savedCorrect++;
    } else if (missedSomeAnswers) {
      // Partial credit on multi-select checkbox: NEVER lock as complete! Keep good picks & tell AI to add missing true options
      delete entry.correct[qKey];
      entry.partial[qKey] = selectedOpts;
      savedPartial++;
    } else if (isIncorrect) {
      delete entry.correct[qKey];
      if (!Array.isArray(entry.wrong[qKey])) entry.wrong[qKey] = [];
      for (const opt of selectedOpts) {
        if (!entry.wrong[qKey].some((w) => normalizeText(w) === normalizeText(opt))) {
          entry.wrong[qKey].push(opt);
        }
      }
      savedWrong++;
    }
  }

  saveQuizMemory(all);
  quizFeedbackScrapedUrls.add(baseQuizKey);
  if (savedCorrect || savedWrong || savedPartial) {
    setOutput(
      `Feedback saved ✓\nFull correct locked: ${savedCorrect}\nPartial (need more ticks): ${savedPartial}\nWrong banned: ${savedWrong}`
    );
  }
  return { savedCorrect, savedWrong, savedPartial };
}

function handleQuizPage() {
  const path = window.location.pathname.toLowerCase();
  const main = document.querySelector("main") || document.body;
  const baseQuizKey = path.replace(/\/(attempt|view-submission|view-feedback).*$/i, "");
  const elapsed = Date.now() - pageEnteredAt;

  if (quizFailedUrls.has(baseQuizKey)) {
    // NEVER freeze the whole course forever on a failed quiz — skip cleanly and keep finishing remaining items!
    const qId = extractCourseraItemId(baseQuizKey) || baseQuizKey;
    sidebarSkippedUrls.add(baseQuizKey);
    sidebarSkippedUrls.add(qId);
    if (path.includes("/attempt") || path.includes("/view-feedback") || path.includes("/view-submission")) {
      const backBtn = findButtonByText(["back"], document, { partial: true });
      if (backBtn) {
        actionLock = true;
        setStatus("Quiz skipped -> Back", "#facc15");
        setTimeout(() => {
          backBtn.click();
          setTimeout(() => {
            actionLock = false;
          }, 2500);
        }, 1200);
        return;
      }
    }
    goToNextItem(randMs(2500, 3500), "Quiz skipped -> Next");
    return;
  }

  if (elapsed < 2200) {
    setStatus("Quiz loading...", "#9ca3af");
    return;
  }

  // Case 1: Post-submit graded view (/view-feedback or /view-submission)
  if (path.includes("/view-feedback") || path.includes("/view-submission")) {
    const pageText = (document.body.innerText || "").slice(0, 2500);
    const norm = normalizeText(pageText);
    const failedByText = isQuizFailedText(norm);
    const requiredPass = getRequiredPassPercent(pageText);
    const score = extractScorePercent(pageText);
    const passed =
      !failedByText &&
      (norm.includes("you passed") ||
        norm.includes("passed!") ||
        norm.includes("congratulations") ||
        (score !== null && score >= requiredPass));

    if (failedByText || (score !== null && score < requiredPass)) {
      // ALWAYS scrape which questions were right vs wrong from this feedback page BEFORE clicking Try again!
      scrapeQuizFeedback(baseQuizKey);

      const retries = quizRetryCounts[baseQuizKey] || 0;
      const retryBtn = findButtonByText(["try again", "retake", "resume"], document);
      if (retries < MAX_QUIZ_RETRIES && retryBtn) {
        quizRetryCounts[baseQuizKey] = retries + 1;
        quizSubmittedUrls.delete(baseQuizKey);
        quizTickedUrls.delete(baseQuizKey);
        actionLock = true;
        setStatus(`Score ${score !== null ? score + "%" : "<80%"} -> Smart Retry`, "#facc15");
        setTimeout(() => {
          retryBtn.click();
          setTimeout(() => {
            actionLock = false;
          }, 3000);
        }, 1200);
        return;
      }
      if (retries < MAX_QUIZ_RETRIES && !retryBtn) {
        const backBtn = findButtonByText(["back"], document, { partial: true });
        if (backBtn) {
          actionLock = true;
          setStatus("Failed -> Back to retry", "#facc15");
          setTimeout(() => {
            backBtn.click();
            setTimeout(() => {
              actionLock = false;
            }, 2500);
          }, 1200);
          return;
        }
      }
      quizFailedUrls.add(baseQuizKey);
      setStatus(`Score ${score !== null ? score + "%" : "failed"} (check)`, "#f87171");
      setOutput(`Quiz score ${score !== null ? score + "%" : "< " + MIN_PASS_PERCENT + "%"} after ${retries} retries.`);
      return;
    }

    if (passed) {
      setStatus(`Passed (${score !== null ? score + "%" : "OK"})`, "#86efac");
      const nextBtn = findButtonByText(["go to next item", "next item"], document);
      if (nextBtn) {
        goToNextItem(randMs(2500, 3500), "Quiz Passed -> Next");
      } else {
        const backBtn = findButtonByText(["back"], document, { partial: true });
        if (backBtn) {
          actionLock = true;
          setStatus("Back to course...", "#86efac");
          setTimeout(() => {
            backBtn.click();
            setTimeout(() => {
              actionLock = false;
            }, 2500);
          }, 1500);
        }
      }
      return;
    }

    if (norm.includes("nice work") && !norm.includes("incorrect")) {
      const backBtn = findButtonByText(["back"], document, { partial: true });
      if (backBtn) {
        actionLock = true;
        setStatus("Quiz OK -> Back", "#86efac");
        setTimeout(() => {
          backBtn.click();
          setTimeout(() => {
            actionLock = false;
          }, 2500);
        }, 1500);
        return;
      }
    }

    setStatus("Checking score...", "#60a5fa");
    return;
  }

  // Case 2: Active attempt page (/attempt)
  // Strictly count ONLY VISIBLE, enabled quiz radio/checkbox inputs outside sidebar/panel — NEVER trigger on Quiz Cover Page!
  const hasCoverActionBtn = Boolean(
    findButtonByText(["start assignment", "resume assignment", "try again", "retake"], document)
  );
  const enabledQuizInputsCount = Array.from(
    document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  ).filter((el) => {
    if (el.disabled) return false;
    if (el.closest("#cs-helper-panel, nav, aside, [role='navigation'], header")) return false;
    const lbl = el.closest("label") || el.parentElement;
    return isVisible(el) || isVisible(lbl);
  }).length;
  const isAttemptPage = path.includes("/attempt") || (!hasCoverActionBtn && enabledQuizInputsCount >= 2);

  if (isAttemptPage) {
    if (quizSubmittedUrls.has(baseQuizKey)) {
      setStatus("Waiting result...", "#60a5fa");
      return;
    }

    // Wait for Coursera React quiz questions/options to actually finish rendering before calling Gemini!
    if (enabledQuizInputsCount < 2) {
      setStatus("Waiting questions...", "#9ca3af");
      return;
    }

    // Respect temporary API cooldown (e.g. 503 high demand) instead of permanently pausing!
    const coolUntil = quizCooldownUntil[baseQuizKey] || 0;
    if (Date.now() < coolUntil) {
      const secsLeft = Math.ceil((coolUntil - Date.now()) / 1000);
      setStatus(`API retry in ${secsLeft}s...`, "#facc15");
      return;
    }

    if (quizTickedUrls.has(baseQuizKey)) {
      quizSolvingInProgress = true;
      checkHonorCodeAndSubmit(baseQuizKey).finally(() => {
        setTimeout(() => {
          quizSolvingInProgress = false;
        }, 3000);
      });
      return;
    }

    const retryCount = quizRetryCounts[baseQuizKey] || 0;
    solveQuiz({
      autoSubmit: true,
      baseQuizKey,
      useStrongModel: retryCount > 0
    });
    return;
  }

  // Case 3: Quiz Cover Page (NOT /attempt, NOT /view-feedback, NOT /view-submission)
  const hasStartOrResumeBtn = Boolean(
    findButtonByText(["start assignment", "resume assignment", "start"], document)
  );
  const tryAgainBtn = findButtonByText(["try again", "retake"], document);

  // Read ONLY the right-side main quiz content (never contaminated by sidebar's other grades!)
  const rawCoverText = getMainContentText();
  const normTop = normalizeText(rawCoverText);
  const failedByText = isQuizFailedText(normTop);
  const requiredPass = getRequiredPassPercent(rawCoverText);
  const cleanedCover = stripPassThresholdText(rawCoverText);
  const gradeMatch = cleanedCover.match(/(?:your grade|highest grade|grade received|receive grade|passed)[^\n%]{0,60}(\d{1,3}(?:\.\d+)?)\s*%/i);
  const score = gradeMatch ? parseFloat(gradeMatch[1]) : extractScorePercent(rawCoverText);
  const passedByText = !failedByText && (normTop.includes("you passed") || normTop.includes("passed!"));
  const passedByScore = !failedByText && score !== null && score >= requiredPass;
  const isSidebarTicked = isCurrentSidebarItemGreenTicked();

  // 1. ALWAYS catch failed/unticked quizzes with Try again FIRST — NEVER move to Next!
  const needsRetry =
    failedByText ||
    (score !== null && score < requiredPass) ||
    (Boolean(tryAgainBtn) && !passedByText && !passedByScore && !isSidebarTicked);

  if (needsRetry) {
    const retries = quizRetryCounts[baseQuizKey] || 0;
    // Before retrying, click "View feedback" once so we learn which exact questions were right vs wrong!
    const viewFeedbackBtn = findButtonByText(["view feedback"], document);
    if (retries < MAX_QUIZ_RETRIES && viewFeedbackBtn && !quizFeedbackScrapedUrls.has(baseQuizKey)) {
      actionLock = true;
      setStatus("Reviewing mistakes first...", "#60a5fa");
      viewFeedbackBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        viewFeedbackBtn.click();
        setTimeout(() => {
          actionLock = false;
        }, 2800);
      }, 900);
      return;
    }

    const retryBtn =
      tryAgainBtn ||
      findButtonByText(["resume assignment", "start assignment"], document);
    if (retries < MAX_QUIZ_RETRIES && retryBtn) {
      quizRetryCounts[baseQuizKey] = retries + 1;
      quizSubmittedUrls.delete(baseQuizKey);
      quizTickedUrls.delete(baseQuizKey);
      quizFeedbackScrapedUrls.delete(baseQuizKey);
      actionLock = true;
      setStatus(`Failed (${score !== null ? score + "%" : "<80%"}) -> Smart Retry`, "#facc15");
      retryBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        retryBtn.focus();
        retryBtn.click();
        setTimeout(() => {
          actionLock = false;
        }, 3000);
      }, 700);
      return;
    }
    quizFailedUrls.add(baseQuizKey);
    setStatus(`Score ${score !== null ? score + "%" : "failed"} (check)`, "#f87171");
    setOutput(`Quiz score ${score !== null ? score + "%" : "< " + MIN_PASS_PERCENT + "%"} after ${retries} retries.`);
    return;
  }

  // 2. Advance ONLY when genuinely passed or green-ticked (and definitely NOT failed)!
  if (!failedByText && !hasStartOrResumeBtn && (passedByText || passedByScore || isSidebarTicked)) {
    setStatus(`Passed (${score !== null ? score + "%" : "OK"})`, "#86efac");
    goToNextItem(randMs(2200, 3200), "Quiz Passed -> Next");
    return;
  }

  // 3. If just submitted and waiting for grade/green-tick to appear, wait instead of skipping!
  if (quizSubmittedUrls.has(baseQuizKey)) {
    setStatus("Waiting grade/tick...", "#60a5fa");
    return;
  }

  const startBtn = findButtonByText(
    ["resume assignment", "start assignment", "start", "try again", "retake", "continue"],
    document
  );
  if (startBtn) {
    actionLock = true;
    setStatus("Opening Quiz...", "#60a5fa");
    startBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      startBtn.click();
      setTimeout(() => {
        actionLock = false;
      }, 3000);
    }, 800);
    return;
  }

  setStatus("Quiz: waiting...", "#facc15");
}

// 6. OPTIONAL (Discussions, Dialogue/Coach) & FALLBACK
function handleOptionalOrFallbackPage() {
  const elapsed = Date.now() - pageEnteredAt;
  scrollReadingStep(1.0);

  const markBtn = findButtonByText(["mark as completed", "mark complete"], document, { partial: true });
  if (markBtn) {
    markBtn.click();
    goToNextItem(randMs(2500, 3500), "Marked -> Next");
    return;
  }

  if (elapsed < 4500) {
    setStatus("Loading item...", "#9ca3af");
    return;
  }

  goToNextItem(2500, "Moving Next...");
}

// ---------------- Structured Quiz Extraction (Per-Question) ----------------
function extractQuestionBlocks() {
  const root = document.body;

  let containers = Array.from(
    root.querySelectorAll(
      '[data-testid^="part-Submission_"], .rc-FormPartsQuestion, [role="radiogroup"], [role="group"]'
    )
  ).filter((el) => {
    if (el.closest("#cs-helper-panel, nav, aside, [role='navigation']")) return false;
    if (!isVisible(el)) return false;
    const inputs = el.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    return inputs.length >= 2;
  });

  containers = containers.filter(
    (el) => !containers.some((other) => other !== el && other.contains(el))
  );

  const blocks = containers.map((container, index) => {
    let promptRoot = container;
    if (
      container.getAttribute("role") === "radiogroup" ||
      container.getAttribute("role") === "group"
    ) {
      if (container.parentElement && container.parentElement.innerText.length > container.innerText.length) {
        promptRoot = container.parentElement;
      }
      if (
        promptRoot.parentElement &&
        promptRoot.parentElement.querySelectorAll('input[type="radio"], input[type="checkbox"]').length ===
          container.querySelectorAll('input[type="radio"], input[type="checkbox"]').length
      ) {
        promptRoot = promptRoot.parentElement;
      }
    }

    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => !l.closest("#cs-helper-panel") && isVisible(l) && (l.innerText || "").trim().length > 0
    );

    const options = labels.map((l) => (l.innerText || "").replace(/\s+/g, " ").trim());
    const cleanOptions = labels.map((l) => extractCleanTextWithMath(l));
    const fullText = extractCleanTextWithMath(promptRoot);
    const isMultiSelect = container.querySelectorAll('input[type="checkbox"]').length >= 2;

    return {
      q: index + 1,
      container,
      labels,
      options,
      cleanOptions,
      fullText,
      isMultiSelect,
      qKey: getQuestionFingerprint(fullText, options)
    };
  });

  return blocks.filter((b) => b.options.length >= 2);
}

async function tickQuestionAnswers(blocks, results) {
  // Only consider labels that are actually tied to a radio or checkbox input (never click random page labels!)
  const globalLabels = Array.from(document.querySelectorAll("label")).filter((l) => {
    if (l.closest("#cs-helper-panel, nav, aside, [role='navigation'], header")) return false;
    if (!isVisible(l) || !(l.innerText || "").trim()) return false;
    const innerInput = l.querySelector('input[type="radio"], input[type="checkbox"]');
    if (innerInput) return true;
    if (l.htmlFor) {
      const target = document.getElementById(l.htmlFor);
      if (target && (target.type === "radio" || target.type === "checkbox")) return true;
    }
    return false;
  });

  let tickedCount = 0;
  let totalExpected = 0;
  const matchedLogs = [];
  const missedLogs = [];

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const answers = (Array.isArray(item.answers) ? item.answers : [item.answers]).filter(Boolean);
    const qNum = typeof item.q === "number" ? item.q : i + 1;
    const block = blocks.find((b) => b.q === qNum) || blocks[i] || null;
    const searchLabels = block ? block.labels : globalLabels;

    // On resumed multi-select checkbox questions, uncheck any stale checked box that is NOT in the new answers!
    if (block && block.isMultiSelect) {
      const normalizedNewAns = answers.map((a) => normalizeText(a));
      for (const lbl of block.labels) {
        const inp =
          lbl.querySelector('input[type="checkbox"]') ||
          (lbl.htmlFor ? document.getElementById(lbl.htmlFor) : null);
        if (inp && inp.checked) {
          const lt = normalizeText(lbl.innerText);
          const mt = normalizeText(extractCleanTextWithMath(lbl));
          const shouldStayChecked = normalizedNewAns.some(
            (t) =>
              lt === t ||
              mt === t ||
              (t.length >= 3 && (lt.includes(t) || t.includes(lt) || mt.includes(t) || t.includes(mt)))
          );
          if (!shouldStayChecked) {
            lbl.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(randMs(400, 700));
            lbl.click();
            await sleep(randMs(350, 600));
          }
        }
      }
    }

    for (const rawAns of answers) {
      const ans = String(rawAns).replace(/\s*\[math:.*?\]/gi, "").trim();
      totalExpected++;
      const target = normalizeText(ans);
      const targetLoose = normalizeMathLoose(ans);
      if (!target) continue;

      let matchedLabel = searchLabels.find(
        (l) =>
          normalizeText(l.innerText) === target ||
          normalizeText(extractCleanTextWithMath(l)) === target ||
          (targetLoose.length >= 2 &&
            (normalizeMathLoose(l.innerText) === targetLoose ||
              normalizeMathLoose(extractCleanTextWithMath(l)) === targetLoose))
      );

      if (!matchedLabel && target.length >= 3) {
        matchedLabel = searchLabels.find((l) => {
          const lt = normalizeText(l.innerText);
          const mt = normalizeText(extractCleanTextWithMath(l));
          const ll = normalizeMathLoose(l.innerText);
          const ml = normalizeMathLoose(extractCleanTextWithMath(l));
          return (
            lt.includes(target) ||
            (lt.length >= 3 && target.includes(lt)) ||
            mt.includes(target) ||
            (mt.length >= 3 && target.includes(mt)) ||
            (targetLoose.length >= 3 && (ll.includes(targetLoose) || ml.includes(targetLoose)))
          );
        });
      }

      if (!matchedLabel && block) {
        matchedLabel = globalLabels.find((l) => normalizeText(l.innerText) === target);
      }

      if (matchedLabel) {
        const input =
          matchedLabel.querySelector('input[type="radio"], input[type="checkbox"]') ||
          (matchedLabel.htmlFor ? document.getElementById(matchedLabel.htmlFor) : null);

        setStatus(`Reading Q${qNum}...`, "#60a5fa");
        matchedLabel.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(randMs(1800, 3200));
        if (!input || !input.checked) {
          matchedLabel.click();
        }
        tickedCount++;
        matchedLogs.push(`Q${qNum} ✓ ${ans}`);
        setStatus(`Ticked Q${qNum} ✓`, "#86efac");
        await sleep(randMs(1400, 2400));
      } else {
        missedLogs.push(`Q${qNum} ✗ ${ans}`);
      }
    }
  }

  return { tickedCount, totalExpected, matchedLogs, missedLogs };
}

// ---------------- Honor Code + Submit + "Ready to submit?" Modal Confirmation ----------------
function matchesHonorCodeText(text) {
  const t = normalizeText(text);
  return (
    t.includes("understand and agree") ||
    t.includes("honor code") ||
    t.includes("confirm this work") ||
    t.includes("my own") ||
    /\bi,\s+.+,\s+understand/i.test(t)
  );
}

async function clickReadyToSubmitModal(baseQuizKey) {
  for (let i = 0; i < 12; i++) {
    const modals = getVisibleModals();
    for (let m = modals.length - 1; m >= 0; m--) {
      const modalSubmit = findButtonByText(
        ["submit", "yes, submit", "confirm", "submit assignment"],
        modals[m]
      );
      if (modalSubmit) {
        setStatus("Confirming Submit...", "#86efac");
        await sleep(randMs(700, 1200));
        modalSubmit.click();
        if (baseQuizKey) quizSubmittedUrls.add(baseQuizKey);
        return true;
      }
    }

    const allSubmits = findButtonsByText(["submit", "yes, submit", "confirm"], document);
    if (allSubmits.length >= 2) {
      setStatus("Confirming Submit...", "#86efac");
      await sleep(randMs(700, 1200));
      allSubmits[allSubmits.length - 1].click();
      if (baseQuizKey) quizSubmittedUrls.add(baseQuizKey);
      return true;
    }

    await sleep(400);
  }
  return false;
}

async function checkHonorCodeAndSubmit(baseQuizKey) {
  if (await clickReadyToSubmitModal(baseQuizKey)) {
    return true;
  }

  setStatus("Reviewing answers...", "#60a5fa");
  await sleep(randMs(2400, 3800));
  setStatus("Checking Honor Code...", "#60a5fa");

  const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(
    (cb) => !cb.closest("#cs-helper-panel")
  );

  let honorTicked = false;
  for (const cb of allCheckboxes) {
    const labelEl =
      cb.closest("label") ||
      (cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
    const wrapper = labelEl || cb.closest("div")?.parentElement || cb.parentElement;
    const containerText = wrapper ? wrapper.innerText || wrapper.textContent || "" : "";

    if (matchesHonorCodeText(containerText)) {
      if (!cb.checked) {
        (labelEl || wrapper || cb).scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(randMs(1100, 1800));
        if (labelEl) labelEl.click();
        else cb.click();
        await sleep(600);
        if (!cb.checked) {
          cb.click();
          await sleep(450);
        }
      }
      if (cb.checked) honorTicked = true;
    }
  }

  if (!honorTicked) {
    const candidates = Array.from(document.querySelectorAll('label, [role="checkbox"]')).filter(
      (el) => !el.closest("#cs-helper-panel") && isVisible(el) && matchesHonorCodeText(el.innerText)
    );
    for (const el of candidates) {
      const ariaChecked = el.getAttribute("aria-checked");
      const innerCb = el.querySelector('input[type="checkbox"]');
      if (ariaChecked !== "true" && (!innerCb || !innerCb.checked)) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(randMs(1000, 1600));
        el.click();
        await sleep(600);
      }
    }
  }

  const textInputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(
    (el) => !el.closest("#cs-helper-panel") && isVisible(el)
  );
  for (const inp of textInputs) {
    const around = normalizeText(inp.closest("div")?.parentElement?.innerText || inp.placeholder || "");
    if (
      !inp.value &&
      (around.includes("full name") || around.includes("legal name") || around.includes("honor code"))
    ) {
      const nameMatch = (document.body.innerText || "").match(/I,\s*([^,\n]+),\s*understand/i);
      const nameToFill = nameMatch ? nameMatch[1].trim() : "Nitin Kumar";
      setReactInputValue(inp, nameToFill);
    }
  }

  await sleep(randMs(1800, 3000));

  for (let attempt = 0; attempt < 15; attempt++) {
    const submitBtn = findButtonByText(["submit", "submit assignment"], document);
    if (submitBtn) {
      setStatus("Submitting Quiz...", "#86efac");
      submitBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(randMs(1200, 2000));
      submitBtn.click();

      await sleep(randMs(1200, 2000));
      const confirmed = await clickReadyToSubmitModal(baseQuizKey);
      if (!confirmed && baseQuizKey) {
        quizSubmittedUrls.add(baseQuizKey);
      }
      return true;
    }
    await sleep(400);
  }

  setStatus("Submit disabled/missing", "#facc15");
  return false;
}

// ---------------- Dynamic Fast Model Discovery (same engine as CodeTantra Agent!) ----------------
async function discoverAvailableModels(apiKey) {
  if (cachedWorkingModels && cachedWorkingModels.length > 0) {
    return cachedWorkingModels;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.models)) {
      const eligible = data.models
        .filter((m) => {
          const name = (m.name || "").replace(/^models\//, "");
          const methods = m.supportedGenerationMethods || [];
          if (!methods.includes("generateContent")) return false;
          if (!name.startsWith("gemini-")) return false;
          if (/(image|tts|live|audio|embed|robotics|transcribe|1\.5)/i.test(name)) {
            return false;
          }
          return true;
        })
        .map((m) => (m.name || "").replace(/^models\//, ""));

      if (eligible.length > 0) {
        const scoreModel = (name) => {
          if (name.includes("3.5-flash-lite")) return 1;
          if (name.includes("3.6-flash")) return 2;
          if (name.includes("3.7-flash")) return 3;
          if (name.includes("3.8-flash")) return 4;
          if (name.includes("2.5-flash-lite")) return 5;
          if (name.includes("2.5-flash") && !name.includes("pro")) return 6;
          if (name.includes("flash-latest")) return 7;
          if (name.includes("2.0-flash")) return 8;
          if (name.includes("flash")) return 9;
          return 15;
        };
        eligible.sort((a, b) => scoreModel(a) - scoreModel(b));
        const lastGood = localStorage.getItem("cs_last_working_model");
        const topList = eligible.slice(0, 8);
        if (lastGood && eligible.includes(lastGood)) {
          cachedWorkingModels = [lastGood, ...topList.filter((m) => m !== lastGood)].slice(0, 8);
        } else {
          cachedWorkingModels = topList;
        }
        return cachedWorkingModels;
      }
    }
  } catch {
    // Fall back to static list
  }

  return FALLBACK_GEMINI_MODELS.slice(0, 5);
}

async function fetchWithTimeout(url, options, timeoutMs = 14000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiWithFallback(prompt, useStrongModel = false) {
  const apiKey = getApiKey();
  let models = await discoverAvailableModels(apiKey);
  if (useStrongModel && models.length > 1) {
    // On retry (<80%), prefer a stronger non-lite model first if available
    const strongFirst = [...models].sort((a, b) => (a.includes("lite") ? 1 : 0) - (b.includes("lite") ? 1 : 0));
    models = strongFirst;
  }

  const errorLogs = [];
  let sawRetryable = false;

  for (const model of models) {
    const shortName = model.replace("gemini-", "");
    setStatus(`AI: ${shortName}`, "#60a5fa");

    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json"
            }
          })
        },
        14000
      );

      const data = await res.json().catch(() => ({}));

      if (res.ok && !data.error) {
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (rawText) {
          localStorage.setItem("cs_last_working_model", model);
          if (cachedWorkingModels) {
            cachedWorkingModels = [model, ...cachedWorkingModels.filter((m) => m !== model)];
          }
          return { ok: true, model, rawText };
        }
      }

      const errMsg = data?.error?.message || `HTTP ${res.status}`;
      errorLogs.push(`${model} (${res.status}): ${errMsg.slice(0, 90)}`);

      if (res.status === 400 && /api key not valid/i.test(errMsg)) {
        return { ok: false, error: `API Key invalid hai! 'Key' button dabakar sahi Gemini API Key dalo.\n${errMsg}`, retryable: false };
      }

      if (RETRYABLE_HTTP_CODES.has(res.status)) {
        sawRetryable = true;
        await sleep(350);
        continue;
      }

      return { ok: false, error: errorLogs.join("\n"), retryable: false };
    } catch (err) {
      sawRetryable = true;
      const msg = err.name === "AbortError" ? "Timeout (14s)" : err.message;
      errorLogs.push(`${model}: ${msg}`);
      await sleep(350);
    }
  }

  cachedWorkingModels = null;
  return { ok: false, error: errorLogs.slice(-3).join("\n") || "All Gemini models failed.", retryable: sawRetryable };
}

async function solveQuiz({ autoSubmit = false, baseQuizKey = null, useStrongModel = false } = {}) {
  if (quizSolvingInProgress) return;
  quizSolvingInProgress = true;

  setStatus("Reading Quiz...", "#60a5fa");
  setOutput("Questions padh raha hoon aur Gemini se exact answers nikaal raha hoon...");

  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus("No API Key", "#f87171");
    setOutput("Error: 'Key' button dabakar Gemini API Key set karo.");
    quizSolvingInProgress = false;
    return;
  }

  const blocks = extractQuestionBlocks();
  const mainContent = document.querySelector("main") || document.body;

  const { entry: quizMem } = baseQuizKey ? getQuizMemoryFor(baseQuizKey) : { entry: { correct: {}, wrong: {} } };

  let quizPayloadText = "";
  if (blocks.length > 0) {
    quizPayloadText = blocks
      .map((b) => {
        const locked = quizMem.correct[b.qKey];
        const partial = quizMem.partial?.[b.qKey];
        const banned = quizMem.wrong[b.qKey];
        let hint = b.isMultiSelect
          ? `\n[QUESTION TYPE: MULTIPLE-SELECT CHECKBOXES — TEST EVERY OPTION INDEPENDENTLY AND RETURN ALL TRUE OPTIONS IN "answers" ARRAY!]`
          : `\n[QUESTION TYPE: SINGLE-CHOICE RADIO — RETURN EXACTLY ONE OPTION]`;
        if (locked && locked.length) {
          hint += `\n[CONFIRMED 100% CORRECT FROM PREVIOUS ATTEMPT — MUST PICK EXACTLY THIS]: ${locked.join(" | ")}`;
        }
        if (partial && partial.length) {
          hint += `\n[PARTIAL CREDIT PREVIOUSLY — YOU MISSED AT LEAST ONE TRUE OPTION! KEEP THE TRUE PICK(S) BELOW AND ALSO ADD ALL OTHER TRUE OPTIONS]: ${partial.join(" | ")}`;
        }
        if (banned && banned.length) {
          hint += `\n[CONFIRMED WRONG FROM PREVIOUS ATTEMPT — NEVER PICK THESE AGAIN]: ${banned.join(" | ")}`;
        }
        const optLines = b.options
          .map((o, idx) => {
            const clean = b.cleanOptions?.[idx];
            return clean && clean !== o ? `- ${o}  [Math: ${clean}]` : `- ${o}`;
          })
          .join("\n");
        return `=== Question ${b.q} ===\n${b.fullText}${hint}\nAvailable Options:\n${optLines}`;
      })
      .join("\n\n")
      .slice(0, 18000);
  } else {
    quizPayloadText = (mainContent.innerText || "").slice(0, 18000);
  }

  const prompt = `You are a senior computer science professor solving a Coursera quiz. Carefully trace every line of code (check 0-based indexing, array bounds, types, exceptions, edge cases) and verify every concept so that you score 100%.

Return ONLY valid JSON in this exact format:
{
  "results": [
    {
      "q": 1,
      "answers": ["Exact option text here"]
    }
  ]
}

Strict Rules:
- Copy each correct option text EXACTLY verbatim from "Available Options" (do not add "A.", "B.", bullets, or extra text).
- Answer EVERY question in order (q: 1, 2, 3, ...).
- For multiple-select questions ("Select all that apply"), include ALL correct option strings in the "answers" array.
- Do not include explanations or markdown outside the JSON object.

Quiz Content:
${quizPayloadText}`;

  const scheduleRetryOrPause = (reason, { retryable = true } = {}) => {
    if (!baseQuizKey) return;
    if (retryable) {
      // Never permanently pause on temporary 503/429 spikes — auto-retry quickly after 5s!
      quizCooldownUntil[baseQuizKey] = Date.now() + 5000;
      setStatus("API busy (retry 5s)", "#facc15");
      if (reason) setOutput(`${reason}\n\n5 सेकंड में अपने-आप फिर कोशिश करेगा... (अगर CodeTantra भी इसी Key पर चल रहा है तो ऊपर 'Key' बटन से Coursera के लिए अलग Key डाल सकते हो)`);
      return;
    }
    const errs = (quizSolveErrorCounts[baseQuizKey] || 0) + 1;
    quizSolveErrorCounts[baseQuizKey] = errs;
    if (errs >= 3) {
      quizFailedUrls.add(baseQuizKey);
    } else {
      quizCooldownUntil[baseQuizKey] = Date.now() + 6000;
      setStatus(`Retry solve (${errs}/2)...`, "#facc15");
      if (reason) setOutput(`${reason}\n\nAuto-retrying (${errs}/2)...`);
    }
  };

  try {
    const apiRes = await callGeminiWithFallback(prompt, useStrongModel);

    if (!apiRes.ok) {
      setStatus(apiRes.retryable ? "API busy -> retrying" : "API Error", apiRes.retryable ? "#facc15" : "#f87171");
      setOutput(`Gemini API Error:\n${apiRes.error}`);
      scheduleRetryOrPause(`Gemini API Error:\n${apiRes.error}`, { retryable: Boolean(apiRes.retryable) });
      return;
    }

    const stripped = apiRes.rawText.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const jsonMatch = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const cleaned = jsonMatch ? jsonMatch[1] : stripped;
    const parsed = JSON.parse(cleaned);
    const results = Array.isArray(parsed) ? parsed : parsed.results || [];

    const { tickedCount, totalExpected, matchedLogs, missedLogs } = await tickQuestionAnswers(blocks, results);

    setStatus(
      `Ticked ${tickedCount}/${totalExpected}`,
      tickedCount > 0 && missedLogs.length === 0 ? "#86efac" : "#facc15"
    );

    let summary = `Model: ${apiRes.model}\nAuto-ticked: ${tickedCount}/${totalExpected}\n\n`;
    if (matchedLogs.length) summary += matchedLogs.join("\n");
    if (missedLogs.length) summary += `\n\nManual check:\n${missedLogs.join("\n")}`;
    setOutput(summary.trim());

    if (tickedCount === 0) {
      scheduleRetryOrPause(summary.trim() || "0 options matched on page.", { retryable: false });
      return;
    }

    if (baseQuizKey) {
      quizSolveErrorCounts[baseQuizKey] = 0;
      delete quizCooldownUntil[baseQuizKey];
      quizTickedUrls.add(baseQuizKey);
    }

    if (autoSubmit) {
      await checkHonorCodeAndSubmit(baseQuizKey);
    }
  } catch (err) {
    setStatus("Solve Error", "#f87171");
    setOutput(`Error: ${err.message}`);
    scheduleRetryOrPause(`Error: ${err.message}`, { retryable: false });
  } finally {
    setTimeout(() => {
      quizSolvingInProgress = false;
    }, 3500);
  }
}

// ---------------- Boot ----------------
setTimeout(() => {
  createPanel();
  if (autoMode) {
    setAutoMode(true);
  }
}, 1800);

setInterval(() => {
  if (!document.getElementById("cs-helper-panel")) {
    createPanel();
  }
}, 2500);
