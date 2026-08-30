#!/usr/bin/env bash
set -euo pipefail
# verify-spike.sh – checks source identity/metadata, output tags/privacy, timing, and frame preservation.
# For hlg-local-b-v1: exact known-source SHA gate (allowlisted fingerprints).
# For hlg-rec709-v1: verifies exact HLG input metadata (bt2020nc/arib-std-b67/bt2020 tv, >=10-bit YUV, has_dovi=false) before accepting output.
# Common: source!=output, bounded timing/dimension/audio preservation, Rec.709 H.264 High yuv420p tags,
# semantic privacy-tag scan, and no-overwrite. HDR side-data scanning is intentionally bounded.
# Privacy pattern equivalent: com[.]apple[.]quicktime[.] (matched as a semantic tag key).
# Bounded HDR evidence names include Mastering display metadata, Content light level metadata,
# HDR10+, DOVI, HDR Vivid, and Ambient viewing environment.
# Deterministic metadata/timing checks are not visual correctness; human comparison remains required.

usage() {
  echo "Usage: $0 <source.MOV> <output.MOV> [profileId]" >&2
  exit 2
}
if [ $# -lt 2 ] || [ $# -gt 3 ]; then usage; fi

SRC_INPUT="$1"
DST_INPUT="$2"
EXPECTED_PROFILE="${3:-hlg-local-b-v1}"

case "$EXPECTED_PROFILE" in
  hlg-local-b-v1|hlg-rec709-v1|pq-rec709-v1) ;;
  *)
    echo "FAIL: unknown profile $EXPECTED_PROFILE" >&2
    exit 1
    ;;
esac

# Resolve only the self-contained bundle tool. Never fall back to PATH or a
# developer-specific install; an incomplete bundle must fail closed.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FFPROBE="$PROJECT_ROOT/tools/ffprobe"
if [ ! -f "$FFPROBE" ] || [ ! -x "$FFPROBE" ]; then
  echo "FAIL: bundled ffprobe is missing or not executable" >&2
  exit 1
fi

# Use the same realpath(abspath) rule for both paths, including symlinked parents.
realpath_abspath() {
  python3 - "$1" <<'PY'
import os
import sys
print(os.path.realpath(os.path.abspath(sys.argv[1])))
PY
}
SRC_REAL="$(realpath_abspath "$SRC_INPUT")"
DST_REAL="$(realpath_abspath "$DST_INPUT")"
if [ "$SRC_REAL" = "$DST_REAL" ]; then
  echo "FAIL: source and output resolve to the same path" >&2
  exit 1
fi

if [ ! -f "$SRC_REAL" ]; then echo "FAIL: source missing $SRC_INPUT" >&2; exit 1; fi
if [ ! -f "$DST_REAL" ]; then echo "FAIL: output missing $DST_INPUT" >&2; exit 1; fi
if [ ! -s "$DST_REAL" ]; then echo "FAIL: output empty $DST_INPUT" >&2; exit 1; fi

# Accept H.264 MP4 output naming; warn if legacy ProRes detected but still allow verification.
DST_BN="$(basename "$DST_INPUT")"
case "$DST_BN" in
  *_sdr_rec709_h264*.mp4) ;;
  *)
    echo "WARN: output name $DST_BN does not match expected *_sdr_rec709_h264_*.mp4; checking anyway" >&2
    ;;
esac
# Explicit acceptance: H.264 profile suffixes; legacy ProRes names warn
case "$DST_BN" in
  *_sdr_rec709_h264_*.mp4) echo "OK: output name $DST_BN matches H.264 MP4 profile (compact compatible)" >&2 ;;
  *_sdr_rec709_proreslt*.mov) echo "WARN: legacy ProRes name $DST_BN detected; expected *_sdr_rec709_h264_*.mp4 for current H.264 contract" >&2 ;;
  *_v6.mov|*_v5.mov|*_v4.mov|*_v3.mov|*_v2.mov|*_v1.mov) echo "WARN: legacy ProRes name $DST_BN detected; expected H.264 MP4" >&2 ;;
  *) echo "OK: output name $DST_BN accepted" >&2 ;;
esac

echo "OK: verifying for profile $EXPECTED_PROFILE" >&2

