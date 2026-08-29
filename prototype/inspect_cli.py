#!/usr/bin/env python3
"""
inspect_cli – single JSON request on stdin, bounded 8 KiB.
Version 1 + {path: string} → inspect_local_path + classify.
Never writes Output, never logs path.
"""
import sys
import json
from pathlib import Path

# Ensure repo root on sys.path for absolute-script execution
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

MAX_REQUEST_BYTES = 8192

def _error(reason: str):
    # Compact generic error, no path/metadata dump
    payload = {"outcome": "error", "reason": reason}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()

def _complete(result_dict):
    payload = {"outcome": "complete", "result": result_dict}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()

def main():
    # Read bounded stdin
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    except Exception:
        _error("invalid_request")
        return

    if not data:
        _error("invalid_request")
        return

    if len(data) > MAX_REQUEST_BYTES:
        _error("invalid_request")
        return

    # Parse JSON
    try:
        text = data.decode("utf-8")
    except Exception:
        _error("invalid_request")
        return

    try:
        obj = json.loads(text)
    except Exception:
        _error("invalid_request")
        return

    # Validate shape: must be dict with version==1 and path string
    if not isinstance(obj, dict):
        _error("invalid_request")
        return
    if isinstance(obj.get("version"), bool) or obj.get("version") != 1:
        _error("invalid_request")
        return
    path_val = obj.get("path")
    if not isinstance(path_val, str) or not path_val:
        _error("invalid_request")
        return
    # Reject clearly oversized path string
    if len(path_val) > 4096:
        _error("invalid_request")
        return
    # Strict: only version and path allowed? Be permissive but if extra keys unrelated, still accept minimal contract.
    # However, if extra keys beyond allowed set, treat as invalid_request to prevent arbitrary fields.
    allowed_keys = {"version", "path"}
    if set(obj.keys()) - allowed_keys:
        _error("invalid_request")
        return

    # Do inspection – reuse existing prototype logic
    try:
        from prototype.inspector import inspect_user_selected_path
        from prototype.classifier import classify
    except Exception:
        _error("internal_error")
        return

    try:
        ev, err = inspect_user_selected_path(path_val, REPO_ROOT)
    except Exception:
        _error("internal_error")
        return

    if ev is None:
        # Map path-boundary / probe failures to generic reason without leaking path
        # Use invalid_path for boundary-like errors, inspection_failed otherwise – both generic.
        if err in ("not_absolute", "unsupported_extension", "symlink_rejected", "is_directory", "not_regular_file", "resolve_failed", "stat_failed", "root_escape", "not_found", "sample_root_missing", "missing_path"):
            _error("invalid_path")
        else:
            _error("inspection_failed")
        return

    # ev may be present but parse_ok False → classify will yield uncertain
    try:
        result = classify(ev)
        resp_dict = result.to_response_dict()
    except Exception:
        _error("internal_error")
        return

    # Privacy: to_response_dict already only contains allowed fields
    _complete(resp_dict)

if __name__ == "__main__":
    main()
