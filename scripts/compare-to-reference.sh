#!/usr/bin/env bash
set -euo pipefail
# compare-to-reference.sh – quantitative crossed-pair comparison of v5 SDR outputs vs MainConcept references.
# Crossed pairing is mandatory: filenames are swapped relative to takes.
#   Take-A (tight close-up): 1.MOV (491f) ↔ 2-rec709.mp4 (493f) ↔ 1_sdr_rec709_proreslt_v5.mov
#   Take-B (wider, mouth open): 2.MOV (557f) ↔ 1-rec709.mp4 (557f) ↔ 2_sdr_rec709_proreslt_v5.mov
# Method: signalstats YAVG normalized to 8-bit (Y8 = Y10*255/1023) over 1s windows at t=02,05,08s.
# Reports Δ8 codes, Δ10 codes, % SDR range, and stops (gamma 2.2 linear-light).
# ponytail: quantitative luma delta is not visual correctness; still requires human on-screen judgment.

usage() {
  echo "Usage: $0 [<output.mov> <reference.mp4>]  # no args compares both v5 crossed pairs" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
resolve_bin() {
  local base="$1"
  local candidates=(
    "$PROJECT_ROOT/tools/$base"
    "/opt/homebrew/opt/ffmpeg-full/bin/$base"
    "/opt/homebrew/bin/$base"
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  if command -v "$base" >/dev/null 2>&1; then command -v "$base"; return 0; fi
  return 1
}
FFMPEG="$(resolve_bin ffmpeg)" || { echo "error: ffmpeg not found" >&2; exit 1; }
FFPROBE="$(resolve_bin ffprobe)" || { echo "error: ffprobe not found" >&2; exit 1; }
FFMPEG_DIR="$(dirname "$FFMPEG")"
if [ -x "$FFMPEG_DIR/ffprobe" ]; then FFPROBE="$FFMPEG_DIR/ffprobe"; fi

# Validate signalstats filter locally
if ! "$FFMPEG" -hide_banner -h filter=signalstats 2>&1 | grep -q "Filter signalstats"; then
  echo "error: signalstats filter not available in $FFMPEG" >&2
  exit 1
fi

realpath_abspath() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
}

# Canonical crossed pairs. The custom two-argument mode is restricted to these
# v5 pairs so a naive 1→1 or 2→2 comparison cannot pass by accident.
PAIR_A_REF="$PROJECT_ROOT/Sample/2-rec709.mp4"
PAIR_A_OUT="$PROJECT_ROOT/Output/spike/1_sdr_rec709_proreslt_v5.mov"
PAIR_B_REF="$PROJECT_ROOT/Sample/1-rec709.mp4"
PAIR_B_OUT="$PROJECT_ROOT/Output/spike/2_sdr_rec709_proreslt_v5.mov"
assert_crossed_pair() {
  local out_real ref_real
  out_real="$(realpath_abspath "$1")"
  ref_real="$(realpath_abspath "$2")"
  if { [ "$out_real" = "$PAIR_A_OUT" ] && [ "$ref_real" = "$PAIR_A_REF" ]; } ||
     { [ "$out_real" = "$PAIR_B_OUT" ] && [ "$ref_real" = "$PAIR_B_REF" ]; }; then
    return 0
  fi
  echo "FAIL: only the enforced crossed v5 pairs are allowed" >&2
  echo "  expected: $PAIR_A_OUT ↔ $PAIR_A_REF" >&2
  echo "        or: $PAIR_B_OUT ↔ $PAIR_B_REF" >&2
  echo "  got:      $out_real ↔ $ref_real" >&2
  return 1
}

measure_yavg() {
  local file="$1" ts="$2" dur="${3:-1}"
  local out yavgs ydepth yavg_mean depth yavg8 yavg10
  # Single ffmpeg invocation; parse lavfi.signalstats.YAVG and YBITDEPTH from combined stderr+stdout
  out="$("$FFMPEG" -loglevel info -ss "$ts" -t "$dur" -i "$file" -vf "signalstats,metadata=print:file=-" -f null - 2>&1)"
  # Extract YAVG values
  yavgs="$(printf '%s\n' "$out" | grep -oE 'lavfi\.signalstats\.YAVG=[0-9.]+' | cut -d= -f2 || true)"
  ydepth="$(printf '%s\n' "$out" | grep -oE 'lavfi\.signalstats\.YBITDEPTH=[0-9]+' | head -n1 | cut -d= -f2 || true)"
  if [ -z "$yavgs" ]; then
    echo "error: failed to measure YAVG for $file at t=$ts (no signalstats output)" >&2
    echo "$out" | head -n 50 >&2
    return 1
  fi
  # Average YAVG over window, detect bit depth
  python3 - "$yavgs" "$ydepth" <<'PY'
import sys
yavgs = [float(x) for x in sys.argv[1].split()]
ydepth_str = sys.argv[2].strip()
depth = int(ydepth_str) if ydepth_str else 8
yavg_mean = sum(yavgs)/len(yavgs)
if depth == 10:
    yavg8 = yavg_mean * 255.0/1023.0
    yavg10 = yavg_mean
else:
    yavg8 = yavg_mean
    yavg10 = yavg_mean * 1023.0/255.0 if yavg_mean else 0
# Also normalize: if depth 10, 10-bit Codes; if 8, convert to 10-bit equiv for reporting
print(f"{yavg8:.4f} {yavg10:.4f} {depth} {len(yavgs)}")
PY
}

compare_pair() {
  local label="$1" ref="$2" out="$3"
  local ref_real out_real
  ref_real="$(realpath_abspath "$ref")"
  out_real="$(realpath_abspath "$out")"
  if [ ! -f "$ref_real" ]; then echo "FAIL: reference missing $ref" >&2; return 1; fi
  if [ ! -f "$out_real" ]; then echo "FAIL: output missing $out" >&2; return 1; fi

  echo "=== $label ===" >&2
  echo "ref: $ref_real" >&2
  echo "out: $out_real" >&2

  # Verify tags superficially
  local ref_probe out_probe
  ref_probe="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,duration,nb_frames,color_space,color_transfer,color_primaries,pix_fmt -of json "$ref_real")"
  out_probe="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,duration,nb_frames,color_space,color_transfer,color_primaries,pix_fmt -of json "$out_real")"
  echo "ref probe: $(printf '%s' "$ref_probe" | python3 -c "import json,sys; s=(json.load(sys.stdin).get('streams') or [{}])[0]; print(f\"{s.get('width')}x{s.get('height')} {s.get('color_space')}/{s.get('color_transfer')}/{s.get('color_primaries')} {s.get('pix_fmt')} {s.get('duration')}s {s.get('nb_frames')}f\")")" >&2
  echo "out probe: $(printf '%s' "$out_probe" | python3 -c "import json,sys; s=(json.load(sys.stdin).get('streams') or [{}])[0]; print(f\"{s.get('width')}x{s.get('height')} {s.get('color_space')}/{s.get('color_transfer')}/{s.get('color_primaries')} {s.get('pix_fmt')} {s.get('duration')}s {s.get('nb_frames')}f\")")" >&2

  printf "%-6s %-12s %-12s %-8s %-8s %-10s %-8s\n" "t" "REF Y8" "OUT Y8" "Δ8" "Δ10" "%SDR" "stops" >&2
  local total_delta=0
  local count=0
  local deltas=()
  for ts in 2 5 8; do
    local ref_m out_m
    ref_m="$(measure_yavg "$ref_real" "$ts")" || return 1
    out_m="$(measure_yavg "$out_real" "$ts")" || return 1
    read -r ref_y8 ref_y10 ref_depth ref_n <<< "$ref_m"
    read -r out_y8 out_y10 out_depth out_n <<< "$out_m"
    # Compute deltas via python for precision
    python3 - "$ref_y8" "$ref_y10" "$out_y8" "$out_y10" "$ts" <<'PY' >&2
import sys, math
ref_y8=float(sys.argv[1]); ref_y10=float(sys.argv[2]); out_y8=float(sys.argv[3]); out_y10=float(sys.argv[4]); ts=int(sys.argv[5])
delta8=out_y8-ref_y8
delta10=out_y10-ref_y10
pct=delta8/255*100
def lin(y): return (y/255)**2.2 if y>1 else 1e-6
stops=math.log2(lin(out_y8)/lin(ref_y8)) if ref_y8>0 and out_y8>0 else 0
print(f"{ts:02d}   {ref_y8:6.1f}     {out_y8:6.1f}   {delta8:+6.1f} {delta10:+6.0f} {pct:+6.1f}% {stops:+6.2f}")
PY
    # For aggregration, recompute delta in bash via python
    delta8="$(python3 - "$ref_y8" "$out_y8" <<'PY'
import sys; print(float(sys.argv[2])-float(sys.argv[1]))
PY
)"
    deltas+=("$delta8")
    total_delta="$(python3 - "$total_delta" "$delta8" <<'PY'
import sys; print(float(sys.argv[1])+float(sys.argv[2]))
PY
)"
    count=$((count+1))
    # Also print human line via python above; need duplicate with printf
    # Use same python but already printed, now re-evaluate for table row
    python3 - "$ref_y8" "$out_y8" "$ts" <<'PY2'
