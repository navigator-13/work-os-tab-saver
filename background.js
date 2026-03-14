// ─────────────────────────────────────────────────────────────────
// Work OS Tab Saver — background.js  v2
// Service worker: capture, heuristic labelling, split detection,
// day-grouped storage, alarms, notifications, restore, export
// ─────────────────────────────────────────────────────────────────

// ── Alarm names ──────────────────────────────
const ALARM_MORNING = "morning-prompt";
const ALARM_EOD     = "eod-prompt";
const ALARM_SNOOZE  = "snooze-prompt";

// ── Install / startup: register alarms ───────
chrome.runtime.onInstalled.addListener(setupAlarms);
chrome.runtime.onStartup.addListener(setupAlarms);

async function setupAlarms() {
  // Clear existing so we don't double-register
  await chrome.alarms.clearAll();
  scheduleRecurringAlarms();
}

function scheduleRecurringAlarms() {
  const now    = new Date();
  const today9 = new Date(now);
  today9.setHours(9, 0, 0, 0);
  const todayEOD = new Date(now);
  todayEOD.setHours(16, 30, 0, 0);

  // Schedule morning alarm: next 9:00am (today if not yet passed, else tomorrow)
  const morning = today9 > now ? today9 : new Date(today9.getTime() + 86400000);
  chrome.alarms.create(ALARM_MORNING, {
    when:        morning.getTime(),
    periodInMinutes: 1440, // repeat every 24hrs
  });

  // Schedule EOD alarm: next 4:30pm
  const eod = todayEOD > now ? todayEOD : new Date(todayEOD.getTime() + 86400000);
  chrome.alarms.create(ALARM_EOD, {
    when:        eod.getTime(),
    periodInMinutes: 1440,
  });
}

// ── Alarm fired ───────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_MORNING) await handleMorningAlarm();
  if (alarm.name === ALARM_EOD)     await handleEodAlarm();
  if (alarm.name === ALARM_SNOOZE)  await handleSnoozeAlarm();
});

async function handleMorningAlarm() {
  // Don't prompt if already dismissed today
  const state = await getPromptState();
  const today = dateKey(new Date());
  if (state.dismissedDate === today) return;

  // Find most recent work capture
  const lastWork = await getLastWorkCapture();
  if (!lastWork) return; // nothing to restore

  // Don't prompt if that capture is from today already
  if (lastWork.capturedAt.startsWith(today)) return;

  showNotification("morning", lastWork);
}

async function handleEodAlarm() {
  const state = await getPromptState();
  const today = dateKey(new Date());
  if (state.eodDismissedDate === today) return;

  // Skip if user captured in the last 30 minutes
  const lastCapture = await getLastCaptureAny();
  if (lastCapture) {
    const minsAgo = (Date.now() - new Date(lastCapture.capturedAt).getTime()) / 60000;
    if (minsAgo < 30) return;
  }

  showEodNotification();
}

async function handleSnoozeAlarm() {
  const state = await getPromptState();
  if (state.snoozePending === "morning") {
    const lastWork = await getLastWorkCapture();
    if (lastWork) showNotification("morning", lastWork);
  }
  if (state.snoozePending === "eod") {
    showEodNotification();
  }
  await setPromptState({ snoozePending: null });
}

// ── Notifications ─────────────────────────────
function showNotification(type, capture) {
  const dayLabel  = formatCaptureDate(capture.capturedAt);
  const winCount  = capture.windows.length;
  const tabCount  = capture.windows.reduce((s, w) => s + w.tabs.length, 0);

  chrome.notifications.create("work-os-morning", {
    type:    "basic",
    iconUrl: "icons/icon128.png",
    title:   "Resume your work session?",
    message: `${dayLabel} · ${winCount} window${winCount !== 1 ? "s" : ""}, ${tabCount} tabs`,
    buttons: [
      { title: "Restore  [R]" },
      { title: "Snooze 30m  [S]" },
    ],
    requireInteraction: true,
    silent: false,
  });
}

function showEodNotification() {
  chrome.notifications.create("work-os-eod", {
    type:    "basic",
    iconUrl: "icons/icon128.png",
    title:   "End of day — save your session?",
    message: "Capture a snapshot before you close up.",
    buttons: [
      { title: "Capture now  [C]" },
      { title: "Snooze 30m   [S]" },
    ],
    requireInteraction: true,
    silent: false,
  });
}

