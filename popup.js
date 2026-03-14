// ─────────────────────────────────────────────────────────────────
// Work OS Tab Saver — popup.js  v2
// Toolbar popup: day-grouped list, capture tabs, diff view,
// restore modal with capture selector, import/export
// ─────────────────────────────────────────────────────────────────

let allDays            = [];
let activeFilter       = "all";   // "all" | "work" | "personal"
let activeRestoreDay   = null;
let activeRestoreCap   = null;    // currently selected capture in modal
const openDayIds       = new Set(); // days explicitly opened by user

// ── Boot ─────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  await loadDays();
  bindEvents();
});

// ── Filter helper ─────────────────────────────
function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll(".filter-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.filter === filter)
  );
  renderDays();
}

// ── Load & render ─────────────────────────────
async function loadDays() {
  const res = await chrome.runtime.sendMessage({ type: "GET_DAYS" });
  allDays   = res.days || [];
  renderDays();
}

function renderDays() {
  const list  = document.getElementById("days-list");
  const empty = document.getElementById("empty-state");
  const query = document.getElementById("search-input").value.toLowerCase();

  Array.from(list.querySelectorAll(".day-group")).forEach((el) => el.remove());

  let days = allDays;

  // Context filter
  if (activeFilter !== "all") {
    days = days
      .map((day) => ({
        ...day,
        captures: day.captures.filter((c) => c.context === activeFilter),
      }))
      .filter((day) => day.captures.length);
  }

  // Search filter
  if (query) {
    days = days
      .map((day) => ({
        ...day,
        captures: day.captures.filter(
          (c) =>
            c.label.toLowerCase().includes(query) ||
            c.windows.some((w) => w.label.toLowerCase().includes(query)) ||
            c.windows.some((w) =>
              w.tabs.some((t) => t.title.toLowerCase().includes(query))
            )
        ),
      }))
      .filter((day) => day.captures.length);
  }

  if (!days.length) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  days.forEach((day) => list.appendChild(buildDayGroup(day, query)));
}

function buildDayGroup(day, query) {
  const isOpen = openDayIds.has(day.id) || !!query;
  const group  = document.createElement("div");
  group.className  = `day-group${isOpen ? " day-group--open" : ""}`;
  group.dataset.id = day.id;

  const dateLabel = formatDate(day.date);
  const totalTabs = day.captures.reduce(
    (s, c) => s + c.windows.reduce((ws, w) => ws + w.tabs.length, 0), 0
  );

  group.innerHTML = `
    <div class="day-header day-toggle" title="Click to expand">
      <div class="day-header-left">
        <span class="day-chevron">▶</span>
        <span class="day-date">${dateLabel}</span>
        <span class="day-meta muted">${day.captures.length} capture${day.captures.length !== 1 ? "s" : ""} · ${totalTabs} tabs</span>
      </div>
      <div class="day-actions">
        <button class="btn-icon btn-export-day" data-id="${day.id}" title="Export day as JSON">↓</button>
        <button class="btn-icon btn-delete-day" data-id="${day.id}" title="Delete day">🗑</button>
      </div>
    </div>
    <div class="captures-list">
      ${day.captures.map((cap, ci) => buildCaptureRow(cap, day, ci)).join("")}
    </div>
  `;
  return group;
}

function buildCaptureRow(cap, day, captureIndex) {
  const time      = formatTime(cap.capturedAt);
  const tabCount  = cap.windows.reduce((s, w) => s + w.tabs.length, 0);
  const ctxIcon   = cap.context === "work" ? "💼" : "🏠";
  const prevCap   = day.captures[captureIndex - 1];
  const diffBadge = prevCap ? buildDiffBadge(prevCap, cap) : "";

  const windowChips = cap.windows.map((w, wi) => `
    <span class="chip chip-neutral chip-selectable"
      data-day-id="${day.id}" data-cap-id="${cap.id}" data-win-index="${wi}"
      title="Click to select for restore">
      ${escHtml(w.label)}<span class="chip-count">${w.tabs.length}</span>
    </span>
  `).join("");

  return `
    <div class="capture-row" data-day-id="${day.id}" data-cap-id="${cap.id}">
      <div class="capture-row-main">
        <div class="capture-row-top">
          <span class="ctx-icon">${ctxIcon}</span>
          <span class="capture-label">${escHtml(cap.label)}</span>
          <span class="capture-time muted">${time}</span>
          ${diffBadge}
        </div>
        <div class="window-chips">${windowChips}</div>
      </div>
      <div class="capture-row-actions">
        <button class="btn-icon btn-copy-md"
          data-day-id="${day.id}" data-cap-id="${cap.id}"
          title="Copy as Markdown">MD</button>
        <button class="btn-icon btn-restore-cap"
          data-day-id="${day.id}" data-cap-id="${cap.id}"
          title="Restore this capture">↗</button>
        <button class="btn-icon btn-delete-cap"
          data-day-id="${day.id}" data-cap-id="${cap.id}"
          title="Delete capture">🗑</button>
      </div>
    </div>
  `;
}

