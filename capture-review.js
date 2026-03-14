// ─────────────────────────────────────────────────────────────────
// Work OS Tab Saver — capture-review.js  v2
// Post-capture review: per-window context, exclude windows/tabs,
// merge suggestions, split suggestions, auto-sort, save
// ─────────────────────────────────────────────────────────────────

const WORK_CATEGORIES = new Set([
  "Recruiting", "Research", "Dev", "Design", "Docs",
  "Email", "Comms", "Calendar", "Tasks", "Finance",
]);

let capturedWindows = [];
let dismissedMerges = new Set(); // "indexA-indexB" pairs user has dismissed
let activePicker    = null;

// ── Boot ─────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.session.get("pendingCapture");
  capturedWindows = data.pendingCapture || [];

  if (!capturedWindows.length) {
    document.getElementById("loading-msg").textContent = "No windows were captured.";
    return;
  }

  initWindowData();
  prefillCaptureLabel();
  renderWindows();
  bindEvents();
});

// ── Init per-window data ──────────────────────
function initWindowData() {
  const timeCtx = getTimeContext();
  capturedWindows.forEach((win) => {
    win.excluded = false;
    win.context  = inferWindowContext(win, timeCtx);
    win.tabs.forEach((tab) => { tab.excluded = false; });
  });
}

function getTimeContext() {
  const now  = new Date();
  const hour = now.getHours();
  const min  = now.getMinutes();
  const day  = now.getDay();
  const isWeekday  = day >= 1 && day <= 5;
  const afterStart = hour >= 8;
  const beforeEnd  = hour < 18 || (hour === 18 && min <= 30);
  return (isWeekday && afterStart && beforeEnd) ? "work" : "personal";
}

function inferWindowContext(win, timeCtx) {
  const parts    = win.label.split(" · ");
  const category = parts.length > 1 ? parts[parts.length - 1] : null;
  if (category && WORK_CATEGORIES.has(category)) return "work";
  return timeCtx;
}

// ── Pre-fill capture label ────────────────────
function prefillCaptureLabel() {
  const input = document.getElementById("capture-label-input");
  const hour  = new Date().getHours();
  let label = "Morning";
  if (hour >= 12 && hour < 17) label = "Afternoon";
  else if (hour >= 17)         label = "Evening";
  input.value = label;
  input.select();
}

// ── Category helpers ──────────────────────────
function getCategoryFromLabel(label) {
  const parts = label.split(" · ");
  return parts.length > 1 ? parts[parts.length - 1] : label;
}

// ── Sort windows by category ──────────────────
function sortWindowsByCategory() {
  capturedWindows.sort((a, b) => {
    const catA = getCategoryFromLabel(a.label);
    const catB = getCategoryFromLabel(b.label);
    if (catA === "Misc" && catB !== "Misc") return 1;
    if (catB === "Misc" && catA !== "Misc") return -1;
    return catA.localeCompare(catB);
  });
}

// ── Detect merge candidates ───────────────────
// Adjacent windows with the same category → show merge banner between them.
function detectMergePairs() {
  const pairs = new Set();
  for (let i = 0; i < capturedWindows.length - 1; i++) {
    const catA = getCategoryFromLabel(capturedWindows[i].label);
    const catB = getCategoryFromLabel(capturedWindows[i + 1].label);
    const key  = `${i}-${i + 1}`;
    if (catA === catB && catA !== "Misc" && !dismissedMerges.has(key)) {
      pairs.add(i);
    }
  }
  return pairs;
}

// ── Render ────────────────────────────────────
function renderWindows({ sort = true } = {}) {
  if (sort) sortWindowsByCategory();
  const mergePairs = detectMergePairs();
  const list = document.getElementById("windows-list");
  list.innerHTML = "";
  capturedWindows.forEach((win, i) => {
    list.appendChild(buildWindowBlock(win, i));
    if (mergePairs.has(i)) {
      list.appendChild(buildMergeBanner(i, i + 1));
    }
  });
}

