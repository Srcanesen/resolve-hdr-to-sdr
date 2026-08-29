#!/usr/bin/env bash
set -euo pipefail
# verify-spike.sh – checks source identity/metadata, output tags/privacy, timing, and frame preservation.
# For hlg-local-b-v1: exact known-source SHA gate (allowlisted fingerprints).
# For hlg-rec709-v1: verifies exact HLG input metadata (bt2020nc/arib-std-b67/bt2020 tv, >=10-bit YUV, has_dovi=false) before accepting output.
# Common: source!=output, timing/frame preservation, Rec.709 H.264 High yuv420p tags, privacy scan, no-overwrite.
# ponytail: deterministic metadata/timing checks are not visual correctness; human still comparison remains required.

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

# Resolve ffprobe: prefer libplacebo-capable binary when detected (mirrors converter).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
resolve_ffprobe() {
  local candidates=(
    "$PROJECT_ROOT/tools/ffprobe"
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
    "/opt/homebrew/bin/ffprobe"
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  if command -v ffprobe >/dev/null 2>&1; then command -v ffprobe; return 0; fi
  echo "ffprobe"
}
FFPROBE="$(resolve_ffprobe)"

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
  # Generic HLG: verify exact HLG input metadata before accepting output, no SHA allowlist
  # Requirements: parse_ok, not unspecified/contradictory, exact triplet bt2020nc + arib-std-b67 + bt2020, color_range=tv,
  # known >=10-bit YUV pix_fmt via explicit allowlist, has_dovi=false.
  SRC_META_JSON="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=codec_name,codec_tag_string,pix_fmt,color_space,color_transfer,color_primaries,color_range -show_entries stream=side_data_list -of json "$SRC_REAL" 2>/dev/null)" || {
    echo "FAIL: ffprobe failed for source $SRC_INPUT (profile $EXPECTED_PROFILE)" >&2
    exit 1
  }
  if [ -z "$SRC_META_JSON" ]; then
    echo "FAIL: empty ffprobe output for source $SRC_INPUT" >&2
    exit 1
  fi
  python3 - "$SRC_META_JSON" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
streams = data.get("streams", [])
v = next((s for s in streams if s.get("codec_type") == "video"), streams[0] if streams else {})
# Extract fields
cs = v.get("color_space")
ct = v.get("color_transfer")
cp = v.get("color_primaries")
cr = v.get("color_range")
pix = v.get("pix_fmt")
# Side data dovi detection
has_dovi = False
side = v.get("side_data_list") or []
for sd in side:
    t = (sd.get("side_data_type") or "").lower()
    if "dovi" in t or "dolby" in t:
        has_dovi = True
        break
# unspecified/contradictory via color values
is_unspecified = False
for val in (cs, ct, cp):
    if val is None:
        continue
    vl = str(val).lower()
    if vl in ("unknown", "unspecified", "2"):
        is_unspecified = True
# Also check if any color field missing is considered fail-closed (unknown)
if cs is None or ct is None or cp is None or cr is None or pix is None:
    print(f"FAIL: missing required HLG metadata for generic profile: cs={cs} ct={ct} cp={cp} cr={cr} pix={pix}", file=sys.stderr)
    sys.exit(1)
if is_unspecified:
    print(f"FAIL: unspecified metadata for generic profile: cs={cs} ct={ct} cp={cp}", file=sys.stderr)
    sys.exit(1)
# Contradictory not directly detectable here, but if ffprobe reports contradictory?
# For now treat is_contradictory as false unless explicit, but generic verifier should fail if contradictory flag would be true.
# We'll fail if colors are contradictory via mismatch? Already handled by exact triplet.
allowed_pix = {"yuv420p10le","yuv422p10le","yuv444p10le","yuv420p12le","yuv422p12le","yuv444p12le"}
pix_norm = str(pix).strip().lower()
if pix_norm not in allowed_pix:
    print(f"FAIL: pix_fmt {pix} not in allowed >=10-bit list for generic profile", file=sys.stderr)
    sys.exit(1)
if cs != "bt2020nc":
    print(f"FAIL: color_space {cs} != bt2020nc for generic profile", file=sys.stderr)
    sys.exit(1)
if ct != "arib-std-b67":
    print(f"FAIL: color_transfer {ct} != arib-std-b67 for generic profile", file=sys.stderr)
    sys.exit(1)
if cp != "bt2020":
    print(f"FAIL: color_primaries {cp} != bt2020 for generic profile", file=sys.stderr)
    sys.exit(1)
if cr != "tv":
    print(f"FAIL: color_range {cr} != tv for generic profile", file=sys.stderr)
    sys.exit(1)
if has_dovi:
    print(f"FAIL: has_dovi true but generic profile requires non-Dolby HLG", file=sys.stderr)
    sys.exit(1)
# PQ should be rejected (already ct check ensures not PQ, but double-check)
if ct and ("2084" in ct.lower() or ct.lower() == "smpte2084"):
    print(f"FAIL: PQ transfer detected for generic profile", file=sys.stderr)
    sys.exit(1)
print(f"OK: generic HLG source verified cs={cs} ct={ct} cp={cp} cr={cr} pix={pix} has_dovi={has_dovi}", file=sys.stderr)
PY
  if [ $? -ne 0 ]; then
    exit 1
  fi
  echo "OK: source HLG metadata verified for profile $EXPECTED_PROFILE" >&2
elif [ "$EXPECTED_PROFILE" = "pq-rec709-v1" ]; then
  # PQ narrow gate: strict re-gate using stream + first-frame side data; require both MDCV/CLLI and reject DOVI/HDR10+
  # Requirements: parse_ok, not unspecified/contradictory, exact bt2020nc + smpte2084 + bt2020, tv, >=10-bit allowlist, has_dovi=false, has_hdr10plus=false, BOTH MDCV and CLLI present.
  SRC_META_JSON="$("$FFPROBE" -v error -select_streams v:0 -read_intervals "%+#1" -show_streams -show_frames -of json "$SRC_REAL" 2>/dev/null)" || {
    echo "FAIL: ffprobe failed for source $SRC_INPUT (profile $EXPECTED_PROFILE)" >&2
    exit 1
  }
  if [ -z "$SRC_META_JSON" ]; then
    echo "FAIL: empty ffprobe output for source $SRC_INPUT" >&2
    exit 1
  fi
  python3 - "$SRC_META_JSON" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
