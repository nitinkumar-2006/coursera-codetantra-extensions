const DEFAULT_GEMINI_API_KEY = "";

const FALLBACK_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-2.5-flash"
];

let cachedWorkingModels = null;
let apiCooldownUntil = 0;

const RETRYABLE_HTTP_CODES = new Set([400, 403, 404, 408, 429, 500, 502, 503, 504]);
const MAX_FIX_ATTEMPTS = 3;

let autoMode = sessionStorage.getItem("ct_auto_mode") === "true";
let autoInterval = null;
let isBusy = false;
let tickInFlight = false;
let solvedUrls = new Set();
let lastHashUrl = window.location.href;
let slideEnteredAt = Date.now();
let pendingBridgeCalls = new Map();
let msgCounter = 1;

function getApiKeys() {
  const raw = (localStorage.getItem("ct_gemini_api_key") || "").trim();
  const list = raw
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 15);
  if (!list.includes(DEFAULT_GEMINI_API_KEY)) list.push(DEFAULT_GEMINI_API_KEY);
  return list;
}

function getApiKey() {
  return getApiKeys()[0];
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
    border-radius: 16px; padding: 13px; width: 325px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28);
    font-size: 12.5px;
  `;

  panel.innerHTML = `
    <div style="font-weight: 600; margin-bottom: 10px; display:flex; justify-content:space-between; align-items:center;">
      <span style="display:flex; align-items:center; gap:6px;">
        <span style="color:#ffffff;">CodeTantra Agent</span>
        <span style="font-size:10px; background:rgba(10,12,18,0.65); border:1px solid rgba(255,255,255,0.22); color:#e5e7eb; padding:2px 6px; border-radius:6px;">v6.7</span>
        <button id="ct-set-key" class="ct-icon-btn" title="Set custom Gemini API Key">Key</button>
        <button id="ct-scan-top" class="ct-icon-btn" title="Jump to topmost incomplete pink question">Top</button>
        <button id="ct-lang-btn" class="ct-icon-btn" title="Preferred language for multi-lang editors">Lang</button>
      </span>
      <span id="ct-status" style="color:#e5e7eb; font-size:11px; font-weight:500; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Idle</span>
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
    apiCooldownUntil = 0;
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
  document.getElementById("ct-set-key").addEventListener("click", () => {
    const curRaw = localStorage.getItem("ct_gemini_api_key") || getApiKey();
    const newKey = prompt("1 ya multiple Gemini API Keys paste karo (comma se separate karke — 429 aane par auto-rotate hoga):", curRaw);
    if (newKey && newKey.trim()) {
      localStorage.setItem("ct_gemini_api_key", newKey.trim());
      cachedWorkingModels = null;
      apiCooldownUntil = 0;
      const count = getApiKeys().length;
      setStatus(`Keys saved (${count}) ✓`, "#86efac");
      setOutput(`${count} Gemini API Key(s) active hain — quota/429 aane par automatically next key use hogi.`);
    }
  });

  syncAutoUI();
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
  if (autoMode) {
    btn.innerText = "Stop Auto";
    btn.classList.add("ct-glass-btn-running");
    setStatus("Running...", "#86efac");
  } else {
    btn.innerText = "Start Auto";
    btn.classList.remove("ct-glass-btn-running");
    setStatus("Stopped", "#d1d5db");
  }
}

