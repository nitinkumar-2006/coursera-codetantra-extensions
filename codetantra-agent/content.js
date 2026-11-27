const CT_API_KEY_STORAGE = "codetantra_only_gemini_api_key_v1";
const LEGACY_SHARED_STORAGE_KEYS = [
  "cs_gemini_api_key",
  "ct_gemini_api_key",
  "gemini_api_key",
  "coursera_gemini_api_key",
  "coursera_only_gemini_api_key_v1"
];
const SHARED_KEY_BLOCK_MSG =
  "Same/Shared API Key blocked! Coursera aur CodeTantra mein alag-alag API Key dalna zaroori hai.";

// Purge any old or shared storage keys immediately on load
try {
  for (const oldKey of LEGACY_SHARED_STORAGE_KEYS) {
    localStorage.removeItem(oldKey);
  }
  // One-time seed of user-verified CodeTantra-only key (if cleared via Set Key, never re-seeds)
  if (localStorage.getItem("ct_seeded_key_5cfg") !== "done") {
    if (!localStorage.getItem(CT_API_KEY_STORAGE)) {
      localStorage.setItem(CT_API_KEY_STORAGE, "");
    }
    localStorage.setItem("ct_seeded_key_5cfg", "done");
  }
  // v11.3: Smart Auto-Language default (auto-detects Python/WebTech/Java/C; asks once on multi-lang DSA dropdowns)
  if (localStorage.getItem("ct_v113_smart_auto") !== "done") {
    localStorage.setItem("ct_preferred_lang", "auto");
    localStorage.setItem("ct_v113_smart_auto", "done");
  }
} catch {}

// Live-benchmarked best models for API mode (skip weak flash-lite-latest)
const VERIFIED_WORKING_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash"
];

const BLOCKED_SLIDE_PATTERNS = [];
function isBlockedSlideText(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return BLOCKED_SLIDE_PATTERNS.some((re) => re.test(t));
}

let cachedModelsByKey = new Map();
let failedModelUntil = new Map();
let apiCooldownUntil = 0;

const RETRYABLE_HTTP_CODES = new Set([400, 403, 404, 408, 429, 500, 502, 503, 504]);
const MAX_FIX_ATTEMPTS = 20;

let autoMode = false;
let autoInterval = null;
let isBusy = false;
let aiRequestInFlight = false;
let tickInFlight = false;
let solvedUrls = new Set();
let failedUrls = new Set();
let lastHashUrl = window.location.href;
let slideEnteredAt = Date.now();
let pendingBridgeCalls = new Map();
let msgCounter = 1;

function isBlockedOrSharedKey(key) {
  const k = (key || "").trim();
  if (!k) return false;
  if (k.startsWith("AQ.Ab8RN6") && k.endsWith("9IQiA")) return true;
  if (/coursera/i.test(k)) return true;
  return false;
}

function purgeBlockedOrInvalidStoredKey() {
  const raw = (localStorage.getItem(CT_API_KEY_STORAGE) || "").trim();
  if (!raw) return { blocked: false, keys: [] };
  const tokens = raw
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (tokens.some((k) => isBlockedOrSharedKey(k))) {
    localStorage.removeItem(CT_API_KEY_STORAGE);
    localStorage.removeItem("ct_last_working_model");
    cachedModelsByKey.clear();
    failedModelUntil.clear();
    autoMode = false;
    sessionStorage.setItem("ct_auto_mode", "false");
    if (autoInterval) {
      clearInterval(autoInterval);
      autoInterval = null;
    }
    return { blocked: true, keys: [] };
  }
  const valid = tokens.filter((k) => k.length >= 20);
  return { blocked: false, keys: valid };
}

function getApiKeys() {
  const check = purgeBlockedOrInvalidStoredKey();
  if (check.blocked) {
    syncKeyBtn();
    syncAutoUI();
    setStatus("Shared Key Blocked", "#f87171");
    setOutput(SHARED_KEY_BLOCK_MSG);
    return [];
  }
  return check.keys;
}

function getApiKey() {
  return getApiKeys()[0] || "";
}

function hasValidApiKey() {
  return getApiKeys().length > 0;
}

function getAiMode() {
  return localStorage.getItem("ct_ai_mode") === "api" ? "api" : "web";
}

function isWebMode() {
  return getAiMode() === "web";
}

function isAiReady() {
  return isWebMode() || hasValidApiKey();
}

function getTypingSpeedSec() {
  const raw = parseInt(localStorage.getItem("ct_typing_speed_sec") || "8", 10);
  if (isNaN(raw)) return 8;
  return Math.max(1, Math.min(60, raw));
}

if (isAiReady() && sessionStorage.getItem("ct_auto_mode") === "true") {
  autoMode = true;
} else {
  autoMode = false;
  sessionStorage.setItem("ct_auto_mode", "false");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randMs(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

// ---------------- Bridge Communication (MAIN world + all iframes) ----------------
// Live progress updates from background.js while Gemini Web tab is generating
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "GEMINI_WEB_PROGRESS" && msg.text) {
      setOutput(msg.text);
    }
  });
} catch {}

window.addEventListener("message", (event) => {
  if (!event.data || event.data.source !== "CT_BRIDGE") return;
  const { id, type, payload, pct } = event.data;

  if (type === "TYPE_PROGRESS") {
    setStatus(`Typing ${pct}%...`, "#86efac");
    return;
  }

  if (id && pendingBridgeCalls.has(id)) {
    const resolve = pendingBridgeCalls.get(id);
    pendingBridgeCalls.delete(id);
    resolve(payload);
  }
});

function callBridge(type, payload = {}, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const id = `ct_${Date.now()}_${msgCounter++}`;
    const timer = setTimeout(() => {
      if (pendingBridgeCalls.has(id)) {
        pendingBridgeCalls.delete(id);
        resolve({ ok: false, error: "Editor bridge timeout." });
      }
    }, timeoutMs);

    pendingBridgeCalls.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });

    window.postMessage({ source: "CT_CONTENT", id, type, payload }, "*");
  });
}

