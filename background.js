"use strict";

const STORAGE_KEY = "webexplorer.nodes";
const TAB_STATE_KEY = "webexplorer.tabstate";
const LOG_KEY = "webexplorer.log";
const MAX_NODES = 5000;
const LOG_MAX = 200;
const REDIRECT_MERGE_MS = 1500;
const HISTORY_STATE_MERGE_MS = 500;
const HISTORY_STATE_HASH_ADD_MS = 5000;
const OPENED_REDIRECTOR_MS = 5000;

const INTERSTITIAL_PATTERNS = [
  /^https?:\/\/(?:www\.|m\.)?fark\.com\/goto\//i,
  /^https?:\/\/chatgpt\.com\/auth\/login\b/i,
  /^https?:\/\/[\w.-]*auth0\.com\/samlp\//i,
  /^https?:\/\/login\.microsoftonline\.com\//i,
  /^https?:\/\/[\w.-]*\.okta\.com\/login\/sessionCookieRedirect\b/i,
  /^https?:\/\/api\.workos\.com\/sso\//i
];

function isInterstitial(url) {
  return INTERSTITIAL_PATTERNS.some(p => p.test(url));
}

let nodes = {};
let tabCurrent = {};
let tabHistory = {};
let tabHistoryIndex = {};
let lastCommitAt = {};
let pendingOpener = {};
let logBuffer = [];
let saveTimer = null;

function log(type, data) {
  const entry = { t: Date.now(), type, ...data };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_MAX);
  }
  scheduleSave();
}
let loaded = false;
let loadPromise = null;

const CHILD_TRANSITIONS = new Set([
  "link",
  "form_submit",
  "manual_subframe",
  "auto_subframe"
]);

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function normalizeUrl(url) {
  return url.endsWith("#") ? url.slice(0, -1) : url;
}

function sameUrl(a, b) {
  return normalizeUrl(a) === normalizeUrl(b);
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function siblingParentPath(url) {
  try {
    const u = new URL(url);
    if (u.hash && u.hash.length > 1 && u.hash.includes("/")) {
      const i = u.hash.lastIndexOf("/");
      return {
        shape: "hash",
        value: u.origin + u.pathname + u.search + u.hash.slice(0, i)
      };
    }
    if (u.pathname.length > 1) {
      const i = u.pathname.lastIndexOf("/");
      if (i > 0) {
        return {
          shape: u.hash && u.hash.length > 1 ? "path+hash" : "path",
          value: u.origin + u.pathname.slice(0, i)
        };
      }
    }
  } catch {}
  return null;
}

function hasHash(url) {
  try {
    const u = new URL(url);
    return !!(u.hash && u.hash.length > 1);
  } catch {
    return false;
  }
}

function isShallowHash(url) {
  try {
    const h = new URL(url).hash;
    return !h || h.length <= 1 || !h.includes("/");
  } catch {
    return true;
  }
}

function isSameDocCleanup(curUrl, newUrl) {
  try {
    const a = new URL(curUrl);
    const b = new URL(newUrl);
    if (a.origin !== b.origin) return false;
    if (a.pathname !== b.pathname) return false;
    return isShallowHash(curUrl) && isShallowHash(newUrl);
  } catch {
    return false;
  }
}

function isStableFavicon(url) {
  return !!url && !url.startsWith("data:") && !url.startsWith("chrome://");
}

function shouldReplaceFavicon(current, incoming) {
  if (!incoming) return false;
  if (incoming.startsWith("chrome://")) return false;
  if (current === incoming) return false;
  if (!current || current.startsWith("chrome://")) return true;
  if (isStableFavicon(incoming) && !isStableFavicon(current)) return true;
  if (!isStableFavicon(incoming) && isStableFavicon(current)) return false;
  if (!isStableFavicon(incoming) && !isStableFavicon(current)) return false;
  return true;
}

function samePage(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

function inheritFavicon(startNodeId, newUrl) {
  let id = startNodeId;
  for (let depth = 0; depth < 10 && id; depth++) {
    const n = nodes[id];
    if (!n) return null;
    if (n.favIconUrl && sameOrigin(n.url, newUrl)) {
      return n.favIconUrl;
    }
    id = n.parentId;
  }
  return null;
}

function shouldIgnore(url) {
  if (!url) return true;
  if (url === "about:blank") return true;
  return (
    url.startsWith("about:") ||
    url.startsWith("moz-extension:") ||
    url.startsWith("chrome:") ||
    url.startsWith("resource:") ||
    url.startsWith("view-source:")
  );
}

async function load() {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const stored = await browser.storage.local.get([STORAGE_KEY, TAB_STATE_KEY, LOG_KEY]);
      if (stored[STORAGE_KEY]) nodes = stored[STORAGE_KEY];
      if (stored[TAB_STATE_KEY]) {
        const s = stored[TAB_STATE_KEY];
        tabCurrent = s.tabCurrent || {};
        tabHistory = s.tabHistory || {};
        tabHistoryIndex = s.tabHistoryIndex || {};
        lastCommitAt = s.lastCommitAt || {};
        pendingOpener = s.pendingOpener || {};
      }
      if (stored[LOG_KEY]) logBuffer = stored[LOG_KEY];
      const restored = Object.keys(tabCurrent).length;
      await reconcileTabs();
      loaded = true;
      log("wake", { tabs: restored, nodes: Object.keys(nodes).length });
      console.log("WebExplorer: background woke up — restored state for", restored, "tab(s),", Object.keys(nodes).length, "nodes");
    })();
  }
  return loadPromise;
}

