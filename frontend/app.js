/* Notebook DAG Viewer — edit cells, ignore empties, run all sequentially.
   Also keeps the single-line layout and non-overlapping curved edges.
*/

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

/* ---------------------------- graph shaping ------------------------------- */
function buildElements(graph) {
  const nodesSorted = [...graph.nodes].sort((a, b) => cellIndex(a.id) - cellIndex(b.id));
  const order = new Map(nodesSorted.map((n, i) => [n.id, i]));
  const laneCount = new Map();
  const elements = [];

  for (const n of nodesSorted) {
    elements.push({ data: { id: n.id, label: n.label, code: n.code ?? "" }, classes: "cell-node" });
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
  nodesSorted.forEach((n, idx) => {
    const node = cy.getElementById(n.id);
    node.position({ x: idx * spacing, y });
  });
  cy.center();
  cy.fit(undefined, 60);
}

/* --------------------------- Cytoscape setup ------------------------------ */
let cy = null;
let currentGraph = { nodes: [], edges: [] }; // authoritative in-UI state
let selectedNodeId = null;

function renderGraph(graph) {
  currentGraph = graph; // replace state with latest from server
  const { elements, nodesSorted } = buildElements(graph);

  if (!cy) {
    cy = cytoscape({
      container: document.getElementById("graph"),
      elements,
      style: [
        {
          selector: "node.cell-node",
          style: {
            "shape": "ellipse",
            "width": 56,
            "height": 56,
            "background-color": "#6aa1ff",
            "border-color": "#1f2a37",
            "border-width": 2,
            "label": "data(label)",
            "text-valign": "top",
            "text-halign": "center",
            "text-margin-y": -40,
            "color": "#e8eef6",
            "font-weight": 700,
            "font-size": 11,
            "text-wrap": "wrap",
            "text-max-width": 100
          }
        },
        {
          selector: "edge.flow-edge",
          style: {
            "curve-style": "unbundled-bezier",
            "edge-distances": "node-position",
            "control-point-distances": "data(cpd)",
            "control-point-weights": "data(cpw)",
            "width": 2,
            "line-color": "#9fb3c8",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#9fb3c8",
            "arrow-scale": 1.1,
            "label": "data(label)",
            "font-size": 10,
            "text-background-color": "#121821",
            "text-background-opacity": 1,
            "text-background-padding": 2,
            "color": "#9fb3c8",
            "z-index-compare": "manual",
            "z-index": 1
          }
        },
        {
          selector: ":selected",
          style: {
            "background-color": "#ffd166",
            "line-color": "#ffd166",
            "target-arrow-color": "#ffd166",
            "z-index": 2
          }
        }
      ],
      wheelSensitivity: 0.2,
      boxSelectionEnabled: false,
      autoungrabify: false
    });

    cy.on("tap", "node", (evt) => {
      const data = evt.target.data();
      selectedNodeId = data.id;
      document.querySelector("#details h2").textContent = data.label;
      const editor = document.getElementById("editor");
      editor.value = data.code || "";
      document.getElementById("apply-btn").disabled = false;
    });
  } else {
    cy.elements().remove();
    cy.add(elements);
  }

  positionLinear(cy, nodesSorted);

  // Retain selection after re-render (if still present)
  if (selectedNodeId && cy.getElementById(selectedNodeId).nonempty()) {
    cy.$id(selectedNodeId).select();
  }
}

/* --------------------------- Sample + wiring ------------------------------ */
const SAMPLE = {
  nodes: [
    { id: "cell-1", label: "Cell 1", code: "import math\nx = 2" },
    { id: "cell-2", label: "Cell 2", code: "y = x**3" },
    { id: "cell-3", label: "Cell 3", code: "def f(a):\n    return a*2" },
    { id: "cell-4", label: "Cell 4", code: "z = f(y)\nz" }
  ],
  edges: [
    { source: "cell-1", target: "cell-2", labels: ["x"] },
    { source: "cell-3", target: "cell-4", labels: ["f"] },
    { source: "cell-2", target: "cell-4", labels: ["y"] }
  ]
};

const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const sampleBtn = document.getElementById("sample-btn");
const runAllBtn = document.getElementById("run-all-btn");
const applyBtn = document.getElementById("apply-btn");
const editor = document.getElementById("editor");
const runOut = document.getElementById("run-output");

uploadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const res = await uploadNotebook(file);
    renderGraph(res.graph);
    runOut.textContent = "Notebook uploaded. Empty cells ignored.";
  } catch (err) {
    alert("Upload failed: " + err.message);
  }
});

sampleBtn.addEventListener("click", () => {
  // Ask server to compute edges too (so empty cells would be ignored consistently)
  postJSON("/api/graph", { cells: SAMPLE.nodes.map(n => n.code) })
    .then(graph => renderGraph(graph));
});

applyBtn.addEventListener("click", async () => {
  if (!selectedNodeId) return;
  // Update in-memory node code
  const nodesSorted = [...currentGraph.nodes].sort((a, b) => cellIndex(a.id) - cellIndex(b.id));

  // Build cells by current order, replacing the selected node's code with editor value
  const cells = nodesSorted.map(n => n.id === selectedNodeId ? editor.value : (n.code ?? ""));

  // Recompute graph server-side (this will drop empty cells automatically)
  const graph = await postJSON("/api/graph", { cells });
  renderGraph(graph);
  runOut.textContent = `Updated ${selectedNodeId}. Graph recomputed.`;
});

runAllBtn.addEventListener("click", async () => {
  if (!currentGraph.nodes.length) {
    runOut.textContent = "Nothing to run. Upload a notebook or try the sample.";
    return;
  }
  // Build cells list in visual order; server will ignore empties and run sequentially
  const cells = [...currentGraph.nodes]
    .sort((a, b) => cellIndex(a.id) - cellIndex(b.id))
    .map(n => n.code ?? "");

  runOut.textContent = "Running all cells...\n";
  try {
    const res = await postJSON("/api/run", { cells });
    if (res.ok) {
      const lines = res.logs.map(l => `>>> ${l.cell}\n${l.stdout || "(no output)"}\n`);
      runOut.textContent = lines.join("\n");
    } else {
      const lines = (res.logs || []).map(l => `>>> ${l.cell}\n${l.stdout || "(no output)"}\n`);
      runOut.textContent = lines.join("\n") + `\n✖ Failed at ${res.failed_cell}\n${res.stdout}`;
    }
  } catch (err) {
    runOut.textContent = "Run failed: " + err.message;
  }
});

/* Initialize empty graph so UI feels alive; user can click Sample */
renderGraph({ nodes: [], edges: [] });
