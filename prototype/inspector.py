import os
import json
import hashlib
import subprocess
from pathlib import Path
from typing import Tuple, Optional

from .contracts import InspectionEvidence
from .evidence import EvidenceError, extract_evidence
from .path_boundary import get_sample_root, validate_local_path, validate_user_selected_path, PathValidationError


FFPROBE_TIMEOUT_SECONDS = 15


def get_ffprobe_executable(repo_root: Path) -> Path:
    # repo-resolved tools/ffprobe absolute executable
    p = (repo_root / "tools" / "ffprobe")
    # resolve symlink chain strictly
    try:
        abs_path = p.resolve(strict=True)
    except FileNotFoundError:
        raise FileNotFoundError(f"ffprobe not found at {p}")
    if not abs_path.is_file():
        raise FileNotFoundError(f"ffprobe not a file: {abs_path}")
    # ensure executable
    if not os.access(abs_path, os.X_OK):
        raise PermissionError(f"ffprobe not executable: {abs_path}")
    return abs_path


def _resolve_ffprobe_executable(repo_root: Path, ffprobe_executable: Optional[Path] = None) -> Path:
    """Resolve the production repo tool or an explicit test-only executable."""
    if ffprobe_executable is None:
        return get_ffprobe_executable(repo_root)
    candidate = Path(ffprobe_executable)
    if not candidate.is_absolute():
        raise FileNotFoundError("ffprobe injection must be absolute")
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError:
        raise FileNotFoundError("ffprobe injection not found")
    if not resolved.is_file():
        raise FileNotFoundError("ffprobe injection not a file")
    if not os.access(resolved, os.X_OK):
        raise PermissionError("ffprobe injection not executable")
    return resolved


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192 * 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _sanitize_display_name(name: str) -> str:
    # basename only, remove path separators, limit length
    # Keep only printable?
    import re
    n = name.strip().split("/")[-1].split("\\")[-1]
    n = n[:255]
    # remove control chars
    n = "".join(c for c in n if c.isprintable())
    if not n:
        n = "upload"
    return n


def _parse_ffprobe_json(stdout_bytes: bytes, display_name: str, size: int, sha256: str) -> InspectionEvidence:
    try:
        data = json.loads(stdout_bytes.decode("utf-8"))
    except Exception:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error="json_parse_failed",
        )
    try:
        return extract_evidence(data, display_name, size, sha256)
    except EvidenceError as error:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error=error.reason,
        )
    except Exception:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error="evidence_extraction_failed",
        )


def _same_identity(before, after) -> bool:
    return (
        after.st_size == before.st_size
        and after.st_ino == before.st_ino
        and after.st_dev == before.st_dev
        and after.st_mtime_ns == before.st_mtime_ns
    )


