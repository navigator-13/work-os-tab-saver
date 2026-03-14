// ─────────────────────────────────────────────────────────────────
// Work OS Tab Saver — notification-prompt.js
// Morning restore + EOD capture prompt page
// Hotkeys: R = restore, C = capture, S = snooze, D = dismiss
// ─────────────────────────────────────────────────────────────────

let promptType    = null;  // "morning" | "eod"
let lastWorkCap   = null;
let selectedWindows = [];  // for restore checkboxes

// ── Boot ─────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.session.get("promptType");
  promptType  = data.promptType || "morning";

  if (promptType === "morning") {
    await setupMorningPrompt();
  } else {
    setupEodPrompt();
  }

  bindHotkeys();
});

// ── Morning prompt ────────────────────────────
async function setupMorningPrompt() {
  document.getElementById("prompt-morning").classList.remove("hidden");

  const res  = await chrome.runtime.sendMessage({ type: "GET_LAST_WORK" });
  lastWorkCap = res.capture;

  const infoEl = document.getElementById("morning-session-info");

  if (!lastWorkCap) {
    infoEl.innerHTML = `<p class="muted">No previous work session found.</p>`;
    document.getElementById("btn-restore").disabled = true;
    return;
  }

  const date     = new Date(lastWorkCap.capturedAt).toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
  const time     = new Date(lastWorkCap.capturedAt).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });
  const tabCount = lastWorkCap.windows.reduce((s, w) => s + w.tabs.length, 0);

  infoEl.innerHTML = `
    <div class="session-preview-header">
      <span class="session-date">${date} at ${time}</span>
      <span class="session-stats muted">${lastWorkCap.windows.length} windows · ${tabCount} tabs</span>
    </div>
    <div class="session-windows-select" id="windows-select">
      ${lastWorkCap.windows.map((win, i) => `
        <label class="window-select-row">
          <input type="checkbox" class="window-checkbox" data-index="${i}" checked />
          <span class="window-select-label">${escHtml(win.label)}</span>
          <span class="muted window-select-count">${win.tabs.length} tab${win.tabs.length !== 1 ? "s" : ""}</span>
        </label>
      `).join("")}
    </div>
    <div class="select-all-row">
      <button class="btn-text-sm" id="btn-select-all">Select all</button>
      <button class="btn-text-sm" id="btn-deselect-all">Deselect all</button>
    </div>
  `;

  // Select all / deselect all
  document.getElementById("btn-select-all")?.addEventListener("click", () => {
    document.querySelectorAll(".window-checkbox").forEach((cb) => (cb.checked = true));
  });
  document.getElementById("btn-deselect-all")?.addEventListener("click", () => {
    document.querySelectorAll(".window-checkbox").forEach((cb) => (cb.checked = false));
  });

  // Bind morning action buttons
  document.getElementById("btn-restore").addEventListener("click", handleRestore);
  document.getElementById("btn-snooze").addEventListener("click", () => handleSnooze("morning"));
  document.getElementById("btn-dismiss-morning").addEventListener("click", () => handleDismiss("morning"));
}

// ── EOD prompt ────────────────────────────────
function setupEodPrompt() {
  document.getElementById("prompt-eod").classList.remove("hidden");

  document.getElementById("btn-capture-eod").addEventListener("click", handleEodCapture);
  document.getElementById("btn-snooze-eod").addEventListener("click", () => handleSnooze("eod"));
  document.getElementById("btn-dismiss-eod").addEventListener("click", () => handleDismiss("eod"));
}

// ── Actions ───────────────────────────────────
async function handleRestore() {
  if (!lastWorkCap) return;

  const checked = [...document.querySelectorAll(".window-checkbox:checked")];
  if (!checked.length) {
    flashButton("btn-restore", "Select at least one window");
    return;
  }

  const windows = checked.map((cb) => lastWorkCap.windows[parseInt(cb.dataset.index)]);
  await chrome.runtime.sendMessage({ type: "RESTORE_WINDOWS", windows });
  await chrome.runtime.sendMessage({ type: "DISMISS_PROMPT", promptType: "morning" });
  await chrome.storage.session.remove("promptType");

  flashSuccess("btn-restore", "✓ Restoring…");
  setTimeout(() => window.close(), 700);
}

async function handleEodCapture() {
  await chrome.runtime.sendMessage({ type: "DISMISS_PROMPT", promptType: "eod" });
  await chrome.runtime.sendMessage({ type: "INITIATE_CAPTURE" });
  await chrome.storage.session.remove("promptType");
  window.close();
}

async function handleSnooze(type) {
  await chrome.runtime.sendMessage({ type: "SNOOZE_PROMPT", promptType: type });
  await chrome.storage.session.remove("promptType");
  flashSuccess(type === "morning" ? "btn-snooze" : "btn-snooze-eod", "✓ Snoozed 30 min");
  setTimeout(() => window.close(), 600);
}

async function handleDismiss(type) {
  await chrome.runtime.sendMessage({ type: "DISMISS_PROMPT", promptType: type });
  await chrome.storage.session.remove("promptType");
  window.close();
}

// ── Keyboard hotkeys ──────────────────────────
function bindHotkeys() {
  document.addEventListener("keydown", async (e) => {
    // Don't fire if user is typing in an input
    if (e.target.tagName === "INPUT") return;

    const key = e.key.toLowerCase();

    if (promptType === "morning") {
      if (key === "r") handleRestore();
      if (key === "s") handleSnooze("morning");
      if (key === "d") handleDismiss("morning");
    }

    if (promptType === "eod") {
      if (key === "c") handleEodCapture();
      if (key === "s") handleSnooze("eod");
      if (key === "d") handleDismiss("eod");
    }

    // Escape always dismisses
    if (e.key === "Escape") handleDismiss(promptType);
  });
}

// ── UI helpers ────────────────────────────────
function flashButton(id, msg) {
  const btn   = document.getElementById(id);
  const orig  = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => (btn.textContent = orig), 1500);
}

function flashSuccess(id, msg) {
  const btn      = document.getElementById(id);
  btn.textContent = msg;
  btn.disabled    = true;
}

function escHtml(str = "") {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