// ── Diff badge ────────────────────────────────
// Compare URL sets between previous and current capture
function buildDiffBadge(prevCap, currCap) {
  const prevUrls = new Set(prevCap.windows.flatMap((w) => w.tabs.map((t) => t.url)));
  const currUrls = new Set(currCap.windows.flatMap((w) => w.tabs.map((t) => t.url)));

  let added   = 0;
  let removed = 0;
  for (const url of currUrls) if (!prevUrls.has(url)) added++;
  for (const url of prevUrls) if (!currUrls.has(url)) removed++;

  if (!added && !removed) return `<span class="diff-badge diff-same" title="No changes from previous capture">= same</span>`;

  const parts = [];
  if (added)   parts.push(`<span class="diff-added">+${added}</span>`);
  if (removed) parts.push(`<span class="diff-removed">-${removed}</span>`);
  return `<span class="diff-badge" title="Changes from previous capture">${parts.join(" ")}</span>`;
}

// ── Events ────────────────────────────────────
function bindEvents() {
  // Capture button
  document.getElementById("btn-capture").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "INITIATE_CAPTURE" });
    window.close();
  });

  // Filter buttons
  document.querySelector(".filter-row").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    setFilter(btn.dataset.filter);
  });

  // Search
  document.getElementById("search-input").addEventListener("input", renderDays);

  // Hotkeys: W = work filter, P = personal filter, A = all, C = capture
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const key = e.key.toLowerCase();
    if (key === "w") setFilter("work");
    if (key === "p") setFilter("personal");
    if (key === "a") setFilter("all");
    if (key === "c") document.getElementById("btn-capture").click();
  });

  // Import
  document.getElementById("import-file-input").addEventListener("change", handleImport);

  // Day list delegation
  document.getElementById("days-list").addEventListener("click", async (e) => {
    // Toggle day open/closed (header click, not buttons)
    const header = e.target.closest(".day-toggle");
    if (header && !e.target.closest("button") && !e.target.closest(".chip-selectable")) {
      const group = header.closest(".day-group");
      const id    = group.dataset.id;
      if (openDayIds.has(id)) {
        openDayIds.delete(id);
        group.classList.remove("day-group--open");
      } else {
        openDayIds.add(id);
        group.classList.add("day-group--open");
      }
      return;
    }
    // Export day
    if (e.target.classList.contains("btn-export-day")) {
      const id  = e.target.dataset.id;
      const day = allDays.find((d) => d.id === id);
      if (day) chrome.runtime.sendMessage({ type: "EXPORT_DAY", day });
    }
    // Delete day
    if (e.target.classList.contains("btn-delete-day")) {
      const id  = e.target.dataset.id;
      const day = allDays.find((d) => d.id === id);
      if (day && confirm(`Delete all captures for ${formatDate(day.date)}?`)) {
        await chrome.runtime.sendMessage({ type: "DELETE_DAY", dayId: id });
        await loadDays();
      }
    }
    // Copy capture as Markdown
    if (e.target.classList.contains("btn-copy-md")) {
      const { dayId, capId } = e.target.dataset;
      const day = allDays.find((d) => d.id === dayId);
      const cap = day?.captures.find((c) => c.id === capId);
      if (cap && day) copyCaptureMd(cap, day, e.target);
    }
    // Toggle chip selection
    const chip = e.target.closest(".chip-selectable");
    if (chip) {
      chip.classList.toggle("chip--selected");
      return;
    }
    // Restore capture: open selected chips, or all if none selected
    if (e.target.classList.contains("btn-restore-cap")) {
      const { dayId, capId } = e.target.dataset;
      const day = allDays.find((d) => d.id === dayId);
      const cap = day?.captures.find((c) => c.id === capId);
      if (!cap) return;
      const row = e.target.closest(".capture-row");
      const selected = [...row.querySelectorAll(".chip--selected")];
      const windows  = selected.length
        ? selected.map((ch) => cap.windows[parseInt(ch.dataset.winIndex)])
        : cap.windows;
      await chrome.runtime.sendMessage({ type: "RESTORE_WINDOWS", windows });
      window.close();
    }
    // Delete capture
    if (e.target.classList.contains("btn-delete-cap")) {
      const { dayId, capId } = e.target.dataset;
      if (confirm("Delete this capture?")) {
        await chrome.runtime.sendMessage({ type: "DELETE_CAPTURE", dayId, captureId: capId });
        await loadDays();
      }
    }
  });

  // Modal
  document.getElementById("modal-close").addEventListener("click", closeRestoreModal);
  document.getElementById("modal-select-all").addEventListener("click", () => {
    document.querySelectorAll(".window-checkbox").forEach((cb) => (cb.checked = true));
  });
  document.getElementById("modal-restore-btn").addEventListener("click", handleRestore);
  document.getElementById("restore-modal").addEventListener("click", (e) => {
    if (e.target === document.getElementById("restore-modal")) closeRestoreModal();
  });
}