streams = data.get("streams", [])
v = next((s for s in streams if s.get("codec_type") == "video"), streams[0] if streams else {})
cs = v.get("color_space")
ct = v.get("color_transfer")
cp = v.get("color_primaries")
cr = v.get("color_range")
pix = v.get("pix_fmt")
# Detect DOVI/HDR10+ and MDCV/CLLI from stream side_data_list AND bounded first frame side_data
def collect_flags(data):
    has_dovi = False
    has_hdr10plus = False
    has_mdcv = False
    has_clli = False
    # stream
    side = v.get("side_data_list") or []
    for sd in side:
        t = (sd.get("side_data_type") or "").lower()
        if "dovi" in t or "dolby" in t:
            has_dovi = True
        if "hdr10plus" in t or "hdr10_plus" in t or "hdr10+" in t or "st2094-40" in t or "st2094-10" in t or "st2094" in t:
            has_hdr10plus = True
        if "mastering display" in t or "mdcv" in t:
            has_mdcv = True
        if "content light" in t or "clli" in t:
            has_clli = True
        if t == "mdcv" or "mdcv" in t:
            has_mdcv = True
        if t == "clli" or "clli" in t:
            has_clli = True
    # frames (first frame only due to -read_intervals %+#1)
    frames = data.get("frames", []) or []
    for fr in frames:
        f_side = fr.get("side_data_list")
        if f_side is None:
            f_side = fr.get("side_data", []) or []
        if not isinstance(f_side, list):
            continue
        for sd in f_side:
            if not isinstance(sd, dict):
                continue
            t = str(sd.get("side_data_type", "")).lower()
            if "dovi" in t or "dolby" in t:
                has_dovi = True
            if "hdr10plus" in t or "hdr10_plus" in t or "hdr10+" in t or "st2094-40" in t or "st2094-10" in t or "st2094" in t:
                has_hdr10plus = True
            if "mastering display" in t or "mdcv" in t:
                has_mdcv = True
            if "content light" in t or "clli" in t:
                has_clli = True
            if t == "mdcv" or "mdcv" in t:
                has_mdcv = True
            if t == "clli" or "clli" in t:
                has_clli = True
    return has_dovi, has_hdr10plus, has_mdcv, has_clli
has_dovi, has_hdr10plus, has_mdcv, has_clli = collect_flags(data)
# unspecified check
is_unspecified = False
for val in (cs, ct, cp):
    if val is None:
        continue
    vl = str(val).lower()
    if vl in ("unknown", "unspecified", "2", ""):
        is_unspecified = True