// ── Build window block ────────────────────────
function buildWindowBlock(win, index) {
  const block = document.createElement("div");
  block.className = `window-block${win.excluded ? " excluded" : ""}`;
  block.dataset.index = index;

  const confLabel = {
    high:   "High confidence",
    medium: "Medium confidence",
    low:    "Low confidence — review label",
  }[win.confidence || "low"];

  const splitHtml = win.splitSuggestion ? buildSplitBanner(win.splitSuggestion, index) : "";

  block.innerHTML = `
    ${splitHtml}
    <div class="window-block-header">
      <div class="window-label-row">
        <label class="win-cb-wrap" title="Include this window">
          <input type="checkbox" class="win-include-cb" data-index="${index}" ${win.excluded ? "" : "checked"} />
        </label>
        <div class="label-field-wrap">
          <input
            class="window-label-input"
            type="text"
            value="${escHtml(win.label)}"
            data-index="${index}"
            placeholder="Label this window…"
          />
          <span class="confidence-badge confidence-${win.confidence || "low"}">${confLabel}</span>
        </div>
        <div class="win-header-right">
          <span class="window-block-meta">${win.tabs.length} tab${win.tabs.length !== 1 ? "s" : ""}</span>
          <button class="btn-merge-to" data-index="${index}" title="Merge into another group">Merge ▾</button>
          <div class="win-ctx-toggle" data-index="${index}">
            <button class="win-ctx-btn${win.context === "work" ? " active" : ""}" data-ctx="work" data-index="${index}" title="Work">💼</button>
            <button class="win-ctx-btn${win.context === "personal" ? " active" : ""}" data-ctx="personal" data-index="${index}" title="Personal">🏠</button>
          </div>
        </div>
      </div>
    </div>
    <div class="tabs-list">
      ${win.tabs.map((tab, ti) => buildTabRow(tab, index, ti)).join("")}
    </div>
  `;
  return block;
}

function buildTabRow(tab, winIndex, tabIndex) {
  const favHtml = tab.favIconUrl
    ? `<img class="fav" src="${escHtml(tab.favIconUrl)}" onerror="this.style.display='none'" />`
    : `<span class="fav-placeholder"></span>`;

  return `
    <div class="tab-row${tab.excluded ? " excluded" : ""}" data-win="${winIndex}" data-tab="${tabIndex}">
      <label class="tab-cb-wrap">
        <input type="checkbox" class="tab-include-cb" data-win="${winIndex}" data-tab="${tabIndex}" ${tab.excluded ? "" : "checked"} />
      </label>
      ${favHtml}
      <div class="tab-info">
        <div class="tab-title">${escHtml(tab.title)}</div>
        <div class="tab-url muted">${escHtml(shortenUrl(tab.url))}</div>
      </div>
      <button class="btn-send-tab" data-win="${winIndex}" data-tab="${tabIndex}" title="Send to another group">→</button>
    </div>
  `;
}

// ── Build merge banner ────────────────────────
function buildMergeBanner(indexA, indexB) {
  const banner = document.createElement("div");
  banner.className = "merge-banner";
  banner.dataset.a = indexA;
  banner.dataset.b = indexB;

  const labelA = escHtml(capturedWindows[indexA].label);
  const labelB = escHtml(capturedWindows[indexB].label);

  banner.innerHTML = `
    <div class="merge-labels">
      <span class="merge-label">${labelA}</span>
      <span class="merge-vert-arrow">↕</span>
      <span class="merge-label">${labelB}</span>
    </div>
    <div class="merge-actions">
      <button class="btn-merge" data-a="${indexA}" data-b="${indexB}">Merge?</button>
      <button class="btn-merge-dismiss" data-a="${indexA}" data-b="${indexB}" title="Dismiss">✕</button>
    </div>
  `;
  return banner;
}

// ── Build split banner ────────────────────────
function buildSplitBanner(suggestion, index) {
  return `
    <div class="split-banner" data-index="${index}">
      <span class="split-icon">⚡</span>
      <span class="split-text">
        Two topics detected:
        <strong>${escHtml(suggestion.clusterA.label)}</strong> and
        <strong>${escHtml(suggestion.clusterB.label)}</strong>
      </span>
      <button class="btn-split" data-index="${index}">Split</button>
      <button class="btn-split-dismiss" data-index="${index}" title="Dismiss">✕</button>
    </div>
  `;
}

