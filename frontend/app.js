/* Nav + context menu + single-cell run + existing DAG features */

/* ----------------------------- helpers ----------------------------------- */
async function postJSON(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function uploadNotebook(file) {
  const form = new FormData();
  form.append("nb", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function cellIndex(id) {
  const m = /(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}
function generateId(nodes) {
  let n = nodes.length + 1;
  const used = new Set(nodes.map(n => n.id));
  while (used.has(`cell-${n}`)) n++;
  return `cell-${n}`;
}
function cloneGraph(g) {
  return { nodes: g.nodes.map(n => ({ ...n })), edges: g.edges.map(e => ({ ...e })) };
}

/* ---------------------------- state -------------------------------------- */
let cy = null;
let currentGraph = { nodes: [], edges: [] };
let selectedNodeId = null;
let connectMode = null; // 'add' | 'remove' | null
let firstPick = null;

/* --------------------------- UI refs ------------------------------------- */
const runOut = document.getElementById("run-output");
const editor = document.getElementById("editor");
const applyBtn = document.getElementById("apply-btn");
const ioBadges = document.getElementById("io-badges");

/* Menubar elements */
const menubar = document.querySelector(".menubar");
const menuUpload = document.getElementById("menu-upload"); // label that triggers input
const fileInput = document.getElementById("file-input");
const menuNewWs = document.getElementById("menu-new-ws");

const menuAddNode = document.getElementById("menu-add-node");
const menuDelNode = document.getElementById("menu-del-node");
const menuAddConn = document.getElementById("menu-add-conn");
const menuDelConn = document.getElementById("menu-del-conn");

const menuRunCell = document.getElementById("menu-run-cell");
const menuRunAll = document.getElementById("menu-run-all");

/* Context menu elements */
const ctx = document.getElementById("ctx");
const ctxAddNode = document.getElementById("ctx-add-node");
const ctxDelNode = document.getElementById("ctx-del-node");
const ctxAddConn = document.getElementById("ctx-add-conn");
const ctxDelConn = document.getElementById("ctx-del-conn");
const ctxRunCell = document.getElementById("ctx-run-cell");
const ctxRunAll = document.getElementById("ctx-run-all");

/* ---------------------- graph element building --------------------------- */
function buildElements(graph) {
  const nodesSorted = [...graph.nodes].sort((a, b) => cellIndex(a.id) - cellIndex(b.id));
  const order = new Map(nodesSorted.map((n, i) => [n.id, i]));
  const laneCount = new Map();
  const elements = [];

  for (const n of nodesSorted) {
    elements.push({ data: { id: n.id, label: n.label ?? n.id, code: n.code ?? "" }, classes: "cell-node" });
  }

  for (const e of graph.edges) {
    const i = order.get(e.source);
    const j = order.get(e.target);
    if (i == null || j == null) continue;

    const key = `${i}-${j}`;
    const k = laneCount.get(key) ?? 0;
    laneCount.set(key, k + 1);

    const span = Math.abs(j - i) || 1;
    const base = 80;
    const perSpan = 70 * span;
    const perLane = 30 * k;
    const distance = base + perSpan + perLane;
    const sign = ((i + j + k) % 2 === 0) ? 1 : -1;
    const cpd = [sign * distance];
    const cpw = [0.48 + Math.min(0.12, span * 0.02)];
    const label = (e.labels || []).join(", ");

    elements.push({
      data: { id: `${e.source}->${e.target}-${k}`, source: e.source, target: e.target, label, cpd, cpw },
      classes: "flow-edge",
    });
  }

  return { elements, nodesSorted };
}

function positionLinear(cy, nodesSorted) {
  const spacing = 180;
  const y = 0;
  nodesSorted.forEach((n, idx) => cy.getElementById(n.id).position({ x: idx * spacing, y }));
  cy.center();
  cy.fit(undefined, 60);
}

function refreshIOBadges() {
  ioBadges.innerHTML = "";
  if (!selectedNodeId) return;
  const incoming = currentGraph.edges.filter(e => e.target === selectedNodeId).length;
  const outgoing = currentGraph.edges.filter(e => e.source === selectedNodeId).length;
  const inB = document.createElement("span");
  inB.className = "badge in";
  inB.textContent = `incoming: ${incoming}`;
  const outB = document.createElement("span");
  outB.className = "badge out";
  outB.textContent = `outgoing: ${outgoing}`;
  ioBadges.appendChild(inB);
  ioBadges.appendChild(outB);
}

/* --------------------------- render/setup -------------------------------- */
function renderGraph(graph) {
  currentGraph = graph;
  const { elements, nodesSorted } = buildElements(graph);

  if (!cy) {
    cy = cytoscape({
      container: document.getElementById("graph"),
      elements,
      style: [
        { selector: "node.cell-node", style: {
          "shape": "ellipse","width": 56,"height": 56,"background-color": "#6aa1ff",
          "border-color": "#1f2a37","border-width": 2,
          "label": "data(label)","text-valign": "top","text-halign": "center","text-margin-y": -40,
          "color": "#e8eef6","font-weight": 700,"font-size": 11,"text-wrap": "wrap","text-max-width": 100
        }},
        { selector: "edge.flow-edge", style: {
          "curve-style": "unbundled-bezier","edge-distances": "node-position",
          "control-point-distances": "data(cpd)","control-point-weights": "data(cpw)",
          "width": 2,"line-color": "#9fb3c8","target-arrow-shape": "triangle","target-arrow-color": "#9fb3c8","arrow-scale": 1.1,
          "label": "data(label)","font-size": 10,"text-background-color": "#121821","text-background-opacity": 1,"text-background-padding": 2,"color": "#9fb3c8",
          "z-index-compare": "manual","z-index": 1
        }},
        { selector: ":selected", style: {
          "background-color": "#ffd166","line-color": "#ffd166","target-arrow-color": "#ffd166","z-index": 2
        }}
      ],
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
      autoungrabify: false
    });

    cy.on("tap", "node", (evt) => {
      const data = evt.target.data();
      if (connectMode) {
        if (!firstPick) {
          firstPick = data.id;
          cy.$id(data.id).select();
          return;
        } else {
          const second = data.id;
          if (connectMode === "add") addConnection(firstPick, second);
          if (connectMode === "remove") removeConnection(firstPick, second);
          connectMode = null;
          firstPick = null;
          cy.$(":selected").unselect();
          return;
        }
      }
      selectedNodeId = data.id;
      document.querySelector("#details h2").textContent = data.label;
      editor.value = data.code || "";
      applyBtn.disabled = false;
      refreshIOBadges();
    });

    // Right-click (context menu) only when clicking empty canvas
    const canvas = document.getElementById("graph");
    canvas.addEventListener("contextmenu", (e) => {
      // Show only if not right-clicking a node (let node tap handler manage node actions)
      const isOnNode = cy.nodes().some(n => {
        const bb = n.renderedBoundingBox();
        return e.offsetX >= bb.x1 && e.offsetX <= bb.x2 && e.offsetY >= bb.y1 && e.offsetY <= bb.y2;
      });
      if (isOnNode) return; // use top menu or keyboard for node-specific actions
      e.preventDefault();
      ctx.classList.remove("hidden");
      ctx.style.left = Math.min(e.clientX + 2, window.innerWidth - ctx.offsetWidth - 8) + "px";
      ctx.style.top  = Math.min(e.clientY + 2, window.innerHeight - ctx.offsetHeight - 8) + "px";
    });

    document.addEventListener("click", () => ctx.classList.add("hidden"));
    window.addEventListener("resize", () => ctx.classList.add("hidden"));
  } else {
    cy.elements().remove();
    cy.add(elements);
  }

  positionLinear(cy, nodesSorted);

  if (selectedNodeId && cy.getElementById(selectedNodeId).nonempty()) cy.$id(selectedNodeId).select();
  refreshIOBadges();
}

/* --------------------------- operations ---------------------------------- */
function addNode(afterId = null) {
  const g = cloneGraph(currentGraph);
  const newId = generateId(g.nodes);
  const node = { id: newId, label: `Cell ${newId.split("-")[1]}`, code: "" };
  g.nodes.push(node);
  renderGraph(g);
  selectedNodeId = newId;
  editor.value = "";
  applyBtn.disabled = false;
  document.querySelector("#details h2").textContent = node.label;
}
function removeNode(nodeId) {
  if (!nodeId) return;
  const g = cloneGraph(currentGraph);
  const incoming = g.edges.filter(e => e.target === nodeId).map(e => e.source);
  const outgoing = g.edges.filter(e => e.source === nodeId).map(e => e.target);
  g.nodes = g.nodes.filter(n => n.id !== nodeId);
  g.edges = g.edges.filter(e => e.source !== nodeId && e.target !== nodeId);
  for (const s of incoming) for (const t of outgoing) {
    if (s === t) continue;
    if (!g.edges.find(e => e.source === s && e.target === t)) g.edges.push({ source: s, target: t, labels: [] });
  }
  selectedNodeId = null;
  renderGraph(g);
  editor.value = "";
  applyBtn.disabled = true;
  document.querySelector("#details h2").textContent = "Cell";
}
function addConnection(src, dst) {
  if (!src || !dst || src === dst) return;
  const g = cloneGraph(currentGraph);
  if (!g.edges.find(e => e.source === src && e.target === dst)) g.edges.push({ source: src, target: dst, labels: [] });
  renderGraph(g);
}
function removeConnection(src, dst) {
  if (!src || !dst) return;
  const g = cloneGraph(currentGraph);
  g.edges = g.edges.filter(e => !(e.source === src && e.target === dst));
  renderGraph(g);
}
function applyEdit() {
  if (!selectedNodeId) return;
  const g = cloneGraph(currentGraph);
  const n = g.nodes.find(n => n.id === selectedNodeId);
  if (!n) return;
  n.code = editor.value;
  renderGraph(g);
}

/* ----- run helpers: subgraph for "run selected cell" (all its ancestors) -- */
function getAncestors(graph, targetId) {
  const parents = new Map();
  for (const e of graph.edges) {
    if (!parents.has(e.target)) parents.set(e.target, new Set());
    parents.get(e.target).add(e.source);
  }
  const anc = new Set();
  const stack = [targetId];
  while (stack.length) {
    const cur = stack.pop();
    const pset = parents.get(cur) || new Set();
    for (const p of pset) if (!anc.has(p)) { anc.add(p); stack.push(p); }
  }
  return anc;
}
async function runSelectedCell() {
  if (!selectedNodeId) {
    runOut.textContent = "Select a node first.";
    return;
  }
  // Build subgraph of ancestors + the node; send to /api/run_graph for topo exec
  const anc = getAncestors(currentGraph, selectedNodeId);
  const nodeIds = new Set([...anc, selectedNodeId]);
  const nodes = currentGraph.nodes
    .filter(n => nodeIds.has(n.id))
    .map(n => ({ id: n.id, code: n.code || "" }));
  const edges = currentGraph.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({ source: e.source, target: e.target }));

  runOut.textContent = `Running ancestors + ${selectedNodeId}...\n`;
  const res = await postJSON("/api/run_graph", { nodes, edges });
  if (res.ok) {
    const lines = res.logs.map(l => `>>> ${l.node} [component ${l.component}]\n${l.stdout || "(no output)"}\n`);
    runOut.textContent = lines.join("\n");
  } else {
    const lines = (res.logs || []).map(l => `>>> ${l.node} [component ${l.component}]\n${l.stdout || "(no output)"}\n`);
    runOut.textContent = lines.join("\n") + `\n✖ Failed at ${res.failed_node} (component ${res.component})\n${res.stdout}`;
  }
}
async function runAll() {
  const payload = {
    nodes: currentGraph.nodes.map(n => ({ id: n.id, code: n.code || "" })),
    edges: currentGraph.edges.map(e => ({ source: e.source, target: e.target })),
  };
  runOut.textContent = "Running all components (topological order)...\n";
  const res = await postJSON("/api/run_graph", payload);
  if (res.ok) {
    const lines = res.logs.map(l => `>>> ${l.node} [component ${l.component}]\n${l.stdout || "(no output)"}\n`);
    runOut.textContent = lines.join("\n");
  } else {
    const lines = (res.logs || []).map(l => `>>> ${l.node} [component ${l.component}]\n${l.stdout || "(no output)"}\n`);
    runOut.textContent = lines.join("\n") + `\n✖ Failed at ${res.failed_node} (component ${res.component})\n${res.stdout}`;
  }
}

/* --------------------------- menu wiring --------------------------------- */
// Open/close dropdowns
menubar.addEventListener("click", (e) => {
  const trigger = e.target.closest(".menu-trigger");
  if (trigger) {
    const menu = trigger.parentElement;
    const open = menu.classList.contains("open");
    document.querySelectorAll(".menu").forEach(m => m.classList.remove("open"));
    if (!open) menu.classList.add("open");
  } else if (!e.target.closest(".menu-list")) {
    document.querySelectorAll(".menu").forEach(m => m.classList.remove("open"));
  }
});

// File → Upload Notebook
menuUpload.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const res = await uploadNotebook(file);
    renderGraph(res.graph);
    runOut.textContent = "Notebook uploaded. Empty cells ignored. Edit nodes and connections as needed.";
  } catch (err) {
    alert("Upload failed: " + err.message);
  } finally {
    fileInput.value = "";
  }
});

