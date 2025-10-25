from __future__ import annotations
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import nbformat as nbf
from pathlib import Path
from typing import List, Dict, Set
import io, sys, traceback, ast
from contextlib import redirect_stdout

from .parser import build_graph  # still used for initial auto-graph from cells

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
UPLOADS = ROOT / "uploads"
UPLOADS.mkdir(exist_ok=True)

app = FastAPI(title="Notebook DAG Viewer", version="0.3.0")

# --------- Models ----------
class GraphRequest(BaseModel):
    cells: List[str]

class RunRequest(BaseModel):
    cells: List[str]

class RunGraphRequest(BaseModel):
    nodes: List[Dict]  # [{id, code, ...}]
    edges: List[Dict]  # [{source, target}]

# --------- Helpers ----------
def _run_cell(code: str, env: dict) -> str:
    """Execute one 'cell' in the shared env. Prints the last expression's repr (like Jupyter)."""
    buf = io.StringIO()
    try:
        tree = ast.parse(code or "", mode="exec")
        body = list(tree.body)
        with redirect_stdout(buf):
            if body and isinstance(body[-1], ast.Expr):
                prefix = ast.Module(body=body[:-1], type_ignores=[])
                exec(compile(prefix, "<cell>", "exec"), env, env)
                value = eval(compile(ast.Expression(body[-1].value), "<cell>", "eval"), env, env)
                if value is not None:
                    print(repr(value))
            else:
                exec(compile(tree, "<cell>", "exec"), env, env)
    except Exception:
        buf.write(traceback.format_exc())
        raise RuntimeError(buf.getvalue())
    return buf.getvalue()

def _topo_sort(nodes: List[Dict], edges: List[Dict]):
    """Return topo ordering per weakly-connected component.
       - Ignores empty/whitespace-only nodes.
       - Builds components; each component gets its own env.
       - Returns: list of (component_nodes_in_order, component_edges)
    """
    # filter nodes (ignore empties)
    node_map = {n["id"]: n for n in nodes if (n.get("code") or "").strip()}
    ids = list(node_map.keys())

    # Build adjacency and indegrees only for existing ids
    adj: Dict[str, Set[str]] = {i: set() for i in ids}
    indeg: Dict[str, int] = {i: 0 for i in ids}
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s in node_map and t in node_map and s != t:
            if t not in adj[s]:
                adj[s].add(t)
                indeg[t] += 1

    # Find weakly connected components (undirected)
    undirected: Dict[str, Set[str]] = {i: set() for i in ids}
    for s in ids:
        for t in adj[s]:
            undirected[s].add(t)
            undirected[t].add(s)

    seen = set()
    components = []
    for i in ids:
        if i in seen: continue
        # BFS to collect component
        q = [i]; seen.add(i); comp = []
        while q:
            u = q.pop()
            comp.append(u)
            for v in undirected[u]:
                if v not in seen:
                    seen.add(v); q.append(v)
        components.append(comp)

    # Topo sort within each component (Kahn)
    ordered_components = []
    for comp in components:
        indeg_local = {k: indeg[k] for k in comp}
        adj_local = {k: {v for v in adj[k] if v in comp} for k in comp}
        q = [k for k in comp if indeg_local[k] == 0]
        order = []
        while q:
            u = q.pop(0)
            order.append(u)
            for v in adj_local[u]:
                indeg_local[v] -= 1
                if indeg_local[v] == 0:
                    q.append(v)
        # If cycle, remaining nodes will still have indegree>0; append them as-is to avoid deadlock.
        remaining = [k for k in comp if k not in order]
        order.extend(remaining)
        comp_edges = [e for e in edges if e.get("source") in comp and e.get("target") in comp]
        ordered_components.append((order, comp_edges))
    return ordered_components, node_map

# --------- Routes ----------
@app.post("/api/graph")
async def graph_from_cells(payload: GraphRequest):
    graph = build_graph(payload.cells)
    return JSONResponse(graph)

@app.post("/api/upload")
async def upload_notebook(nb: UploadFile = File(...)):
    if not nb.filename.endswith(".ipynb"):
        return JSONResponse({"error": "Please upload a .ipynb file"}, status_code=400)

    data = await nb.read()
    path = UPLOADS / nb.filename
    path.write_bytes(data)

    nbnode = nbf.reads(data.decode("utf-8"), as_version=4)
    raw_cells = [c.get("source", "") for c in nbnode.get("cells", []) if c.get("cell_type") == "code"]
    cells = [c for c in raw_cells if c and c.strip()]  # ignore empties

    graph = build_graph(cells)  # auto infer to start; user can edit connections later in UI
    return JSONResponse({"filename": nb.filename, "graph": graph})

@app.post("/api/run")
async def run_workflow(payload: RunRequest):
    # legacy: run in given order with shared env
    cells = [c for c in payload.cells if c and c.strip()]
    env: dict = {}
    logs = []
    try:
        for idx, code in enumerate(cells, start=1):
            out = _run_cell(code, env)
            logs.append({"cell": f"cell-{idx}", "stdout": out})
    except RuntimeError as e:
        return JSONResponse({"ok": False, "failed_cell": f"cell-{len(logs)+1}", "stdout": str(e), "logs": logs})
    return JSONResponse({"ok": True, "logs": logs})

@app.post("/api/run_graph")
async def run_graph(payload: RunGraphRequest):
    """Run all cells per graph dependencies:
       - Each weakly-connected component runs in its own environment (standalone behavior).
       - Within a component, respect topological order (incoming before outgoing).
    """
    ordered_components, node_map = _topo_sort(payload.nodes, payload.edges)
    all_logs = []
    comp_index = 0
    for order, _comp_edges in ordered_components:
        comp_index += 1
        env: dict = {}
        for nid in order:
            code = node_map[nid].get("code") or ""
            try:
                out = _run_cell(code, env)
            except RuntimeError as e:
                return JSONResponse({
                    "ok": False,
                    "failed_node": nid,
                    "component": comp_index,
                    "stdout": str(e),
                    "logs": all_logs
                })
            all_logs.append({"node": nid, "component": comp_index, "stdout": out})
    return JSONResponse({"ok": True, "logs": all_logs})

# ---- Static frontend ----
@app.get("/")
async def serve_index():
    index = FRONTEND / "index.html"
    return FileResponse(str(index))

app.mount("/static", StaticFiles(directory=str(FRONTEND), html=False), name="static")
print("Serving static from:", FRONTEND.resolve())

# Run: uvicorn backend.main:app --reload