// ── Notification button clicks ────────────────
chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (notifId === "work-os-morning") {
    chrome.notifications.clear(notifId);
    if (buttonIndex === 0) openPromptTab("morning");
    if (buttonIndex === 1) snoozePrompt("morning");
  }
  if (notifId === "work-os-eod") {
    chrome.notifications.clear(notifId);
    if (buttonIndex === 0) initiateCapture();
    if (buttonIndex === 1) snoozePrompt("eod");
  }
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId === "work-os-morning") openPromptTab("morning");
  if (notifId === "work-os-eod")     openPromptTab("eod");
  chrome.notifications.clear(notifId);
});

async function snoozePrompt(type) {
  await setPromptState({ snoozePending: type });
  chrome.alarms.create(ALARM_SNOOZE, { delayInMinutes: 30 });
}

async function openPromptTab(type) {
  await chrome.storage.session.set({ promptType: type });
  chrome.tabs.create({ url: chrome.runtime.getURL("notification-prompt.html"), active: true });
}

// ── Prompt state helpers ──────────────────────
async function getPromptState() {
  const d = await chrome.storage.local.get("promptState");
  return d.promptState || {};
}
async function setPromptState(patch) {
  const current = await getPromptState();
  await chrome.storage.local.set({ promptState: { ...current, ...patch } });
}


// ── Keyboard shortcut ─────────────────────────
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "capture-session") initiateCapture();
});

// ── Message bus ───────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {
      case "INITIATE_CAPTURE":   await initiateCapture();                           return { ok: true };
      case "SAVE_CAPTURE":       await saveCapture(msg.capture);                    return { ok: true };
      case "GET_DAYS":           return { days: await getDays() };
      case "GET_DAY":            return { day:  await getDay(msg.dayId) };
      case "DELETE_CAPTURE":     await deleteCapture(msg.dayId, msg.captureId);     return { ok: true };
      case "DELETE_DAY":         await deleteDay(msg.dayId);                        return { ok: true };
      case "RESTORE_WINDOWS":    await restoreWindows(msg.windows);                 return { ok: true };
      case "EXPORT_DAY":         exportDayAsJSON(msg.day);                          return { ok: true };
      case "IMPORT_DAY":         await importDay(msg.day);                          return { ok: true };
      case "DISMISS_PROMPT":     await dismissPrompt(msg.promptType);               return { ok: true };
      case "SNOOZE_PROMPT":      await snoozePrompt(msg.promptType);                return { ok: true };
      case "GET_LAST_WORK":      return { capture: await getLastWorkCapture() };
      default:                   return { ok: false, error: "unknown message type" };
    }
  };
  handle().then(sendResponse);
  return true;
});


// ─────────────────────────────────────────────────────────────────
// CAPTURE
// ─────────────────────────────────────────────────────────────────

async function initiateCapture() {
  const windows = await chrome.windows.getAll({ populate: true });
  const normal  = windows.filter((w) => w.type === "normal");

  const capturedWindows = normal.map((win) => {
    const tabs = win.tabs
      .filter((t) => !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
      .map((t) => ({
        title:      t.title      || "Untitled",
        url:        t.url,
        favIconUrl: t.favIconUrl || "",
        pinned:     t.pinned,
        index:      t.index,
      }));

    const { label, confidence } = inferWindowLabel(tabs);
    const splitSuggestion        = detectSplit(tabs);

    return { windowId: win.id, label, confidence, tabs, splitSuggestion };
  });

  await chrome.storage.session.set({ pendingCapture: capturedWindows });
  chrome.tabs.create({ url: chrome.runtime.getURL("capture-review.html"), active: true });
}


// ─────────────────────────────────────────────────────────────────
// HEURISTIC LABELLER
// ─────────────────────────────────────────────────────────────────

const DOMAIN_CATEGORIES = {
  // Recruiting & hiring
  "linkedin.com":               "Recruiting",
  "greenhouse.io":              "Recruiting",
  "lever.co":                   "Recruiting",
  "workday.com":                "Recruiting",
  "glassdoor.com":              "Recruiting",
  "indeed.com":                 "Recruiting",
  "wellfound.com":              "Recruiting",
  "otta.com":                   "Recruiting",
  "recruitee.com":              "Recruiting",
  "ashbyhq.com":                "Recruiting",
  "rippling.com":               "Recruiting",
  "smartrecruiters.com":        "Recruiting",
  // Company research
  "crunchbase.com":             "Research",
  "pitchbook.com":              "Research",
  "tracxn.com":                 "Research",
  "owler.com":                  "Research",
  "similarweb.com":             "Research",
  "builtwith.com":              "Research",
  "linkedin.com/company":       "Research",
  // Dev
  "github.com":                 "Dev",
  "gitlab.com":                 "Dev",
  "stackoverflow.com":          "Dev",
  "developer.chrome.com":       "Dev",
  "npmjs.com":                  "Dev",
  "vercel.com":                 "Dev",
  "netlify.com":                "Dev",
  "supabase.com":               "Dev",
  "developer.mozilla.org":      "Dev",
  "codepen.io":                 "Dev",
  // Design
  "figma.com":                  "Design",
  "dribbble.com":               "Design",
  "behance.net":                "Design",
  "framer.com":                 "Design",
  "webflow.com":                "Design",
  // Docs & notes
  "notion.so":                  "Docs",
  "docs.google.com":            "Docs",
  "confluence.atlassian.com":   "Docs",
  "coda.io":                    "Docs",
  "airtable.com":               "Docs",
  "obsidian.md":                "Docs",
  // Comms
  "mail.google.com":            "Email",
  "outlook.live.com":           "Email",
  "slack.com":                  "Comms",
  "discord.com":                "Comms",
  "teams.microsoft.com":        "Comms",
  // Productivity
  "calendar.google.com":        "Calendar",
  "trello.com":                 "Tasks",
  "linear.app":                 "Tasks",
  "asana.com":                  "Tasks",
  "jira.atlassian.com":         "Tasks",
  "clickup.com":                "Tasks",
  // Finance / admin
  "stripe.com":                 "Finance",
  "quickbooks.intuit.com":      "Finance",
  "expensify.com":              "Finance",
};

const STOP_WORDS = new Set([
  "the","a","an","and","or","of","in","on","at","to","for","with","by",
  "from","is","are","was","were","be","been","this","that","it","its",
  "new","tab","page","home","google","search","result","results","loading",
  "untitled","com","www","http","https","login","signin","sign","dashboard",
  "overview","profile","settings","account","user","my","your","our",
  "inc","llc","ltd","co","corp","company","about","jobs","careers","blog",
  "home","welcome","get","started","how","what","why","when","where","who",
]);

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
  } catch { return ""; }
}