def _inspect_canonical(
    canonical: Path,
    repo_root: Path,
    ffprobe_executable: Optional[Path] = None,
) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """Hash once, probe a bounded interval, and detect changes using file identity."""
    try:
        st_before = os.stat(canonical)
        size_before = st_before.st_size
    except OSError:
        return None, "stat_failed"
    try:
        sha = sha256_file(canonical)
        # This catches a write occurring while the single hash was being read.
        if not _same_identity(st_before, os.stat(canonical)):
            return None, "identity_changed"
    except OSError:
        return None, "hash_failed"
    try:
        ffprobe = _resolve_ffprobe_executable(repo_root, ffprobe_executable)
    except Exception:
        return None, "ffprobe_missing"
    try:
        result = subprocess.run(
            [
                str(ffprobe), "-v", "quiet", "-print_format", "json",
                "-select_streams", "V:0", "-show_format", "-show_streams", "-show_frames",
                # One second from the beginning is bounded by time. Uppercase V:0
                # selects the first real (non-attached) video stream.
                "-read_intervals", "0%+1", str(canonical),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFPROBE_TIMEOUT_SECONDS,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "ffprobe_timeout"
    except Exception:
        return None, "ffprobe_exec_failed"
    if result.returncode != 0:
        return None, "ffprobe_nonzero"
    if not result.stdout or len(result.stdout) == 0:
        return None, "ffprobe_empty"
    try:
        if not _same_identity(st_before, os.stat(canonical)):
            return None, "identity_changed"
    except OSError:
        return None, "stat_failed"
    display_name = _sanitize_display_name(canonical.name)
    ev = _parse_ffprobe_json(result.stdout, display_name, size_before, sha)
    if not ev.parse_ok:
        return ev, ev.parse_error
    return ev, None


def inspect_local_path(
    path_str: str,
    repo_root: Path,
    ffprobe_executable: Optional[Path] = None,
) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """
    Inspect a local path under Sample/ root.
    Returns (evidence, error_reason). On validation/probe failure, evidence is None or with parse_ok False but classification will be uncertain.
    This function is host-only and keeps raw path internal; caller should map to sanitized response.
    """
    try:
        canonical = validate_local_path(path_str, repo_root)
    except PathValidationError as e:
        return None, e.reason
    return _inspect_canonical(canonical, repo_root, ffprobe_executable)


def inspect_user_selected_path(
    path_str: str,
    repo_root: Path,
    ffprobe_executable: Optional[Path] = None,
) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """
    Electron-selected path: arbitrary absolute local .mov/.mp4 regular file.
    Preserves safe checks: absolute, extension, no final symlink, no directory/nonregular,
    strict canonicalization, identity recheck, no shell/PATH fallback.
    No Sample-root restriction. Classification unchanged and privacy-filtered by caller.
    """
    try:
        canonical = validate_user_selected_path(path_str, repo_root)
    except PathValidationError as e:
        return None, e.reason
    return _inspect_canonical(canonical, repo_root, ffprobe_executable)


def inspect_upload_bytes(data: bytes, filename_hint: str) -> Tuple[Optional[InspectionEvidence], Optional[str], Path]:
    """
    Inspect raw upload bytes that have already been written to a temp file.
    This helper expects data already validated and written; it will hash and probe the temp file.
    The caller is responsible for temp file lifecycle.
    For testing convenience we provide bytes-based variant without file writing.
    Not used in server path which writes to file first.
    """
    # This is not the primary server path; used for tests
    sha = hashlib.sha256(data).hexdigest()
    size = len(data)
    display_name = _sanitize_display_name(filename_hint or "upload")
    # For bytes path we need a temp file to run ffprobe, but we can simulate parsing if not needed
    # Return evidence with unspecified to allow classifier to handle? Caller should use inspect_temp_file instead
    return None, "not_implemented_for_bytes", Path()


def inspect_temp_file(
    temp_path: Path,
    display_name_hint: str,
    repo_root: Path,
    precomputed_sha256: Optional[str] = None,
    ffprobe_executable: Optional[Path] = None,
) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """Inspect a private upload, reusing the hash made while the request was written."""
    try:
        st_before = os.stat(temp_path)
        size = st_before.st_size
        if size == 0:
            return None, "empty"
    except OSError:
        return None, "stat_failed"

    try:
        sha = precomputed_sha256 if precomputed_sha256 is not None else sha256_file(temp_path)
        if not _same_identity(st_before, os.stat(temp_path)):
            return None, "identity_changed"
    except OSError:
        return None, "hash_failed"

    try:
        ffprobe = _resolve_ffprobe_executable(repo_root, ffprobe_executable)
    except Exception:
        return None, "ffprobe_missing"

    try:
        result = subprocess.run(
            [
                str(ffprobe), "-v", "quiet", "-print_format", "json",
                "-select_streams", "V:0", "-show_format", "-show_streams", "-show_frames",
                "-read_intervals", "0%+1", str(temp_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=FFPROBE_TIMEOUT_SECONDS,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "ffprobe_timeout"
    except Exception:
        return None, "ffprobe_exec_failed"

    if result.returncode != 0:
        return None, "ffprobe_nonzero"
    if not result.stdout:
        return None, "ffprobe_empty"
    try:
        if not _same_identity(st_before, os.stat(temp_path)):
            return None, "identity_changed"
    except OSError:
        return None, "stat_failed"

    display_name = _sanitize_display_name(display_name_hint)
    ev = _parse_ffprobe_json(result.stdout, display_name, size, sha)
    if not ev.parse_ok:
        return ev, ev.parse_error
    return ev, None