function setAutoMode(enabled) {
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

// ---------------- Dynamic Model Discovery + Diverse Quota Buckets + Multi-Key Rotation ----------------
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
          if (!name.startsWith("gemini-") && !name.startsWith("gemma-3-")) return false;
          if (/(image|tts|live|audio|embed|robotics|transcribe|1\.5|2\.0|2\.5-flash-lite|2\.5-flash$|2\.5-pro$|gemma-3-1b|gemma-3-4b)/i.test(name)) {
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
          if (name === "gemini-flash-latest") return 5;
          if (name.includes("flash-lite")) return 6;
          if (name.includes("flash")) return 7;
          if (name.includes("gemma-3-27b")) return 8;
          if (name.includes("gemma-3-12b")) return 9;
          return 12;
        };
        eligible.sort((a, b) => scoreModel(a) - scoreModel(b));

        // Pick DIVERSE model families (different quota buckets!) so 429 on one bucket doesn't kill all attempts
        const familyOf = (n) => {
          if (n.includes("gemma-3-27b")) return "gemma27";
          if (n.includes("gemma-3-12b")) return "gemma12";
          if (n.includes("flash-lite")) return "flash-lite";
          if (n.includes("3.6")) return "g36";
          if (n.includes("3.7")) return "g37";
          if (n.includes("3.8")) return "g38";
          if (n.includes("2.5")) return "g25";
          if (n.includes("pro")) return "pro";
          return n;
        };
        const diverse = [];
        const seenFam = new Set();
        for (const m of eligible) {
          const fam = familyOf(m);
          if (!seenFam.has(fam)) {
            seenFam.add(fam);
            diverse.push(m);
          }
          if (diverse.length >= 7) break;
        }
        // Ensure gemma-3-27b-it is always available as a huge separate free-tier fallback
        if (eligible.includes("gemma-3-27b-it") && !diverse.includes("gemma-3-27b-it")) {
          diverse.push("gemma-3-27b-it");
        }

        const lastGood = localStorage.getItem("ct_last_working_model");
        if (lastGood && eligible.includes(lastGood)) {
          cachedWorkingModels = [lastGood, ...diverse.filter((m) => m !== lastGood)].slice(0, 8);
        } else {
          cachedWorkingModels = diverse.slice(0, 8);
        }
        return cachedWorkingModels;
      }
    }
  } catch {
    // Fall back to static list
  }

  return [...FALLBACK_GEMINI_MODELS, "gemma-3-27b-it"];
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
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
  const errorLogs = [];

  for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
    const apiKey = apiKeys[kIdx];
    const models = await discoverAvailableModels(apiKey);

    for (const model of models) {
      const isGemma = model.startsWith("gemma-");
      setStatus(`AI: ${model.replace("gemini-", "")} (K${kIdx + 1})`, "#60a5fa");
      try {
        const bodyObj = {
          contents: [{ parts: [{ text: prompt }] }]
        };
        if (!isGemma) {
          bodyObj.generationConfig = { responseMimeType: "application/json" };
        }

        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyObj)
          },
          15000
        );

        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) {
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (rawText) {
            localStorage.setItem("ct_last_working_model", model);
            if (cachedWorkingModels) {
              cachedWorkingModels = [model, ...cachedWorkingModels.filter((m) => m !== model)];
            }
            return { ok: true, model, rawText: extractJsonFromText(rawText) };
          }
        }

        const errMsg = data?.error?.message || `HTTP ${res.status}`;
        errorLogs.push(`K${kIdx + 1}/${model} (${res.status}): ${errMsg.slice(0, 75)}`);

        if (res.status === 400 && /api key not valid/i.test(errMsg)) {
          // Invalid key -> skip remaining models on this key, try next key!
          break;
        }

        if (RETRYABLE_HTTP_CODES.has(res.status)) {
          await sleep(300);
          continue;
        }
      } catch (err) {
        const msg = err.name === "AbortError" ? "Timeout (15s)" : err.message;
        errorLogs.push(`K${kIdx + 1}/${model}: ${msg}`);
      }
    }
  }

  const hitQuota = errorLogs.some((e) => e.includes("(429)") || /quota/i.test(e));
  const hitBusy = errorLogs.some((e) => e.includes("(503)") || /high demand/i.test(e));
  apiCooldownUntil = Date.now() + (hitQuota ? 40000 : 20000);
  return {
    ok: false,
    error:
      (hitQuota
        ? "Aaj ka free Gemini API quota khatam ho gaya (429)! 'Key' dabakar doosre Gmail ka naya free API key paste karo (comma se multiple keys bhi daal sakte ho).\n"
        : hitBusy
        ? "Google Gemini server abhi high demand par hai (503) — 20s baad khud retry karega.\n"
        : "") + (errorLogs.slice(-3).join("\n") || "All Gemini models failed.")
  };
}