// ── Events ────────────────────────────────────
function bindEvents() {
  const list = document.getElementById("windows-list");

  // Checkboxes: window and tab include/exclude
  list.addEventListener("change", (e) => {
    if (e.target.classList.contains("win-include-cb")) {
      const i = parseInt(e.target.dataset.index);
      capturedWindows[i].excluded = !e.target.checked;
      const block = list.querySelector(`.window-block[data-index="${i}"]`);
      if (block) block.classList.toggle("excluded", !e.target.checked);
    }
    if (e.target.classList.contains("tab-include-cb")) {
      const wi = parseInt(e.target.dataset.win);
      const ti = parseInt(e.target.dataset.tab);
      capturedWindows[wi].tabs[ti].excluded = !e.target.checked;
      const row = list.querySelector(`.tab-row[data-win="${wi}"][data-tab="${ti}"]`);
      if (row) row.classList.toggle("excluded", !e.target.checked);
    }
  });

  // Window label live-edit
  list.addEventListener("input", (e) => {
    if (e.target.classList.contains("window-label-input")) {
      const i = parseInt(e.target.dataset.index);
      capturedWindows[i].label = e.target.value;
    }
  });

  // Clicks: context toggle, split, merge, merge-to, send-tab
  list.addEventListener("click", (e) => {
    const ctxBtn = e.target.closest(".win-ctx-btn");
    if (ctxBtn) {
      const i   = parseInt(ctxBtn.dataset.index);
      const ctx = ctxBtn.dataset.ctx;
      capturedWindows[i].context = ctx;
      const toggle = list.querySelector(`.win-ctx-toggle[data-index="${i}"]`);
      toggle?.querySelectorAll(".win-ctx-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.ctx === ctx);
      });
      return;
    }
    if (e.target.classList.contains("btn-split")) {
      handleSplit(parseInt(e.target.dataset.index));
    }
    if (e.target.classList.contains("btn-split-dismiss")) {
      dismissSplitBanner(parseInt(e.target.dataset.index));
    }
    if (e.target.classList.contains("btn-merge")) {
      handleMerge(parseInt(e.target.dataset.a), parseInt(e.target.dataset.b));
    }
    if (e.target.classList.contains("btn-merge-dismiss")) {
      dismissMergeBanner(parseInt(e.target.dataset.a), parseInt(e.target.dataset.b));
    }
    if (e.target.classList.contains("btn-merge-to")) {
      const sourceIndex = parseInt(e.target.dataset.index);
      const options = capturedWindows
        .map((w, i) => ({ label: w.label, value: i }))
        .filter(({ value }) => value !== sourceIndex);
      showPicker(e.target, options, (targetIndex) => handleMergeTo(sourceIndex, targetIndex));
      return;
    }
    if (e.target.classList.contains("btn-send-tab")) {
      const wi = parseInt(e.target.dataset.win);
      const ti = parseInt(e.target.dataset.tab);
      const options = capturedWindows
        .map((w, i) => ({ label: w.label, value: i }))
        .filter(({ value }) => value !== wi);
      showPicker(e.target, options, (targetIndex) => handleSendTab(wi, ti, targetIndex));
      return;
    }
  });

  // Dismiss picker on outside mousedown
  document.addEventListener("mousedown", (e) => {
    if (activePicker && !activePicker.contains(e.target)) closePicker();
  });

  // Hotkeys: Enter = save, Escape = discard
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const key = e.key.toLowerCase();
    if (key === "enter")  handleSave();
    if (key === "escape") document.getElementById("btn-discard").click();
  });

  document.getElementById("btn-save").addEventListener("click", handleSave);
  document.getElementById("btn-discard").addEventListener("click", async () => {
    await chrome.storage.session.remove("pendingCapture");
    window.close();
  });
}

// ── Picker dropdown ───────────────────────────
function showPicker(anchorEl, options, onSelect) {
  closePicker();
  if (!options.length) return;

  const picker = document.createElement("div");
  picker.className = "group-picker";
  picker.id = "active-group-picker";

  options.forEach(({ label, value }) => {
    const opt = document.createElement("button");
    opt.className = "group-picker-option";
    opt.textContent = label;
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      closePicker();
      onSelect(value);
    });
    picker.appendChild(opt);
  });

  document.body.appendChild(picker);
  activePicker = picker;

  const rect = anchorEl.getBoundingClientRect();
  picker.style.top  = `${rect.bottom + 4}px`;
  picker.style.left = `${rect.left}px`;
}