// ── Restore modal ─────────────────────────────
function openRestoreModal(dayId, capId) {
  activeRestoreDay = allDays.find((d) => d.id === dayId);
  if (!activeRestoreDay) return;

  activeRestoreCap = activeRestoreDay.captures.find((c) => c.id === capId)
                   || activeRestoreDay.captures[activeRestoreDay.captures.length - 1];

  const dateLabel = formatDate(activeRestoreDay.date);
  document.getElementById("modal-title").textContent    = dateLabel;
  document.getElementById("modal-subtitle").textContent =
    `${activeRestoreDay.captures.length} capture${activeRestoreDay.captures.length !== 1 ? "s" : ""}`;

  renderCaptureTabs();
  renderModalWindows();
  document.getElementById("restore-modal").classList.remove("hidden");
}

function renderCaptureTabs() {
  const container = document.getElementById("modal-capture-tabs");
  container.innerHTML = activeRestoreDay.captures.map((cap) => {
    const active = cap.id === activeRestoreCap.id;
    const icon   = cap.context === "work" ? "💼" : "🏠";
    return `
      <button class="modal-cap-tab ${active ? "active" : ""}" data-cap-id="${cap.id}">
        ${icon} ${escHtml(cap.label)}
        <span class="modal-cap-time">${formatTime(cap.capturedAt)}</span>
      </button>
    `;
  }).join("");

  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".modal-cap-tab");
    if (!btn) return;
    activeRestoreCap = activeRestoreDay.captures.find((c) => c.id === btn.dataset.capId);
    container.querySelectorAll(".modal-cap-tab").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    renderModalWindows();
  });
}

function renderModalWindows() {
  const list = document.getElementById("modal-windows-list");
  list.innerHTML = "";

  activeRestoreCap.windows.forEach((win, i) => {
    const row = document.createElement("div");
    row.className = "modal-window-row";
    row.innerHTML = `
      <label class="window-row-label">
        <input type="checkbox" class="window-checkbox" data-index="${i}" checked />
        <span class="window-label">${escHtml(win.label)}</span>
        <span class="window-tab-count muted">${win.tabs.length} tab${win.tabs.length !== 1 ? "s" : ""}</span>
      </label>
      <div class="tab-preview">
        ${win.tabs.slice(0, 4).map((t) => `
          <div class="tab-preview-row">
            ${t.favIconUrl ? `<img class="fav" src="${escHtml(t.favIconUrl)}" onerror="this.style.display='none'" />` : ""}
            <span class="tab-title">${escHtml(t.title)}</span>
          </div>
        `).join("")}
        ${win.tabs.length > 4 ? `<div class="tab-preview-more muted">+${win.tabs.length - 4} more</div>` : ""}
      </div>
    `;
    list.appendChild(row);
  });
}

function closeRestoreModal() {
  document.getElementById("restore-modal").classList.add("hidden");
  activeRestoreDay = null;
  activeRestoreCap = null;
}

async function handleRestore() {
  if (!activeRestoreCap) return;
  const selected = [...document.querySelectorAll(".window-checkbox:checked")]
    .map((cb) => activeRestoreCap.windows[parseInt(cb.dataset.index)]);
  if (!selected.length) { alert("Select at least one window."); return; }
  await chrome.runtime.sendMessage({ type: "RESTORE_WINDOWS", windows: selected });
  closeRestoreModal();
  window.close();
}

// ── Import ────────────────────────────────────
async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  showToast("Importing…");
  try {
    const text = await file.text();
    const day  = JSON.parse(text);

    if (!day.id || !day.date || !Array.isArray(day.captures)) {
      throw new Error("Invalid day file format.");
    }

    // Re-ID captures to avoid collisions
    day.captures = day.captures.map((c) => ({ ...c, id: crypto.randomUUID(), importedOriginalId: c.id }));

    await chrome.runtime.sendMessage({ type: "IMPORT_DAY", day });
    await loadDays();
    showToast("✓ Imported", 2500);
  } catch (err) {
    showToast(`✗ ${err.message}`, 3000);
  }
  e.target.value = "";
}

function showToast(msg, duration = 0) {
  const toast    = document.getElementById("import-status");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  if (duration) setTimeout(() => toast.classList.add("hidden"), duration);
}

// ── Markdown export ───────────────────────────
function buildCaptureMd(cap, day) {
  const ctxIcon  = cap.context === "work" ? "💼" : "🏠";
  const dateLabel = formatDate(day.date);
  const time      = formatTime(cap.capturedAt);

  const lines = [
    `## ${ctxIcon} ${cap.label} — ${dateLabel} · ${time}`,
    "",
  ];

  cap.windows.forEach((win) => {
    const winCtxIcon = win.context === "work" ? "💼" : "🏠";
    lines.push(`### ${winCtxIcon} ${win.label}`);
    win.tabs.forEach((tab) => {
      const title = tab.title.replace(/[[\]]/g, (c) => `\\${c}`);
      lines.push(`- [${title}](${tab.url})`);
    });
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

async function copyCaptureMd(cap, day, btn) {
  const md = buildCaptureMd(cap, day);
  await navigator.clipboard.writeText(md);
  const orig = btn.textContent;
  btn.textContent = "✓";
  setTimeout(() => { btn.textContent = orig; }, 1500);
}

// ── Utils ─────────────────────────────────────
function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function escHtml(str = "") {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
