#!/usr/bin/env bash
set -euo pipefail
# Regression: arbitrary filename with exact known SHA must be accepted by verifier.
# Uses hard-link to Sample/2.MOV as IMG_6700.MOV and retained v5 output.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_ORIG="$PROJECT_ROOT/Sample/2.MOV"
OUT_V5="$PROJECT_ROOT/Output/spike/2_sdr_rec709_proreslt_v5.mov"
TMPDIR="$(mktemp -d)"
LINK_PATH="$TMPDIR/IMG_6700.MOV"
cleanup() {
  rm -rf "$TMPDIR" 2>/dev/null || true
}
trap cleanup EXIT
if [ ! -f "$SRC_ORIG" ]; then echo "SKIP: Sample/2.MOV missing" >&2; exit 0; fi
if [ ! -f "$OUT_V5" ]; then echo "SKIP: Output/spike/2_sdr_rec709_proreslt_v5.mov missing" >&2; exit 0; fi
# Create hard link (external) to prove SHA-agnostic basename acceptance
ln "$SRC_ORIG" "$LINK_PATH"
# Verify SHA equals expected (hard link shares inode)
EXPECTED_SHA="2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a"
ACTUAL_SHA="$(shasum -a 256 "$LINK_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then echo "FAIL: hardlink SHA mismatch" >&2; exit 1; fi
echo "Running verifier with arbitrary basename hardlink..." >&2
"$PROJECT_ROOT/scripts/verify-spike.sh" "$LINK_PATH" "$OUT_V5"
echo "PASS: verifier accepted arbitrary basename IMG_6700.MOV with known SHA" >&2
# Also test basename rejection still strict: unknown SHA should fail
UNKNOWN="$TMPDIR/unknown.MOV"
echo "dummy" > "$UNKNOWN"
if "$PROJECT_ROOT/scripts/verify-spike.sh" "$UNKNOWN" "$OUT_V5" 2>/dev/null; then
  echo "FAIL: verifier should reject unknown SHA" >&2; exit 1
else
  echo "OK: verifier correctly rejects unknown SHA" >&2
fi
