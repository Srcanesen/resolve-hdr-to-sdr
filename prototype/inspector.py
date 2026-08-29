import os
import json
import hashlib
import subprocess
from pathlib import Path
from typing import Tuple, Optional

from .contracts import InspectionEvidence
from .path_boundary import get_sample_root, validate_local_path, validate_user_selected_path, PathValidationError


_UNKNOWN_COLOR_VALUES = {"", "unknown", "unspecified", "2"}
FFPROBE_TIMEOUT_SECONDS = 15


def _strict_flag(value) -> bool:
    """Parse ffprobe's 0/1 flags without treating arbitrary strings as truthy."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value in {"0", "1"}:
        return value == "1"
    raise ValueError("invalid_boolean_flag")


def _strict_int(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("invalid_integer")
    return value


def _optional_strict_int(mapping: dict, key: str):
    if key not in mapping or mapping[key] is None:
        return None
    return _strict_int(mapping[key])


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
    except Exception:
        return InspectionEvidence(
            sha256=sha256,
            size=size,
            display_name=display_name,
            parse_ok=False,
            parse_error="json_parse_failed",
        )

    try:
        if not isinstance(data, dict):
            raise ValueError("probe_root_not_object")
        streams = data.get("streams")
        fmt = data.get("format", {})
        if not isinstance(streams, list) or not isinstance(fmt, dict):
            raise ValueError("probe_shape_invalid")

        # A cover/attached picture is a video stream too, but is not the source video.
        candidates = []
        for position, stream in enumerate(streams):
            if not isinstance(stream, dict):
                raise ValueError("stream_shape_invalid")
            if stream.get("codec_type") != "video":
                continue
            disposition = stream.get("disposition", {})
            if disposition is None:
                disposition = {}
            if not isinstance(disposition, dict):
                raise ValueError("disposition_shape_invalid")
            attached = False
            if "attached_pic" in disposition:
                attached = _strict_flag(disposition["attached_pic"])
            is_default = False
            if "default" in disposition:
                is_default = _strict_flag(disposition["default"])
            candidates.append((position, stream, attached, is_default))

        selected = next((item for item in candidates if not item[2] and item[3]), None)
        if selected is None:
            selected = next((item for item in candidates if not item[2]), None)
        if selected is None:
            return InspectionEvidence(
                sha256=sha256,
                size=size,
                display_name=display_name,
                parse_ok=False,
                parse_error="no_video_stream",
            )
        position, vstream, _, _ = selected
        stream_index = vstream.get("index", position)
        if stream_index is None:
            stream_index = position
        stream_index = _strict_int(stream_index)

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
        level = _optional_strict_int(vstream, "level")

        has_dovi = False
        has_hdr10plus = False
        has_mdcv = False
        has_clli = False
        dovi_values = {}
        metadata_conflict = False

        def merge_dovi_value(key, value):
            nonlocal metadata_conflict
            if value is None:
                return
            if key in dovi_values and dovi_values[key] != value:
                metadata_conflict = True
            else:
                dovi_values[key] = value

        def inspect_side_data(side_data):
            nonlocal has_dovi, has_hdr10plus, has_mdcv, has_clli
            if not isinstance(side_data, dict):
                raise ValueError("side_data_shape_invalid")
            side_type = side_data.get("side_data_type", "")
            if not isinstance(side_type, str):
                raise ValueError("side_data_type_invalid")
            side_type_lower = side_type.lower()
            if "dovi" in side_type_lower or "dolby" in side_type_lower:
                has_dovi = True
                for field in ("dv_profile", "dv_level", "dv_bl_signal_compatibility_id"):
                    if field in side_data:
                        merge_dovi_value(field, _optional_strict_int(side_data, field))
                for field in ("rpu_present_flag", "el_present_flag", "bl_present_flag"):
                    if field in side_data:
                        merge_dovi_value(field, _strict_flag(side_data[field]))
            if (
                "hdr10plus" in side_type_lower
                or "hdr10_plus" in side_type_lower
                or "hdr10+" in side_type_lower
                or "st2094-40" in side_type_lower
                or "st2094-10" in side_type_lower
                or "st2094" in side_type_lower
            ):
                has_hdr10plus = True
            if "mastering display" in side_type_lower or "mdcv" in side_type_lower:
                has_mdcv = True
            if "content light" in side_type_lower or "clli" in side_type_lower:
                has_clli = True

        def inspect_side_data_list(side_list):
            if side_list is None:
                return
            if not isinstance(side_list, list):
                raise ValueError("side_data_list_invalid")
            for side_data in side_list:
                inspect_side_data(side_data)

        inspect_side_data_list(vstream.get("side_data_list", []))

        # Keep frame evidence only for the selected real video stream. A frame from
        # an audio or attached-picture stream must not influence classification.
        frames = data.get("frames", [])
        if frames is None:
            frames = []
        if not isinstance(frames, list):
            raise ValueError("frames_shape_invalid")
        for frame in frames:
            if not isinstance(frame, dict):
                raise ValueError("frame_shape_invalid")
            if "stream_index" in frame:
                frame_index = _strict_int(frame["stream_index"])
                if frame_index != stream_index:
                    continue
            elif sum(1 for item in candidates if not item[2]) != 1:
                # Without a stream index, metadata from a multi-video probe is
                # ambiguous and must not influence the selected source stream.
                continue
            if "media_type" in frame:
                media_type = frame["media_type"]
                if not isinstance(media_type, str):
                    raise ValueError("frame_media_type_invalid")
                if media_type.lower() != "video":
                    continue
            frame_side_data = frame.get("side_data_list")
            if frame_side_data is None:
                frame_side_data = frame.get("side_data", [])
            inspect_side_data_list(frame_side_data)

        is_unspecified = any(
            _normalize_probe_value(value) in _UNKNOWN_COLOR_VALUES
            for value in (color_space, color_transfer, color_primaries)
        )
        is_contradictory = metadata_conflict or _has_semantic_color_contradiction(
            color_transfer, color_space, color_primaries
        )

        return InspectionEvidence(
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
            level=level,
            dv_profile=dovi_values.get("dv_profile"),
            dv_level=dovi_values.get("dv_level"),
            dv_compat_id=dovi_values.get("dv_bl_signal_compatibility_id"),
            rpu_present=dovi_values.get("rpu_present_flag"),
            el_present=dovi_values.get("el_present_flag"),
            bl_present=dovi_values.get("bl_present_flag"),
            has_dovi=has_dovi,
            has_hdr10plus=has_hdr10plus,
            has_mdcv=has_mdcv,
            has_clli=has_clli,
            is_unspecified=is_unspecified,
            is_contradictory=is_contradictory,
            parse_ok=True,
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


def _inspect_canonical(canonical: Path, repo_root: Path) -> Tuple[Optional[InspectionEvidence], Optional[str]]:
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
        ffprobe = get_ffprobe_executable(repo_root)
    except Exception:
        return None, "ffprobe_missing"
    try:
        result = subprocess.run(
            [
                str(ffprobe), "-v", "quiet", "-print_format", "json",
                "-select_streams", "v", "-show_format", "-show_streams", "-show_frames",
                # One second from the beginning is bounded by time and does not
                # accidentally select an audio packet as a packet-count probe can do.
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


def inspect_temp_file(
    temp_path: Path,
    display_name_hint: str,
    repo_root: Path,
    precomputed_sha256: Optional[str] = None,
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
        ffprobe = get_ffprobe_executable(repo_root)
    except Exception:
        return None, "ffprobe_missing"

    try:
        result = subprocess.run(
            [
                str(ffprobe), "-v", "quiet", "-print_format", "json",
                "-select_streams", "v", "-show_format", "-show_streams", "-show_frames",
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
