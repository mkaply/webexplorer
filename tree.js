"use strict";

let allNodes = {};
let markingMode = false;
const markedIds = new Set();

function setMarkingMode(on) {
  markingMode = on;
  document.body.classList.toggle("marking-mode", on);
  document.getElementById("mark").classList.toggle("active", on);
}

function toggleMark(nodeId) {
  if (markedIds.has(nodeId)) markedIds.delete(nodeId);
  else markedIds.add(nodeId);
  const li = document.querySelector(`li.node[data-id="${nodeId}"]`);
  if (li) li.classList.toggle("marked", markedIds.has(nodeId));
  const btn = document.getElementById("report");
  btn.disabled = markedIds.size === 0;
  btn.textContent = markedIds.size ? `Report (${markedIds.size})` : "Report";
}

async function loadTree() {
  const res = await browser.runtime.sendMessage({ type: "getTree" });
  render((res && res.nodes) || {});
}

function buildIndex(nodes) {
  const children = {};
  const roots = [];
  for (const n of Object.values(nodes)) {
    if (n.parentId && nodes[n.parentId]) {
      (children[n.parentId] = children[n.parentId] || []).push(n);
    } else {
      roots.push(n);
    }
  }
  const cmp = (a, b) => a.timestamp - b.timestamp;
  roots.sort(cmp);
  for (const arr of Object.values(children)) arr.sort(cmp);
  return { children, roots };
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function fmt(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderNode(node, children) {
  const li = document.createElement("li");
  li.className = "node";
  if (markedIds.has(node.id)) li.classList.add("marked");
  li.dataset.id = node.id;

  const row = document.createElement("div");
  row.className = "row";

  const kids = children[node.id] || [];
  const toggle = document.createElement("span");
  toggle.className = "toggle" + (kids.length ? "" : " leaf");
  toggle.textContent = kids.length ? "▼" : "·";
  if (kids.length) {
    toggle.addEventListener("click", () => {
      const collapsed = li.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "▶" : "▼";
    });
  }
  row.appendChild(toggle);

  if (node.favIconUrl) {
    const img = document.createElement("img");
    img.className = "favicon";
    img.src = node.favIconUrl;
    img.onerror = () => img.remove();
    row.appendChild(img);
  } else {
    const ph = document.createElement("span");
    ph.className = "favicon";
    row.appendChild(ph);
  }

  const a = document.createElement("a");
  a.className = "title";
  a.href = node.url;
  a.textContent = node.title || node.url;
  a.title =
    (node.title || node.url) +
    "\n" + node.url +
    "\n" + new Date(node.timestamp).toLocaleString() +
    (node.transitionType ? "\n[" + node.transitionType + "]" : "");
  a.addEventListener("click", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (markingMode) {
      toggleMark(node.id);
      return;
    }
    const inBackground = e.ctrlKey || e.metaKey || e.shiftKey;
    browser.runtime.sendMessage({
      type: "openFromNode",
      nodeId: node.id,
      active: !inBackground
    });
  });
  a.addEventListener("auxclick", e => {
    if (e.button !== 1) return;
    e.preventDefault();
    browser.runtime.sendMessage({
      type: "openFromNode",
      nodeId: node.id,
      active: false
    });
  });
  row.appendChild(a);

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = hostname(node.url) + " · " + fmt(node.timestamp);
  row.appendChild(meta);

  const del = document.createElement("button");
  del.className = "delete";
  del.title = "Remove this entry (children reparent to its parent)";
  del.textContent = "✕";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await browser.runtime.sendMessage({ type: "deleteNode", id: node.id });
  });
  row.appendChild(del);

  li.appendChild(row);
  if (kids.length) {
    const ul = document.createElement("ul");
    for (const c of kids) ul.appendChild(renderNode(c, children));
    li.appendChild(ul);
  }
  return li;
}