import sys, math
ref=float(sys.argv[1]); out=float(sys.argv[2]); ts=sys.argv[3]
delta=out-ref
pct=delta/255*100
def lin(y): return (y/255)**2.2 if y>1 else 1e-6
stops=math.log2(lin(out)/lin(ref))
# Print row to stderr already, but ensure stdout parsable
PY2
  done
  # Mean delta and v5 acceptance gate. The target is abs(mean YAVG8 delta) <= 10
  # codes across the three required one-second windows; do not trim brightness here.
  local mean_delta
  mean_delta="$(python3 - "${deltas[@]}" <<'PY'
import sys
values=[float(x) for x in sys.argv[1:]]
print(f"{sum(values)/len(values):.6f}" if values else "0.000000")
PY
)"
  if ! python3 - "$mean_delta" "$label" <<'PY' >&2
import math, sys
mean=float(sys.argv[1]); label=sys.argv[2]
rng_note=""
# Stops mean approximated from a typical reference Y8 of 100, as in prior notes.
def lin(y): return (y/255)**2.2
stops=math.log2(lin(100+mean)/lin(100)) if 100+mean > 0 else 0
print(f"MEAN Δ8={mean:+.1f} codes | abs(mean)={abs(mean):.4f} threshold=10.0000 | {mean/255*100:+.1f}% SDR | ~{stops:+.2f} stops (approx at 100)")
if abs(mean) > 10.0:
    print(f"FAIL: {label} abs(mean YAVG8 delta) {abs(mean):.4f} exceeds 10.0000 codes", file=sys.stderr)
    raise SystemExit(1)