// File → New Workspace
menuNewWs.addEventListener("click", () => {
  selectedNodeId = null; connectMode = null; firstPick = null;
  renderGraph({ nodes: [], edges: [] });
  editor.value = ""; applyBtn.disabled = true;
  document.querySelector("#details h2").textContent = "Cell";
  runOut.textContent = "New workspace created.";
});

// Edit → node/connection ops
menuAddNode.addEventListener("click", () => addNode(selectedNodeId));
menuDelNode.addEventListener("click", () => {
  if (!selectedNodeId) return alert("Select a node to delete.");
  removeNode(selectedNodeId);
});
menuAddConn.addEventListener("click", () => { connectMode = "add"; firstPick = null; runOut.textContent = "Add: click source then target."; });
menuDelConn.addEventListener("click", () => { connectMode = "remove"; firstPick = null; runOut.textContent = "Remove: click source then target."; });

// Run → cell / all
menuRunCell.addEventListener("click", runSelectedCell);
menuRunAll.addEventListener("click", runAll);

// Context menu actions
ctxAddNode.addEventListener("click", () => { addNode(selectedNodeId); ctx.classList.add("hidden"); });
ctxDelNode.addEventListener("click", () => { if (!selectedNodeId) alert("Select a node to delete."); else removeNode(selectedNodeId); ctx.classList.add("hidden"); });
ctxAddConn.addEventListener("click", () => { connectMode = "add"; firstPick = null; runOut.textContent = "Add: click source then target."; ctx.classList.add("hidden"); });
ctxDelConn.addEventListener("click", () => { connectMode = "remove"; firstPick = null; runOut.textContent = "Remove: click source then target."; ctx.classList.add("hidden"); });
ctxRunCell.addEventListener("click", () => { runSelectedCell(); ctx.classList.add("hidden"); });
ctxRunAll.addEventListener("click", () => { runAll(); ctx.classList.add("hidden"); });

// Apply editor changes
applyBtn.addEventListener("click", () => { applyEdit(); runOut.textContent = `Updated ${selectedNodeId || "cell"}.`; });

/* ------------------------------ boot ------------------------------------- */
renderGraph({ nodes: [], edges: [] });