async function reconcileTabs() {
  try {
    const tabs = await browser.tabs.query({});
    const valid = new Set(tabs.map(t => String(t.id)));
    let dropped = 0;
    for (const tid of Object.keys(tabCurrent)) {
      if (!valid.has(tid)) {
        delete tabCurrent[tid];
        delete tabHistory[tid];
        delete tabHistoryIndex[tid];
        delete lastCommitAt[tid];
        delete pendingOpener[tid];
        dropped++;
      }
    }
    if (dropped) {
      log("reconcile", { dropped });
      console.log("WebExplorer: pruned", dropped, "stale tab entries during reconcile");
    }
  } catch (e) {
    console.error("WebExplorer: tab reconcile failed", e);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const ids = Object.keys(nodes);
    if (ids.length > MAX_NODES) {
      const sorted = ids
        .map(id => nodes[id])
        .sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = sorted.length - MAX_NODES;
      for (let i = 0; i < toRemove; i++) delete nodes[sorted[i].id];
      for (const n of Object.values(nodes)) {
        if (n.parentId && !nodes[n.parentId]) n.parentId = null;
      }
    }
    try {
      await browser.storage.local.set({
        [STORAGE_KEY]: nodes,
        [TAB_STATE_KEY]: { tabCurrent, tabHistory, tabHistoryIndex, lastCommitAt, pendingOpener },
        [LOG_KEY]: logBuffer
      });
    } catch (e) {
      console.error("WebExplorer save failed", e);
    }
  }, 500);
}

function addNode({ url, title, tabId, parentId, transitionType, favIconUrl }) {
  const node = {
    id: newId(),
    url,
    title: title || url,
    favIconUrl: favIconUrl || null,
    timestamp: Date.now(),
    parentId: parentId || null,
    tabId,
    transitionType: transitionType || null
  };
  nodes[node.id] = node;
  tabCurrent[tabId] = node.id;
  pushTabHistory(tabId, node.id);
  scheduleSave();
  return node;
}

function pushTabHistory(tabId, nodeId) {
  const hist = tabHistory[tabId] || [];
  const idx = tabHistoryIndex[tabId];
  const truncated = idx == null ? [] : hist.slice(0, idx + 1);
  truncated.push(nodeId);
  tabHistory[tabId] = truncated;
  tabHistoryIndex[tabId] = truncated.length - 1;
}

function tryForwardBack(tabId, url) {
  const hist = tabHistory[tabId];
  const idx = tabHistoryIndex[tabId];
  if (!hist || idx == null) return false;
  const matches = (i) => i >= 0 && i < hist.length && nodes[hist[i]] && sameUrl(nodes[hist[i]].url, url);
  // Probe outward from current index — closest match wins, so a single-step
  // back/forward is preferred over a long jump.
  for (let d = 1; d < hist.length; d++) {
    if (matches(idx - d)) {
      tabHistoryIndex[tabId] = idx - d;
      tabCurrent[tabId] = hist[idx - d];
      return true;
    }
    if (matches(idx + d)) {
      tabHistoryIndex[tabId] = idx + d;
      tabCurrent[tabId] = hist[idx + d];
      return true;
    }
  }
  return false;
}