function render(nodes) {
  allNodes = nodes;
  const { children, roots } = buildIndex(nodes);
  const root = document.getElementById("tree");
  root.textContent = "";
  if (!roots.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No history yet. Start browsing and your tree will appear here.";
    root.appendChild(empty);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "tree-root";
  for (const r of roots) ul.appendChild(renderNode(r, children));
  root.appendChild(ul);
  applyFilter();
}

function applyFilter() {
  const q = document.getElementById("search").value.toLowerCase().trim();
  const items = document.querySelectorAll("#tree li.node");
  if (!q) {
    items.forEach(li => li.classList.remove("hidden", "match"));
    return;
  }
  items.forEach(li => {
    li.classList.remove("match");
    li.classList.add("hidden");
  });
  items.forEach(li => {
    const text = li.querySelector(".row").textContent.toLowerCase();
    if (text.includes(q)) {
      li.classList.add("match");
      li.classList.remove("hidden");
      let p = li.parentElement;
      while (p && p.id !== "tree") {
        if (p.tagName === "LI") p.classList.remove("hidden");
        p = p.parentElement;
      }
    }
  });
}

document.getElementById("search").addEventListener("input", applyFilter);
document.getElementById("refresh").addEventListener("click", loadTree);

document.getElementById("expand").addEventListener("click", () => {
  document.querySelectorAll("#tree li.node.collapsed").forEach(li => {
    li.classList.remove("collapsed");
    const t = li.querySelector(":scope > .row > .toggle");
    if (t && !t.classList.contains("leaf")) t.textContent = "▼";
  });
});

document.getElementById("collapse").addEventListener("click", () => {
  document.querySelectorAll("#tree li.node").forEach(li => {
    if (li.querySelector(":scope > ul")) {
      li.classList.add("collapsed");
      const t = li.querySelector(":scope > .row > .toggle");
      if (t && !t.classList.contains("leaf")) t.textContent = "▶";
    }
  });
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear all WebExplorer history?")) return;
  await browser.runtime.sendMessage({ type: "clear" });
});

document.getElementById("mark").addEventListener("click", () => {
  setMarkingMode(!markingMode);
});

document.getElementById("report").addEventListener("click", async () => {
  const btn = document.getElementById("report");
  const ids = [...markedIds];
  const report = await buildReport(ids);
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Report"; }, 1500);
  } catch (e) {
    alert("Clipboard write failed: " + e.message);
    return;
  }
  for (const id of ids) {
    const li = document.querySelector(`li.node[data-id="${id}"]`);
    if (li) li.classList.remove("marked");
  }
  markedIds.clear();
  setMarkingMode(false);
});

function summarizeFavicon(url) {
  if (!url) return null;
  return {
    present: true,
    isData: url.startsWith("data:"),
    length: url.length,
    sample: url.length > 80 ? url.slice(0, 80) + "…" : url
  };
}

function nodeSummary(n) {
  return {
    id: n.id,
    url: n.url,
    title: n.title,
    transitionType: n.transitionType,
    timestamp: n.timestamp,
    tabId: n.tabId,
    parentId: n.parentId,
    favicon: summarizeFavicon(n.favIconUrl)
  };
}

async function buildReport(nodeIds) {
  const [treeRes, logRes] = await Promise.all([
    browser.runtime.sendMessage({ type: "getTree" }),
    browser.runtime.sendMessage({ type: "getLog" })
  ]);
  const nodesMap = (treeRes && treeRes.nodes) || {};
  const logEntries = (logRes && logRes.log) || [];
  const manifest = browser.runtime.getManifest();

  const meta = {
    generated: new Date().toISOString(),
    extension: {
      name: manifest.name,
      version: manifest.version,
      id: manifest.browser_specific_settings && manifest.browser_specific_settings.gecko
        ? manifest.browser_specific_settings.gecko.id
        : null
    },
    userAgent: navigator.userAgent,
    nodeCount: Object.keys(nodesMap).length,
    logEntryCount: logEntries.length
  };

  const sections = nodeIds.map(nid => {
    const n = nodesMap[nid];
    if (!n) return { nodeId: nid, missing: true };

    const ancestry = [];
    let cur = n;
    let depth = 0;
    while (cur && depth < 50) {
      ancestry.unshift(nodeSummary(cur));
      cur = cur.parentId ? nodesMap[cur.parentId] : null;
      depth++;
    }

    const children = Object.values(nodesMap)
      .filter(x => x.parentId === nid)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(nodeSummary);

    const siblings = n.parentId
      ? Object.values(nodesMap)
          .filter(x => x.parentId === n.parentId && x.id !== nid)
          .sort((a, b) => Math.abs(a.timestamp - n.timestamp) - Math.abs(b.timestamp - n.timestamp))
          .slice(0, 10)
          .map(nodeSummary)
      : [];

    const ancestorIds = new Set(ancestry.map(a => a.id));
    const childIds = new Set(children.map(c => c.id));
    const ts = n.timestamp;
    const tabId = n.tabId;
    const related = logEntries.filter(e =>
      (e.nodeId && (e.nodeId === nid || ancestorIds.has(e.nodeId) || childIds.has(e.nodeId))) ||
      (e.parentId && (e.parentId === nid || ancestorIds.has(e.parentId))) ||
      (e.tabId === tabId && Math.abs(e.t - ts) < 10000)
    );

    return { ancestry, children, siblingsNearestInTime: siblings, relatedLog: related };
  });

  return { ...meta, marked: sections };
}


browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["webexplorer.nodes"]) {
    render(changes["webexplorer.nodes"].newValue || {});
  }
});

loadTree();