if [ "$EXPECTED_PROFILE" = "hlg-local-b-v1" ]; then
  # Expected fingerprints for the two known samples (local B allowlist, frozen).
  EXPECTED_1="46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593"
  EXPECTED_2="2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a"
  # Identify known source strictly by exact SHA (basename-agnostic) — required for user-selected IMG_6700.MOV whose SHA equals Sample/2.
  SRC_SHA="$(shasum -a 256 "$SRC_REAL" | awk '{print $1}')"
  SRC_BN="$(basename "$SRC_INPUT")"
  case "$SRC_SHA" in
    "$EXPECTED_1") EXPECTED="$EXPECTED_1" ;;
    "$EXPECTED_2") EXPECTED="$EXPECTED_2" ;;
    *)
      echo "FAIL: unknown source fingerprint $SRC_SHA (basename $SRC_BN not allowlisted) for profile $EXPECTED_PROFILE" >&2
      exit 1
      ;;
  esac
  if [ "$SRC_SHA" != "$EXPECTED" ]; then
    echo "FAIL: source SHA changed for $SRC_BN" >&2
    echo "  expected $EXPECTED" >&2
    echo "  got      $SRC_SHA" >&2
    exit 1
  fi
  echo "OK: source SHA $SRC_BN $SRC_SHA for profile $EXPECTED_PROFILE" >&2
elif [ "$EXPECTED_PROFILE" = "hlg-rec709-v1" ]; then
  # Re-gate with the same normalized stream + selected-frame evidence as inspection.
  SRC_META_JSON="$("$FFPROBE" -v error -select_streams V:0 -read_intervals "0%+1" -show_streams -show_frames -of json "$SRC_REAL" 2>/dev/null)" || {
    echo "FAIL: ffprobe failed for source (profile $EXPECTED_PROFILE)" >&2
    exit 1
  }
  if [ -z "$SRC_META_JSON" ]; then
    echo "FAIL: empty ffprobe output for source (profile $EXPECTED_PROFILE)" >&2
    exit 1
  fi
  if ! printf '%s' "$SRC_META_JSON" | python3 "$PROJECT_ROOT/electron/verify_contract.py" source "$EXPECTED_PROFILE"; then
    exit 1
  fi
  echo "OK: source HLG metadata verified for profile $EXPECTED_PROFILE" >&2
elif [ "$EXPECTED_PROFILE" = "pq-rec709-v1" ]; then
  # Re-gate with the same normalized stream + selected-frame evidence as inspection.
  SRC_META_JSON="$("$FFPROBE" -v error -select_streams V:0 -read_intervals "0%+1" -show_streams -show_frames -of json "$SRC_REAL" 2>/dev/null)" || {
    echo "FAIL: ffprobe failed for source (profile $EXPECTED_PROFILE)" >&2
    exit 1
  }
  if [ -z "$SRC_META_JSON" ]; then
    echo "FAIL: empty ffprobe output for source (profile $EXPECTED_PROFILE)" >&2
    exit 1
  fi
  if ! printf '%s' "$SRC_META_JSON" | python3 "$PROJECT_ROOT/electron/verify_contract.py" source "$EXPECTED_PROFILE"; then
    exit 1
  fi
  echo "OK: source PQ metadata verified for profile $EXPECTED_PROFILE" >&2
else
  echo "FAIL: unknown profile $EXPECTED_PROFILE" >&2
  exit 1
fi

# Timing policy: passthrough timestamps, exact decoded video-frame count, unchanged
# display dimensions (coded dimensions plus a 90-degree display matrix), and preserved audio streams.
# Missing/N/A/non-numeric values fail closed via the bounded verifier helper.
probe_contract() {
  "$FFPROBE" -v error -count_frames \
    -show_entries 'stream=codec_type,width,height,duration,nb_read_frames,codec_name,channels,sample_rate:stream_side_data=side_data_type,rotation:format=duration' \
    -of json "$1" 2>/dev/null
}
if ! SRC_CONTRACT_JSON="$(probe_contract "$SRC_REAL")"; then
  echo "FAIL: timing/media probe failed for source" >&2
  exit 1
fi
if ! DST_CONTRACT_JSON="$(probe_contract "$DST_REAL")"; then
  echo "FAIL: timing/media probe failed for output" >&2
  exit 1
fi
if [ -z "$SRC_CONTRACT_JSON" ] || [ -z "$DST_CONTRACT_JSON" ]; then
  echo "FAIL: timing/media probe returned no data" >&2
  exit 1