function handleNavigation(details, opts) {
  if (details.frameId !== 0) return;
  if (shouldIgnore(details.url)) return;
  if (isInterstitial(details.url)) {
    log("nav", {
      src: opts.fromCommitted ? "commit" : "history",
      tabId: details.tabId,
      url: details.url,
      decision: "interstitial-skip"
    });
    return;
  }

  const tType = details.transitionType;
  const quals = details.transitionQualifiers || [];
  const tabId = details.tabId;
  const now = Date.now();
  const prevCommitAt = lastCommitAt[tabId] || 0;

  if (opts.fromCommitted) {
    lastCommitAt[tabId] = now;
  }

  const baseLog = {
    src: opts.fromCommitted ? "commit" : "history",
    tabId,
    url: details.url,
    tType,
    quals
  };

  if (opts.fromCommitted && tType === "reload" && tabCurrent[tabId]) {
    log("nav", { ...baseLog, decision: "reload-skip" });
    return;
  }

  const tryStack = opts.fromHistoryState || quals.includes("forward_back");
  if (tryStack && tryForwardBack(tabId, details.url)) {
    log("nav", { ...baseLog, decision: "repositioned", nodeId: tabCurrent[tabId] });
    return;
  }

  let parentId = null;
  let parentSource = "none";
  if (pendingOpener[tabId]) {
    parentId = pendingOpener[tabId];
    delete pendingOpener[tabId];
    parentSource = "opener";
  } else if (opts.fromHistoryState) {
    parentId = tabCurrent[tabId] || null;
    parentSource = "current";
  } else if (CHILD_TRANSITIONS.has(tType)) {
    parentId = tabCurrent[tabId] || null;
    parentSource = "current";
  }

  const curId = tabCurrent[tabId];
  const cur = curId ? nodes[curId] : null;
  if (cur && sameUrl(cur.url, details.url)) {
    log("nav", { ...baseLog, decision: "dedup", nodeId: curId });
    return;
  }

  if (opts.fromHistoryState && cur && isSameDocCleanup(cur.url, details.url)) {
    cur.url = details.url;
    scheduleSave();
    log("nav", { ...baseLog, decision: "anchor-skip", nodeId: curId });
    return;
  }

  let siblingOverride = false;
  if (opts.fromHistoryState && cur && parentId === curId) {
    const csp = siblingParentPath(cur.url);
    const sp = siblingParentPath(details.url);
    if (
      csp && sp &&
      csp.shape === sp.shape &&
      csp.value === sp.value &&
      !isSameDocCleanup(cur.url, details.url)
    ) {
      parentId = cur.parentId || null;
      siblingOverride = true;
    }
  }

  const isRedirectQual = quals.includes("client_redirect") || quals.includes("server_redirect");
  let canMerge = false;
  if (cur) {
    if (opts.fromCommitted && isRedirectQual && (now - prevCommitAt) < REDIRECT_MERGE_MS) {
      canMerge = true;
    } else if (opts.fromCommitted && parentId === curId && (now - cur.timestamp) < REDIRECT_MERGE_MS) {
      canMerge = true;
    } else if (opts.fromCommitted && parentId === curId && (now - cur.timestamp) < OPENED_REDIRECTOR_MS) {
      const isFirstNav = (tabHistory[tabId] || []).length <= 1;
      const openedFromAnotherTab =
        cur.parentId &&
        nodes[cur.parentId] &&
        nodes[cur.parentId].tabId !== tabId;
      if (isFirstNav && openedFromAnotherTab && !sameOrigin(cur.url, details.url)) {
        canMerge = true;
      }
    } else if (opts.fromHistoryState && parentId === curId) {
      const sinceCommit = now - prevCommitAt;
      const isHashAddition = !hasHash(cur.url) && hasHash(details.url) && isShallowHash(details.url);
      const window = isHashAddition ? HISTORY_STATE_HASH_ADD_MS : HISTORY_STATE_MERGE_MS;
      canMerge = sinceCommit < window;
    }
  }
  const inheritedFavicon = curId ? inheritFavicon(curId, details.url) : null;

  if (canMerge) {
    const sameDoc = samePage(cur.url, details.url);
    cur.url = details.url;
    if (!sameDoc) {
      cur.title = details.url;
      cur.favIconUrl = inheritedFavicon;
    }
    cur.transitionType = opts.fromHistoryState ? (tType || "history_state") : tType;
    scheduleSave();
    log("nav", { ...baseLog, decision: "merged", nodeId: cur.id });
    return;
  }

  const node = addNode({
    url: details.url,
    title: details.url,
    favIconUrl: inheritedFavicon,
    tabId,
    parentId,
    transitionType: opts.fromHistoryState ? (tType || "history_state") : tType
  });
  log("nav", {
    ...baseLog,
    decision: parentId ? "added-child" : "added-root",
    nodeId: node.id,
    parentId,
    parentSource,
    siblingOverride
  });
}