PY
  then
    return 1
  fi
  echo "OK: comparison $label complete; abs(mean YAVG8 delta) <= 10 codes" >&2
  return 0
}

# Main dispatch
if [ $# -eq 2 ]; then
  assert_crossed_pair "$1" "$2" || exit 1
  compare_pair "custom enforced crossed v5 pair" "$2" "$1"
  exit 0
elif [ $# -ne 0 ]; then
  usage
fi

# Default: both crossed v5 pairs. Pairing is explicit and cannot be overridden.
echo "compare-to-reference: crossed pairing (filenames swapped relative to takes) is mandatory" >&2
echo "  Take-A tight: 1.MOV (491f 16.375s) ↔ 2-rec709.mp4 (493f 16.433s) ↔ 1_sdr_rec709_proreslt_v5.mov" >&2
echo "  Take-B wide:  2.MOV (557f 18.565s) ↔ 1-rec709.mp4 (557f 18.566s) ↔ 2_sdr_rec709_proreslt_v5.mov" >&2
echo "  naive 1→1 / 2→2 is invalid (mismatched takes)" >&2

fail=0
if ! compare_pair "Take-A tight (1_v5 vs 2-rec709)" "$PAIR_A_REF" "$PAIR_A_OUT"; then fail=1; fi
echo "" >&2
if ! compare_pair "Take-B wide (2_v5 vs 1-rec709)" "$PAIR_B_REF" "$PAIR_B_OUT"; then fail=1; fi

if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more crossed-pair comparisons failed the abs(mean YAVG8 delta) <= 10 target" >&2
  exit 1
fi
echo "PASS: both crossed v5 pairs met abs(mean YAVG8 delta) <= 10 (quantitative, not visual correctness)" >&2