function closePicker() {
  const existing = document.getElementById("active-group-picker");
  if (existing) existing.remove();
  activePicker = null;
}

// ── Merge To ──────────────────────────────────
function handleMergeTo(sourceIndex, targetIndex) {
  const source = capturedWindows[sourceIndex];
  const target = capturedWindows[targetIndex];
  target.tabs = [
    ...target.tabs,
    ...source.tabs.map((t) => ({ ...t, excluded: false })),
  ];
  capturedWindows.splice(sourceIndex, 1);
  dismissedMerges.clear();
  renderWindows({ sort: false });
}

// ── Send Tab To ───────────────────────────────
function handleSendTab(sourceWinIndex, sourceTabIndex, targetWinIndex) {
  const sourceWin = capturedWindows[sourceWinIndex];
  const [tab]     = sourceWin.tabs.splice(sourceTabIndex, 1);
  tab.excluded    = false;
  capturedWindows[targetWinIndex].tabs.push(tab);
  if (sourceWin.tabs.length === 0) {
    capturedWindows.splice(sourceWinIndex, 1);
  }
  dismissedMerges.clear();
  renderWindows({ sort: false });
}

// ── Split ─────────────────────────────────────
function handleSplit(index) {
  const win        = capturedWindows[index];
  const suggestion = win.splitSuggestion;
  if (!suggestion) return;

  const winA = {
    label:           suggestion.clusterA.label,
    confidence:      "high",
    tabs:            suggestion.clusterA.tabs.map((t) => ({ ...t, excluded: false })),
    splitSuggestion: null,
    excluded:        false,
    context:         win.context,
  };
  const winB = {
    label:           suggestion.clusterB.label,
    confidence:      "high",
    tabs:            suggestion.clusterB.tabs.map((t) => ({ ...t, excluded: false })),
    splitSuggestion: null,
    excluded:        false,
    context:         win.context,
  };

  capturedWindows.splice(index, 1, winA, winB);
  dismissedMerges.clear();
  renderWindows();
}

function dismissSplitBanner(index) {
  capturedWindows[index].splitSuggestion = null;
  const block  = document.querySelector(`.window-block[data-index="${index}"]`);
  const banner = block?.querySelector(".split-banner");
  if (banner) banner.remove();
}

// ── Merge ─────────────────────────────────────
function handleMerge(indexA, indexB) {
  const winA = capturedWindows[indexA];
  const winB = capturedWindows[indexB];
  winA.tabs = [
    ...winA.tabs,
    ...winB.tabs.map((t) => ({ ...t, excluded: false })),
  ];
  capturedWindows.splice(indexB, 1);
  dismissedMerges.clear();
  renderWindows({ sort: false }); // keep current order so merged window stays in place
}

function dismissMergeBanner(indexA, indexB) {
  dismissedMerges.add(`${indexA}-${indexB}`);
  renderWindows({ sort: false });
}

// ── Save ──────────────────────────────────────
async function handleSave() {
  const labelInput = document.getElementById("capture-label-input");
  const label      = labelInput.value.trim();

  if (!label) {
    labelInput.focus();
    labelInput.classList.add("input-error");
    return;
  }

  const includedWindows = capturedWindows
    .filter((win) => !win.excluded)
    .map((win) => ({
      label:      win.label,
      confidence: win.confidence,
      context:    win.context,
      tabs:       win.tabs.filter((tab) => !tab.excluded),
    }))
    .filter((win) => win.tabs.length > 0);

  // Derive capture-level context: "work" if any window is work
  const captureContext = includedWindows.some((w) => w.context === "work") ? "work" : "personal";

  const capture = {
    id:         crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    context:    captureContext,
    label,
    windows:    includedWindows,
  };

  await chrome.runtime.sendMessage({ type: "SAVE_CAPTURE", capture });
  await chrome.storage.session.remove("pendingCapture");

  const btn = document.getElementById("btn-save");
  btn.textContent = "✓ Saved!";
  btn.disabled    = true;
  setTimeout(() => window.close(), 700);
}

// ── Utils ─────────────────────────────────────
function shortenUrl(url = "") {
  try {
    const u    = new URL(url);
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 37) + "…" : u.pathname;
    return u.hostname.replace(/^www\./, "") + path;
  } catch { return url; }
}

function escHtml(str = "") {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