browser.webNavigation.onCreatedNavigationTarget.addListener(async details => {
  await load();
  const sourceNodeId = tabCurrent[details.sourceTabId];
  if (sourceNodeId) {
    pendingOpener[details.tabId] = sourceNodeId;
    scheduleSave();
    log("opener", {
      tabId: details.tabId,
      sourceTabId: details.sourceTabId,
      sourceNodeId,
      url: details.url
    });
  } else {
    log("opener-miss", {
      tabId: details.tabId,
      sourceTabId: details.sourceTabId,
      url: details.url
    });
    console.warn(
      "WebExplorer: new tab", details.tabId,
      "opened from source tab", details.sourceTabId,
      "but source tab had no tracked node — new tab will become a ROOT.",
      "URL:", details.url
    );
  }
});

async function seedTitleFromTab(tabId) {
  const nodeId = tabCurrent[tabId];
  if (!nodeId || !nodes[nodeId]) return;
  if (nodes[nodeId].title !== nodes[nodeId].url) return;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.title && tab.title !== tab.url && samePage(tab.url, nodes[nodeId].url)) {
      nodes[nodeId].title = tab.title;
      scheduleSave();
    }
  } catch {}
}

browser.webNavigation.onCommitted.addListener(async details => {
  await load();
  handleNavigation(details, { fromCommitted: true });
  seedTitleFromTab(details.tabId);
});

browser.webNavigation.onHistoryStateUpdated.addListener(async details => {
  await load();
  handleNavigation(details, { fromHistoryState: true });
  seedTitleFromTab(details.tabId);
});

browser.webNavigation.onReferenceFragmentUpdated.addListener(async details => {
  await load();
  handleNavigation(details, { fromHistoryState: true });
  seedTitleFromTab(details.tabId);
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.favIconUrl) return;
  await load();
  const id = tabCurrent[tabId];

  if (changeInfo.favIconUrl) {
    const u = changeInfo.favIconUrl;
    const preview = u.length > 60 ? u.slice(0, 60) + "…" : u;
    let decision;
    if (!id || !nodes[id]) decision = "skip-no-node";
    else if (!samePage(tab.url, nodes[id].url)) decision = "skip-url-mismatch";
    else if (!shouldReplaceFavicon(nodes[id].favIconUrl, u)) {
      decision = nodes[id].favIconUrl === u ? "skip-same" :
        (isStableFavicon(nodes[id].favIconUrl) ? "skip-no-downgrade" : "skip-keep-first-data");
    }
    else decision = "stored";
    log("favicon", {
      tabId,
      nodeId: id || null,
      decision,
      preview,
      tabUrl: tab.url,
      nodeUrl: id && nodes[id] ? nodes[id].url : null
    });
  }

  if (changeInfo.title) {
    const t = changeInfo.title;
    const preview = t.length > 80 ? t.slice(0, 80) + "…" : t;
    let decision;
    if (!id || !nodes[id]) decision = "skip-no-node";
    else if (!samePage(tab.url, nodes[id].url)) decision = "skip-url-mismatch";
    else if (t === nodes[id].title) decision = "skip-same";
    else decision = "stored";
    log("title", {
      tabId,
      nodeId: id || null,
      decision,
      preview,
      tabUrl: tab.url,
      nodeUrl: id && nodes[id] ? nodes[id].url : null
    });
  }

  if (!id || !nodes[id]) return;
  if (!samePage(tab.url, nodes[id].url)) return;
  let changed = false;
  if (changeInfo.title && changeInfo.title !== nodes[id].title) {
    nodes[id].title = changeInfo.title;
    changed = true;
  }
  if (changeInfo.favIconUrl && shouldReplaceFavicon(nodes[id].favIconUrl, changeInfo.favIconUrl)) {
    nodes[id].favIconUrl = changeInfo.favIconUrl;
    changed = true;
  } else if (
    !nodes[id].favIconUrl &&
    tab.favIconUrl &&
    isStableFavicon(tab.favIconUrl) &&
    shouldReplaceFavicon(null, tab.favIconUrl)
  ) {
    nodes[id].favIconUrl = tab.favIconUrl;
    changed = true;
    const u = tab.favIconUrl;
    const preview = u.length > 60 ? u.slice(0, 60) + "…" : u;
    log("favicon", {
      tabId,
      nodeId: id,
      decision: "fallback-stored",
      preview,
      tabUrl: tab.url,
      nodeUrl: nodes[id].url
    });
  }
  if (changed) scheduleSave();
});