async function clickNextSlide() {
  setStatus("Moving Next...", "#86efac");
  await sleep(400);
  const res = await callBridge("CLICK_BUTTON", { targets: ["next >", "next", "next lesson", "next question"] }, 3000);
  if (res && res.ok) return true;

  // Fallback 1: "About this unit" / module overview page where Next > button doesn't exist
  const beforeUrl = window.location.href;
  const unitRes = await callBridge("OPEN_UNIT_ITEM", {}, 3000);
  if (unitRes && unitRes.ok) {
    setStatus("Opening card...", "#86efac");
    setOutput(`Unit card click kiya:\n${unitRes.title || "First question"}`);
    await sleep(1000);
    return window.location.href !== beforeUrl;
  }

  // Fallback 2: Open left sidebar and jump to topmost incomplete unit/question (e.g. after 21.2.1 -> 22.1.1)
  const sideRes = await callBridge("OPEN_NEXT_SIDEBAR_ITEM", {}, 6000);
  if (sideRes && sideRes.ok) {
    setStatus("Opening next unit...", "#86efac");
    setOutput(`Sidebar se agla incomplete question khola:\n${sideRes.title}`);
    await sleep(1200);
    return window.location.href !== beforeUrl;
  }

  setStatus("Next btn missing", "#facc15");
  return false;
}

