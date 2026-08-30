#!/usr/bin/env bash
set -euo pipefail
# v5 libplacebo path via ffmpeg-full 9.0.1 (keg-only, molten-vk). Validates bt.2390/spline/hable availability; prefers spline for this known HLG spike, then bt.2390, then hable. The v4 bt.2390 choice was quantitatively falsified against the crossed MainConcept references. zscale t=linear:npl=100 remains a supported fallback; old scale+tonemap fallback is retained only with a hard WARNING as semantically wrong. Fail-visible on libplacebo error (no guessed graph).

usage() {
  echo "Usage: $0 <source.MOV> <output.MOV>" >&2
  echo "  Validates known HLG bt2020nc/arib-std-b67/bt2020 input class before conversion;" >&2
  echo "  writes 10-bit Rec.709 SDR ProRes 422 LT MOV without container location metadata." >&2
  exit 2
}

if [ $# -ne 2 ]; then usage; fi

SRC="$1"
DST="$2"

# Resolve both paths with one routine so symlinked parents cannot route output over input.
realpath_abspath() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
}
SRC_REAL="$(realpath_abspath "$SRC")"
DST_REAL="$(realpath_abspath "$DST")"

if [ "$SRC_REAL" = "$DST_REAL" ]; then
  echo "error: source and destination must be different (would overwrite input)" >&2
  exit 1
fi

# Resolve FFmpeg/FFprobe: prefer libplacebo-capable binary when detected.
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
FFMPEG="$(resolve_bin ffmpeg)" || { echo "error: ffmpeg not found (checked tools/, ffmpeg-full, /opt/homebrew/bin, PATH)" >&2; exit 1; }
FFPROBE="$(resolve_bin ffprobe)" || { echo "error: ffprobe not found" >&2; exit 1; }
# If ffmpeg-full ffmpeg was chosen, prefer its sibling ffprobe when that sibling exists.
FFMPEG_DIR="$(dirname "$FFMPEG")"
if [ -x "$FFMPEG_DIR/ffprobe" ]; then
  FFPROBE="$FFMPEG_DIR/ffprobe"
fi

[ -f "$SRC_REAL" ] || { echo "error: source not found: $SRC" >&2; exit 1; }

# Validate known input class – fail-visible on unknown/mismatch
PROBE_JSON="$("$FFPROBE" -v error -select_streams V:0 -show_entries stream=color_space,color_transfer,color_primaries,color_range,pix_fmt,codec_name -of json "$SRC_REAL")"
CS="$(echo "$PROBE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["streams"][0] if d.get("streams") else {}; print(s.get("color_space",""))')"
CT="$(echo "$PROBE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["streams"][0] if d.get("streams") else {}; print(s.get("color_transfer",""))')"
CP="$(echo "$PROBE_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["streams"][0] if d.get("streams") else {}; print(s.get("color_primaries",""))')"

if [ "$CS" != "bt2020nc" ] || [ "$CT" != "arib-std-b67" ] || [ "$CP" != "bt2020" ]; then
  echo "error: input not in known HLG BT.2020 class (got ${CS}/${CT}/${CP}; expected bt2020nc/arib-std-b67/bt2020) – fail-visible, requires explicit decision" >&2
  exit 3
fi

# Capability detection: libplacebo preferred (research-backed), else documented zscale+tonemap fallback
HAS_LIBPLACEBO=0
if "$FFMPEG" -hide_banner -h filter=libplacebo 2>&1 | grep -q "Filter libplacebo"; then
  HAS_LIBPLACEBO=1
fi
HAS_ZSCALE=0
if "$FFMPEG" -hide_banner -h filter=zscale 2>&1 | grep -q "Filter zscale"; then
  HAS_ZSCALE=1
fi
# Detect apply_dolbyvision only if locally supported and safe; otherwise plain HLG path (no explicit DOVI).
HAS_APPLY_DOVI=0
if "$FFMPEG" -hide_banner -h filter=libplacebo 2>&1 | grep -q "apply_dolbyvision"; then
  HAS_APPLY_DOVI=1
