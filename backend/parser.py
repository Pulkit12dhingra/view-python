from __future__ import annotations
import ast
from typing import Dict, List, Set, Tuple

class NameCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.defs: Set[str] = set()
        self.uses: Set[str] = set()

    # definitions
    def visit_Assign(self, node: ast.Assign):
        for t in node.targets:
            self._collect_target(t)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign):
        self._collect_target(node.target)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign):
        self._collect_target(node.target)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self.defs.add(node.name)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self.defs.add(node.name)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):
        self.defs.add(node.name)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            self.defs.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node: ast.ImportFrom):
        for alias in node.names:
            self.defs.add(alias.asname or alias.name)

    # usages
    def visit_Name(self, node: ast.Name):
        if isinstance(node.ctx, ast.Load):
            self.uses.add(node.id)

    def _collect_target(self, target: ast.AST):
        if isinstance(target, ast.Name):
            self.defs.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._collect_target(elt)

def analyze_cell(code: str) -> Tuple[Set[str], Set[str]]:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set(), set()
    nc = NameCollector()
    nc.visit(tree)
    return nc.defs, (nc.uses - nc.defs)

def build_graph(cells: List[str]) -> Dict:
    """Return a graph with nodes/edges inferred from notebook cells.
       Empty/whitespace-only cells are ignored.
    """
    # 1) Ignore empty cells
    filtered = [c for c in cells if c and c.strip()]
    defs_by_cell: List[Set[str]] = []
    uses_by_cell: List[Set[str]] = []
    for code in filtered:
        d, u = analyze_cell(code)
        defs_by_cell.append(d)
        uses_by_cell.append(u)

    edges = []
    for i in range(len(filtered)):
        for j in range(i + 1, len(filtered)):
            shared = sorted(defs_by_cell[i].intersection(uses_by_cell[j]))
            if shared:
                edges.append({
                    "source": f"cell-{i+1}",
                    "target": f"cell-{j+1}",
                    "labels": shared,
                })

    nodes = [
        {
            "id": f"cell-{i+1}",
            "label": f"Cell {i+1}",
            "code": filtered[i],
        }
        for i in range(len(filtered))
    ]

    return {"nodes": nodes, "edges": edges}