// ---------------- 1. CODING PROBLEM SOLVER ----------------
async function solveCodingProblem(edState, { autoSubmitAndNext = false } = {}) {
  // Step 0: If user selected a preferred language (e.g. JAVA/PYTHON) via 'Lang' button, switch multi-lang dropdown first!
  const prefLang = localStorage.getItem("ct_preferred_lang") || "auto";
  if (prefLang !== "auto" && edState.language && edState.language.toLowerCase() !== prefLang) {
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

  // AUTO-RESET GUARDRAIL: If editor is blank/wiped OR pink starter package was deleted earlier, Reset FIRST!
  let activeEdState = edState;
  const looksWipedOrBroken =
    (activeEdState.code || "").trim().length < 15 ||
    (errRequiredPkg && !(activeEdState.code || "").includes(errRequiredPkg));
  if (looksWipedOrBroken) {
    const didReset = await resetCodeEditor("Editor blank ya broken starter code mila.");
    if (didReset) {
      const freshState = await callBridge("READ_EDITOR", {}, 5000);
      if (freshState && freshState.found) {
        activeEdState = freshState;
      }
    }
  }

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    let currentState = attempt === 1 ? activeEdState : await callBridge("READ_EDITOR", {}, 5000);
    // On retry after a compilation/syntax/class error, Reset cleanly first so we never pile edits on broken code
    if (
      attempt > 1 &&
      /(syntaxerror|indentationerror|compilation error|noclassdeffounderror|classnotfoundexception|wrong name:|cannot find symbol)/i.test(
        previousError || ""
      )
    ) {
      const didReset = await resetCodeEditor("Compilation/Syntax error — clean starter par reset kar raha hoon.");
      if (didReset) {
        const freshState = await callBridge("READ_EDITOR", {}, 5000);
        if (freshState && freshState.found) currentState = freshState;
      }
    }
    const latestErrInfo = extractJavaPkgAndClassFromError(previousError);
    if (latestErrInfo.pkg) errRequiredPkg = latestErrInfo.pkg;
    if (latestErrInfo.cls) errRequiredClass = latestErrInfo.cls;

    const numberedStarter = formatNumberedCode(currentState.code, currentState.lockedLines);
    const lang = currentState.language || "infer from problem statement & starter code";

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
        await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"] }, 3000);
        setStatus("Evaluating tests...", "#60a5fa");
        let evalRes = { status: "unknown", summary: "" };
        for (let poll = 0; poll < 14; poll++) {
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

${previousError ? `CRITICAL — READ THIS EXACT ERROR FROM TEST CASE RUNNER FIRST AND FIX ITS ROOT CAUSE:\n${previousError}\n${errRequiredPkg ? `MANDATORY: Line 1 MUST have '${errRequiredPkg}' and the main class MUST be '${errRequiredClass}'!\n` : ""}DO NOT delete working code and rewrite blindly — fix ONLY the exact lines causing this error!\n\n` : ""}Current Code in Editor (1-based line numbers with [LOCKED] vs [EDITABLE] hints):
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

    const cleaned = apiRes.rawText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    let edits = Array.isArray(parsed.edits)
      ? parsed.edits
      : parsed.code
      ? [{ mode: parsed.mode || "replace_all", start_line: parsed.start_line || 1, end_line: parsed.end_line || 1, code: parsed.code }]
      : [];

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

    // Step 3 (Quota-smart): Run 1 focused internal QA pass only when structural warnings exist or on retry (saves 60% API quota!)
    const needQaPass = structuralWarnings.length > 0 || attempt > 1;
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

    // Normalize edit modes so start_line >= 1 is ALWAYS replace_lines (never accidentally Full wipe!)
    edits = edits.map((e) => ({
      ...e,
      mode: e.start_line >= 1 && e.mode !== "replace_all" ? "replace_lines" : e.mode || (e.start_line >= 1 ? "replace_lines" : "replace_all")
    }));

    // Balanced natural human typing pace (~35-52s on 1st attempt, ~25-38s on fix)
    const targetTotalMs = attempt === 1 ? randMs(35000, 52000) : randMs(25000, 38000);
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
    const subRes = await callBridge("CLICK_BUTTON", { targets: ["submit", "submit code", "compile & run"] }, 3000);

    if (!subRes || !subRes.ok) {
      setStatus("Submit btn missing", "#facc15");
      return;
    }

    setStatus("Evaluating tests...", "#60a5fa");

    let evalRes = { status: "unknown", summary: "" };
    for (let poll = 0; poll < 14; poll++) {
      await sleep(800);
      evalRes = await callBridge("EVAL_TESTS", {}, 2000);
      if (evalRes && (evalRes.status === "passed" || evalRes.status === "failed")) {
        break;
      }
    }

    if (evalRes.status === "passed") {
      solvedUrls.add(window.location.href);
      setStatus("100% Passed ✓", "#86efac");
      setOutput(`${evalRes.summary}\nSab test cases pass! Next question par jaa raha hoon...`);
      await sleep(1800);
      await clickNextSlide();
      return;
    }

    if (attempt === MAX_FIX_ATTEMPTS) {
      setStatus("Check test cases", "#facc15");
      setOutput(`Attempt ${attempt} ke baad result:\n${evalRes.summary || "Manual check needed."}`);
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

    // Give iframes, CodeMirror 6, and Pyodide plenty of time to mount cleanly
    if (Date.now() - slideEnteredAt < 3000) {
      setStatus("Loading slide...", "#9ca3af");
      return;
    }

    // NEVER blindly skip a coding/quiz page via solvedUrls — always verify actual test-case pass status!
    const edState = await callBridge("READ_EDITOR", {}, 3500);
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

    // Only advance pure theory/reading slides calmly after 7 seconds
    if (Date.now() - slideEnteredAt >= 7000) {
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
  if (autoMode) setAutoMode(true);
}, 400);

setInterval(() => {
  if (!document.getElementById("ct-helper-panel")) {
    createPanel();
  }
}, 2500);