fi
# v5: validate bt.2390/spline/hable availability inside libplacebo; spline is primary for this known HLG spike
HAS_BT2390=0
HAS_SPLINE=0
HAS_HABLE=0
if [ "$HAS_LIBPLACEBO" -eq 1 ]; then
  LIBPLACEBO_HELP="$("$FFMPEG" -hide_banner -h filter=libplacebo 2>&1)"
  # Match the tonemapping enum entries, not the unrelated spline36 upscaler option.
  if echo "$LIBPLACEBO_HELP" | grep -Eq '^[[:space:]]+bt\.2390[[:space:]]+[0-9]+'; then HAS_BT2390=1; fi
  if echo "$LIBPLACEBO_HELP" | grep -Eq '^[[:space:]]+spline[[:space:]]+[0-9]+'; then HAS_SPLINE=1; fi
  if echo "$LIBPLACEBO_HELP" | grep -Eq '^[[:space:]]+hable[[:space:]]+[0-9]+'; then HAS_HABLE=1; fi
  echo "spike: libplacebo tonemapping availability bt.2390=$HAS_BT2390 spline=$HAS_SPLINE hable=$HAS_HABLE" >&2
  if [ "$HAS_BT2390" -eq 0 ] && [ "$HAS_SPLINE" -eq 0 ] && [ "$HAS_HABLE" -eq 0 ]; then
    echo "error: libplacebo available but none of bt.2390/spline/hable tonemappings are locally valid – fail-visible, requires explicit decision" >&2
    exit 4
  fi
fi

if [ "$HAS_LIBPLACEBO" -eq 1 ]; then
  # v5 known-HLG path with locally validated preference: spline > bt.2390 > hable.
  if [ "$HAS_SPLINE" -eq 1 ]; then
    VF="libplacebo=tonemapping=spline:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le"
    FILTER_LABEL="libplacebo (spline/perceptual/bt709; v5 primary) via $FFMPEG"
  elif [ "$HAS_BT2390" -eq 1 ]; then
    VF="libplacebo=tonemapping=bt.2390:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le"
    FILTER_LABEL="libplacebo (bt.2390/perceptual/bt709; spline unavailable) via $FFMPEG"
  else
    VF="libplacebo=tonemapping=hable:gamut_mode=perceptual:colorspace=bt709:range=tv:color_primaries=bt709:color_trc=bt709:format=yuv422p10le"
    FILTER_LABEL="libplacebo (hable/perceptual/bt709; spline/bt.2390 unavailable) via $FFMPEG"
  fi
  if [ "$HAS_APPLY_DOVI" -eq 1 ]; then
    FILTER_LABEL="$FILTER_LABEL [apply_dolbyvision supported, plain HLG path]"
  fi
elif [ "$HAS_ZSCALE" -eq 1 ]; then
  VF="zscale=t=linear:npl=100,tonemap=hable:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv422p10le"
  FILTER_LABEL="zscale+tonemap(hable) [research-backed correct fallback] via $FFMPEG"
else
  # fallback available in this ffmpeg (scale+tonemap+colorspace) – tonemap requires linear light
  SCALE_HELP="$("$FFMPEG" -hide_banner -h filter=scale 2>&1)" || {
    echo "error: cannot inspect installed scale filter" >&2
    exit 1
  }
  for OPTION in in_transfer out_transfer; do
    if ! printf '%s\n' "$SCALE_HELP" | grep -Eq "^[[:space:]]+$OPTION[[:space:]]"; then
      echo "error: installed scale lacks required $OPTION option" >&2
      exit 1
    fi
  done
  echo "WARNING: libplacebo and zscale unavailable; falling back to scale+tonemap+colorspace which is RESEARCH-PROVEN SEMANTICALLY WRONG (blown highlights, no perceptual gamut mapping). Not for visual acceptance." >&2
  VF="scale=in_transfer=arib-std-b67:out_transfer=linear,tonemap=hable:desat=2,colorspace=bt709,format=yuv422p10le"
  FILTER_LABEL="scale+tonemap(hable)+colorspace (fallback, SEMANTICALLY WRONG – use only if no libplacebo/zscale)"
fi

if [ -e "$DST_REAL" ]; then
  echo "error: output already exists; refusing to replace: $DST_REAL" >&2
  exit 1
fi
mkdir -p "$(dirname "$DST_REAL")"

FFVER="$("$FFMPEG" -version 2>&1 | head -n1)"
echo "spike: $FFVER" >&2
echo "spike: ffmpeg=$FFMPEG ffprobe=$FFPROBE" >&2
echo "spike: filter=$FILTER_LABEL" >&2
echo "spike: vf=\"$VF\"" >&2
echo "spike: $SRC_REAL -> $DST_REAL" >&2

# Deterministic mapping: video plus optional audio, strip container metadata (especially location/camera)
# Explicit 10-bit Rec.709 SDR ProRes 422 LT tags; never overwrites input file
"$FFMPEG" -hide_banner -loglevel info -i "$SRC_REAL" \
  -map_metadata -1 \
  -map 0:V:0 -map 0:a? \
  -vf "$VF" \
  -c:v prores_ks -profile:v 1 -pix_fmt yuv422p10le -vendor ap10 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 128k \
  -fps_mode passthrough \
  -movflags +write_colr \
  -n "$DST_REAL"

echo "spike: done $DST_REAL" >&2