// ---------------- UI (Crisp Apple Dark Glassmorphism) ----------------
function createPanel() {
  if (document.getElementById("ct-helper-panel")) return;

  if (!document.getElementById("ct-glass-styles")) {
    const styleTag = document.createElement("style");
    styleTag.id = "ct-glass-styles";
    styleTag.textContent = `
      #ct-helper-panel {
        transition: box-shadow 0.2s ease, border-color 0.2s ease;
      }
      #ct-helper-panel:hover {
        border-color: rgba(255, 255, 255, 0.34);
      }
      .ct-glass-btn {
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
      .ct-glass-btn:hover {
        background: rgba(18, 22, 32, 0.88);
        border-color: rgba(255, 255, 255, 0.42);
      }
      .ct-glass-btn:active {
        transform: scale(0.97);
      }
      .ct-glass-btn-running {
        background: rgba(58, 16, 22, 0.78);
        border-color: rgba(248, 113, 113, 0.48);
        color: #ffffff;
      }
      .ct-glass-btn-running:hover {
        background: rgba(82, 20, 28, 0.90);
        border-color: rgba(248, 113, 113, 0.68);
      }
      .ct-icon-btn {
        background: rgba(10, 12, 18, 0.62);
        border: 1px solid rgba(255, 255, 255, 0.20);
        color: #e5e7eb;
        border-radius: 6px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
      }
      .ct-icon-btn:hover {
        border-color: rgba(255, 255, 255, 0.45);
        color: #ffffff;
      }
      .ct-key-missing {
        background: rgba(127, 29, 29, 0.78) !important;
        border-color: rgba(248, 113, 113, 0.70) !important;
        color: #fecaca !important;
        font-weight: 600;
      }
      .ct-key-active {
        background: rgba(20, 83, 45, 0.74) !important;
        border-color: rgba(134, 239, 172, 0.60) !important;
        color: #bbf7d0 !important;
        font-weight: 600;
      }
      .ct-mode-active {
        background: rgba(20, 83, 45, 0.80) !important;
        border-color: rgba(134, 239, 172, 0.70) !important;
        color: #bbf7d0 !important;
        font-weight: 600;
      }
      .ct-speed-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 5px;
        margin-top: 7px;
      }
      .ct-speed-chip {
        background: rgba(10, 12, 18, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #e5e7eb;
        border-radius: 7px;
        padding: 4px 3px;
        font-size: 10.5px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
      }
      .ct-speed-chip:hover {
        border-color: rgba(255, 255, 255, 0.45);
        color: #ffffff;
      }
      .ct-speed-chip-active {
        background: rgba(20, 83, 45, 0.80) !important;
        border-color: rgba(134, 239, 172, 0.70) !important;
        color: #bbf7d0 !important;
      }
    `;
    document.head.appendChild(styleTag);
  }

  const panel = document.createElement("div");
  panel.id = "ct-helper-panel";
  panel.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    background: rgba(16, 18, 26, 0.64);
    backdrop-filter: blur(12px) saturate(150%);
    -webkit-backdrop-filter: blur(12px) saturate(150%);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 16px; padding: 13px; width: 345px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28);
    font-size: 12.5px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
      <span style="display:flex; align-items:center; gap:5px; flex-wrap:nowrap;">
        <span style="color:#ffffff; white-space:nowrap; font-size:13px;">CodeTantra</span>
        <span style="font-size:10px; background:rgba(10,12,18,0.65); border:1px solid rgba(255,255,255,0.22); color:#e5e7eb; padding:2px 6px; border-radius:6px;">v16.6</span>
        <button id="ct-mode-btn" class="ct-icon-btn ct-mode-active" title="Active AI Mode (click to toggle Web / API)">Web</button>
      </span>
      <span style="display:flex; align-items:center; gap:6px;">
        <span id="ct-status" style="color:#e5e7eb; font-size:11px; font-weight:500; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Idle</span>
        <button id="ct-settings-btn" class="ct-icon-btn" title="Settings: Mode, Language, API Key & Typing Speed" style="padding:2px 6px; font-size:11px;">⚙</button>
      </span>
    </div>
    <div id="ct-settings-drawer" style="display:none; margin-bottom:10px; padding:9px 10px; border-radius:11px; background:rgba(10,12,18,0.78); border:1px solid rgba(255,255,255,0.16);">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.10);">
        <span style="display:flex; gap:5px;">
          <button id="ct-pick-web" class="ct-icon-btn" style="padding:3px 8px;">Web</button>
          <button id="ct-pick-api" class="ct-icon-btn" style="padding:3px 8px;">API</button>
        </span>
        <button id="ct-set-key" class="ct-icon-btn ct-key-missing" style="padding:3px 8px;" title="Set CodeTantra-only Gemini API Key">Set Key</button>
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:4px; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.10);">
        <span style="font-size:11px; color:#e5e7eb;">Lang:</span>
        <span style="display:flex; gap:3px; flex-wrap:wrap; justify-content:flex-end;">
          <button class="ct-icon-btn ct-lang-chip" data-lang="auto" style="padding:2px 6px;">Auto</button>
          <button class="ct-icon-btn ct-lang-chip" data-lang="java" style="padding:2px 6px;">Java</button>
          <button class="ct-icon-btn ct-lang-chip" data-lang="python" style="padding:2px 6px;">Py</button>
          <button class="ct-icon-btn ct-lang-chip" data-lang="webtech" style="padding:2px 6px;">WebTech</button>
          <button class="ct-icon-btn ct-lang-chip" data-lang="cpp" style="padding:2px 5px;">C++</button>
          <button class="ct-icon-btn ct-lang-chip" data-lang="c" style="padding:2px 5px;">C</button>
        </span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; font-size:11px; color:#e5e7eb;">
        <span>Typing Speed: <b id="ct-speed-val" style="color:#86efac;">8s</b></span>
        <span style="display:flex; align-items:center; gap:4px;">
          <button id="ct-speed-minus" class="ct-icon-btn" style="padding:1px 7px; font-weight:700;">−</button>
          <button id="ct-speed-plus" class="ct-icon-btn" style="padding:1px 7px; font-weight:700;">+</button>
        </span>
      </div>
      <input id="ct-speed-slider" type="range" min="1" max="60" value="8" style="width:100%; margin-top:6px; accent-color:#86efac; cursor:pointer;" />
      <div class="ct-speed-grid">
        <button class="ct-speed-chip" data-sec="2">2s Turbo</button>
        <button class="ct-speed-chip" data-sec="5">5s Fast</button>
        <button class="ct-speed-chip" data-sec="10">10s Normal</button>
        <button class="ct-speed-chip" data-sec="20">20s Med</button>
        <button class="ct-speed-chip" data-sec="35">35s Slow</button>
        <button class="ct-speed-chip" data-sec="60">60s Human</button>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-bottom:2px;">
      <button id="ct-toggle-auto" class="ct-glass-btn">
        Start Auto
      </button>
      <button id="ct-solve-one" class="ct-glass-btn">
        Solve & Type
      </button>
    </div>
    <div id="ct-output" style="margin-top:9px; max-height:200px; overflow-y:auto; background:rgba(10, 12, 18, 0.72); color:#f3f4f6; border:1px solid rgba(255, 255, 255, 0.16); padding:8px 10px; border-radius:10px; font-size:11.5px; line-height:1.45; white-space:pre-wrap; display:none;"></div>
  `;

  document.body.appendChild(panel);
  document.getElementById("ct-toggle-auto").addEventListener("click", () => setAutoMode(!autoMode));
  document.getElementById("ct-solve-one").addEventListener("click", () => {
    if (isBusy) {
      callBridge("STOP_TYPING");
      setStatus("Stopping...", "#facc15");
      return;
    }
    if (!isAiReady()) {
      showApiKeyRequired();
      return;
    }
    apiCooldownUntil = 0;
    failedUrls.delete(window.location.href);
    solveCurrentSlide({ autoSubmitAndNext: false });
  });

  // Clean Single Active Mode Pill (GREEN for whichever mode is active!) + Settings Drawer
  const modeBtn = document.getElementById("ct-mode-btn");
  const pickWebBtn = document.getElementById("ct-pick-web");
  const pickApiBtn = document.getElementById("ct-pick-api");
  const settingsBtn = document.getElementById("ct-settings-btn");
  const settingsDrawer = document.getElementById("ct-settings-drawer");

  function setAiMode(mode) {
    localStorage.setItem("ct_ai_mode", mode === "api" ? "api" : "web");
    apiCooldownUntil = 0;
    failedUrls.delete(window.location.href);
    syncModeBtn();
    setStatus(mode === "web" ? "Web Active ✓" : "API Active ✓", "#86efac");
    setOutput(
      mode === "web"
        ? "Web Mode ON (Green) — Free gemini.google.com tab use karega (0 API Key)."
        : "API Mode ON (Green) — CodeTantra-only API key use karega."
    );
  }

  function syncModeBtn() {
    const webOn = isWebMode();
    if (modeBtn) {
      modeBtn.innerText = webOn ? "Web" : "API";
      modeBtn.classList.remove("ct-mode-active", "ct-key-missing");
      if (webOn || hasValidApiKey()) {
        modeBtn.classList.add("ct-mode-active");
      } else {
        modeBtn.classList.add("ct-key-missing");
      }
      modeBtn.title = webOn ? "Active: Web Mode (Green). Click to switch to API." : "Active: API Mode (Green). Click to switch to Web.";
    }
    if (pickWebBtn) pickWebBtn.classList.toggle("ct-mode-active", webOn);
    if (pickApiBtn) pickApiBtn.classList.toggle("ct-mode-active", !webOn);
    syncAutoUI();
  }
  syncModeBtn();
  modeBtn.addEventListener("click", () => setAiMode(isWebMode() ? "api" : "web"));
  pickWebBtn.addEventListener("click", () => setAiMode("web"));
  pickApiBtn.addEventListener("click", () => setAiMode("api"));
  settingsBtn.addEventListener("click", () => {
    if (!settingsDrawer) return;
    settingsDrawer.style.display = settingsDrawer.style.display === "none" ? "block" : "none";
  });

  // Auto-Language Switcher inside Settings Drawer (default: Java for DSA)
  const langChips = Array.from(panel.querySelectorAll(".ct-lang-chip"));
  function applyPreferredLang(langVal) {
    const normalized = langVal || "auto";
    localStorage.setItem("ct_preferred_lang", normalized);
    if (normalized !== "auto") sessionStorage.removeItem("ct_multilang_choice");
    langChips.forEach((chip) => {
      chip.classList.toggle("ct-mode-active", chip.dataset.lang === normalized);
    });
  }
  applyPreferredLang(localStorage.getItem("ct_preferred_lang") || "auto");
  langChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      applyPreferredLang(chip.dataset.lang);
      setStatus(`Lang: ${chip.dataset.lang.toUpperCase()}`, "#86efac");
    });
  });

  // Typing Speed Grid inside Settings Drawer (1s - 60s)
  const speedVal = document.getElementById("ct-speed-val");
  const speedSlider = document.getElementById("ct-speed-slider");
  const speedChips = Array.from(panel.querySelectorAll(".ct-speed-chip"));
  function applyTypingSpeed(sec) {
    const clamped = Math.max(1, Math.min(60, parseInt(sec, 10) || 8));
    localStorage.setItem("ct_typing_speed_sec", String(clamped));
    if (speedVal) speedVal.innerText = `${clamped}s`;
    if (speedSlider) speedSlider.value = String(clamped);
    speedChips.forEach((chip) => {
      chip.classList.toggle("ct-speed-chip-active", parseInt(chip.dataset.sec, 10) === clamped);
    });
  }
  applyTypingSpeed(getTypingSpeedSec());
  speedSlider.addEventListener("input", () => applyTypingSpeed(speedSlider.value));
  document.getElementById("ct-speed-minus").addEventListener("click", () => applyTypingSpeed(getTypingSpeedSec() - 2));
  document.getElementById("ct-speed-plus").addEventListener("click", () => applyTypingSpeed(getTypingSpeedSec() + 2));
  speedChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      applyTypingSpeed(chip.dataset.sec);
      setStatus(`Speed: ${chip.dataset.sec}s`, "#86efac");
    });
  });
  document.getElementById("ct-set-key").addEventListener("click", async () => {
    const curRaw = localStorage.getItem(CT_API_KEY_STORAGE) || "";
    const newKey = prompt(
      "Sirf CodeTantra ke liye alag Gemini API Key paste karo (20+ chars; comma se multiple keys bhi daal sakte ho). Khali chhod kar OK dabane par key remove ho jayegi:",
      curRaw
    );
    if (newKey === null) return;

    const cleaned = newKey.replace(/["'`]/g, "").trim();
    cachedModelsByKey.clear();
    failedModelUntil.clear();
    apiCooldownUntil = 0;

    // Empty OK => remove saved key and immediately lock/stop agent
    if (!cleaned) {
      localStorage.removeItem(CT_API_KEY_STORAGE);
      localStorage.removeItem("ct_last_working_model");
      setAutoMode(false);
      syncKeyBtn();
      setStatus("API Key Required", "#f87171");
      setOutput("CodeTantra API Key remove kar di gayi hai. Agent lock ho gaya hai — chalane ke liye 'Set Key' se nayi key daalo.");
      return;
    }

    const tokens = cleaned
      .split(/[\s,;]+/)
      .map((k) => k.trim())
      .filter(Boolean);

    // Block shared/Coursera keys immediately
    if (tokens.some((k) => isBlockedOrSharedKey(k))) {
      localStorage.removeItem(CT_API_KEY_STORAGE);
      localStorage.removeItem("ct_last_working_model");
      setAutoMode(false);
      syncKeyBtn();
      setStatus("Shared Key Blocked", "#f87171");
      setOutput(SHARED_KEY_BLOCK_MSG);
      return;
    }

    const validKeys = tokens.filter((k) => k.length >= 20);
    if (!validKeys.length) {
      localStorage.removeItem(CT_API_KEY_STORAGE);
      setAutoMode(false);
      syncKeyBtn();
      setStatus("API Key Required", "#f87171");
      setOutput("Invalid API Key! Kam se kam 20 characters ki CodeTantra-only Gemini API Key daalo.");
      return;
    }

    localStorage.setItem(CT_API_KEY_STORAGE, validKeys.join(","));
    syncKeyBtn();
    setStatus("Testing key...", "#60a5fa");
    const report = [];
    for (let i = 0; i < validKeys.length; i++) {
      const last4 = validKeys[i].slice(-4);
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(validKeys[i])}`);
        const d = await r.json().catch(() => ({}));
        if (r.ok && Array.isArray(d.models)) {
          report.push(`Key ${i + 1} (..${last4}): Valid ✓ (${d.models.length} models)`);
        } else {
          report.push(`Key ${i + 1} (..${last4}): ERROR ${r.status} (${(d?.error?.message || "Invalid").slice(0, 55)})`);
        }
      } catch (e) {
        report.push(`Key ${i + 1} (..${last4}): Network error (${e.message})`);
      }
    }
    const anyOk = report.some((line) => line.includes("Valid ✓"));
    setStatus(anyOk ? `Key ..${validKeys[0].slice(-4)} ✓` : "Key Error!", anyOk ? "#86efac" : "#f87171");
    setOutput(report.join("\n"));
  });

  syncKeyBtn();
  syncAutoUI();
}

function syncKeyBtn() {
  const keyBtn = document.getElementById("ct-set-key");
  if (!keyBtn) return;
  const check = purgeBlockedOrInvalidStoredKey();
  const primary = check.keys[0] || "";
  if (primary && primary.length >= 20) {
    keyBtn.innerText = `Key ..${primary.slice(-4)}`;
    keyBtn.classList.remove("ct-key-missing");
    keyBtn.classList.add("ct-key-active");
    keyBtn.title = `CodeTantra-only API Key active (..${primary.slice(-4)}) — click to change or clear`;
  } else {
    keyBtn.innerText = "Set Key";
    keyBtn.classList.remove("ct-key-active");
    keyBtn.classList.add("ct-key-missing");
    keyBtn.title = "Set CodeTantra-only Gemini API Key (required)";
  }
}

function showApiKeyRequired() {
  syncKeyBtn();
  setStatus("API Key Required", "#f87171");
  setOutput("CodeTantra-only Gemini API Key set nahi hai! Upar red 'Set Key' button dabakar apna alag CodeTantra API Key (20+ chars) daalo.");
}

function setStatus(text, color = "#e5e7eb") {
  const el = document.getElementById("ct-status");
  if (el) {
    el.innerText = text;
    el.style.color = color;
  }
}

function setOutput(text) {
  const out = document.getElementById("ct-output");
  if (!out) return;
  out.style.display = "block";
  out.innerText = text;
}

function clearOutput() {
  const out = document.getElementById("ct-output");
  if (!out) return;
  out.style.display = "none";
  out.innerText = "";
}

function syncAutoUI() {
  const btn = document.getElementById("ct-toggle-auto");
  if (!btn) return;
  if (autoMode && isAiReady()) {
    btn.innerText = "Stop Auto";
    btn.classList.add("ct-glass-btn-running");
    setStatus("Running...", "#86efac");
  } else {
    btn.innerText = "Start Auto";
    btn.classList.remove("ct-glass-btn-running");
    if (!isAiReady()) {
      setStatus("API Key Required", "#f87171");
    } else {
      setStatus("Stopped", "#d1d5db");
    }
  }
}

function setAutoMode(enabled) {
  if (enabled && !isAiReady()) {
    autoMode = false;
    sessionStorage.setItem("ct_auto_mode", "false");
    if (autoInterval) {
      clearInterval(autoInterval);
      autoInterval = null;
    }
    syncAutoUI();
    showApiKeyRequired();
    return;
  }

  autoMode = enabled;
  sessionStorage.setItem("ct_auto_mode", enabled ? "true" : "false");
  syncAutoUI();

  if (autoInterval) {
    clearInterval(autoInterval);
    autoInterval = null;
  }

  if (!autoMode) {
    callBridge("STOP_TYPING");
    return;
  }

  apiCooldownUntil = 0;
  failedUrls.delete(window.location.href);
  autoInterval = setInterval(runAutoTick, 1000);
  runAutoTick();
}

function formatNumberedCode(code, lockedLines = []) {
  if (!code || !code.trim()) return "(empty editor)";
  const lockedSet = new Set(lockedLines || []);
  return code
    .split("\n")
    .map((line, i) => {
      const ln = i + 1;
      const tag = lockedSet.has(ln) ? "[LOCKED]" : "[EDITABLE]";
      return `${ln} ${tag}: ${line}`;
    })
    .join("\n");
}

// ---------------- Dynamic Model Discovery + Verified Working Models First ----------------
async function discoverAvailableModels(apiKey) {
  const cached = cachedModelsByKey.get(apiKey);
  if (cached && cached.length > 0) {
    return cached;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(data.models)) {
      const availableSet = new Set(
        data.models
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => (m.name || "").replace(/^models\//, ""))
      );

      // Keep ONLY live-verified working models first so we NEVER waste time on retired 404 or paid-only 429 models
      const prioritized = VERIFIED_WORKING_MODELS.filter((m) => availableSet.has(m));
      const extras = [...availableSet].filter(
        (name) =>
          !prioritized.includes(name) &&
          name.startsWith("gemini-") &&
          !/(image|tts|live|audio|embed|robotics|transcribe|imagen|veo|lyria|customtools|computer|1\.0|1\.5|2\.0|2\.5|3\.6|3\.7|3\.8|pro|omni|nano|antigravity|deep-research|gemini-4-)/i.test(
            name
          )
      );
      // Always keep gemini-3-flash-preview FIRST (never let stale flash-lite override it!)
      const combined = [...prioritized, ...extras].slice(0, 5);
      if (combined.length > 0) {
        cachedModelsByKey.set(apiKey, combined);
        return combined;
      }
    }
  } catch {
    // Fall back to live-verified list
  }

  return [...VERIFIED_WORKING_MODELS];
}

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonFromText(raw) {
  const str = (raw || "").trim();
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cleaned = (fenced ? fenced[1] : str).trim();
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return cleaned;
  let endIdx = cleaned.lastIndexOf("}");
  while (endIdx > firstBrace) {
    const candidate = cleaned.slice(firstBrace, endIdx + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      endIdx = cleaned.lastIndexOf("}", endIdx - 1);
    }
  }
  const lastBrace = cleaned.lastIndexOf("}");
  return lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
}

function detectSubject(langHint = "", textHint = "") {
  const combined = `${langHint} ${textHint} ${document.title || ""}`.toLowerCase();
  if (/\bpython\b|\.py\b|\bdef\s+\w+|\breadline\(|\b__init__\b/i.test(combined)) return "python";
  if (/\bjava\b|\.java\b|\bpublic\s+class\b|\bsystem\.out\b/i.test(combined)) return "java";
  if (/\b(html|html5|css|css3|javascript|webtech|web\s*tech|dom)\b|\.(html|htm|css|js)\b/i.test(combined)) return "webtech";
  return "other";
}

async function captureCleanTabScreenshot() {
  const panel = document.getElementById("ct-helper-panel");
  const prevVis = panel ? panel.style.visibility : "";
  try {
    if (panel) panel.style.visibility = "hidden";
    await sleep(90);
    const res = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const t = setTimeout(() => finish({ ok: false }), 5000);
      chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (reply) => {
        if (chrome.runtime.lastError) finish({ ok: false });
        else finish(reply || { ok: false });
      });
    });
    if (res && res.ok && res.base64) return { mimeType: res.mimeType || "image/jpeg", base64: res.base64 };
    return null;
  } catch {
    return null;
  } finally {
    if (panel) panel.style.visibility = prevVis;
  }
}

async function callGemini(prompt, { expectJson = true, forceApi = false, screenshot = null, subject = "" } = {}) {
  if (aiRequestInFlight) {
    console.warn("[CT-FSM] Blocked overlapping AI call (single-flight lock active)");
    return { ok: false, error: "AI request already in flight." };
  }
  aiRequestInFlight = true;
  try {
  // STRICT MODE ISOLATION: Web mode stays 100% on Gemini Web (with subject-wise persistent chat); API mode stays 100% on API!
  if (isWebMode() && !forceApi) {
    const resolvedSubject = subject || detectSubject("", prompt);
    setStatus(screenshot ? "Web + Screenshot..." : `AI: Gemini (${resolvedSubject})`, "#93c5fd");
    setOutput(screenshot ? `Live screenshot + error Gemini (${resolvedSubject}) chat par bhej raha hoon...` : `Gemini Web (${resolvedSubject} chat) se answer laa raha hoon...`);
    try {
      const res = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
        const t = setTimeout(() => finish({ ok: false, error: "Gemini Web timeout (130s) — Gemini tab mein 'Neon' se 'Fast' par switch karo ya 'API' mode chalao." }), 130000);
        chrome.runtime.sendMessage({ type: "GEMINI_WEB_ASK", prompt, screenshot, questionUrl: window.location.href, subject: resolvedSubject }, (reply) => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            finish(reply || { ok: false, error: "Gemini Web background worker se reply nahi mila." });
          }
        });
      });
      if (res && res.ok && res.rawText) {
        return { ok: true, model: res.model || "Gemini Web (Free)", rawText: expectJson ? extractJsonFromText(res.rawText) : res.rawText };
      }
      apiCooldownUntil = Date.now() + 20000;
      return { ok: false, error: res?.error || "Gemini Web se reply nahi mila. Check karo gemini.google.com tab logged in hai." };
    } catch (err) {
      apiCooldownUntil = Date.now() + 20000;
      return { ok: false, error: `Gemini Web error: ${err.message}` };
    }
  }

  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    return {
      ok: false,
      error: "Koi valid Gemini API Key set nahi hai! Upar 'Web' dabakar free mode chalao ya 'Key' mein CodeTantra API key daalo."
    };
  }

  const errorLogs = [];
  const now = Date.now();

  for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
    const apiKey = apiKeys[kIdx];
    const models = await discoverAvailableModels(apiKey);

    // Skip models blacklisted in the last 4 minutes for 503/429/404 (unless ALL are blacklisted)
    const healthyModels = models.filter((m) => (failedModelUntil.get(`${kIdx}:${m}`) || 0) <= now);
    const runModels = healthyModels.length ? healthyModels : models;

    for (const model of runModels) {
      const isGemma = model.startsWith("gemma-");
      const hasImg = Boolean(screenshot && screenshot.base64 && !isGemma);
      setStatus(hasImg ? `Vision: ${model.replace("gemini-", "")}` : `AI: ${model.replace("gemini-", "")} (K${kIdx + 1})`, "#60a5fa");
      setOutput(`${hasImg ? "Live screenshot + code dekh kar fix kar raha hoon..." : "Code generate kar raha hoon..."}\nModel: ${model} (Key ${kIdx + 1}/${apiKeys.length})${errorLogs.length ? "\nLast skipped: " + errorLogs[errorLogs.length - 1] : ""}`);
      try {
        const reqParts = [{ text: prompt }];
        if (hasImg) {
          reqParts.push({ inline_data: { mime_type: screenshot.mimeType || "image/jpeg", data: screenshot.base64 } });
        }
        const bodyObj = {
          contents: [{ parts: reqParts }]
        };
        if (expectJson && !isGemma) {
          bodyObj.generationConfig = { responseMimeType: "application/json" };
        }

        // 45s timeout so long DSA solutions (like B-Tree / HeapSort) NEVER get killed mid-generation!
        // Fast errors (404 / 429 / 503) still return in <1s and switch immediately.
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyObj)
          },
          45000
        );

        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) {
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (rawText) {
            failedModelUntil.delete(`${kIdx}:${model}`);
            localStorage.setItem("ct_last_working_model", model);
            const keyList = cachedModelsByKey.get(apiKey);
            if (keyList) {
              cachedModelsByKey.set(apiKey, [model, ...keyList.filter((m) => m !== model)]);
            }
            return { ok: true, model, rawText: expectJson ? extractJsonFromText(rawText) : rawText };
          }
        }

        const errMsg = data?.error?.message || `HTTP ${res.status}`;
        errorLogs.push(`K${kIdx + 1}/${model} (${res.status}): ${errMsg.slice(0, 80)}`);

        // Invalid or permission-denied key: skip rest of models for THIS key immediately
        if (res.status === 403 || (res.status === 400 && /api key not valid/i.test(errMsg))) {
          break;
        }
        // Blacklist broken/overloaded/quota-hit model for 4 minutes so it never wastes time again!
        if (res.status === 503 || res.status === 429 || res.status === 404) {
          failedModelUntil.set(`${kIdx}:${model}`, Date.now() + 240000);
        }

        if (RETRYABLE_HTTP_CODES.has(res.status)) {
          await sleep(250);
          continue;
        }
      } catch (err) {
        const msg = err.name === "AbortError" ? "Timeout (45s)" : err.message;
        failedModelUntil.set(`${kIdx}:${model}`, Date.now() + 240000);
        errorLogs.push(`K${kIdx + 1}/${model}: ${msg}`);
      }
    }
  }

  const hitQuota = errorLogs.some((e) => e.includes("(429)") || /quota/i.test(e));
  const hitBusy = errorLogs.some((e) => e.includes("(503)") || /high demand/i.test(e));
  const hitDenied = errorLogs.some((e) => e.includes("(403)") || /api key not valid/i.test(e));
  apiCooldownUntil = Date.now() + (hitQuota ? 40000 : 20000);
  const shownLogs = errorLogs.length <= 5 ? errorLogs : [...errorLogs.slice(0, 2), "...", ...errorLogs.slice(-2)];
  return {
    ok: false,
    error:
      (hitQuota
        ? "Is key par aaj ka free Gemini quota (429) khatam ho gaya! 'Key' dabakar naya Gmail API key paste karo (purana hata kar ya comma se).\n"
        : hitDenied
        ? "API Key invalid ya blocked hai (403) — 'Key' dabakar aistudio.google.com/apikey se nayi AIza... key paste karo.\n"
        : hitBusy
        ? "Google Gemini server abhi high demand par hai (503) — 20s baad khud retry karega.\n"
        : "") + (shownLogs.join("\n") || "All Gemini models failed.")
  };
  } finally {
    aiRequestInFlight = false;
  }
}

async function clickNextSlide() {
  setStatus("Moving Next...", "#86efac");
  await sleep(400);
  const res = await callBridge("CLICK_BUTTON", { targets: ["next >", "next", "next lesson", "next question"] }, 3000);
  if (res && res.ok) return true;

  // Fallback: "About this unit" / module overview page where Next > button doesn't exist
  const beforeUrl = window.location.href;
  const unitRes = await callBridge("OPEN_UNIT_ITEM", {}, 3000);
  if (unitRes && unitRes.ok) {
    setStatus("Opening card...", "#86efac");
    setOutput(`Unit card click kiya:\n${unitRes.title || "First question"}`);
    await sleep(1000);
    return window.location.href !== beforeUrl;
  }

  // Never randomly yank the user to another unit via sidebar from a question slide!
  // Sidebar jump only happens when the user clicks 'Top' or an overview unit is 100% completed.
  setStatus("Next btn missing", "#facc15");
  return false;
}

// ---------------- 1. CODING PROBLEM SOLVER ----------------
async function solveCodingProblem(edState, { autoSubmitAndNext = false } = {}) {
  // Step 0: Smart Auto-Language Detection + Ask Once on Multi-Language DSA Dropdowns!
  let prefLang = localStorage.getItem("ct_preferred_lang") || "auto";
  if (prefLang === "auto" && edState.hasMultiLangDropdown) {
    let savedMulti = sessionStorage.getItem("ct_multilang_choice") || "";
    if (!savedMulti) {
      const asked = prompt(
        "Is multi-language question ke liye kaunsa language select karoon? (java / cpp / python / c):",
        edState.language || "java"
      );
      savedMulti = (asked || edState.language || "java").trim().toLowerCase();
      if (savedMulti === "c++") savedMulti = "cpp";
      if (savedMulti === "py") savedMulti = "python";
      sessionStorage.setItem("ct_multilang_choice", savedMulti);
    }
    prefLang = savedMulti;
  }
  if (prefLang !== "auto" && prefLang !== "webtech" && (!edState.language || edState.language.toLowerCase() !== prefLang)) {
    setStatus(`Switching -> ${prefLang.toUpperCase()}`, "#60a5fa");
    const sw = await callBridge("SWITCH_LANG", { lang: prefLang }, 4000);
    if (sw && sw.ok && !sw.already) {
      const refreshed = await callBridge("READ_EDITOR", {}, 10000);
      if (refreshed && refreshed.found) edState = refreshed;
    }
  }

  // Step 1 (Fast): Open Sample Test Cases + Question Hints across ALL frames BEFORE building blueprint!
  setStatus("Opening test cases...", "#60a5fa");
  setOutput("Sample Test Cases aur Question Hints khol kar padh raha hoon...");
  const expandedInfo = await callBridge("EXPAND_PROBLEM_PANELS", {}, 5000);
  function getCleanTopFallbackText() {
    try {
      const c = document.body.cloneNode(true);
      c.querySelectorAll("#ct-helper-panel, header, nav, .navbar, script, style").forEach((el) => el.remove());
      return (c.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 9000);
    } catch {
      return "";
    }
  }
  const problemText =
    expandedInfo && expandedInfo.problemText && expandedInfo.problemText.length > (edState.problemText || "").length
      ? expandedInfo.problemText
      : edState.problemText && edState.problemText.length > 60
      ? edState.problemText
      : getCleanTopFallbackText();
  const tcOpened = /test case\s*1/i.test(problemText);

  function buildEditableSlots(code, lockedLines = [], partialLockedLines = []) {
    const lines = (code || "").replace(/\r\n/g, "\n").split("\n");
    const lockedSet = new Set(lockedLines || []);
    const partialSet = new Set(partialLockedLines || []);
    const slots = [];
    let start = -1;
    const isCommentOrBlankOnly = (txt) => !txt.replace(/#.*|\/\/.*|\/\*[\s\S]*?\*\//g, "").trim();
    const flush = (endLn) => {
      if (start !== -1 && endLn >= start) {
        const sliceCode = lines.slice(start - 1, endLn).join("\n");
        if (partialSet.size === 0 || !isCommentOrBlankOnly(sliceCode)) {
          slots.push({
            id: slots.length + 1,
            start_line: start,
            end_line: endLn,
            isInline: false,
            code: sliceCode
          });
        }
        start = -1;
      }
    };
    for (let ln = 1; ln <= lines.length; ln++) {
      if (partialSet.has(ln)) {
        flush(ln - 1);
        slots.push({ id: slots.length + 1, start_line: ln, end_line: ln, isInline: true, code: lines[ln - 1] });
      } else if (!lockedSet.has(ln)) {
        if (start === -1) start = ln;
      } else {
        flush(ln - 1);
      }
    }
    flush(lines.length);
    return slots;
  }

  function formatCodeWithSlots(code, lockedLines = [], slots = [], partialLockedLines = []) {
    const lines = (code || "").replace(/\r\n/g, "\n").split("\n");
    if (!lines.length || (lines.length === 1 && !lines[0].trim())) return "<<< EDITABLE SLOT 1 (Empty File) >>>\n<<< END SLOT 1 >>>";
    const slotStartMap = new Map(slots.map((s) => [s.start_line, s]));
    const slotEndMap = new Map(slots.map((s) => [s.end_line, s]));
    const lockedSet = new Set(lockedLines || []);
    const partialSet = new Set(partialLockedLines || []);
    const out = [];
    for (let ln = 1; ln <= lines.length; ln++) {
      const st = slotStartMap.get(ln);
      if (st) out.push(`<<< EDITABLE SLOT ${st.id} (Lines ${st.start_line}-${st.end_line}) >>>`);
      const tag = lockedSet.has(ln)
        ? "[LOCKED]"
        : partialSet.has(ln)
        ? "[INLINE_BLANK - FILL ONLY THE WHITE GAP INSIDE THIS LINE; DO NOT WRITE THIS STATEMENT ON AN EMPTY LINE ABOVE]"
        : "[EDITABLE]";
      out.push(`${ln} ${tag}: ${lines[ln - 1]}`);
      const en = slotEndMap.get(ln);
      if (en) out.push(`<<< END SLOT ${en.id} >>>`);
    }
    return out.join("\n");
  }

  const initialSlots = buildEditableSlots(edState.code, edState.lockedLines, edState.partialLockedLines);
  const existingEditableChars = initialSlots
    .map((s) => s.code.replace(/\/\/.*|\/\*[\s\S]*?\*\/|#.*|\s+/g, "").length)
    .reduce((a, b) => a + b, 0);

  // GREEN TIMER FAST-PATH: If question timer pill (e.g. 05:47) is already GREEN, just Submit once to verify & move Next without re-typing!
  if (autoSubmitAndNext && edState.isTimerGreen) {
    setStatus("Already Green ✓", "#86efac");
    setOutput("Timer pill GREEN hai (already done) — Submit karke verify kar raha hoon, phir Next...");
    await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"], preferEditorSubmit: true }, 2500);
    await sleep(1200);
    const checkGreenEval = await callBridge("EVAL_TESTS", {}, 7500);
    if (!checkGreenEval || checkGreenEval.status !== "failed") {
      solvedUrls.add(window.location.href);
      setStatus("Green Verified ✓", "#86efac");
      await sleep(450);
      await clickNextSlide();
      return;
    }
  }

  let existingEval = await callBridge("EVAL_TESTS", {}, 7500);
  // GUARD against stale 'Passed' badges carried over from the previous question in CodeTantra's SPA:
  // Only treat as Already Passed if the current editor actually has real solution code written (> 60 non-comment chars)!
  if (autoSubmitAndNext && existingEval && existingEval.status === "passed" && existingEditableChars > 60) {
    solvedUrls.add(window.location.href);
    setStatus("Already Passed ✓", "#86efac");
    setOutput(`${existingEval.summary}\nAgle question par jaa raha hoon...`);
    await sleep(1200);
    await clickNextSlide();
    return;
  }

  // PRE-CHECK SUBMIT: Never pre-submit if any [INLINE_BLANK] line still has an unfilled gap (e.g. starter code after Reset)!
  const codeLinesNow = (edState.code || "").replace(/\r\n/g, "\n").split("\n");
  const hasUnfilledBlank = (edState.partialLockedLines || []).some((ln) => /\S\s{3,}\S/.test(codeLinesNow[ln - 1] || ""));
  const preCheckMinChars = (edState.partialLockedLines || []).length > 0 ? 15 : 90;
  if (!hasUnfilledBlank && (!existingEval || existingEval.status === "unknown") && existingEditableChars > preCheckMinChars) {
    setStatus("Checking existing code...", "#60a5fa");
    setOutput("Editor mein code pehle se likha hai — pehle Submit karke exact error / test-case diff nikal raha hoon...");
    const preSub = await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"], preferEditorSubmit: true }, 3000);
    if (preSub && preSub.ok) {
      await sleep(1200);
      for (let poll = 0; poll < 16; poll++) {
        await sleep(750);
        const checkRes = await callBridge("EVAL_TESTS", {}, 7500);
        if (checkRes && (checkRes.status === "passed" || checkRes.status === "failed")) {
          existingEval = checkRes;
          break;
        }
      }
      if (existingEval && existingEval.status === "passed") {
        solvedUrls.add(window.location.href);
        setStatus("100% Passed ✓", "#86efac");
        setOutput(`${existingEval.summary}\nExisting code pehle se pass ho gaya!${autoSubmitAndNext ? " Next par jaa raha hoon..." : ""}`);
        if (autoSubmitAndNext) {
          await sleep(1000);
          await clickNextSlide();
        }
        return;
      }
    }
  }

  function extractJavaPkgAndClassFromError(errText) {
    const txt = errText || "";
    const m1 = txt.match(/wrong name:\s*([a-zA-Z0-9_]+)\/([A-Za-z0-9_]+)/i);
    if (m1) return { pkg: `package ${m1[1]};`, cls: m1[2] };
    const m2 = txt.match(/(?:main class|ClassNotFoundException:)\s*([a-zA-Z0-9_]+)\.([A-Za-z0-9_]+)/i);
    if (m2) return { pkg: `package ${m2[1]};`, cls: m2[2] };
    return { pkg: "", cls: "" };
  }

  // If previous run failed (e.g. Compilation Error / Expected vs Actual mismatch), read it immediately on Attempt 1!
  let previousError = existingEval && existingEval.status === "failed" ? existingEval.summary || "" : "";
  let { pkg: errRequiredPkg, cls: errRequiredClass } = extractJavaPkgAndClassFromError(previousError);

  // NEVER wipe working code with Reset on compiler/class errors — read the exact error and fix ONLY the broken editable slot(s)!
  let activeEdState = edState;
  let lastTypedCodeFingerprint = "";
  let consecutiveSameCode = 0;

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    let currentState = attempt === 1 ? activeEdState : await callBridge("READ_EDITOR", {}, 10000);
    if (
      (currentState.partialLockedLines || []).length > 0 &&
      /syntaxerror|indentationerror|taberror|expected|compilation error/i.test(previousError || "") &&
      (attempt > 1 || (existingEval && existingEval.status === "failed"))
    ) {
      setStatus("Resetting inline blank...", "#facc15");
      setOutput("Inline blank ke upar/andar error tha — Reset dabakar clean starter code wapas laa raha hoon...");
      const rst = await callBridge("CLICK_BUTTON", { targets: ["reset", "reset code"] }, 3000);
      if (rst && rst.ok) {
        await sleep(600);
        await callBridge("CLICK_BUTTON", { targets: ["yes", "ok", "confirm", "reset"] }, 2500);
        await sleep(1200);
        currentState = await callBridge("READ_EDITOR", {}, 10000);
        lastTypedCodeFingerprint = "";
      }
    }
    const editableSlots = buildEditableSlots(currentState.code, currentState.lockedLines, currentState.partialLockedLines);
    const latestErrInfo = extractJavaPkgAndClassFromError(previousError);
    if (latestErrInfo.pkg) errRequiredPkg = latestErrInfo.pkg;
    if (latestErrInfo.cls) errRequiredClass = latestErrInfo.cls;

    const numberedStarter = formatNumberedCode(currentState.code, currentState.lockedLines);
    const lang = currentState.language || (prefLang !== "auto" ? prefLang : "infer from problem statement & starter code");

    // SURGICAL FAST-FIX: If the ONLY issue is missing 'package qXXXXX;' on Line 1 of an existing Java file, insert ONLY Line 1 without rewriting the whole file!
    if (
      errRequiredPkg &&
      currentState.code &&
      currentState.code.length > 120 &&
      !currentState.code.includes(errRequiredPkg) &&
      !(currentState.lockedLines || []).includes(1)
    ) {
      const firstLine = currentState.code.split("\n")[0] || "";
      setStatus("Fixing package line...", "#60a5fa");
      setOutput(`Error padha: Missing ${errRequiredPkg}\nPura code nahi hata raha — sirf Line 1 par ${errRequiredPkg} add kar raha hoon!`);
      const fixEdits = [{ mode: "replace_lines", start_line: 1, end_line: 1, code: `${errRequiredPkg}\n${firstLine}` }];
      const typeRes = await callBridge("TYPE_CODE", { edits: fixEdits, targetTotalMs: 4000 }, 60000);
      if (typeRes && typeRes.ok && autoSubmitAndNext) {
        await sleep(450);
        await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"], preferEditorSubmit: true }, 3000);
        setStatus("Evaluating tests...", "#60a5fa");
        let evalRes = { status: "unknown", summary: "" };
        for (let poll = 0; poll < 22; poll++) {
          await sleep(800);
          evalRes = await callBridge("EVAL_TESTS", {}, 7500);
          if (evalRes && (evalRes.status === "passed" || evalRes.status === "failed")) break;
        }
        if (evalRes.status === "passed") {
          solvedUrls.add(window.location.href);
          setStatus("100% Passed ✓", "#86efac");
          setOutput(`${evalRes.summary}\nSirf package fix karte hi 100% pass! Next par jaa raha hoon...`);
          await sleep(1800);
          await clickNextSlide();
          return;
        }
        previousError = evalRes.summary || previousError;
        continue;
      }
    }

    setStatus(attempt === 1 ? "Planning blueprint..." : `Fixing error (try ${attempt})...`, "#60a5fa");
    setOutput(
      previousError
        ? `Error padha:\n${previousError.slice(0, 180)}\nIs exact error ko fix karne ka blueprint bana raha hoon...`
        : `Editor: ${currentState.type.toUpperCase()} (${lang}) | Test Cases: ${tcOpened ? "Opened ✓" : "Read"}\nStep 2: Andar hi code blueprint bana raha hoon...`
    );

    const slottedCode = formatCodeWithSlots(currentState.code, currentState.lockedLines, editableSlots, currentState.partialLockedLines);
    const hasLocks = (currentState.lockedLines || []).length > 0 || (currentState.partialLockedLines || []).length > 0;

    const prompt = previousError
      ? `Fix this ${lang} error in the code below:\n${previousError}\n${errRequiredPkg ? `Line 1 MUST be '${errRequiredPkg}' and class MUST be '${errRequiredClass}'.\n` : ""}\nProblem:\n${problemText}\n\nCurrent Code:\n${hasLocks ? slottedCode : currentState.code}\n\nReturn ONLY the complete fixed ${lang} code inside a single triple-backtick code block (no explanations; keep all [LOCKED] lines unchanged and fill any [INLINE_BLANK] gaps cleanly).`
      : `Solve this ${lang} problem:\n${problemText}\n\nStarter Code:\n${hasLocks ? slottedCode : (currentState.code || "(empty)")}\n\nReturn ONLY the complete working ${lang} code inside a single triple-backtick code block (no explanations, preserve exact Python indentation & __init__, keep all [LOCKED] lines unchanged, and fill any [INLINE_BLANK] gaps cleanly).`;

    let liveScreenshot = null;
    let finalPrompt = prompt;
    if (Boolean(previousError) || attempt >= 2) {
      setStatus("Capturing screen...", "#60a5fa");
      setOutput("Error/test-case screen ka live screenshot lekar AI ko bhej raha hoon...");
      liveScreenshot = await captureCleanTabScreenshot();
    }
    const subject = detectSubject(lang, problemText);
    console.log("[CT-FSM] Ask AI", { attempt, subject, modelMode: getAiMode(), hasLocks, slots: editableSlots.map((s) => `${s.id}:${s.isInline ? "inline" : "block"}`) });
    const apiRes = await callGemini(finalPrompt, { expectJson: false, screenshot: liveScreenshot, subject });
    if (!apiRes.ok) {
      const failReason = /timeout/i.test(apiRes.error || "") ? "timeout" : "empty";
      console.log(`[GEMINI_FAIL_REASON: ${failReason}]`, apiRes.error);
      setStatus("API Error", "#f87171");
      setOutput(`Gemini Error:\n${apiRes.error}`);
      return;
    }

    const rawReply = (apiRes.rawText || "").trim();
    const fullFileLines = (currentState.code || "").replace(/\r\n/g, "\n").split("\n");
    const isPythonLang = /python/i.test(lang || "");
    // Match the file's exact indentation style: only use tabs if starter code explicitly has \t; otherwise use 4 spaces (CodeTantra CM6 default '····').
    const fileHasTabs = /(?:^|\n)\t/.test(currentState.code || "");
    const pythonUseTabs = isPythonLang && fileHasTabs;

    function normalizePythonIndent(codeStr) {
      return codeStr
        .split("\n")
        .map((line) => {
          const m = line.match(/^([ \t]+)(.*)$/);
          if (!m) return line;
          const ws = m[1];
          const rest = m[2];
          if (pythonUseTabs) {
            const expanded = ws.replace(/\t/g, "    ");
            const levels = Math.floor(expanded.length / 4);
            const rem = expanded.length % 4;
            return "\t".repeat(levels) + (rem >= 2 ? "\t" : "") + rest;
          } else {
            return ws.replace(/\t/g, "    ") + rest;
          }
        })
        .join("\n");
    }

    function cleanSlotCode(slotMeta, codeStr) {
      let c = (codeStr || "").replace(/\r\n/g, "\n");
      // Strip fenced wrappers outside/inside slot body without eating line-1 leading indentation
      c = c.replace(/^```[a-z0-9+#-]*[ \t]*\n/i, "").replace(/\n[ \t]*```[ \t]*$/g, "");
      c = c.replace(/^```[a-z0-9+#-]*[ \t]*|[ \t]*```$/gi, "");
      // Strip any nested/stray <<<SLOT N>>> or <<<END_SLOT N>>> tags so they NEVER get typed into the editor!
      c = c.replace(/^[ \t]*<<<\s*(?:END_)?SLOT\s*\d+\s*>>>[ \t]*$/gim, "").replace(/^\n+|\n+$/g, "");
      if (isPythonLang) {
        c = c.replace(/^(\s*def\s+)init(\s*\()/gm, "$1__init__$2").replace(/^(\s*def\s+)str(\s*\()/gm, "$1__str__$2");
        c = normalizePythonIndent(c);
      }
      if (slotMeta?.isInline) {
        const singleLine = c.split("\n").map((l) => l.trim()).filter(Boolean)[0] || c.trim();
        const origWs = ((fullFileLines[slotMeta.start_line - 1] || "").match(/^([ \t]*)/) || ["", ""])[1];
        return origWs + singleLine;
      }
      if (!slotMeta) return c;
      const slotLines = c.split("\n");
      const prevLockedRaw = slotMeta.start_line > 1 ? fullFileLines[slotMeta.start_line - 2] || "" : "";
      const prevLocked = prevLockedRaw.trim();
      const nextLocked = slotMeta.end_line < fullFileLines.length ? (fullFileLines[slotMeta.end_line] || "").trim() : "";
      if (prevLocked && slotLines.length > 1 && slotLines[0].trim() === prevLocked) slotLines.shift();
      if (nextLocked && slotLines.length > 1 && slotLines[slotLines.length - 1].trim() === nextLocked) slotLines.pop();

      // PYTHON BLOCK-START GUARD: If the [LOCKED] line immediately above this slot ends with ':' (e.g. 'class Employee:'),
      // the first non-empty line inside this slot MUST be indented 1 level deeper than that locked header!
      if (isPythonLang && /:\s*(#.*)?$/.test(prevLocked)) {
        const unit = pythonUseTabs ? "\t" : "    ";
        const prevIndentMatch = prevLockedRaw.match(/^([ \t]*)/);
        const prevIndentNorm = prevIndentMatch ? normalizePythonIndent(prevIndentMatch[1] + "x").slice(0, -1) : "";
        const requiredIndent = prevIndentNorm + unit;
        const firstNonEmptyIdx = slotLines.findIndex((l) => l.trim().length > 0);
        if (firstNonEmptyIdx !== -1) {
          const firstLine = slotLines[firstNonEmptyIdx];
          const firstWs = (firstLine.match(/^([ \t]*)/) || ["", ""])[1];
          if (firstWs.length <= prevIndentNorm.length) {
            const otherIndented = slotLines.slice(firstNonEmptyIdx + 1).some((l) => l.trim().length > 0 && l.startsWith(requiredIndent));
            if (otherIndented) {
              slotLines[firstNonEmptyIdx] = requiredIndent + firstLine.trimStart();
            } else {
              for (let k = firstNonEmptyIdx; k < slotLines.length; k++) {
                if (slotLines[k].trim().length > 0) slotLines[k] = unit + slotLines[k];
              }
            }
          }
        }
      }
      return slotLines.join("\n");
    }

    let parsed = { notes: "" };
    let edits = [];
    let parseTier = "none";

    function extractSlotEditsFromFullCode(starterCode, aiRawCode, lockedList, partialList, slots, inlineBlanksMeta = []) {
      let cleanedAi = (aiRawCode || "").replace(/\r\n/g, "\n");
      cleanedAi = cleanedAi.replace(/^```[a-z0-9+#-]*[ \t]*\n/i, "").replace(/\n[ \t]*```[ \t]*$/g, "").replace(/^\n+|\n+$/g, "");
      if (!cleanedAi.trim()) return [];

      const lockedArr = lockedList || [];
      const partialArr = partialList || [];
      if (lockedArr.length === 0 && partialArr.length === 0) {
        return [{ mode: "replace_all", start_line: 1, end_line: 1, code: cleanSlotCode(null, cleanedAi) }];
      }

      const starterLines = (starterCode || "").replace(/\r\n/g, "\n").split("\n");
      const aiLines = cleanedAi.split("\n");
      const lockedSet = new Set(lockedArr);
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const inlineMetaByLine = new Map((inlineBlanksMeta || []).map((b) => [b.line, b]));

      // Existing locked lines set (prevent duplicating any locked/inline line into an editable_block!)
      const existingProtectedNorms = new Set();
      for (const ln of lockedArr) {
        const n = norm(starterLines[ln - 1]);
        if (n) existingProtectedNorms.add(n);
      }

      // Match [LOCKED] lines monotonically in aiLines as anchors
      const anchorMap = new Map();
      let aiCursor = 0;
      let nonEmptyLockedTotal = 0;
      for (let ln = 1; ln <= starterLines.length; ln++) {
        if (!lockedSet.has(ln)) continue;
        const target = norm(starterLines[ln - 1]);
        if (!target) continue;
        nonEmptyLockedTotal++;
        for (let j = aiCursor; j < aiLines.length; j++) {
          if (norm(aiLines[j]) === target) {
            anchorMap.set(ln, j);
            aiCursor = j + 1;
            break;
          }
        }
      }

      if (nonEmptyLockedTotal >= 2 && anchorMap.size < Math.ceil(nonEmptyLockedTotal * 0.3) && slots.length === 1) {
        return [{
          mode: "replace_lines",
          start_line: slots[0].start_line,
          end_line: slots[0].end_line,
          isInline: Boolean(slots[0].isInline),
          code: cleanSlotCode(slots[0], cleanedAi)
        }];
      }

      const outEdits = [];
      const consumedAiIndices = new Set();

      // STEP A: Fill Inline Blanks FIRST & mark matched Gemini lines as consumed!
      for (const slot of slots) {
        if (!slot.isInline) continue;
        const origLine = starterLines[slot.start_line - 1] || "";
        const meta = inlineMetaByLine.get(slot.start_line);
        const gapM = origLine.match(/^([ \t]*\S.*?)([ \t]{3,})(\S.*)?$/);
        const lockedPrefix = meta?.lockedPrefix ?? (gapM ? gapM[1] : "");
        const lockedSuffix = meta?.lockedSuffix ?? (gapM ? (gapM[3] || "") : "");
        const prefTrim = lockedPrefix.trim();
        const sufTrim = lockedSuffix.trim();

        let prevAiIdx = -1;
        for (let ln = slot.start_line - 1; ln >= 1; ln--) {
          if (anchorMap.has(ln)) { prevAiIdx = anchorMap.get(ln); break; }
        }
        let nextAiIdx = aiLines.length;
        for (let ln = slot.end_line + 1; ln <= starterLines.length; ln++) {
          if (anchorMap.has(ln)) { nextAiIdx = anchorMap.get(ln); break; }
        }

        const findMatchIdx = (startI, endI) => {
          if (prefTrim) {
            if (sufTrim) {
              for (let j = startI; j < endI; j++) {
                if (!consumedAiIndices.has(j) && aiLines[j].trim().startsWith(prefTrim) && aiLines[j].includes(sufTrim)) return j;
              }
            }
            for (let j = startI; j < endI; j++) {
              if (!consumedAiIndices.has(j) && aiLines[j].trim().startsWith(prefTrim)) return j;
            }
          }
          for (let j = startI; j < endI; j++) {
            if (!consumedAiIndices.has(j) && aiLines[j].trim().length > 0) return j;
          }
          return -1;
        };

        let matchedIdx = findMatchIdx(prevAiIdx + 1, nextAiIdx);
        if (matchedIdx === -1) matchedIdx = findMatchIdx(0, aiLines.length);

        if (matchedIdx !== -1) {
          consumedAiIndices.add(matchedIdx);
          const rawMatched = aiLines[matchedIdx];
          let innerCode = rawMatched.trim();
          if (prefTrim && innerCode.startsWith(prefTrim)) innerCode = innerCode.slice(prefTrim.length).trim();
          if (sufTrim && innerCode.endsWith(sufTrim)) innerCode = innerCode.slice(0, innerCode.length - sufTrim.length).trim();
          else if (sufTrim.startsWith("#")) innerCode = innerCode.replace(/\s*#.*$/, "").trim();

          if (innerCode) {
            console.log(`[CT-EDIT] Line ${slot.start_line} (inline_blank): matched ${JSON.stringify(innerCode)}`);
            outEdits.push({
              mode: "replace_lines",
              start_line: slot.start_line,
              end_line: slot.end_line,
              isInline: true,
              gapStart: meta?.gapStart,
              gapEnd: meta?.gapEnd,
              lockedPrefix,
              lockedSuffix,
              innerCode,
              code: cleanSlotCode(slot, rawMatched)
            });
          }
        }
      }

      // STEP B: Fill Full Editable Blocks Only Where Needed (exclude consumed inline lines & duplicate locked lines!)
      for (const slot of slots) {
        if (slot.isInline) continue;
        let prevAiIdx = -1;
        for (let ln = slot.start_line - 1; ln >= 1; ln--) {
          if (anchorMap.has(ln)) { prevAiIdx = anchorMap.get(ln); break; }
        }
        let nextAiIdx = aiLines.length;
        for (let ln = slot.end_line + 1; ln <= starterLines.length; ln++) {
          if (anchorMap.has(ln)) { nextAiIdx = anchorMap.get(ln); break; }
        }

        const filteredLines = [];
        for (let j = prevAiIdx + 1; j < nextAiIdx; j++) {
          if (consumedAiIndices.has(j)) continue;
          const lineN = norm(aiLines[j]);
          if (lineN && existingProtectedNorms.has(lineN)) continue;
          let matchesInlinePrefix = false;
          for (const ln of partialArr) {
            const bMeta = inlineMetaByLine.get(ln);
            const pTrim = (bMeta?.lockedPrefix || "").trim();
            if (pTrim && aiLines[j].trim().startsWith(pTrim)) { matchesInlinePrefix = true; break; }
          }
          if (matchesInlinePrefix) continue;
          filteredLines.push(aiLines[j]);
        }

        const blockText = filteredLines.join("\n").replace(/^\n+|\n+$/g, "");
        if (!blockText.trim()) continue;
        const cleanedBlock = cleanSlotCode(slot, blockText);
        if (norm(cleanedBlock) === norm(slot.code)) continue;

        console.log(`[CT-EDIT] Block L${slot.start_line}-L${slot.end_line}: ${cleanedBlock.split("\n").length} line(s)`);
        outEdits.push({
          mode: "replace_lines",
          start_line: slot.start_line,
          end_line: slot.end_line,
          isInline: false,
          code: cleanedBlock
        });
      }
      return outEdits;
    }

    // TIER 1 (Primary Anchor-Based Diff on Fenced Code Block): Works naturally with full Gemini code!
    const fenceBlocks = [];
    const fenceRe = /```(?!json\b)[a-z0-9+#-]*[ \t]*\r?\n([\s\S]*?)```/gi;
    let fm;
    while ((fm = fenceRe.exec(rawReply)) !== null) {
      if ((fm[1] || "").trim().length > 10 && !/<<<\s*SLOT\s*\d+\s*>>>/i.test(fm[1])) {
        fenceBlocks.push(fm[1]);
      }
    }
    const bestFence = fenceBlocks.sort((a, b) => b.length - a.length)[0];
    if (bestFence) {
      const anchored = extractSlotEditsFromFullCode(
        currentState.code,
        bestFence,
        currentState.lockedLines,
        currentState.partialLockedLines,
        editableSlots,
        currentState.inlineBlanks || []
      );
      if (anchored.length > 0) {
        parseTier = "anchor-diff";
        edits = anchored;
      }
    }

    // TIER 2 (JSON Backup): Parse {"1": "...", "2": "..."} or {"slots": [...]} or {"edits": [...]}
    if (!edits.length) {
      try {
        const maybeJson = JSON.parse(extractJsonFromText(rawReply));
        if (maybeJson && typeof maybeJson === "object" && !Array.isArray(maybeJson)) {
          parsed = maybeJson;
          if (Array.isArray(maybeJson.slots) && maybeJson.slots.length > 0) {
            parseTier = "json-slots";
            for (const s of maybeJson.slots) {
              if (!s || typeof s.code !== "string") continue;
              const slotMeta = editableSlots.find((m) => m.id === Number(s.id)) || (editableSlots.length === 1 ? editableSlots[0] : null);
              if (slotMeta) {
                edits.push({
                  mode: (currentState.lockedLines || []).length === 0 && editableSlots.length === 1 && !slotMeta.isInline ? "replace_all" : "replace_lines",
                  start_line: slotMeta.start_line,
                  end_line: slotMeta.end_line,
                  isInline: Boolean(slotMeta.isInline),
                  code: cleanSlotCode(slotMeta, s.code)
                });
              } else if ((currentState.lockedLines || []).length === 0) {
                edits.push({ mode: "replace_all", start_line: 1, end_line: 1, code: cleanSlotCode(null, s.code) });
              }
            }
          } else if (Array.isArray(maybeJson.edits) && maybeJson.edits.length > 0) {
            parseTier = "json-edits";
            edits = maybeJson.edits;
          } else if (typeof maybeJson.code === "string" && maybeJson.code.trim()) {
            parseTier = "json-code";
            edits = [{ mode: maybeJson.mode || "replace_all", start_line: maybeJson.start_line || 1, end_line: maybeJson.end_line || 1, code: maybeJson.code }];
          } else {
            const numKeys = Object.keys(maybeJson).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
            if (numKeys.length > 0) {
              parseTier = "json-map";
              for (const k of numKeys) {
                const val = maybeJson[k];
                if (typeof val !== "string" || !val.trim()) continue;
                const slotMeta = editableSlots.find((m) => m.id === Number(k)) || (editableSlots.length === 1 ? editableSlots[0] : null);
                if (slotMeta) {
                  edits.push({
                    mode: (currentState.lockedLines || []).length === 0 && editableSlots.length === 1 && !slotMeta.isInline ? "replace_all" : "replace_lines",
                    start_line: slotMeta.start_line,
                    end_line: slotMeta.end_line,
                    isInline: Boolean(slotMeta.isInline),
                    code: cleanSlotCode(slotMeta, val)
                  });
                } else if ((currentState.lockedLines || []).length === 0) {
                  edits.push({ mode: "replace_all", start_line: 1, end_line: 1, code: cleanSlotCode(null, val) });
                }
              }
            }
          }
        }
      } catch {}
    }

    // TIER 3 (Forgiving <<<SLOT N>>> Fallback)
    if (!edits.length) {
      const slotRegex = /<<<\s*SLOT\s*(\d+)\s*>>>[ \t]*\r?\n?([\s\S]*?)(?:\r?\n?[ \t]*<<<\s*END_SLOT\s*\1\s*>>>|$)/gi;
      let sm;
      while ((sm = slotRegex.exec(rawReply)) !== null) {
        const slotId = parseInt(sm[1], 10);
        const rawSlotBody = (sm[2] || "").replace(/\n+$/, "");
        if (!rawSlotBody.trim()) continue;
        const slotMeta = editableSlots.find((m) => m.id === slotId) || (editableSlots.length === 1 ? editableSlots[0] : null);
        parseTier = "slot-tags";
        if (slotMeta) {
          edits.push({
            mode: (currentState.lockedLines || []).length === 0 && editableSlots.length === 1 && !slotMeta.isInline ? "replace_all" : "replace_lines",
            start_line: slotMeta.start_line,
            end_line: slotMeta.end_line,
            isInline: Boolean(slotMeta.isInline),
            code: cleanSlotCode(slotMeta, rawSlotBody)
          });
        } else if ((currentState.lockedLines || []).length === 0) {
          edits.push({ mode: "replace_all", start_line: 1, end_line: 1, code: cleanSlotCode(null, rawSlotBody) });
        }
      }
    }

    console.log("[CT-PARSE]", { parseTier, editsCount: edits.length, rawLen: rawReply.length });

    // Guard against malformed multi-Full hallucinated arrays
    if (edits.length > 1 && edits.every((e) => e.mode === "replace_all" || !e.start_line)) {
      edits = [{ mode: "replace_all", start_line: 1, end_line: 1, code: edits.map((e) => e.code || "").join("\n") }];
    } else if (edits.length > 12) {
      previousError = (previousError ? previousError + "\n" : "") + "Return 1 clean JSON key per editable slot.";
      setStatus(`Cleanup retry (${attempt})...`, "#facc15");
      continue;
    }

    if (!edits.length) {
      console.warn("[GEMINI_FAIL_REASON: parse_failed]", rawReply.slice(0, 200));
      if (attempt < MAX_FIX_ATTEMPTS) {
        previousError =
          (previousError ? previousError + "\n" : "") +
          'CRITICAL: Return ONLY a valid JSON object mapping slot numbers to code, e.g. {"1": "..."}.';
        setStatus(`Format retry (${attempt})...`, "#facc15");
        continue;
      }
      failedUrls.add(window.location.href);
      setStatus("Paused (no code)", "#facc15");
      setOutput("Gemini se code extract nahi ho paya (3 tries complete). Raw reply check karo ya 'Solve & Type' dabao.");
      return;
    }

    // HARD SLOT-TAG GUARD: Never inject raw <<<SLOT or <<<END_SLOT tags into CodeTantra editor!
    if (edits.some((e) => /<<<\s*(?:END_)?SLOT/i.test(e.code || ""))) {
      console.warn("[GEMINI_FAIL_REASON: guard_rejected]", "stray SLOT tag in parsed code");
      edits = edits.map((e) => ({
        ...e,
        code: (e.code || "").replace(/^[ \t]*<<<\s*(?:END_)?SLOT\s*\d+\s*>>>[ \t]*$/gim, "").trim()
      }));
    }

    // INTERNAL SELF-TEST BEFORE TYPING: Assemble full code + verify against Sample Test Cases!
    function assembleCode(origCode, editList) {
      const lines = (origCode || "").replace(/\r\n/g, "\n").split("\n");
      const sorted = [...editList].sort((a, b) => (b.start_line || 1) - (a.start_line || 1));
      for (const e of sorted) {
        const newLines = (e.code || "").replace(/\r\n/g, "\n").split("\n");
        if (e.mode === "replace_all" || !e.start_line) return newLines.join("\n");
        const s = Math.max(0, Math.min(e.start_line - 1, lines.length));
        const endIdx = Math.max(s, Math.min((e.end_line || e.start_line) - 1, lines.length - 1));
        lines.splice(s, endIdx - s + 1, ...newLines);
      }
      return lines.join("\n");
    }

    const assembledPreview = assembleCode(currentState.code, edits);

    // INLINE_BLANK COMPLETENESS GUARD: Never submit if an [INLINE_BLANK] line was left unfilled!
    if ((currentState.partialLockedLines || []).length > 0 && attempt < MAX_FIX_ATTEMPTS) {
      const previewLines = assembledPreview.split("\n");
      const origLines = (currentState.code || "").replace(/\r\n/g, "\n").split("\n");
      const unfilledLn = (currentState.partialLockedLines || []).find((ln) => {
        const pLine = previewLines[ln - 1] || "";
        const oLine = origLines[ln - 1] || "";
        return /\S\s{3,}\S/.test(pLine) || (pLine === oLine && /\S\s{2,}\S/.test(oLine));
      });
      if (unfilledLn) {
        console.warn("[GEMINI_FAIL_REASON: guard_rejected]", `inline blank unfilled at L${unfilledLn}`);
        const blankSlot = editableSlots.find((s) => s.start_line === unfilledLn && s.end_line === unfilledLn);
        previousError =
          `CRITICAL: You left [INLINE_BLANK] on Line ${unfilledLn} UNFILLED! Return JSON {"${blankSlot ? blankSlot.id : 1}": "<completed line>"} filling the white gap inside '${(origLines[unfilledLn - 1] || "").trim()}'.`;
        setStatus(`Blank missed (${attempt})...`, "#facc15");
        setOutput(`AI ne Line ${unfilledLn} ka [INLINE_BLANK] khali chhod diya — Submit nahi kar raha, dobara fill maang raha hoon...`);
        continue;
      }
    }

    const allSlotsInline = editableSlots.length > 0 && editableSlots.every((s) => s.isInline);

    // PYTHON INDENTATION GUARD: Skip when all slots are single-line inline blanks OR when target line is an inline_blank!
    if (isPythonLang && !allSlotsInline && attempt < MAX_FIX_ATTEMPTS) {
      const pyLines = assembledPreview.split("\n");
      const inlineLineSet = new Set(currentState.partialLockedLines || []);
      let badIndentLine = -1;
      for (let pi = 0; pi < pyLines.length - 1; pi++) {
        const cur = pyLines[pi];
        if (!/^[ \t]*(?:class|def|if|elif|else|for|while|with|try|except|finally)\b[^#]*:[ \t]*(?:#.*)?$/.test(cur)) continue;
        const curIndent = (cur.match(/^([ \t]*)/) || ["", ""])[1].length;
        let nextIdx = pi + 1;
        while (nextIdx < pyLines.length && (!pyLines[nextIdx].trim() || /^\s*#/.test(pyLines[nextIdx]))) nextIdx++;
        if (nextIdx < pyLines.length && !inlineLineSet.has(nextIdx + 1)) {
          const nxtIndent = (pyLines[nextIdx].match(/^([ \t]*)/) || ["", ""])[1].length;
          if (nxtIndent <= curIndent) {
            badIndentLine = nextIdx + 1;
            break;
          }
        }
      }
      if (badIndentLine !== -1) {
        console.log("[GEMINI_FAIL_REASON: guard_rejected]", `python indent error at L${badIndentLine}`);
        previousError =
          (previousError ? previousError + "\n" : "") +
          `CRITICAL PYTHON INDENTATION ERROR at Line ${badIndentLine}: Line ${badIndentLine} MUST be indented deeper than the ':' header above it!`;
        setStatus(`Indent retry (${attempt})...`, "#facc15");
        setOutput(`Line ${badIndentLine} par Python indentation missing thi — dobara sahi indentation maang raha hoon...`);
        continue;
      }
    }

    // JAVA / C / C++ BRACE-BALANCE GUARD: Skip when all slots are single-line inline blanks!
    if (/java|cpp|c\b/i.test(lang || "") && !allSlotsInline && attempt < MAX_FIX_ATTEMPTS) {
      const stripped = assembledPreview
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
      const opens = (stripped.match(/\{/g) || []).length;
      const closes = (stripped.match(/\}/g) || []).length;
      if (opens !== closes) {
        console.warn("[GEMINI_FAIL_REASON: guard_rejected]", `brace mismatch ${opens} vs ${closes}`);
        previousError =
          (previousError ? previousError + "\n" : "") +
          `CRITICAL BRACE MISMATCH: Assembled code has ${opens} '{' vs ${closes} '}'! Close every method/if/else block properly with '}' before the next [LOCKED] line.`;
        setStatus(`Brace retry (${attempt})...`, "#facc15");
        setOutput(`Java/C brace mismatch (${opens} '{' vs ${closes} '}') — Submit nahi kar raha, AI se fix maang raha hoon...`);
        continue;
      }
    }

    // SAME-CODE LOOP BREAKER: Never waste time deleting & retyping the EXACT same broken code!
    const codeFingerprint = assembledPreview.replace(/\s+/g, " ").trim();
    if (attempt > 1 && codeFingerprint && codeFingerprint === lastTypedCodeFingerprint) {
      consecutiveSameCode++;
      if (attempt < MAX_FIX_ATTEMPTS) {
        previousError =
          `STOP! You returned the EXACT SAME BROKEN CODE that already failed! You MUST actually fix the bug below:\n` +
          (previousError || "Fix the compilation/test-case error.");
        setStatus(`Same code — switching AI...`, "#facc15");
        setOutput("AI ne exact wahi purana galat code de diya — dobara type nahi kar raha, ChatGPT/fresh fix try kar raha hoon...");
        continue;
      }
    } else {
      consecutiveSameCode = 0;
      lastTypedCodeFingerprint = codeFingerprint;
    }
    const origPkg = (currentState.code || "").match(/^\s*package\s+[^;]+;/m)?.[0] || errRequiredPkg || "";
    const origPubClass = (currentState.code || "").match(/public\s+class\s+([A-Za-z0-9_]+)/)?.[1] || errRequiredClass || "";
    const structuralWarnings = [];
    if (origPkg && !assembledPreview.includes(origPkg.trim())) {
      structuralWarnings.push("MISSING PACKAGE DECLARATION: Starter code requires " + origPkg.trim());
    }
    if (origPubClass && !new RegExp("public\\s+class\\s+" + origPubClass + "\\b").test(assembledPreview)) {
      structuralWarnings.push("MISSING PUBLIC CLASS: Starter code requires public class " + origPubClass);
    }

    // Step 3 (Quota-smart): Run internal QA pass ONLY when structural warnings exist (never burn extra quota on retries!)
    const needQaPass = structuralWarnings.length > 0;
    for (let vPass = 1; vPass <= (needQaPass ? 1 : 0); vPass++) {
      const previewNow = assembleCode(currentState.code, edits);
      const warningsNow = [];
      if (origPkg && !previewNow.includes(origPkg.trim())) {
        warningsNow.push("MISSING PACKAGE DECLARATION: Starter code requires " + origPkg.trim());
      }
      if (origPubClass && !new RegExp("public\\s+class\\s+" + origPubClass + "\\b").test(previewNow)) {
        warningsNow.push("MISSING PUBLIC CLASS: Starter code requires public class " + origPubClass);
      }

      setStatus(`Self-testing (${vPass}/2)...`, "#60a5fa");
      setOutput(`Step 3 (${vPass}/2): Blueprint ko Sample Test Cases par andar test kar raha hoon...`);

      const verifyPrompt = `You are a strict compiler & QA test-case verifier for ${lang}.

Problem Statement, Sample Test Cases & Question Hints:
${problemText}

Original Starter Code (with [LOCKED] vs [EDITABLE] lines):
${numberedStarter}

Proposed Final Assembled Program:
${previewNow}
${warningsNow.length ? "\nCRITICAL ERRORS DETECTED:\n" + warningsNow.join("\n") + "\n" : ""}
Task:
1. Check for ANY SyntaxError, IndentationError (exact 4-space Python indentation!), missing Java 'package ...;' or 'public class ...' name, NameError, or modified [LOCKED] lines.
2. Trace and execute the Proposed Final Assembled Program step-by-step on EVERY Sample Test Case input and compare stdout character-for-character (spaces, colons, newlines, capitalization) with Expected Output.
3. If it compiles cleanly AND matches Expected Output 100% character-for-character, return:
{ "verified": true }
4. If there is ANY bug, missing package/class name, indentation error, or output mismatch, fix the blueprint and return:
{ "verified": false, "edits": [ ...exact corrected edits replacing ONLY [EDITABLE] lines... ], "reason": "what was fixed" }`;

      try {
        const verRes = await callGemini(verifyPrompt);
        if (!verRes.ok) break;
        const verClean = verRes.rawText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
        const verParsed = JSON.parse(verClean);
        if (verParsed.verified === true) {
          setOutput(`Blueprint 100% verified ✓\nAb final code ek side se slow type kar raha hoon...`);
          break;
        }
        if (verParsed.verified === false && Array.isArray(verParsed.edits) && verParsed.edits.length > 0) {
          edits = verParsed.edits;
          setOutput(`Internal QA mein issue fix kiya:\n${verParsed.reason || "Output/syntax fixed"}`);
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    // HARD CODE-LEVEL ENFORCEMENT: Never allow Java package declaration to be dropped!
    const finalAssembledCheck = assembleCode(currentState.code, edits);
    if (origPkg && !finalAssembledCheck.includes(origPkg.trim())) {
      if (edits.length === 1 && edits[0].mode === "replace_all") {
        edits[0].code = `${origPkg.trim()}\n${edits[0].code}`;
      } else if (!(currentState.lockedLines || []).includes(1)) {
        const firstLine = (currentState.code || "").split("\n")[0] || "";
        edits.unshift({ mode: "replace_lines", start_line: 1, end_line: 1, code: `${origPkg.trim()}\n${firstLine}` });
      }
    }

    // CODE-LEVEL SURGICAL DIFF GUARD: On Attempt > 1 (or whenever code already exists in editor), NEVER delete unchanged lines!
    // Even if Gemini returns 'replace_all', trim identical top/bottom lines so ONLY the actual changed lines are edited!
    function computeSurgicalDiffEdit(oldCode, newCode, lockedList) {
      const oldLines = (oldCode || "").replace(/\r\n/g, "\n").split("\n");
      const newLines = (newCode || "").replace(/\r\n/g, "\n").split("\n");
      if (oldLines.length < 5) return null;
      const lockedSet = new Set(lockedList || []);
      let prefix = 0;
      while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
        prefix++;
      }
      let suffix = 0;
      while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
      ) {
        suffix++;
      }
      if (prefix + suffix >= oldLines.length && prefix + suffix >= newLines.length) return null;
      let startLine = prefix + 1;
      let endLine = oldLines.length - suffix;
      if (startLine > endLine) {
        if (prefix > 0 && !lockedSet.has(prefix)) {
          startLine = prefix;
          endLine = prefix;
          const inserted = [oldLines[prefix - 1], ...newLines.slice(prefix, newLines.length - suffix)];
          return { mode: "replace_lines", start_line: startLine, end_line: endLine, code: inserted.join("\n") };
        } else if (startLine <= oldLines.length && !lockedSet.has(startLine)) {
          endLine = startLine;
          const inserted = [...newLines.slice(prefix, newLines.length - suffix), oldLines[startLine - 1]];
          return { mode: "replace_lines", start_line: startLine, end_line: endLine, code: inserted.join("\n") };
        }
        return null;
      }
      for (let ln = startLine; ln <= endLine; ln++) {
        if (lockedSet.has(ln)) return null;
      }
      const changedSlice = newLines.slice(prefix, newLines.length - suffix);
      return { mode: "replace_lines", start_line: startLine, end_line: endLine, code: changedSlice.join("\n") };
    }

    // SURGICAL DIFF FIRST: Whenever code already exists and we are fixing an error, ONLY retype the actual changed lines instead of deleting & retyping unchanged lines!
    if ((attempt > 1 || Boolean(previousError)) && (currentState.code || "").split("\n").length >= 5) {
      const targetFull = assembleCode(currentState.code, edits);
      const surgical = computeSurgicalDiffEdit(currentState.code, targetFull, currentState.lockedLines);
      if (surgical) {
        edits = [surgical];
      } else {
        edits = edits.map((e) => ({
          ...e,
          mode: e.start_line >= 1 && e.mode !== "replace_all" ? "replace_lines" : e.mode || (e.start_line >= 1 ? "replace_lines" : "replace_all")
        }));
      }
    } else if (attempt === 1 && (currentState.lockedLines || []).length === 0 && edits.length > 1) {
      const mergedCode = assembleCode(currentState.code, edits);
      if (mergedCode && mergedCode.trim().length > 10) {
        edits = [{ mode: "replace_all", start_line: 1, end_line: 1, code: mergedCode }];
      }
    } else {
      edits = edits.map((e) => ({
        ...e,
        mode: e.start_line >= 1 && e.mode !== "replace_all" ? "replace_lines" : e.mode || (e.start_line >= 1 ? "replace_lines" : "replace_all")
      }));
    }

    // User-controlled Typing Speed from Speed Grid (1s-60s); surgical retry stays quick (~35%)
    const speedBaseMs = getTypingSpeedSec() * 1000;
    const targetTotalMs =
      attempt === 1
        ? randMs(Math.max(800, Math.round(speedBaseMs * 0.9)), Math.round(speedBaseMs * 1.1))
        : Math.max(1200, Math.round(speedBaseMs * 0.35));
    const blockSummary = edits
      .map((e) => (e.start_line >= 1 && e.mode !== "replace_all" ? `L${e.start_line}-L${e.end_line || e.start_line}` : "Full"))
      .join(", ");

    setOutput(
      `Model: ${apiRes.model}\nBlocks: ${blockSummary}\nTyping naturally (~${Math.round(targetTotalMs / 1000)}s)...\n${parsed.notes || ""}`
    );

    console.log("[CT-INJECT] Typing edits", edits.map((e) => ({ mode: e.mode, s: e.start_line, e: e.end_line, len: (e.code || "").length })));
    const typeRes = await callBridge("TYPE_CODE", { edits, targetTotalMs, lockedLines: currentState.lockedLines || [] }, 300000);
    if (!typeRes || !typeRes.ok) {
      const typeErr = typeRes?.error || "Typing fail/stop ho gayi.";
      if (/stopped by user/i.test(typeErr)) {
        setStatus("Typing stopped", "#facc15");
        setOutput(typeErr);
        return;
      }
      if (attempt < MAX_FIX_ATTEMPTS) {
        // Auto-click CodeTantra's Reset button so any garbled/half-typed lines are wiped back to clean starter code!
        setStatus("Resetting editor...", "#facc15");
        setOutput(`Editor typing issue (${typeErr}) — Reset button dabakar clean starter code wapas laa raha hoon...`);
        const rst = await callBridge("CLICK_BUTTON", { targets: ["reset", "reset code"] }, 3000);
        if (rst && rst.ok) {
          await sleep(600);
          await callBridge("CLICK_BUTTON", { targets: ["yes", "ok", "confirm", "reset"] }, 2500);
          await sleep(1200);
        }
        lastTypedCodeFingerprint = "";
        previousError =
          (previousError ? previousError + "\n" : "") +
          `EDITOR REJECTED PREVIOUS EDITS (editor was Reset to clean starter): ${typeErr}. Return valid replace_lines edits ONLY on [EDITABLE] lines (never replace_all, never overlap [LOCKED] lines).`;
        setStatus(`Edit retry (${attempt})...`, "#facc15");
        continue;
      }
      failedUrls.add(window.location.href);
      setStatus("Paused (edit err)", "#facc15");
      setOutput(`Typing blocked (${typeErr}) — infinite loop rok diya hai. 'Solve & Type' dabakar manual retry kar sakte ho.`);
      return;
    }

    setStatus("Typing done ✓", "#86efac");
    const codeFilled = Boolean(typeRes && typeRes.ok);

    if (!autoSubmitAndNext || !codeFilled) {
      setOutput(`Typing complete (${typeRes.type}, blocks: ${blockSummary}).\nAb Submit dabao ya Start Auto chalao.`);
      return;
    }

    await sleep(450);
    setStatus("Submitting code...", "#60a5fa");
    const subRes = await callBridge(
      "CLICK_BUTTON",
      { targets: ["submit", "submit code", "compile & run"], preferEditorSubmit: true },
      3000
    );

    if (!subRes || !subRes.ok) {
      apiCooldownUntil = Date.now() + 30000;
      setStatus("Submit btn missing", "#facc15");
      setOutput("Submit button click nahi hua — code ko dobara nahi likh raha. Ek baar manual Submit check karo.");
      return;
    }

    setStatus("Evaluating tests...", "#60a5fa");
    setOutput("Submit daba diya — test cases aur compiler output padhne ka wait kar raha hoon...");
    // Give CodeTantra 1.2s to clear old output & start compiling new submission
    await sleep(1200);

    let evalRes = { status: "unknown", summary: "" };
    for (let poll = 0; poll < 25; poll++) {
      await sleep(800);
      evalRes = await callBridge("EVAL_TESTS", {}, 12500);
      if (evalRes && (evalRes.status === "passed" || evalRes.status === "failed")) {
        break;
      }
    }

    // If test runner didn't show result yet, click bottom Submit pill once as backup and wait 10s
    if (evalRes.status === "unknown") {
      await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"] }, 2500);
      for (let poll = 0; poll < 12; poll++) {
        await sleep(800);
        evalRes = await callBridge("EVAL_TESTS", {}, 12500);
        if (evalRes && (evalRes.status === "passed" || evalRes.status === "failed")) {
          break;
        }
      }
    }

    if (evalRes.status === "passed") {
      solvedUrls.add(window.location.href);
      setStatus("100% Passed ✓", "#86efac");
      setOutput(`${evalRes.summary}\nSab test cases pass! Next question par jaa raha hoon...`);
      await sleep(800);
      await clickNextSlide();
      return;
    }

    // If test result is still hidden, click 'Test cases' tab once and re-check before giving up!
    if (evalRes.status === "unknown") {
      await callBridge("CLICK_BUTTON", { targets: ["test cases"] }, 2000);
      await sleep(1500);
      evalRes = await callBridge("EVAL_TESTS", {}, 12500);
    }
    if (evalRes.status === "unknown") {
      if (attempt < MAX_FIX_ATTEMPTS) {
        previousError = "Test cases tab did not show pass yet — re-checking code & Submit.";
        continue;
      }
      failedUrls.add(window.location.href);
      setStatus("Check Test Cases", "#facc15");
      setOutput("Code likh kar Submit daba diya tha, par test result screen par nahi mila — Test cases tab check karo.");
      return;
    }

    if (attempt === MAX_FIX_ATTEMPTS) {
      failedUrls.add(window.location.href);
      setStatus(`Paused (${MAX_FIX_ATTEMPTS}/${MAX_FIX_ATTEMPTS})`, "#facc15");
      setOutput(`${MAX_FIX_ATTEMPTS} tries ke baad ye error aaya:\n${(evalRes.summary || "Manual check needed.").slice(0, 320)}`);
      return;
    }

    previousError = evalRes.summary || "Some test cases failed. Check exact indentation and output format.";
    setOutput(`Test fail hua (Try ${attempt}/${MAX_FIX_ATTEMPTS}) — error padh kar fix kar raha hoon...\n${previousError.slice(0, 300)}`);
  }

  // Safety net: if all attempts ended via continue, pause this URL so runAutoTick NEVER loops every 1s!
  failedUrls.add(window.location.href);
  setStatus("Paused (check err)", "#facc15");
  setOutput(`${MAX_FIX_ATTEMPTS} tries complete ho gaye:\n${(previousError || "Manual check needed.").slice(0, 300)}`);
}

// ---------------- 2. OBJECTIVE / MCQ QUESTION SOLVER ----------------
async function solveMcqQuestion(mcqState, { autoSubmitAndNext = false } = {}) {
  // If already solved/Success on screen (e.g. user manually ticked right answer!), do NOT overwrite — just Next >!
  const preEval = await callBridge("EVAL_MCQ", {}, 1500);
  if (autoSubmitAndNext && preEval && preEval.status === "right") {
    solvedUrls.add(window.location.href);
    setStatus("Already Right ✓", "#86efac");
    setOutput("Quiz pehle se Right hai — Next par jaa raha hoon...");
    await sleep(900);
    await clickNextSlide();
    return;
  }

  const normOpt = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const comboKey = (arr) => [...new Set((arr || []).map(normOpt))].sort().join("|||");

  // Build ordered probability combinations (single options -> pairs -> triples) so we NEVER get stuck or repeat a wrong pick!
  function generateAllSubsets(opts, isMulti) {
    const list = [];
    if (!isMulti) {
      for (const o of opts) list.push([o]);
      return list;
    }
    const n = Math.min(opts.length, 5);
    for (let size = 1; size <= n; size++) {
      const backtrack = (start, cur) => {
        if (cur.length === size) {
          list.push([...cur]);
          return;
        }
        for (let i = start; i < n; i++) {
          cur.push(opts[i]);
          backtrack(i + 1, cur);
          cur.pop();
        }
      };
      backtrack(0, []);
    }
    return list;
  }

  const allCombos = generateAllSubsets(mcqState.options || [], mcqState.isMultiSelect);
  const MAX_MCQ_ATTEMPTS = Math.min(12, Math.max(4, allCombos.length));
  const wrongAttempts = [];
  const triedKeys = new Set();
  let lastFeedback = "";
  let screenCorrectAnswers = Array.isArray(preEval?.correctOptions) && preEval.correctOptions.length ? preEval.correctOptions : [];

  for (let attempt = 1; attempt <= MAX_MCQ_ATTEMPTS; attempt++) {
    let answers = [];
    let modelUsed = "Smart-Rotation";

    // PRIORITY 0: If CodeTantra ALREADY printed green 'Correct' labels on screen, tick ONLY those exact options immediately (zero guesswork!)
    if (screenCorrectAnswers.length > 0 && !triedKeys.has(comboKey(screenCorrectAnswers))) {
      answers = screenCorrectAnswers;
      modelUsed = "Screen-Correct ✓";
    } else if (attempt <= 3) {
      setStatus(attempt === 1 ? "Solving Quiz..." : attempt === 3 ? "Quiz: ChatGPT..." : `Quiz retry ${attempt}...`, "#60a5fa");
      setOutput(
        attempt === 1
          ? "Objective / Quiz question padh raha hoon..."
          : attempt === 3
          ? "Gemini 2 baar galat hua — ab ChatGPT (chatgpt.com) se poochh raha hoon..."
          : `Wrong answer aaya tha — naya option try kar raha hoon (Try ${attempt})...`
      );

      const wrongHistoryBlock = wrongAttempts.length
        ? `\nPREVIOUSLY TRIED & MARKED WRONG BY CODETANTRA (DO NOT REPEAT THESE EXACT SELECTIONS):\n${wrongAttempts
            .map((w, i) => `Attempt ${i + 1} (WRONG): ${JSON.stringify(w)}`)
            .join("\n")}\nFeedback shown: ${lastFeedback || "Wrong answer"}\n`
        : "";

      const prompt = `You are a computer science professor solving a CodeTantra Objective / Quiz Question (Python, Java, C++, Web Tech HTML/CSS/JS, DSA, etc.).

Question & Context:
${mcqState.questionText}

Available Options (copy EXACT verbatim option text from this list ONLY — preserve exact underscores like __add__, __gt__, __str__!):
${mcqState.options.map((o) => `- ${o}`).join("\n")}

Question Type: ${mcqState.isMultiSelect ? "Multiple-select (select ONLY the exact correct subset — do NOT blindly select all options!)" : "Single-choice (select EXACTLY ONE option)"}
${wrongHistoryBlock}
Wrap your JSON inside a triple-backtick json code block so underscores are NEVER stripped:
\`\`\`json
{
  "answers": ["Exact option text here"]
}
\`\`\``;

      try {
        const apiRes = await callGemini(prompt, { expectJson: true, subject: detectSubject("", mcqState.questionText) });
        if (apiRes.ok) {
          modelUsed = apiRes.model;
          const cleaned = apiRes.rawText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed.answers)) answers = parsed.answers;
        }
      } catch {}
    }

    // Probability/Combination Rotation: if Gemini failed OR returned an already-tried wrong combo OR attempt >= 3, pick next untried combination!
    if (!answers.length || triedKeys.has(comboKey(answers))) {
      const nextCombo = allCombos.find((c) => !triedKeys.has(comboKey(c)));
      if (!nextCombo) break;
      answers = nextCombo;
      modelUsed = "Smart-Rotation";
    }

    await sleep(randMs(700, 1200));
    const tickRes = await callBridge("TICK_MCQ", { answers }, 4000);
    if (!tickRes || !tickRes.ok) {
      triedKeys.add(comboKey(answers));
      continue;
    }

    const picked = tickRes.selected && tickRes.selected.length ? tickRes.selected : answers;
    triedKeys.add(comboKey(picked));
    setStatus(`Ticked (${tickRes.ticked}) ✓`, "#86efac");
    setOutput(`${modelUsed} | Try ${attempt}/${MAX_MCQ_ATTEMPTS}:\n${picked.map((a) => `✓ ${a}`).join("\n")}`);

    if (!autoSubmitAndNext) return;

    await sleep(500);
    const subRes = await callBridge("CLICK_BUTTON", { targets: ["submit", "check", "verify", "confirm"] }, 3000);
    if (!subRes || !subRes.ok) {
      setStatus("Submit btn missing", "#facc15");
      return;
    }

    setStatus("Checking answer...", "#60a5fa");
    let evalRes = { status: "unknown", feedback: "" };
    for (let poll = 0; poll < 14; poll++) {
      await sleep(250);
      evalRes = await callBridge("EVAL_MCQ", {}, 1500);
      if (evalRes && (evalRes.status === "right" || evalRes.status === "wrong")) {
        break;
      }
    }

    if (evalRes.status === "right") {
      solvedUrls.add(window.location.href);
      setStatus("Quiz Right ✓", "#86efac");
      setOutput(`Success confirmed!\n${evalRes.feedback || ""}\nAgle question par jaa raha hoon...`);
      await sleep(1400);
      await clickNextSlide();
      return;
    }

    if (Array.isArray(evalRes?.correctOptions) && evalRes.correctOptions.length > 0) {
      screenCorrectAnswers = evalRes.correctOptions;
    }
    wrongAttempts.push(picked);
    lastFeedback = evalRes.feedback || "Wrong answer";
    setStatus(screenCorrectAnswers.length ? "Fixing from labels..." : `Wrong (${attempt}) — rotating...`, "#f87171");
    setOutput(
      screenCorrectAnswers.length
        ? `Screen par 'Correct' options mil gaye — wahi exact options tick kar raha hoon...`
        : `Try ${attempt} galat tha — doosra option combination try kar raha hoon...`
    );
    await callBridge("CLICK_BUTTON", { targets: ["try again", "ok", "close", "retry"] }, 1500);
    await sleep(750);
  }

  apiCooldownUntil = Date.now() + 10000;
  setStatus("Check quiz answer", "#facc15");
  setOutput("Saare option combinations try ho gaye — ek baar check kar lo.");
}

// ---------------- Unified Slide Dispatcher ----------------
async function solveCurrentSlide({ autoSubmitAndNext = false } = {}) {
  if (!isAiReady()) {
    if (autoMode) setAutoMode(false);
    showApiKeyRequired();
    return;
  }
  if (isBusy) return;
  isBusy = true;

  const solveBtn = document.getElementById("ct-solve-one");
  if (solveBtn) solveBtn.innerText = "Stop";

  try {
    const edState = await callBridge("READ_EDITOR", {}, 10000);
    if (edState && edState.found) {
      await solveCodingProblem(edState, { autoSubmitAndNext });
      return;
    }

    const mcqState = await callBridge("READ_MCQ", {}, 3500);
    if (mcqState && mcqState.found) {
      await solveMcqQuestion(mcqState, { autoSubmitAndNext });
      return;
    }

    if (!autoSubmitAndNext) {
      setStatus("No task found", "#facc15");
      setOutput("Is slide par koi coding editor ya objective question nahi mila.");
    }
  } catch (err) {
    setStatus("Error", "#f87171");
    setOutput(`Error: ${err.message}`);
  } finally {
    isBusy = false;
    if (solveBtn) solveBtn.innerText = "Solve & Type";
  }
}

async function runAutoTick() {
  if (!autoMode || isBusy || tickInFlight) return;
  if (!isAiReady()) {
    setAutoMode(false);
    showApiKeyRequired();
    return;
  }
  tickInFlight = true;
  try {
    createPanel();

    if (window.location.href !== lastHashUrl) {
      lastHashUrl = window.location.href;
      slideEnteredAt = Date.now();
      apiCooldownUntil = 0;
      clearOutput();
    }

    if (Date.now() < apiCooldownUntil) {
      const secs = Math.ceil((apiCooldownUntil - Date.now()) / 1000);
      setStatus(`Retry in ${secs}s...`, "#facc15");
      return;
    }

    // Give CodeTantra SPA iframes, CodeMirror 6, and test panel 1.0s to mount & clear previous slide badges
    if (Date.now() - slideEnteredAt < 1000) {
      setStatus("Loading slide...", "#9ca3af");
      return;
    }

    // If this exact question already finished all attempts and failed, pause until user moves or clicks Solve & Type
    if (failedUrls.has(window.location.href)) {
      setStatus("Paused (check err)", "#facc15");
      return;
    }

    // Lightweight editor check (light: true -> NEVER scrolls editor up/down during idle/retry ticks!)
    const edState = await callBridge("READ_EDITOR", { light: true }, 3500);
    if (edState && edState.found) {
      await solveCurrentSlide({ autoSubmitAndNext: true });
      return;
    }

    const mcqState = await callBridge("READ_MCQ", {}, 2500);
    if (mcqState && mcqState.found) {
      await solveCurrentSlide({ autoSubmitAndNext: true });
      return;
    }

    if (solvedUrls.has(window.location.href)) {
      await clickNextSlide();
      return;
    }

    const vidRes = await callBridge("CHECK_VIDEO", {}, 1500);
    if (vidRes && vidRes.found) {
      if (vidRes.ended) {
        solvedUrls.add(window.location.href);
        await sleep(500);
        await clickNextSlide();
      } else {
        setStatus("Playing video...", "#86efac");
      }
      return;
    }

    // HARD SAFETY GUARDRAIL: Never click Next > if Submit/Reset/Test cases/Editor is still loading!
    const pending = await callBridge("CHECK_PENDING_TASK", {}, 2500);
    if (pending && pending.hasTask) {
      setStatus("Waiting editor...", "#60a5fa");
      return;
    }

    // If on an "About this unit" overview page (no editor/quiz/video/submit), open the first uncompleted card quickly
    if (Date.now() - slideEnteredAt >= 1200) {
      const beforeUrl = window.location.href;
      const unitRes = await callBridge("OPEN_UNIT_ITEM", {}, 2500);
      if (unitRes && unitRes.ok) {
        setStatus("Opening card...", "#86efac");
        setOutput(`Unit card open kar raha hoon:\n${unitRes.title || "First question"}`);
        await sleep(700);
        if (window.location.href !== beforeUrl) return;
      } else if (unitRes && unitRes.allCompleted) {
        // All cards in this unit are already green-ticked -> check left sidebar for next incomplete item!
        setStatus("Checking sidebar...", "#60a5fa");
        const sideRes = await callBridge("OPEN_NEXT_SIDEBAR_ITEM", {}, 3500);
        if (sideRes && sideRes.ok) {
          setStatus("Opening pending...", "#86efac");
          setOutput(`Sidebar se incomplete question khol raha hoon:\n${sideRes.title}`);
          await sleep(700);
          if (window.location.href !== beforeUrl) return;
        }
      }
    }

    // Only advance pure theory/reading slides calmly after 10 seconds
    if (Date.now() - slideEnteredAt >= 10000) {
      const moved = await clickNextSlide();
      if (moved) {
        solvedUrls.add(window.location.href);
      }
    } else {
      setStatus("Reading slide...", "#9ca3af");
    }
  } finally {
    tickInFlight = false;
  }
}

// ---------------- Boot ----------------
setTimeout(() => {
  createPanel();
  syncKeyBtn();
  if (!isAiReady()) {
    autoMode = false;
    sessionStorage.setItem("ct_auto_mode", "false");
    syncAutoUI();
  } else if (autoMode) {
    setAutoMode(true);
  }
}, 400);

setInterval(() => {
  if (!document.getElementById("ct-helper-panel")) {
    createPanel();
  }
}, 2500);
