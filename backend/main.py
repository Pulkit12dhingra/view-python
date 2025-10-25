from __future__ import annotations
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import nbformat as nbf
from pathlib import Path
from typing import List
import io, sys, traceback, ast
from contextlib import redirect_stdout

from .parser import build_graph

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
UPLOADS = ROOT / "uploads"
UPLOADS.mkdir(exist_ok=True)

app = FastAPI(title="Notebook DAG Viewer", version="0.2.0")

class GraphRequest(BaseModel):
    cells: List[str]

class RunRequest(BaseModel):
    cells: List[str]

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
    # Ignore empty cells here as well
    cells = [c for c in raw_cells if c and c.strip()]

    graph = build_graph(cells)
    return JSONResponse({"filename": nb.filename, "graph": graph})

def _run_cell(code: str, env: dict) -> str:
    """Execute one 'cell' in the shared env. Prints the last expression's repr (like Jupyter)."""
    buf = io.StringIO()
    try:
        tree = ast.parse(code, mode="exec")
        body = list(tree.body)
        with redirect_stdout(buf):
            if body and isinstance(body[-1], ast.Expr):
                # exec all but last, then eval last expr and print its repr
                prefix = ast.Module(body=body[:-1], type_ignores=[])
                exec(compile(prefix, "<cell>", "exec"), env, env)
                value = eval(compile(ast.Expression(body[-1].value), "<cell>", "eval"), env, env)
                # mimic notebook display by printing repr
                if value is not None:
                    print(repr(value))
            else:
                exec(compile(tree, "<cell>", "exec"), env, env)
    except Exception:
        buf.write(traceback.format_exc())
        # re-raise to stop the workflow at this cell
        raise RuntimeError(buf.getvalue())
    return buf.getvalue()

@app.post("/api/run")
async def run_workflow(payload: RunRequest):
    # Sequential run through shared environment, ignoring empty cells
    cells = [c for c in payload.cells if c and c.strip()]
    env: dict = {}
    logs = []
    try:
        for idx, code in enumerate(cells, start=1):
            out = _run_cell(code, env)
            logs.append({"cell": f"cell-{idx}", "stdout": out})
    except RuntimeError as e:
        # Stop on first error
        return JSONResponse({"ok": False, "failed_cell": f"cell-{len(logs)+1}", "stdout": str(e), "logs": logs})

    return JSONResponse({"ok": True, "logs": logs})

# ---- Static frontend (unchanged from your fixed /static mount) --------------

@app.get("/")
async def serve_index():
    index = FRONTEND / "index.html"
    return FileResponse(str(index))

app.mount("/static", StaticFiles(directory=str(FRONTEND), html=False), name="static")

print("Serving static from:", FRONTEND.resolve())

# Run from project root:
# uvicorn backend.main:app --reload