# contradictory: PQ transfer but primaries/space not bt2020
is_contradictory = False
if ct is not None:
    ctn = str(ct).lower()
    if "2084" in ctn or ctn in ("smpte2084", "smpte2084(pq)", "pq", "16"):
        if cs is not None and str(cs).lower() not in ("bt2020nc", "9", "bt2020"):
            # Check if cs is known value and not bt2020nc -> contradictory
            if str(cs).lower() not in ("", "unknown", "unspecified", "2"):
                if str(cs).lower() != "bt2020nc":
                    is_contradictory = True
        if cp is not None and str(cp).lower() not in ("bt2020", "9"):
            if str(cp).lower() not in ("", "unknown", "unspecified", "2"):
                if str(cp).lower() != "bt2020":
                    is_contradictory = True
if cs is None or ct is None or cp is None or cr is None or pix is None:
    print(f"FAIL: missing required PQ metadata for pq profile: cs={cs} ct={ct} cp={cp} cr={cr} pix={pix}", file=sys.stderr)
    sys.exit(1)
if is_unspecified:
    print(f"FAIL: unspecified metadata for pq profile: cs={cs} ct={ct} cp={cp}", file=sys.stderr)
    sys.exit(1)
if is_contradictory:
    print(f"FAIL: contradictory metadata for pq profile: cs={cs} ct={ct} cp={cp}", file=sys.stderr)
    sys.exit(1)
allowed_pix = {"yuv420p10le","yuv422p10le","yuv444p10le","yuv420p12le","yuv422p12le","yuv444p12le"}
pix_norm = str(pix).strip().lower()
if pix_norm not in allowed_pix:
    print(f"FAIL: pix_fmt {pix} not in allowed >=10-bit list for pq profile", file=sys.stderr)
    sys.exit(1)
# exact triplet
if str(cs).lower() not in ("bt2020nc", "9"):
    print(f"FAIL: color_space {cs} != bt2020nc for pq profile", file=sys.stderr)
    sys.exit(1)
# ct must be smpte2084 or 16
ct_norm = str(ct).strip().lower()
if ct_norm not in ("smpte2084", "smpte2084(pq)", "pq", "16") and "2084" not in ct_norm:
    print(f"FAIL: color_transfer {ct} != smpte2084 for pq profile", file=sys.stderr)
    sys.exit(1)
if str(cp).lower() not in ("bt2020", "9"):
    print(f"FAIL: color_primaries {cp} != bt2020 for pq profile", file=sys.stderr)
    sys.exit(1)
if str(cr).lower() != "tv":
    print(f"FAIL: color_range {cr} != tv for pq profile", file=sys.stderr)
    sys.exit(1)
if has_dovi:
    print(f"FAIL: has_dovi true but pq profile requires static HDR10 without Dolby", file=sys.stderr)
    sys.exit(1)
if has_hdr10plus:
    print(f"FAIL: has_hdr10plus true but pq profile requires static HDR10 without HDR10+", file=sys.stderr)
    sys.exit(1)
if not has_mdcv or not has_clli:
    print(f"FAIL: pq profile requires both MDCV and CLLI; got has_mdcv={has_mdcv} has_clli={has_clli}", file=sys.stderr)
    sys.exit(1)
print(f"OK: pq static HDR10 source verified cs={cs} ct={ct} cp={cp} cr={cr} pix={pix} has_mdcv={has_mdcv} has_clli={has_clli} has_dovi={has_dovi} has_hdr10plus={has_hdr10plus}", file=sys.stderr)
PY
  if [ $? -ne 0 ]; then
    exit 1
  fi
  echo "OK: source PQ metadata verified for profile $EXPECTED_PROFILE" >&2
else
  echo "FAIL: unknown profile $EXPECTED_PROFILE" >&2
  exit 1
fi

# HLG timing policy: passthrough timestamps; retain the exact decoded/presentation frame count.
# `nb_frames` can include edit-list preroll (1.MOV reports 503 samples but 491 decoded frames).
probe_timing() {
  "$FFPROBE" -v error -count_frames -select_streams v:0 \
    -show_entries stream=duration,nb_read_frames -of json "$1" |
    python3 -c 'import json,sys; s=(json.load(sys.stdin).get("streams") or [{}])[0]; print((s.get("duration") or "") , (s.get("nb_read_frames") or ""))'
}
read -r SRC_DURATION SRC_FRAMES <<< "$(probe_timing "$SRC_REAL")"
read -r DST_DURATION DST_FRAMES <<< "$(probe_timing "$DST_REAL")"
DURATION_TOLERANCE="0.050"
python3 - "$SRC_DURATION" "$DST_DURATION" "$SRC_FRAMES" "$DST_FRAMES" "$DURATION_TOLERANCE" <<'PY'
import sys
src_duration, dst_duration = float(sys.argv[1]), float(sys.argv[2])
src_frames, dst_frames = int(sys.argv[3]), int(sys.argv[4])
tolerance = float(sys.argv[5])
delta = abs(dst_duration - src_duration)
if src_frames != dst_frames:
    print(f"FAIL: video frame count changed source={src_frames} output={dst_frames}", file=sys.stderr)
    raise SystemExit(1)