browser.tabs.onRemoved.addListener(tabId => {
  delete tabCurrent[tabId];
  delete tabHistory[tabId];
  delete tabHistoryIndex[tabId];
  delete lastCommitAt[tabId];
  delete pendingOpener[tabId];
  scheduleSave();
});

browser.history.onVisitRemoved.addListener(async removeInfo => {
  await load();
  if (removeInfo.allHistory) {
    nodes = {};
    tabCurrent = {};
    tabHistory = {};
    tabHistoryIndex = {};
    lastCommitAt = {};
    pendingOpener = {};
    logBuffer = [];
    await browser.storage.local.set({
      [STORAGE_KEY]: nodes,
      [TAB_STATE_KEY]: { tabCurrent, tabHistory, tabHistoryIndex, lastCommitAt, pendingOpener },
      [LOG_KEY]: logBuffer
    });
    log("history-cleared", {});
    return;
  }
  if (removeInfo.urls && removeInfo.urls.length) {
    const urlSet = new Set(removeInfo.urls.map(normalizeUrl));
    const removedIds = new Set();
    for (const [id, n] of Object.entries(nodes)) {
      if (urlSet.has(normalizeUrl(n.url))) {
        removedIds.add(id);
      }
    }
    for (const id of removedIds) {
      for (const n of Object.values(nodes)) {
        if (n.parentId === id) n.parentId = nodes[id].parentId || null;
      }
      delete nodes[id];
      for (const tid of Object.keys(tabCurrent)) {
        if (tabCurrent[tid] === id) delete tabCurrent[tid];
      }
    }
    if (removedIds.size) {
      log("history-removed", { count: removedIds.size });
      scheduleSave();
    }
  }
});

browser.action.onClicked.addListener(async () => {
  try {
    const url = browser.runtime.getURL("tree.html");
    const existing = await browser.tabs.query({ url });
    if (existing.length) {
      await browser.tabs.update(existing[0].id, { active: true });
      await browser.windows.update(existing[0].windowId, { focused: true });
    } else {
      await browser.tabs.create({ url });
    }
  } catch (e) {
    console.error("WebExplorer: action handler failed", e);
  }
});

browser.runtime.onMessage.addListener(async msg => {
  await load();
  if (msg && msg.type === "getTree") {
    return { nodes };
  }
  if (msg && msg.type === "clear") {
    nodes = {};
    tabCurrent = {};
    tabHistory = {};
    tabHistoryIndex = {};
    lastCommitAt = {};
    pendingOpener = {};
    await browser.storage.local.set({
      [STORAGE_KEY]: nodes,
      [TAB_STATE_KEY]: { tabCurrent, tabHistory, tabHistoryIndex, lastCommitAt, pendingOpener }
    });
    return { ok: true };
  }
  if (msg && msg.type === "getLog") {
    return { log: logBuffer.slice() };
  }
  if (msg && msg.type === "clearLog") {
    logBuffer = [];
    await browser.storage.local.set({ [LOG_KEY]: logBuffer });
    return { ok: true };
  }
  if (msg && msg.type === "openFromNode") {
    const n = nodes[msg.nodeId];
    if (!n) return { ok: false };
    const allTabs = await browser.tabs.query({});
    const existing = allTabs.find(t => t.url && sameUrl(t.url, n.url));
    if (existing) {
      await browser.tabs.update(existing.id, { active: true });
      await browser.windows.update(existing.windowId, { focused: true });
      return { ok: true, switched: true };
    }
    const tab = await browser.tabs.create({
      url: "about:blank",
      active: msg.active !== false
    });
    tabCurrent[tab.id] = n.id;
    tabHistory[tab.id] = [n.id];
    tabHistoryIndex[tab.id] = 0;
    await browser.tabs.update(tab.id, { url: n.url });
    return { ok: true };
  }
  if (msg && msg.type === "deleteNode") {
    const id = msg.id;
    if (nodes[id]) {
      for (const n of Object.values(nodes)) {
        if (n.parentId === id) n.parentId = nodes[id].parentId || null;
      }
      delete nodes[id];
      for (const tid of Object.keys(tabCurrent)) {
        if (tabCurrent[tid] === id) delete tabCurrent[tid];
      }
      scheduleSave();
    }
    return { ok: true };
  }
});

load();
