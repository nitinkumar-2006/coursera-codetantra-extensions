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
} catch {}

// Live-benchmarked best models: gemini-3-flash-preview is #1 (2/2 OK, 0% 503, ~3.3s)
const VERIFIED_WORKING_MODELS = [
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite"
];

const BLOCKED_SLIDE_PATTERNS = [/\b29\.1\.6\b/i, /koko eating bananas/i];
function isBlockedSlideText(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return BLOCKED_SLIDE_PATTERNS.some((re) => re.test(t));
}

let cachedModelsByKey = new Map();
let failedModelUntil = new Map();
let apiCooldownUntil = 0;

const RETRYABLE_HTTP_CODES = new Set([400, 403, 404, 408, 429, 500, 502, 503, 504]);
const MAX_FIX_ATTEMPTS = 3;

let autoMode = false;
let autoInterval = null;
let isBusy = false;
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

if (hasValidApiKey() && sessionStorage.getItem("ct_auto_mode") === "true") {
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
    `;
    document.head.appendChild(styleTag);
  }

  const panel = document.createElement("div");
  panel.id = "ct-helper-panel";
  panel.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 999999;
    background: rgba(16, 18, 26, 0.62);
    backdrop-filter: blur(10px) saturate(150%);
    -webkit-backdrop-filter: blur(10px) saturate(150%);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 16px; padding: 13px; width: 355px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28);
    font-size: 12.5px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center; gap:6px;">
      <span style="display:flex; align-items:center; gap:4px; flex-wrap:nowrap;">
        <span style="color:#ffffff; white-space:nowrap;">CodeTantra</span>
        <span style="font-size:10px; background:rgba(10,12,18,0.65); border:1px solid rgba(255,255,255,0.22); color:#e5e7eb; padding:2px 5px; border-radius:6px;">v8.6</span>
        <button id="ct-set-key" class="ct-icon-btn ct-key-missing" title="Set CodeTantra-only Gemini API Key">Set Key</button>
        <button id="ct-scan-top" class="ct-icon-btn" title="Jump to topmost incomplete pink question">Top</button>
        <button id="ct-lang-btn" class="ct-icon-btn" title="Preferred language for multi-lang editors">Lang</button>
      </span>
      <span id="ct-status" style="color:#e5e7eb; font-size:11px; font-weight:500; max-width:112px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Idle</span>
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
    if (!hasValidApiKey()) {
      showApiKeyRequired();
      return;
    }
    apiCooldownUntil = 0;
    failedUrls.delete(window.location.href);
    solveCurrentSlide({ autoSubmitAndNext: false });
  });
  const langBtn = document.getElementById("ct-lang-btn");
  const langCycle = ["auto", "java", "python", "cpp", "c"];
  function syncLangBtn() {
    const cur = localStorage.getItem("ct_preferred_lang") || "auto";
    if (langBtn) langBtn.innerText = cur === "auto" ? "Lang" : cur.toUpperCase();
  }
  syncLangBtn();
  langBtn.addEventListener("click", () => {
    const cur = localStorage.getItem("ct_preferred_lang") || "auto";
    const next = langCycle[(langCycle.indexOf(cur) + 1) % langCycle.length];
    localStorage.setItem("ct_preferred_lang", next);
    syncLangBtn();
    setStatus(`Lang: ${next.toUpperCase()}`, "#86efac");
  });
  document.getElementById("ct-scan-top").addEventListener("click", async () => {
    if (isBusy) return;
    setStatus("Scanning top...", "#60a5fa");
    const res = await callBridge("OPEN_NEXT_SIDEBAR_ITEM", {}, 8000);
    if (res && res.ok) {
      setStatus("Opened top ✓", "#86efac");
      setOutput(`Sabse upar ka incomplete question khola:\n${res.title}`);
    } else {
      setStatus("None found", "#facc15");
    }
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
  if (autoMode && hasValidApiKey()) {
    btn.innerText = "Stop Auto";
    btn.classList.add("ct-glass-btn-running");
    setStatus("Running...", "#86efac");
  } else {
    btn.innerText = "Start Auto";
    btn.classList.remove("ct-glass-btn-running");
    if (!hasValidApiKey()) {
      setStatus("API Key Required", "#f87171");
    } else {
      setStatus("Stopped", "#d1d5db");
    }
  }
}

function setAutoMode(enabled) {
  if (enabled && !hasValidApiKey()) {
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
  autoInterval = setInterval(runAutoTick, 2000);
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
          (name.startsWith("gemini-") || name.startsWith("gemma-4-")) &&
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
  const cleaned = (raw || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

async function callGemini(prompt) {
  const apiKeys = getApiKeys();
  if (!apiKeys.length) {
    return {
      ok: false,
      error: "Koi valid Gemini API Key set nahi hai! Upar 'Key' button dabakar apni AIza... key paste karo."
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
      setStatus(`AI: ${model.replace("gemini-", "")} (K${kIdx + 1})`, "#60a5fa");
      setOutput(`Code generate kar raha hoon...\nModel: ${model} (Key ${kIdx + 1}/${apiKeys.length})${errorLogs.length ? "\nLast skipped: " + errorLogs[errorLogs.length - 1] : ""}`);
      try {
        const bodyObj = {
          contents: [{ parts: [{ text: prompt }] }]
        };
        if (!isGemma) {
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
            return { ok: true, model, rawText: extractJsonFromText(rawText) };
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
  // Step 0: If user selected a preferred language (e.g. JAVA/PYTHON) via 'Lang' button, ALWAYS switch multi-lang dropdown first!
  const prefLang = localStorage.getItem("ct_preferred_lang") || "auto";
  if (prefLang !== "auto" && (!edState.language || edState.language.toLowerCase() !== prefLang)) {
    setStatus(`Switching -> ${prefLang.toUpperCase()}`, "#60a5fa");
    const sw = await callBridge("SWITCH_LANG", { lang: prefLang }, 4000);
    if (sw && sw.ok && !sw.already) {
      const refreshed = await callBridge("READ_EDITOR", {}, 4500);
      if (refreshed && refreshed.found) edState = refreshed;
    }
  }

  // Step 1 (Fast): Open Sample Test Cases + Question Hints across ALL frames BEFORE building blueprint!
  setStatus("Opening test cases...", "#60a5fa");
  setOutput("Sample Test Cases aur Question Hints khol kar padh raha hoon...");
  const expandedInfo = await callBridge("EXPAND_PROBLEM_PANELS", {}, 5000);
  const problemText =
    expandedInfo && expandedInfo.problemText && expandedInfo.problemText.length > (edState.problemText || "").length
      ? expandedInfo.problemText
      : edState.problemText && edState.problemText.length > 60
      ? edState.problemText
      : (document.body.innerText || "").slice(0, 15000);
  const tcOpened = /test case\s*1/i.test(problemText);

  const existingEval = await callBridge("EVAL_TESTS", {}, 3000);
  if (autoSubmitAndNext && existingEval && existingEval.status === "passed") {
    solvedUrls.add(window.location.href);
    setStatus("Already Passed ✓", "#86efac");
    setOutput(`${existingEval.summary}\nAgle question par jaa raha hoon...`);
    await sleep(1200);
    await clickNextSlide();
    return;
  }

  function extractJavaPkgAndClassFromError(errText) {
    const txt = errText || "";
    const m1 = txt.match(/wrong name:\s*([a-zA-Z0-9_]+)\/([A-Za-z0-9_]+)/i);
    if (m1) return { pkg: `package ${m1[1]};`, cls: m1[2] };
    const m2 = txt.match(/(?:main class|ClassNotFoundException:)\s*([a-zA-Z0-9_]+)\.([A-Za-z0-9_]+)/i);
    if (m2) return { pkg: `package ${m2[1]};`, cls: m2[2] };
    return { pkg: "", cls: "" };
  }

  // Helper: Click CodeTantra's yellow Reset button (+ confirm modal if shown) to restore clean starter + pink locked lines
  async function resetCodeEditor(reasonText) {
    setStatus("Auto-Resetting...", "#facc15");
    setOutput(`${reasonText}\nReset button daba kar fresh starter code wapas laa raha hoon...`);
    const r1 = await callBridge("CLICK_BUTTON", { targets: ["reset", "reset code"] }, 3000);
    if (!r1 || !r1.ok) return false;
    await sleep(600);
    // Confirm reset popup if CodeTantra asks "Are you sure?"
    await callBridge("CLICK_BUTTON", { targets: ["yes", "confirm", "ok", "yes, reset"] }, 1500);
    await sleep(1500);
    return true;
  }

  // If previous run failed (e.g. NoClassDefFoundError / wrong name: q38399/...), read it immediately on Attempt 1!
  let previousError = existingEval && existingEval.status === "failed" ? existingEval.summary || "" : "";
  let { pkg: errRequiredPkg, cls: errRequiredClass } = extractJavaPkgAndClassFromError(previousError);

  // NEVER wipe working code with Reset on compiler/class errors — read the exact error and fix ONLY the broken line(s)!
  let activeEdState = edState;

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    let currentState = attempt === 1 ? activeEdState : await callBridge("READ_EDITOR", {}, 5000);
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
          evalRes = await callBridge("EVAL_TESTS", {}, 2000);
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

    const prompt = `You are a senior software engineer solving a CodeTantra coding problem (Python, Java, C++, C, etc.).

Detected Language: ${lang}

Problem Statement & Sample Test Cases:
${problemText}

${previousError ? `CRITICAL — SURGICAL FIX ONLY! READ THIS EXACT COMPILER / TEST-CASE ERROR AND FIX ONLY THE BROKEN LINE(S):\n${previousError}\n${errRequiredPkg ? `MANDATORY: Line 1 MUST have '${errRequiredPkg}' and the main class MUST be '${errRequiredClass}'!\n` : ""}FORBIDDEN: NEVER use "mode": "replace_all" and NEVER rewrite unchanged methods! Return ONLY the minimal "replace_lines" edit(s) for the exact broken line range!\n\n` : ""}Current Code in Editor (1-based line numbers with [LOCKED] vs [EDITABLE] hints):
${numberedStarter}
Return ONLY valid JSON in this exact format:
{
  "dry_run_output": "exact simulated stdout of the final complete program on Sample Test Case 1",
  "edits": [
    {
      "mode": "replace_lines",
      "start_line": 2,
      "end_line": 2,
      "code": "    def send(self):\\n        print(\\"Sending Email\\")"
    }
  ],
  "notes": "short 1-line summary"
}

Strict Rules:
- STRICT LANGUAGE RULE: Write the entire solution ONLY in ${lang}! NEVER write C/C++ (#include <stdio.h>) inside a Java/Python editor, and NEVER write Java inside a C/Python editor!
- GROUND TRUTH = SAMPLE TEST CASES! Before finalizing edits, mentally dry-run the ENTIRE program (all [LOCKED] lines + your [EDITABLE] edits) against Sample Test Case 1 and put the exact printed stdout in "dry_run_output". Your dry_run_output MUST match the Sample Test Cases Expected Output character-for-character (even if a comment in starter code says something extra like 'also prints parent method' — do NOT print extra lines that are NOT in Expected Output!).
- NEVER modify [LOCKED] lines!
- Carefully check ALL [EDITABLE] lines — including class/function headers (e.g. changing 'class Painter:' to 'class Painter(Participant):' when inheritance is needed!), blank [EDITABLE] lines, placeholder comments, AND any broken/leftover lines from a previous failed attempt (remove/replace them cleanly!). NEVER use hacks like '__bases__'!
- Replace ONLY [EDITABLE] lines using "mode": "replace_lines" with exact 1-based "start_line" and "end_line".
- CRITICAL INDENTATION (especially Python): Preserve exact 4-space indentation levels (e.g. 4 spaces inside class/def, 8 spaces inside method body). Never use inconsistent tabs/spaces!
- CRITICAL FOR JAVA / C++ / C: NEVER delete or rename existing 'package ...;' declarations, 'public class ...' names, imports, or starter class/method signatures! If starter code already exists (even if lines are [EDITABLE]), prefer "mode": "replace_lines" ONLY on the '// Fill the code...' / placeholder / buggy lines so you never break package or public class names!
- Only use "mode": "replace_all" when the editor is completely empty or has no starter structure; if using "replace_all", you MUST preserve the exact 'package ...;' and 'public class ...' name from the original starter code!
- No markdown code fences inside "code".`;

    const apiRes = await callGemini(prompt);
    if (!apiRes.ok) {
      setStatus("API Error", "#f87171");
      setOutput(`Gemini Error:\n${apiRes.error}`);
      return;
    }

    const cleaned = extractJsonFromText(apiRes.rawText);
    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      previousError = "Model returned invalid JSON — please return strictly valid JSON.";
      setStatus(`JSON retry (${attempt})...`, "#facc15");
      continue;
    }
    let edits = Array.isArray(parsed.edits)
      ? parsed.edits
      : parsed.code
      ? [{ mode: parsed.mode || "replace_all", start_line: parsed.start_line || 1, end_line: parsed.end_line || 1, code: parsed.code }]
      : [];

    // Guard against malformed multi-Full hallucinated arrays (e.g. 50x replace_all blocks from flash-lite)
    if (edits.length > 1 && edits.every((e) => e.mode === "replace_all" || !e.start_line)) {
      edits = [{ mode: "replace_all", start_line: 1, end_line: 1, code: edits.map((e) => e.code || "").join("\n") }];
    } else if (edits.length > 12) {
      previousError = "Too many fragmented edit blocks returned. Return 1 clean edit block per editable region.";
      setStatus(`Cleanup retry (${attempt})...`, "#facc15");
      continue;
    }

    if (!edits.length) {
      setStatus("Empty code", "#facc15");
      setOutput("Gemini ne koi valid code edit return nahi kiya.");
      return;
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

    if (attempt > 1 && (currentState.code || "").split("\n").length >= 5) {
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

    // Turbo typing pace (~5.5-7.5s on 1st attempt, ~1.5-3s on surgical compiler/test fix)
    const targetTotalMs = attempt === 1 ? randMs(5500, 7500) : randMs(1500, 3000);
    const blockSummary = edits
      .map((e) => (e.start_line >= 1 && e.mode !== "replace_all" ? `L${e.start_line}-L${e.end_line || e.start_line}` : "Full"))
      .join(", ");

    setOutput(
      `Model: ${apiRes.model}\nBlocks: ${blockSummary}\nTyping naturally (~${Math.round(targetTotalMs / 1000)}s)...\n${parsed.notes || ""}`
    );

    const typeRes = await callBridge("TYPE_CODE", { edits, targetTotalMs, lockedLines: currentState.lockedLines || [] }, 300000);
    if (!typeRes || !typeRes.ok) {
      setStatus("Typing stopped", "#facc15");
      setOutput(typeRes?.error || "Typing fail/stop ho gayi.");
      return;
    }

    setStatus("Typing done ✓", "#86efac");

    if (!autoSubmitAndNext) {
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
      evalRes = await callBridge("EVAL_TESTS", {}, 2000);
      if (evalRes && (evalRes.status === "passed" || evalRes.status === "failed")) {
        break;
      }
    }

    // If test runner didn't show result yet, click bottom Submit pill once as backup and wait 10s
    if (evalRes.status === "unknown") {
      await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"] }, 2500);
      for (let poll = 0; poll < 12; poll++) {
        await sleep(800);
        evalRes = await callBridge("EVAL_TESTS", {}, 2000);
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

    // NEVER blindly rewrite the whole code if test runner status is still unknown (no actual failure detected!)
    if (evalRes.status === "unknown") {
      failedUrls.add(window.location.href);
      setStatus("Check Test Cases", "#facc15");
      setOutput("Code likh kar Submit daba diya tha, par test result screen par nahi mila — dobara nahi likh raha. Test cases tab check karo ya 'Solve & Type' dabao.");
      return;
    }

    if (attempt === MAX_FIX_ATTEMPTS) {
      failedUrls.add(window.location.href);
      setStatus("Paused (3/3 fail)", "#facc15");
      setOutput(`3 tries ke baad ye error aaya (loop rok diya hai):\n${(evalRes.summary || "Manual check needed.").slice(0, 320)}`);
      return;
    }

    previousError = evalRes.summary || "Some test cases failed. Check exact indentation and output format.";
    setOutput(`Test fail hua — error padh kar fix kar raha hoon...\n${previousError.slice(0, 300)}`);
  }
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
    } else if (attempt <= 2) {
      setStatus(attempt === 1 ? "Solving Quiz..." : `Quiz retry ${attempt}...`, "#60a5fa");
      setOutput(
        attempt === 1
          ? "Objective / Quiz question padh raha hoon..."
          : `Wrong answer aaya tha — naya option try kar raha hoon (Try ${attempt})...`
      );

      const wrongHistoryBlock = wrongAttempts.length
        ? `\nPREVIOUSLY TRIED & MARKED WRONG BY CODETANTRA (DO NOT REPEAT THESE EXACT SELECTIONS):\n${wrongAttempts
            .map((w, i) => `Attempt ${i + 1} (WRONG): ${JSON.stringify(w)}`)
            .join("\n")}\nFeedback shown: ${lastFeedback || "Wrong answer"}\n`
        : "";

      const prompt = `You are a computer science professor solving a CodeTantra Objective / Quiz Question (Python, Java, C++, DSA, etc.).

Question & Context:
${mcqState.questionText}

Available Options (copy EXACT verbatim option text from this list ONLY):
${mcqState.options.map((o) => `- ${o}`).join("\n")}

Question Type: ${mcqState.isMultiSelect ? "Multiple-select (select ONLY the exact correct subset — do NOT blindly select all options!)" : "Single-choice (select EXACTLY ONE option)"}
${wrongHistoryBlock}
Return ONLY valid JSON:
{
  "answers": ["Exact option text here"]
}`;

      try {
        const apiRes = await callGemini(prompt);
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
  if (!hasValidApiKey()) {
    if (autoMode) setAutoMode(false);
    showApiKeyRequired();
    return;
  }
  if (isBusy) return;
  isBusy = true;

  const solveBtn = document.getElementById("ct-solve-one");
  if (solveBtn) solveBtn.innerText = "Stop";

  try {
    const edState = await callBridge("READ_EDITOR", {}, 4500);
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
  if (!hasValidApiKey()) {
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

    // Give iframes, CodeMirror 6, and Pyodide time to mount cleanly
    if (Date.now() - slideEnteredAt < 1800) {
      setStatus("Loading slide...", "#9ca3af");
      return;
    }

    // If this exact question already finished 3 attempts and failed, don't endlessly re-type it — pause until user moves or clicks Solve & Type!
    if (failedUrls.has(window.location.href)) {
      setStatus("Paused (check err)", "#facc15");
      return;
    }

    // NEVER blindly skip a coding/quiz page via solvedUrls — always verify actual test-case pass status!
    const edState = await callBridge("READ_EDITOR", {}, 3500);
    if (edState && edState.found) {
      // Check ONLY this active coding problem's own sidebar-stripped statement (NEVER sidebar/panel!)
      const activeProblemHead = (edState.problemText || "").slice(0, 500);
      if (/koko eating bananas/i.test(activeProblemHead)) {
        solvedUrls.add(window.location.href);
        setStatus("Skipped 29.1.6", "#facc15");
        setOutput("29.1.6 (Koko Eating Bananas) skip kiya — agle question par jaa raha hoon...");
        await sleep(700);
        await clickNextSlide();
        return;
      }
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
        await sleep(1200);
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

    // If on an "About this unit" overview page (no editor/quiz/video/submit), open the first uncompleted card
    if (Date.now() - slideEnteredAt >= 3200) {
      const beforeUrl = window.location.href;
      const unitRes = await callBridge("OPEN_UNIT_ITEM", {}, 2500);
      if (unitRes && unitRes.ok) {
        setStatus("Opening card...", "#86efac");
        setOutput(`Unit card open kar raha hoon:\n${unitRes.title || "First question"}`);
        await sleep(1500);
        if (window.location.href !== beforeUrl) return;
      } else if (unitRes && unitRes.allCompleted) {
        // All cards in this unit are already green-ticked -> check left sidebar for next incomplete item!
        setStatus("Checking sidebar...", "#60a5fa");
        const sideRes = await callBridge("OPEN_NEXT_SIDEBAR_ITEM", {}, 3500);
        if (sideRes && sideRes.ok) {
          setStatus("Opening pending...", "#86efac");
          setOutput(`Sidebar se incomplete question khol raha hoon:\n${sideRes.title}`);
          await sleep(1500);
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
  if (!hasValidApiKey()) {
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