if delta > tolerance:
    print(f"FAIL: video duration delta {delta:.6f}s exceeds {tolerance:.3f}s", file=sys.stderr)
    raise SystemExit(1)
print(f"OK: timing source={src_duration:.6f}s output={dst_duration:.6f}s delta={delta:.6f}s frames={src_frames}", file=sys.stderr)
PY

# Output ffprobe tags must be Rec.709 SDR.
PROBE="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range,width,height -of json "$DST_REAL")"
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

# Only inspect the bounded first decoded output frame. A Rec.709 SDR export must not
# retain HDR mastering/light-level, HDR10+, Dolby Vision, HDR Vivid, or ambient HDR data.
DST_FRAME_SIDE_DATA="$("$FFPROBE" -v error -select_streams v:0 -read_intervals "%+#1" -show_frames -show_entries frame=side_data -of json "$DST_REAL" 2>/dev/null)" || {
  echo "FAIL: ffprobe failed while inspecting first output frame side data" >&2
  exit 1
}
if [ -z "$DST_FRAME_SIDE_DATA" ]; then
  echo "FAIL: empty ffprobe output while inspecting first output frame side data" >&2
  exit 1
fi
printf '%s\n' "$DST_FRAME_SIDE_DATA" | python3 -c '
import json
import sys

data = json.load(sys.stdin)
frames = data.get("frames", []) or []
first = frames[0] if frames else {}
side = first.get("side_data_list")
if side is None:
    side = first.get("side_data", []) or []
if not isinstance(side, list):
    side = []

forbidden = []
for item in side:
    if not isinstance(item, dict):
        continue
    name = str(item.get("side_data_type", ""))
    normalized = name.lower().replace("_", " ")
    kind = None
    if ("mastering display metadata" in normalized or
            "mastering display" in normalized or "mdcv" in normalized):
        kind = "MDCV"
    elif ("content light level metadata" in normalized or
          "content light" in normalized or "clli" in normalized):
        kind = "CLLI"
    elif ("hdr10+" in normalized or "hdr10 plus" in normalized or
          "hdr10plus" in normalized or "st2094" in normalized or
          "dynamic hdr plus" in normalized):
        kind = "HDR10+"
    elif "dovi" in normalized or "dolby vision" in normalized:
        kind = "DOVI"
    elif "hdr vivid" in normalized or "dynamic hdr vivid" in normalized:
        kind = "HDR Vivid"
    elif ("ambient viewing environment" in normalized or
          "ambient hdr" in normalized or "amve" in normalized):
        kind = "ambient HDR"
    if kind:
        forbidden.append(f"{kind} ({name})")

if forbidden:
    print("FAIL: output contains forbidden HDR frame side data: " + ", ".join(forbidden), file=sys.stderr)
    raise SystemExit(1)
print("OK: first output frame contains no forbidden HDR side data", file=sys.stderr)
'

# Reject every QuickTime private tag plus location, ISO6709, and creation-time/date tags.
PRIVACY_PATTERN='com[.]apple[.]quicktime[.]|iso6709|location|creation[ _-]?(time|date)|date[ _-]?created'
META="$("$FFPROBE" -v error -show_format -show_streams -of json "$DST_REAL")"
if printf '%s\n' "$META" | grep -v "chroma_location" | grep -Ei "$PRIVACY_PATTERN" >/dev/null; then
  echo "FAIL: output contains forbidden privacy/creation metadata" >&2
  exit 1
fi
if strings -a "$DST_REAL" | grep -v "chroma_location" | grep -Ei "$PRIVACY_PATTERN" >/dev/null; then
  echo "FAIL: output contains forbidden privacy/creation bytes" >&2
  exit 1
fi
echo "OK: no com.apple.quicktime.*, ISO6709, location, or creation-time metadata" >&2

DST_SHA="$(shasum -a 256 "$DST_REAL" | awk '{print $1}')"
DST_SIZE="$(stat -f %z "$DST_REAL" 2>/dev/null || stat -c %s "$DST_REAL")"
echo "OK: output $DST_REAL size=$DST_SIZE sha=$DST_SHA for profile $EXPECTED_PROFILE" >&2
echo "PASS: $SRC_REAL -> $DST_REAL [$EXPECTED_PROFILE]" >&2