function extractKeywords(title) {
  return title
    .replace(/[–\-|·•:,\[\]()\/#@!?]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function inferWindowLabel(tabs) {
  if (!tabs.length) return { label: "Empty Window", confidence: "low" };

  const categoryCounts = {};
  const domainCounts   = {};

  for (const tab of tabs) {
    const domain   = extractDomain(tab.url);
    if (!domain) continue;
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    const category = DOMAIN_CATEGORIES[domain];
    if (category) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  }

  const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];

  const keywordCounts = {};
  for (const tab of tabs) {
    for (const kw of extractKeywords(tab.title)) {
      keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
    }
  }

  const threshold        = Math.max(1, tabs.length * 0.4);
  const entityCandidates = Object.entries(keywordCounts)
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

  const entityName = entityCandidates.slice(0, 2).join(" ");

  let label = "", confidence = "low";

  if (entityName && topCategory) {
    label      = `${entityName} · ${topCategory[0]}`;
    confidence = "high";
  } else if (entityName) {
    label      = entityName;
    confidence = "medium";
  } else if (topCategory) {
    label      = topCategory[0];
    confidence = topCategory[1] / tabs.length >= 0.5 ? "medium" : "low";
  } else {
    const topDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0];
    label           = topDomain ? topDomain[0] : "Misc";
    confidence      = "low";
  }

  return { label, confidence };
}


// ─────────────────────────────────────────────────────────────────
// SPLIT DETECTION
// ─────────────────────────────────────────────────────────────────

// Returns null if no split suggested, or { clusterA, clusterB } if two
// clearly distinct high-signal category clusters detected.
// Threshold: each cluster must have ≥3 tabs and different categories,
// and the two clusters together must account for ≥70% of tabs.

function detectSplit(tabs) {
  if (tabs.length < 6) return null; // not enough signal

  const tabCategories = tabs.map((tab) => {
    const domain   = extractDomain(tab.url);
    const category = DOMAIN_CATEGORIES[domain] || null;
    return { tab, category };
  });

  // Group by category, ignore nulls
  const byCategory = {};
  for (const { tab, category } of tabCategories) {
    if (!category) continue;
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(tab);
  }

  // Find top two categories
  const ranked = Object.entries(byCategory)
    .sort((a, b) => b[1].length - a[1].length)
    .filter(([, ts]) => ts.length >= 3);

  if (ranked.length < 2) return null;

  const [catA, tabsA] = ranked[0];
  const [catB, tabsB] = ranked[1];

  // They must be different category families
  if (catA === catB) return null;

  // Together they must cover ≥70% of all tabs
  const coverage = (tabsA.length + tabsB.length) / tabs.length;
  if (coverage < 0.7) return null;

  return {
    clusterA: { category: catA, tabs: tabsA, label: inferWindowLabel(tabsA).label },
    clusterB: { category: catB, tabs: tabsB, label: inferWindowLabel(tabsB).label },
  };
}


