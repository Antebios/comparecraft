#!/usr/bin/env bash
# Black-box parity check: runs the same quick-compare (-qc) and automerge
# probes against CompareCraft and, if installed, the reference `bcompare`, and
# compares exit codes and merge output.
#
#   scripts/parity.sh [path/to/comparecraft] [path/to/bcompare]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPARECRAFT="${1:-$ROOT/src-tauri/target/release/comparecraft}"
REF="${2:-$(command -v bcompare || true)}"
QC="$ROOT/tests/fixtures/qc"
MG="$ROOT/tests/fixtures/merge"

# pair  expected-exit-codes for: -qc -qc=binary -qc=size -qc=crc
CASES=(
  "x.txt x.txt       1 1 1 1"
  "x.txt crlf.txt    2 11 11 11"
  "x.txt bom.txt     2 11 11 11"
  "x.txt noeol.txt   2 11 11 11"
  "x.txt upper.txt   12 11 11 11"
  "x.txt blank.txt   12 11 11 11"
  "x.txt lead.txt    12 11 11 11"
  "emb1.txt emb2.txt 12 11 11 11"
  "x.txt w.txt       12 11 11 11"
  "x.txt y.txt       1 1 1 1"
  "x.txt z.txt       13 11 11 11"
  "r1.bin r2.bin     11 11 11 11"
  "s1 s2             1 1 1 1"
  "s1 s3             13 11 11 11"
  "s1 s4             13 11 11 11"
  "s1 s5             1 1 1 1"
  "x.txt missing.txt 100 100 100 100"
  ". .               100 100 100 100"
)
MODES=(-qc -qc=binary -qc=size -qc=crc)
pass=0; fail=0

run() { (cd "$QC" && timeout 60 "$@" >/dev/null 2>&1); echo $?; }
check() { # label expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected $2 got $3"; fi
}

printf '%-20s %-11s %-8s %-6s %s\n' pair mode expected comparecraft ${REF:+reference}
for c in "${CASES[@]}"; do
  read -r a b e0 e1 e2 e3 <<<"$c"; exp=($e0 $e1 $e2 $e3)
  for i in 0 1 2 3; do
    m=${MODES[$i]}; j=$(run "$COMPARECRAFT" "$m" "$a" "$b")
    check "comparecraft $m $a $b" "${exp[$i]}" "$j"
    r=""; if [ -n "$REF" ]; then r=$(run "$REF" "$m" "$a" "$b"); check "ref $m $a $b" "${exp[$i]}" "$r"; fi
    printf '%-20s %-11s %-8s %-6s %s\n' "$a $b" "$m" "${exp[$i]}" "$j" "$r"
  done
done

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cd "$MG"
"$COMPARECRAFT" -automerge l.txt r.txt base.txt "$tmp/clean.txt"; check "automerge clean" 0 $?
cmp -s "$tmp/clean.txt" expected-clean.txt; check "automerge clean output" 0 $?
"$COMPARECRAFT" -automerge cl.txt cr.txt base.txt "$tmp/conf.txt"; check "automerge conflict" 101 $?
[ -e "$tmp/conf.txt" ]; check "automerge conflict writes nothing" 1 $?
"$COMPARECRAFT" -automerge -force cl.txt cr.txt base.txt "$tmp/force.txt"; check "automerge -force" 14 $?
cmp -s "$tmp/force.txt" expected-force.txt; check "automerge -force output" 0 $?

echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
