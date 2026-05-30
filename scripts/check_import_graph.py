#!/usr/bin/env python3
"""Static import-graph validator for the browser-ES-module tree.

eslint (this repo) has no import resolver and there is no runtime DOM
harness, so a moved/renamed symbol or a wrong relative path slips
through every gate. This script resolves every relative `import` in the
given roots and asserts each named binding is actually exported by its
target file. Pure static parse — never executes module bodies, so the
browser globals (window/document/localStorage) are irrelevant.

Usage:
    python3 scripts/check_import_graph.py app/web/static/js/mediaview \
        [more roots ...]

Exit 0 = every relative import resolves and every named import has a
matching export. Exit 1 = at least one dangling path or missing export.
"""
from __future__ import annotations

import os
import re
import sys

# import { a, b as c } from './x.js';  /  import Def, { a } from './x.js'
_IMPORT_RE = re.compile(
    r"""import\s+(?P<clause>[^;'"]*?)\s+from\s+['"](?P<path>[^'"]+)['"]""",
    re.DOTALL,
)
# bare side-effect import:  import './x.js';
_BARE_RE = re.compile(r"""import\s+['"](?P<path>[^'"]+)['"]""")
_NAMED_BLOCK_RE = re.compile(r"\{(?P<body>[^}]*)\}")


def _strip_comments(src: str) -> str:
    """Blank out comments without touching string/template contents.

    A naive regex stripper corrupts code when `//`, `/*` or `*/` appear
    inside a string or template literal (e.g. a URL or a swatch list),
    which silently drops real `export` lines. This char-scanner tracks
    string / template / comment state so only genuine comments are
    removed. Comments become spaces (length-preserving is unnecessary;
    newlines in block comments are kept so line numbers don't shift).
    """
    out: list[str] = []
    i, n = 0, len(src)
    quote = ""  # active string delimiter: ' " or `
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if quote:
            out.append(c)
            if c == "\\" and i + 1 < n:  # escape — copy next verbatim
                out.append(nxt)
                i += 2
                continue
            if c == quote:
                quote = ""
            i += 1
            continue
        if c in "'\"`":
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "/" and nxt == "*":
            i += 2
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _collect_exports(src: str) -> set[str]:
    names: set[str] = set()
    # export function foo / export async function foo
    names.update(re.findall(r"export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)", src))
    names.update(re.findall(r"export\s+class\s+([A-Za-z0-9_$]+)", src))
    # export const/let/var foo  (also handles `export const a = .., b = ..`)
    for m in re.finditer(r"export\s+(?:const|let|var)\s+([^;=]+)=", src):
        for part in m.group(1).split(","):
            ident = part.strip().split(" ")[0].strip()
            if re.fullmatch(r"[A-Za-z0-9_$]+", ident):
                names.add(ident)
    # export { a, b as c }  and  export { a } from './x'
    for blk in re.finditer(r"export\s*\{(?P<body>[^}]*)\}", src):
        for tok in blk.group("body").split(","):
            tok = tok.strip()
            if not tok:
                continue
            alias = tok.split(" as ")[-1].strip()
            if re.fullmatch(r"[A-Za-z0-9_$]+", alias):
                names.add(alias)
    if re.search(r"export\s+default", src):
        names.add("default")
    if re.search(r"export\s+\*\s+from", src):
        names.add("*")
    return names


def _resolve(importer: str, rel: str) -> str | None:
    if not rel.startswith("."):
        return None  # bare/core specifier — not our concern
    base = os.path.normpath(os.path.join(os.path.dirname(importer), rel))
    for cand in (base, base + ".js", os.path.join(base, "index.js")):
        if os.path.isfile(cand):
            return cand
    return None


def main(roots: list[str]) -> int:
    files: list[str] = []
    for root in roots:
        if os.path.isfile(root):
            files.append(root)
        for dp, _dn, fn in os.walk(root):
            files.extend(os.path.join(dp, f) for f in fn if f.endswith(".js"))

    export_cache: dict[str, set[str]] = {}

    def exports_of(path: str) -> set[str]:
        if path not in export_cache:
            with open(path, encoding="utf-8") as fh:
                export_cache[path] = _collect_exports(_strip_comments(fh.read()))
        return export_cache[path]

    errors: list[str] = []
    for f in sorted(set(files)):
        with open(f, encoding="utf-8") as fh:
            src = _strip_comments(fh.read())
        seen_spans: set[tuple[int, int]] = set()
        for m in _IMPORT_RE.finditer(src):
            seen_spans.add(m.span())
            rel = m.group("path")
            if not rel.startswith("."):
                continue
            target = _resolve(f, rel)
            if target is None:
                errors.append(f"{f}: unresolved import path '{rel}'")
                continue
            clause = m.group("clause").strip()
            blk = _NAMED_BLOCK_RE.search(clause)
            if not blk:
                continue  # default/namespace import — name presence not checked
            tgt_exports = exports_of(target)
            if "*" in tgt_exports:
                continue  # re-export-all: can't statically enumerate
            for tok in blk.group("body").split(","):
                tok = tok.strip()
                if not tok:
                    continue
                name = tok.split(" as ")[0].strip()
                if name and name not in tgt_exports:
                    errors.append(
                        f"{f}: imports '{name}' from '{rel}' but it is not exported there"
                    )
        for m in _BARE_RE.finditer(src):
            if any(s[0] <= m.start() < s[1] for s in seen_spans):
                continue
            rel = m.group("path")
            if rel.startswith(".") and _resolve(f, rel) is None:
                errors.append(f"{f}: unresolved side-effect import '{rel}'")

    if errors:
        print(f"IMPORT-GRAPH: {len(errors)} problem(s):")
        for e in errors:
            print("  ✗ " + e)
        return 1
    print(f"IMPORT-GRAPH: OK — {len(files)} files, all relative imports resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["app/web/static/js/mediaview"]))