// ─────────────────────────────────────────────────────────────────
// STORAGE  —  Day-grouped model
//
// Schema:
// chrome.storage.local → { days: Day[] }
//
// Day {
//   id:       "day-YYYY-MM-DD"
//   date:     "YYYY-MM-DD"
//   captures: Capture[]
// }
//
// Capture {
//   id:          uuid
//   capturedAt:  ISO string
//   context:     "work" | "personal"
//   label:       string   (auto e.g. "Morning", editable)
//   windows:     Window[]
// }
//
// Window {
//   label:      string
//   confidence: "high"|"medium"|"low"
//   tabs:       Tab[]
// }
//
// Tab { title, url, favIconUrl, pinned, index }
// ─────────────────────────────────────────────────────────────────

async function getDays() {
  const d = await chrome.storage.local.get("days");
  return d.days || [];
}

async function getDay(dayId) {
  const days = await getDays();
  return days.find((d) => d.id === dayId) || null;
}

async function saveCapture(capture) {
  // capture must have: { capturedAt, context, label, windows }
  // We assign id here if missing
  if (!capture.id) capture.id = crypto.randomUUID();

  const today  = dateKey(new Date(capture.capturedAt));
  const dayId  = `day-${today}`;
  const days   = await getDays();
  const idx    = days.findIndex((d) => d.id === dayId);

  if (idx >= 0) {
    // Append capture to existing day
    days[idx].captures.push(capture);
  } else {
    // Create new day
    days.unshift({
      id:       dayId,
      date:     today,
      captures: [capture],
    });
  }

  // Keep days sorted newest-first
  days.sort((a, b) => b.date.localeCompare(a.date));
  await chrome.storage.local.set({ days });
}

async function deleteCapture(dayId, captureId) {
  const days = await getDays();
  const day  = days.find((d) => d.id === dayId);
  if (!day) return;
  day.captures = day.captures.filter((c) => c.id !== captureId);
  // If day is now empty, remove it entirely
  const cleaned = day.captures.length ? days : days.filter((d) => d.id !== dayId);
  await chrome.storage.local.set({ days: cleaned });
}

async function deleteDay(dayId) {
  const days = await getDays();
  await chrome.storage.local.set({ days: days.filter((d) => d.id !== dayId) });
}

async function importDay(day) {
  // Merge imported day into storage (append captures if day already exists)
  const days = await getDays();
  const idx  = days.findIndex((d) => d.id === day.id);
  if (idx >= 0) {
    // Avoid duplicate capture ids
    const existingIds = new Set(days[idx].captures.map((c) => c.id));
    for (const cap of day.captures) {
      if (!existingIds.has(cap.id)) days[idx].captures.push(cap);
    }
  } else {
    days.unshift(day);
    days.sort((a, b) => b.date.localeCompare(a.date));
  }
  await chrome.storage.local.set({ days });
}

// ── Query helpers ─────────────────────────────
async function getLastWorkCapture() {
  const days = await getDays();
  for (const day of days) {
    // captures are stored in insertion order; scan newest day first
    const workCaptures = [...day.captures]
      .filter((c) => c.context === "work" || c.windows?.some((w) => w.context === "work"))
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    if (workCaptures.length) return workCaptures[0];
  }
  return null;
}

async function getLastCaptureAny() {
  const days = await getDays();
  if (!days.length || !days[0].captures.length) return null;
  return [...days[0].captures].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
}

// ── Prompt dismiss ────────────────────────────
async function dismissPrompt(promptType) {
  const today = dateKey(new Date());
  if (promptType === "morning") await setPromptState({ dismissedDate: today });
  if (promptType === "eod")     await setPromptState({ eodDismissedDate: today });
}


// ─────────────────────────────────────────────────────────────────
// RESTORE
// ─────────────────────────────────────────────────────────────────

async function restoreWindows(windowsToRestore) {
  for (const win of windowsToRestore) {
    const urls = win.tabs.map((t) => t.url).filter(Boolean);
    if (!urls.length) continue;
    await chrome.windows.create({ url: urls, focused: false });
  }
}


// ─────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────

function exportDayAsJSON(day) {
  const json     = JSON.stringify(day, null, 2);
  const dataUrl  = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  const filename = `work-os-tab-saver-logs/work-os-${day.id}.json`;
  chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}


// ─────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────

function dateKey(date) {
  // Returns "YYYY-MM-DD" in local time
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatCaptureDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
