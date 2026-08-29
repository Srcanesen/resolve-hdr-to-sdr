import os
import json
import hashlib
import subprocess
from pathlib import Path
from typing import Tuple, Optional

from .contracts import InspectionEvidence
from .path_boundary import get_sample_root, validate_local_path, validate_user_selected_path, PathValidationError


_UNKNOWN_COLOR_VALUES = {"", "unknown", "unspecified", "2"}


def _normalize_probe_value(value) -> Optional[str]:
    if value is None:
        return None
    try:
        return str(value).strip().lower()
    except Exception:
        return None


def _is_known_probe_value(value) -> bool:
    normalized = _normalize_probe_value(value)
    return normalized is not None and normalized not in _UNKNOWN_COLOR_VALUES


def _is_bt2020_value(value, field: str) -> bool:
    normalized = _normalize_probe_value(value)
    if field == "color_space":
        # ffprobe normally emits bt2020nc; 9 is its AVColorSpace enum value.
        return normalized in {"bt2020nc", "9"}
    # bt2020 primaries also use enum value 9 in ffprobe-compatible output.
    return normalized in {"bt2020", "9"}


def _has_semantic_color_contradiction(color_transfer, color_space, color_primaries) -> bool:
    """Detect only known BT.2020 conflicts in fields exposed by ffprobe."""
    transfer = _normalize_probe_value(color_transfer)
    if transfer not in {"arib-std-b67", "smpte2084", "smpte2084(pq)", "pq", "16"}:
        return False
    if _is_known_probe_value(color_space) and not _is_bt2020_value(color_space, "color_space"):
        return True
    if _is_known_probe_value(color_primaries) and not _is_bt2020_value(color_primaries, "color_primaries"):
        return True
    return False


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
    except Exception as e:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error="json_parse_failed",
        )

    try:
        streams = data.get("streams", [])
        fmt = data.get("format", {})

        # Find video stream (first video)
        vstream = None
        for s in streams:
            if s.get("codec_type") == "video":
                vstream = s
                break

        if vstream is None:
            return InspectionEvidence(
                sha256=sha256,
                size=size,
                display_name=display_name,
                parse_ok=False,
                parse_error="no_video_stream",
            )

        codec_name = vstream.get("codec_name")
        codec_tag = vstream.get("codec_tag_string")
        pix_fmt = vstream.get("pix_fmt")
        color_space = vstream.get("color_space")
        color_transfer = vstream.get("color_transfer")
        color_primaries = vstream.get("color_primaries")
        color_range = vstream.get("color_range")
        chroma_location = vstream.get("chroma_location")
        width = vstream.get("width")
        height = vstream.get("height")
        duration = vstream.get("duration") or fmt.get("duration")
        r_frame_rate = vstream.get("r_frame_rate")
        avg_frame_rate = vstream.get("avg_frame_rate")

        # DOVI side data
        has_dovi = False
        has_hdr10plus = False
        dv_profile = None
        dv_level = None
        dv_compat_id = None
        rpu_present = None
        el_present = None
        bl_present = None
        has_mdcv = False
        has_clli = False

        side_list = vstream.get("side_data_list", []) or []
        for sd in side_list:
            t = sd.get("side_data_type", "")
            tl = t.lower()
            if "dovi" in tl or "dolby" in tl:
                has_dovi = True
                dv_profile = sd.get("dv_profile")
                dv_level = sd.get("dv_level")
                dv_compat_id = sd.get("dv_bl_signal_compatibility_id")
                # also fields rpu_present_flag etc
                if "rpu_present_flag" in sd:
                    rpu_present = bool(sd.get("rpu_present_flag"))
                if "el_present_flag" in sd:
                    el_present = bool(sd.get("el_present_flag"))
                if "bl_present_flag" in sd:
                    bl_present = bool(sd.get("bl_present_flag"))
            # HDR10+ dynamic metadata must be detected separately from Dolby
            if "hdr10plus" in tl or "hdr10_plus" in tl or "hdr10+" in tl or "st2094-40" in tl or "st2094-10" in tl or "st2094" in tl:
                # Ensure not misclassifying dolby already captured; still set independently
                has_hdr10plus = True
            if "mastering display" in tl or "mdcv" in tl:
                has_mdcv = True
            if "content light" in tl or "clli" in tl:
                has_clli = True
            # also mdcv/clli can appear as separate strings
            if tl == "mdcv" or "mdcv" in tl:
                has_mdcv = True
            if tl == "clli" or "clli" in tl:
                has_clli = True

        # Bounded first decoded frame side data (supplements stream side_data_list)
        # Local ffprobe exposes MDCV/CLLI on first frame even when stream side_data_list is absent
        frames = data.get("frames", []) or []
        for fr in frames:
            # ffprobe may expose side_data as side_data_list or side_data
            f_side = fr.get("side_data_list", None)
            if f_side is None:
                f_side = fr.get("side_data", []) or []
            if not isinstance(f_side, list):
                continue
            for sd in f_side:
                if not isinstance(sd, dict):
                    continue
                t = sd.get("side_data_type", "")
                tl = str(t).lower()
                if "dovi" in tl or "dolby" in tl:
                    has_dovi = True
                    # Capture rpu flags if present on frame as well
                    if dv_profile is None and "dv_profile" in sd:
                        dv_profile = sd.get("dv_profile")
                    if dv_level is None and "dv_level" in sd:
                        dv_level = sd.get("dv_level")
                    if dv_compat_id is None and "dv_bl_signal_compatibility_id" in sd:
                        dv_compat_id = sd.get("dv_bl_signal_compatibility_id")
                if "hdr10plus" in tl or "hdr10_plus" in tl or "hdr10+" in tl or "st2094-40" in tl or "st2094-10" in tl or "st2094" in tl:
                    has_hdr10plus = True
                if "mastering display" in tl or "mdcv" in tl:
                    has_mdcv = True
                if "content light" in tl or "clli" in tl:
                    has_clli = True
                if tl == "mdcv" or "mdcv" in tl:
                    has_mdcv = True
                if tl == "clli" or "clli" in tl:
                    has_clli = True

        # Also check for unspecified (2)
        is_unspecified = False
        # color_primaries/transfer/space values from ffprobe string may be "unknown" or color values numeric?
        # Check for "unknown" or "unspecified" string or numeric 2
        for val in (color_space, color_transfer, color_primaries):
            normalized = _normalize_probe_value(val)
            if normalized in _UNKNOWN_COLOR_VALUES:
                is_unspecified = True
        # Only semantic contradictions visible in these stream fields are flagged.
        # ffprobe does not expose a reliable container-vs-bitstream comparison here.
        is_contradictory = _has_semantic_color_contradiction(
            color_transfer, color_space, color_primaries
        )

        ev = InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            codec_name=codec_name,
            codec_tag=codec_tag,
            pix_fmt=pix_fmt,
            color_space=color_space,
            color_transfer=color_transfer,
            color_primaries=color_primaries,
            color_range=color_range,
            chroma_location=chroma_location,
            width=width,
            height=height,
            duration=str(duration) if duration is not None else None,
            r_frame_rate=r_frame_rate,
            avg_frame_rate=avg_frame_rate,
            dv_profile=dv_profile,
            dv_level=dv_level,
            dv_compat_id=dv_compat_id,
            rpu_present=rpu_present,
            el_present=el_present,
            bl_present=bl_present,
            has_dovi=has_dovi,
            has_hdr10plus=has_hdr10plus,
            has_mdcv=has_mdcv,
            has_clli=has_clli,
            is_unspecified=is_unspecified,
            is_contradictory=is_contradictory,
            parse_ok=True,
        )
        return ev
    except Exception:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error="evidence_extraction_failed",
        )