fi
DURATION_TOLERANCE="0.050"
# The helper checks width/height, exact video frame count, duration, audio stream count,
# AAC output codec, and channel/sample-rate preservation without float()/int() crashes.
if ! printf '%s\0%s' "$SRC_CONTRACT_JSON" "$DST_CONTRACT_JSON" | \
  python3 "$PROJECT_ROOT/electron/verify_contract.py" media "$DURATION_TOLERANCE"; then
  exit 1
fi

# Output ffprobe tags must be Rec.709 SDR.
PROBE="$("$FFPROBE" -v error -select_streams V:0 -show_entries stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range,width,height -of json "$DST_REAL")"
read -r CS CT CP CR PF CN PR <<< "$(printf '%s\n' "$PROBE" | python3 -c 'import json,sys; s=(json.load(sys.stdin).get("streams") or [{}])[0]; print(*[(s.get(k) or "") for k in ("color_space","color_transfer","color_primaries","color_range","pix_fmt","codec_name","profile")])')"

FAIL=0
if [ "$CS" != "bt709" ]; then echo "FAIL: color_space $CS != bt709" >&2; FAIL=1; fi
if [ "$CT" != "bt709" ]; then echo "FAIL: color_transfer $CT != bt709" >&2; FAIL=1; fi
if [ "$CP" != "bt709" ]; then echo "FAIL: color_primaries $CP != bt709" >&2; FAIL=1; fi
if [ "$CR" != "tv" ]; then echo "FAIL: color_range $CR != tv" >&2; FAIL=1; fi
if [ "$PF" != "yuv420p" ]; then echo "FAIL: pix_fmt $PF != yuv420p" >&2; FAIL=1; fi
if [ "$CN" != "h264" ]; then echo "FAIL: codec $CN != h264" >&2; FAIL=1; fi
if [ "$PR" != "High" ]; then echo "FAIL: profile $PR != High" >&2; FAIL=1; fi
if [ "$FAIL" -ne 0 ]; then exit 1; fi
echo "OK: output Rec.709 SDR tags $CS/$CT/$CP $CR $PF $CN $PR for profile $EXPECTED_PROFILE" >&2

# Inspect a bounded set of output frames and stream side data. forbidden HDR frame side data
# is rejected only within this bounded evidence window. This is an evidence check, not
# an unbounded claim that later packets contain no HDR metadata.
HDR_SCAN_FRAMES=32
DST_FRAME_SIDE_DATA="$("$FFPROBE" -v error -select_streams V:0 -read_intervals "%+#${HDR_SCAN_FRAMES}" \
  -show_streams -show_frames -show_entries 'stream=codec_type,index,side_data_list:frame=stream_index,side_data_list' -of json "$DST_REAL" 2>/dev/null)" || {
  echo "FAIL: ffprobe failed while inspecting bounded output HDR side data" >&2
  exit 1
}
if [ -z "$DST_FRAME_SIDE_DATA" ]; then
  echo "FAIL: empty ffprobe output while inspecting bounded output HDR side data" >&2
  exit 1
fi
# The helper scans stream evidence and at most HDR_SCAN_FRAMES decoded frames.
if ! printf '%s' "$DST_FRAME_SIDE_DATA" | python3 "$PROJECT_ROOT/electron/verify_contract.py" hdr "$HDR_SCAN_FRAMES"; then
  exit 1
fi

# Apply the privacy contract to semantic ffprobe tag maps only. Raw payload bytes are
# not metadata and may legitimately contain these words in compressed media.
META="$("$FFPROBE" -v error -show_format -show_streams -of json "$DST_REAL" 2>/dev/null)" || {
  echo "FAIL: ffprobe failed while inspecting output metadata" >&2
  exit 1
}
if [ -z "$META" ]; then
  echo "FAIL: empty output metadata probe" >&2
  exit 1
fi
# The helper examines only format/stream tags, so encoder text or compressed bytes
# containing words such as "location" do not create a false positive.
if ! printf '%s' "$META" | python3 "$PROJECT_ROOT/electron/verify_contract.py" privacy; then
  exit 1
fi

DST_SHA="$(shasum -a 256 "$DST_REAL" | awk '{print $1}')"
DST_SIZE="$(stat -f %z "$DST_REAL" 2>/dev/null || stat -c %s "$DST_REAL")"
echo "OK: output $DST_REAL size=$DST_SIZE sha=$DST_SHA for profile $EXPECTED_PROFILE" >&2
echo "PASS: $SRC_REAL -> $DST_REAL [$EXPECTED_PROFILE]" >&2
