#!/usr/bin/env python3
"""Extract and decode Free Pascal/Lazarus form resources (binary "TPF0"
streams) from an executable into readable LFM-like text.

    scripts/lfm_extract.py /usr/lib/beyondcompare/BCompare OUT_DIR

Writes one <ClassName>.lfm.txt per form plus actions.tsv, a flat list of every
TUiAction/TAction (form, name, category, caption, shortcut, mac shortcut, hint).
The binary format is the documented Delphi/FPC TReader stream format.
"""
import os
import struct
import sys

VK = {8: "Backspace", 9: "Tab", 13: "Enter", 27: "Esc", 32: "Space", 33: "PgUp", 34: "PgDn",
      35: "End", 36: "Home", 37: "Left", 38: "Up", 39: "Right", 40: "Down", 45: "Ins", 46: "Del",
      107: "Num+", 109: "Num-", 187: "=", 189: "-", 188: ",", 190: ".", 191: "/", 192: "`",
      219: "[", 220: "\\", 221: "]", 222: "'", 186: ";"}


def shortcut_text(v):
    if not isinstance(v, int) or v <= 0:
        return ""
    key = v & 0xFF
    mods = []
    if v & 0x4000: mods.append("Ctrl")
    if v & 0x8000: mods.append("Alt")
    if v & 0x2000: mods.append("Shift")
    if v & 0x1000: mods.append("Meta")
    if 0x30 <= key <= 0x39 or 0x41 <= key <= 0x5A:
        k = chr(key)
    elif 0x70 <= key <= 0x87:
        k = f"F{key - 0x6F}"
    else:
        k = VK.get(key, f"VK{key}")
    return "+".join(mods + [k])


class Reader:
    def __init__(self, data, pos):
        self.d, self.p = data, pos

    def byte(self):
        b = self.d[self.p]; self.p += 1; return b

    def peek(self):
        return self.d[self.p]

    def take(self, n):
        s = self.d[self.p:self.p + n]
        if len(s) < n: raise ValueError("eof")
        self.p += n; return s

    def sstr(self):
        n = self.byte(); return self.take(n).decode("utf-8", "replace")

    def value(self):
        t = self.byte()
        if t == 0: return None
        if t == 1:
            out = []
            while self.peek() != 0: out.append(self.value())
            self.byte(); return out
        if t == 2: return struct.unpack("<b", self.take(1))[0]
        if t == 3: return struct.unpack("<h", self.take(2))[0]
        if t == 4: return struct.unpack("<i", self.take(4))[0]
        if t == 5: self.take(10); return "<extended>"
        if t in (6, 7):
            s = self.sstr(); return s if t == 6 else ("ident", s)
        if t == 8: return False
        if t == 9: return True
        if t == 10:
            n = struct.unpack("<i", self.take(4))[0]; self.take(n); return f"<binary {n} bytes>"
        if t == 11:
            items = []
            while True:
                s = self.sstr()
                if not s: break
                items.append(s)
            return ("set", items)
        if t in (12, 20):
            n = struct.unpack("<i", self.take(4))[0]; return self.take(n).decode("utf-8", "replace")
        if t == 13: return ("ident", "nil")
        if t == 14:
            items = []
            while self.peek() != 0:
                if self.peek() in (2, 3, 4): self.value()
                if self.byte() != 1: raise ValueError("collection item")
                props = {}
                while self.peek() != 0:
                    k = self.sstr(); props[k] = self.value()
                self.byte(); items.append(props)
            self.byte(); return ("collection", items)
        if t == 15: self.take(4); return "<single>"
        if t in (16, 17, 19, 22): return struct.unpack("<q", self.take(8))[0]
        if t in (18, 21):
            n = struct.unpack("<i", self.take(4))[0]; return self.take(2 * n).decode("utf-16-le", "replace")
        raise ValueError(f"value type {t} at {self.p - 1:#x}")

    def obj(self):
        b = self.peek(); flags = 0
        if b & 0xF0 == 0xF0:
            flags = self.byte() & 0x0F
            if flags & 2: self.value()
        cls, name = self.sstr(), self.sstr()
        if not cls or not cls[0].isalpha(): raise ValueError("bad class")
        props = []
        while self.peek() != 0:
            k = self.sstr(); props.append((k, self.value()))
        self.byte()
        kids = []
        while self.peek() != 0: kids.append(self.obj())
        self.byte()
        return {"cls": cls, "name": name, "inherited": bool(flags & 1), "props": props, "kids": kids}


def fmt_val(v, ind):
    if isinstance(v, tuple):
        if v[0] == "ident": return v[1]
        if v[0] == "set": return "[" + ", ".join(v[1]) + "]"
        if v[0] == "collection":
            pad = "  " * (ind + 1)
            parts = ["<"]
            for it in v[1]:
                parts.append(f"{pad}item")
                for k, x in it.items(): parts.append(f"{pad}  {k} = {fmt_val(x, ind + 2)}")
                parts.append(f"{pad}end")
            parts.append("  " * ind + ">")
            return "\n".join(parts)
    if isinstance(v, str) and not v.startswith("<"): return repr(v)
    if isinstance(v, list): return "(" + " ".join(fmt_val(x, ind) for x in v) + ")"
    return str(v)


def dump(o, ind=0):
    pad = "  " * ind
    lines = [f"{pad}{'inherited' if o['inherited'] else 'object'} {o['name']}: {o['cls']}"]
    for k, v in o["props"]:
        s = fmt_val(v, ind + 1)
        if k == "ShortCut": s += f"  {{{shortcut_text(v)}}}"
        lines.append(f"{pad}  {k} = {s}")
    for c in o["kids"]: lines.extend(dump(c, ind + 1))
    lines.append(f"{pad}end")
    return lines


def actions(o, owner, out):
    p = dict(o["props"])
    if o["cls"].endswith("Action") and ("Caption" in p or "ShortCut" in p or "Hint" in p
                                         or "ShortCutStr" in p):
        g = lambda k: str(p.get(k, "")).replace("\t", " ").replace("\n", " ")
        sc = g("ShortCutStr") or shortcut_text(p.get("ShortCut"))
        out.append((owner, o["name"], g("Category"), (g("Caption") or g("Hint").split("|")[0]).replace("&", ""),
                    sc, g("MacShortCutStr"), g("Hint")))
    for c in o["kids"]: actions(c, owner, out)


def main():
    exe, outdir = sys.argv[1], sys.argv[2]
    data = open(exe, "rb").read()
    os.makedirs(outdir, exist_ok=True)
    pos, forms, acts, errors = 0, [], [], 0
    while (pos := data.find(b"TPF0", pos)) != -1:
        try:
            o = Reader(data, pos + 4).obj()
            forms.append(o)
            with open(os.path.join(outdir, f"{o['cls']}.lfm.txt"), "w") as f:
                f.write("\n".join(dump(o)) + "\n")
            actions(o, o["cls"], acts)
        except (ValueError, IndexError, struct.error):
            errors += 1
        pos += 4
    with open(os.path.join(outdir, "actions.tsv"), "w") as f:
        f.write("form\taction\tcategory\tcaption\tshortcut\tmac_shortcut\thint\n")
        for a in acts: f.write("\t".join(a) + "\n")
    print(f"forms={len(forms)} actions={len(acts)} undecodable={errors}")


if __name__ == "__main__":
    main()