def _inspect_canonical(canonical: Path, repo_root: Path) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """Internal helper: hash, ffprobe, identity recheck, parse. No path policy."""
    try:
        st_before = os.stat(canonical)
        size_before = st_before.st_size
        ino_before = st_before.st_ino
        dev_before = st_before.st_dev
        mtime_before = st_before.st_mtime_ns
    except OSError:
        return None, "stat_failed"
    try:
        sha = sha256_file(canonical)
    except OSError:
        return None, "hash_failed"
    try:
        ffprobe = get_ffprobe_executable(repo_root)
    except Exception:
        return None, "ffprobe_missing"
    try:
        result = subprocess.run(
            [str(ffprobe), "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-read_intervals", "%+#1", "-show_frames", str(canonical)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            shell=False,
            check=False,
        )
    except Exception:
        return None, "ffprobe_exec_failed"
    if result.returncode != 0:
        return None, "ffprobe_nonzero"
    if not result.stdout or len(result.stdout) == 0:
        return None, "ffprobe_empty"
    try:
        st_after = os.stat(canonical)
        if st_after.st_size != size_before or st_after.st_ino != ino_before or st_after.st_dev != dev_before or st_after.st_mtime_ns != mtime_before:
            return None, "identity_changed"
        sha_after = sha256_file(canonical)
        if sha_after != sha:
            return None, "identity_changed"
    except OSError:
        return None, "stat_failed"
    display_name = _sanitize_display_name(canonical.name)
    ev = _parse_ffprobe_json(result.stdout, display_name, size_before, sha)
    if not ev.parse_ok:
        return ev, ev.parse_error
    return ev, None


def inspect_local_path(path_str: str, repo_root: Path) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """
    Inspect a local path under Sample/ root.
    Returns (evidence, error_reason). On validation/probe failure, evidence is None or with parse_ok False but classification will be uncertain.
    This function is host-only and keeps raw path internal; caller should map to sanitized response.
    """
    try:
        canonical = validate_local_path(path_str, repo_root)
    except PathValidationError as e:
        return None, e.reason
    return _inspect_canonical(canonical, repo_root)


def inspect_user_selected_path(path_str: str, repo_root: Path) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
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
    return _inspect_canonical(canonical, repo_root)


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


def inspect_temp_file(temp_path: Path, display_name_hint: str, repo_root: Path) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
    """Inspect a temp file containing upload bytes. Caller ensures file 0600 in 0700 dir."""
    try:
        st = os.stat(temp_path)
        size = st.st_size
        if size == 0:
            return None, "empty"
    except OSError:
        return None, "stat_failed"

    try:
        sha = sha256_file(temp_path)
    except OSError:
        return None, "hash_failed"

    try:
        ffprobe = get_ffprobe_executable(repo_root)
    except Exception:
        return None, "ffprobe_missing"

    try:
        result = subprocess.run(
            [str(ffprobe), "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-read_intervals", "%+#1", "-show_frames", str(temp_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
            shell=False,
            check=False,
        )
    except Exception:
        return None, "ffprobe_exec_failed"

    if result.returncode != 0:
        return None, "ffprobe_nonzero"
    if not result.stdout:
        return None, "ffprobe_empty"

    display_name = _sanitize_display_name(display_name_hint)
    ev = _parse_ffprobe_json(result.stdout, display_name, size, sha)
    if not ev.parse_ok:
        return ev, ev.parse_error
    return ev, None
