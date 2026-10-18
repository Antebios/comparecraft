#!/usr/bin/env python3
"""Pretty-print the `Nodes = (...)` menu/toolbar trees of decoded Lazarus
action-list forms (output of lfm_extract.py) as indented outlines.

usage: lfm_nodes.py FORM.lfm.txt [...]
"""
import re
import sys


def parse(text):
    toks = re.findall(r"\(|\)|'(?:[^']|'')*'", text)
    pos = 0

    def seq():
        nonlocal pos
        items = []
        while pos < len(toks) and toks[pos] != ")":
            t = toks[pos]
            pos += 1
            if t == "(":
                kids = seq()
                pos += 1  # ')'
                if items:
                    items[-1][1].extend(kids)
            else:
                items.append((t[1:-1].replace("''", "'"), []))
        return items

    assert toks and toks[0] == "("
    pos = 1
    return seq()


def dump(nodes, depth=0, out=None):
    for name, kids in nodes:
        out.append("  " * depth + name)
        dump(kids, depth + 1, out)
    return out


for path in sys.argv[1:]:
    src = open(path, encoding="utf-8").read()
    for m in re.finditer(r"Nodes = (\(.*\))\s*$", src, re.M):
        print(f"# {path}")
        print("\n".join(dump(parse(m.group(1)), out=[])))
