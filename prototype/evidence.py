"""Pure FFprobe evidence normalization shared by inspection and verification."""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .contracts import (
    ALLOWED_GENERIC_HLG_PIX_FMTS,
    InspectionEvidence,
    PROFILE_ID_GENERIC,
    PROFILE_ID_PQ,
)

_UNKNOWN_COLOR_VALUES = {"", "unknown", "unspecified", "2"}


class EvidenceError(ValueError):
    """A probe payload cannot be safely interpreted as media evidence."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def strict_flag(value: Any) -> bool:
    """Parse FFprobe's 0/1 flags without treating arbitrary strings as truthy."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    if isinstance(value, str) and value in {"0", "1"}:
        return value == "1"
    raise EvidenceError("invalid_boolean_flag")


def strict_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvidenceError("invalid_integer")
    return value


def optional_strict_int(mapping: dict, key: str) -> Optional[int]:
    if key not in mapping or mapping[key] is None:
        return None
    return strict_int(mapping[key])


def normalize_probe_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    try:
        return str(value).strip().lower()
    except Exception:
        return None


def normalize_color_value(value: Any, field: str) -> Optional[str]:
    normalized = normalize_probe_value(value)
    if normalized is None:
        return None
    # FFprobe may be configured to emit enum numbers. Keep one canonical spelling
    # so the classifier and shell verifier consume identical evidence.
    if field == "color_space" and normalized == "9":
        return "bt2020nc"
    if field == "color_primaries" and normalized == "9":
        return "bt2020"
    if field == "color_transfer" and normalized == "16":
        return "smpte2084"
    return normalized


def is_known_probe_value(value: Any) -> bool:
    normalized = normalize_probe_value(value)
    return normalized is not None and normalized not in _UNKNOWN_COLOR_VALUES


def is_bt2020_value(value: Any, field: str) -> bool:
    normalized = normalize_color_value(value, field)
    if field == "color_space":
        return normalized == "bt2020nc"
    return normalized == "bt2020"


def has_semantic_color_contradiction(color_transfer: Any, color_space: Any, color_primaries: Any) -> bool:
    transfer = normalize_color_value(color_transfer, "color_transfer")
    if transfer not in {"arib-std-b67", "smpte2084", "smpte2084(pq)", "pq"}:
        return False
    if is_known_probe_value(color_space) and not is_bt2020_value(color_space, "color_space"):
        return True
    if is_known_probe_value(color_primaries) and not is_bt2020_value(color_primaries, "color_primaries"):
        return True
    return False


def _video_candidates(streams: list) -> List[Tuple[int, dict, bool]]:
    candidates: List[Tuple[int, dict, bool]] = []
    for position, stream in enumerate(streams):
        if not isinstance(stream, dict):
            raise EvidenceError("stream_shape_invalid")
        if stream.get("codec_type") != "video":
            continue
        disposition = stream.get("disposition", {})
        if disposition is None:
            disposition = {}
        if not isinstance(disposition, dict):
            raise EvidenceError("disposition_shape_invalid")
        attached = strict_flag(disposition["attached_pic"]) if "attached_pic" in disposition else False
        candidates.append((position, stream, attached))
    return candidates


def select_primary_video_stream(streams: list) -> Tuple[int, dict, int, int]:
    """Return the first non-attached video in file order and its stream index.

    This is deliberately the same policy as FFmpeg's uppercase ``V:0`` stream
    specifier: default disposition never changes file order and attached pictures
    are excluded only when ``attached_pic`` is exactly 1.
    """
    candidates = _video_candidates(streams)
    real = [candidate for candidate in candidates if not candidate[2]]
    if not real:
        raise EvidenceError("no_video_stream")
    position, stream, _ = real[0]
    stream_index = stream.get("index", position)
    if stream_index is None:
        stream_index = position
    stream_index = strict_int(stream_index)
    return position, stream, stream_index, len(real)


def selected_video_frames(data: dict, stream_index: int, real_video_count: int) -> Iterable[dict]:
    """Yield only frames belonging unambiguously to the selected real video."""
    streams = data.get("streams", [])
    total_video_count = sum(
        isinstance(stream, dict) and stream.get("codec_type") == "video"
        for stream in streams
    )
    frames = data.get("frames", [])
    if frames is None:
        return
    if not isinstance(frames, list):
        raise EvidenceError("frames_shape_invalid")
    for frame in frames:
        if not isinstance(frame, dict):
            raise EvidenceError("frame_shape_invalid")
        if "stream_index" in frame:
            frame_index = strict_int(frame["stream_index"])
            if frame_index != stream_index:
                continue
        elif total_video_count != 1:
            # A frame without an index cannot be assigned safely when an attached
            # picture or another video is also present.
            continue
        if "media_type" in frame:
            media_type = frame["media_type"]
            if not isinstance(media_type, str):
                raise EvidenceError("frame_media_type_invalid")
            if media_type.strip().lower() != "video":
                continue
        yield frame


def side_data_list(node: dict, key: str = "side_data_list") -> list:
    values = node.get(key)
    if values is None and key == "side_data_list":
        values = node.get("side_data", [])
    if values is None:
        values = []
    if not isinstance(values, list):
        raise EvidenceError("side_data_list_invalid")
    return values


def side_data_kind(side_data: dict) -> str:
    if not isinstance(side_data, dict):
        raise EvidenceError("side_data_shape_invalid")
    side_type = side_data.get("side_data_type", "")
    if not isinstance(side_type, str):
        raise EvidenceError("side_data_type_invalid")
    return side_type.strip().lower()


def _is_dovi(side_type: str) -> bool:
    return "dovi" in side_type or "dolby" in side_type


def _is_hdr10plus(side_type: str) -> bool:
    compact = side_type.replace(" ", "").replace("_", "")
    return any(token in compact for token in (
        "hdr10plus", "hdr10+", "st2094-40", "st2094-10", "st2094",
    ))


def _is_mdcv(side_type: str) -> bool:
    return "mastering display" in side_type or "mdcv" in side_type


def _is_clli(side_type: str) -> bool:
    return "content light" in side_type or "clli" in side_type


def _positive_finite_number(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str) and value.strip().upper() in {"", "N/A", "NA", "NONE"}:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number <= 0:
        return None
    return number


def normalized_duration(stream: dict, media_format: dict) -> Optional[float]:
    if "duration" in stream and stream.get("duration") is not None:
        raw = stream.get("duration")
        if isinstance(raw, str) and raw.strip().upper() in {"", "N/A", "NA", "NONE"}:
            raw = None
        else:
            # An explicitly present zero, negative, NaN, Infinity, or malformed
            # duration is invalid; it must not be silently replaced by format data.
            result = _positive_finite_number(raw)
            return result
    return _positive_finite_number(media_format.get("duration"))


def extract_evidence(data: dict, display_name: str, size: int, sha256: str) -> InspectionEvidence:
    """Normalize stream and selected-frame evidence into the internal contract."""
    if not isinstance(data, dict):
        raise EvidenceError("probe_root_not_object")
    streams = data.get("streams")
    media_format = data.get("format", {})
    if not isinstance(streams, list) or not isinstance(media_format, dict):
        raise EvidenceError("probe_shape_invalid")
    _, video, stream_index, real_video_count = select_primary_video_stream(streams)

    field_names = (
        "codec_name", "codec_tag_string", "pix_fmt", "color_space", "color_transfer",
        "color_primaries", "color_range", "chroma_location", "r_frame_rate", "avg_frame_rate",
    )
    values = {field: normalize_probe_value(video.get(field)) for field in field_names}
    width = video.get("width")
    height = video.get("height")
    level = optional_strict_int(video, "level")
    duration = normalized_duration(video, media_format)

    has_dovi = False
    has_hdr10plus = False
    has_mdcv = False
    has_clli = False
    dovi_values: Dict[str, Any] = {}
    metadata_conflict = False

    def merge_dovi_value(key: str, value: Any) -> None:
        nonlocal metadata_conflict
        if value is None:
            return
        if key in dovi_values and dovi_values[key] != value:
            metadata_conflict = True
        else:
            dovi_values[key] = value

    def inspect_side_data(items: list) -> None:
        nonlocal has_dovi, has_hdr10plus, has_mdcv, has_clli
        for item in items:
            side_type = side_data_kind(item)
            if _is_dovi(side_type):
                has_dovi = True
                for field in ("dv_profile", "dv_level", "dv_bl_signal_compatibility_id"):
                    if field in item:
                        merge_dovi_value(field, optional_strict_int(item, field))
                for field in ("rpu_present_flag", "el_present_flag", "bl_present_flag"):
                    if field in item:
                        merge_dovi_value(field, strict_flag(item[field]))
            if _is_hdr10plus(side_type):
                has_hdr10plus = True
            if _is_mdcv(side_type):
                has_mdcv = True
            if _is_clli(side_type):
                has_clli = True

    inspect_side_data(side_data_list(video))
    for frame in selected_video_frames(data, stream_index, real_video_count):
        inspect_side_data(side_data_list(frame))

    color_space = normalize_color_value(video.get("color_space"), "color_space")
    color_transfer = normalize_color_value(video.get("color_transfer"), "color_transfer")
    color_primaries = normalize_color_value(video.get("color_primaries"), "color_primaries")
    is_unspecified = any(
        normalize_probe_value(value) in _UNKNOWN_COLOR_VALUES
        for value in (video.get("color_space"), video.get("color_transfer"), video.get("color_primaries"))
    )
    is_contradictory = metadata_conflict or has_semantic_color_contradiction(
        color_transfer, color_space, color_primaries
    )

    return InspectionEvidence(
        sha256=sha256,
        size=size,
        display_name=display_name,
        codec_name=values["codec_name"],
        codec_tag=values["codec_tag_string"],
        pix_fmt=values["pix_fmt"],
        color_space=color_space,
        color_transfer=color_transfer,
        color_primaries=color_primaries,
        color_range=values["color_range"],
        chroma_location=values["chroma_location"],
        width=width,
        height=height,
        duration=duration,
        r_frame_rate=values["r_frame_rate"],
        avg_frame_rate=values["avg_frame_rate"],
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


def is_generic_hlg_evidence(ev: InspectionEvidence) -> bool:
    if not ev.parse_ok or ev.is_unspecified or ev.is_contradictory:
        return False
    if ev.has_dovi or ev.has_hdr10plus:
        return False
    return (
        normalize_color_value(ev.color_space, "color_space") == "bt2020nc"
        and normalize_color_value(ev.color_transfer, "color_transfer") == "arib-std-b67"
        and normalize_color_value(ev.color_primaries, "color_primaries") == "bt2020"
        and normalize_probe_value(ev.color_range) == "tv"
        and normalize_probe_value(ev.pix_fmt) in ALLOWED_GENERIC_HLG_PIX_FMTS
    )


def is_pq_evidence(ev: InspectionEvidence) -> bool:
    if not ev.parse_ok or ev.is_unspecified or ev.is_contradictory:
        return False
    return (
        not ev.has_dovi
        and not ev.has_hdr10plus
        and normalize_color_value(ev.color_space, "color_space") == "bt2020nc"
        and normalize_color_value(ev.color_transfer, "color_transfer") == "smpte2084"
        and normalize_color_value(ev.color_primaries, "color_primaries") == "bt2020"
        and normalize_probe_value(ev.color_range) == "tv"
        and normalize_probe_value(ev.pix_fmt) in ALLOWED_GENERIC_HLG_PIX_FMTS
        and ev.has_mdcv
        and ev.has_clli
    )


def source_profile_matches(ev: InspectionEvidence, profile_id: str) -> bool:
    if profile_id == PROFILE_ID_GENERIC:
        return is_generic_hlg_evidence(ev)
    if profile_id == PROFILE_ID_PQ:
        return is_pq_evidence(ev)
    return False


__all__ = [
    "EvidenceError",
    "extract_evidence",
    "is_generic_hlg_evidence",
    "is_pq_evidence",
    "normalize_probe_value",
    "normalized_duration",
    "select_primary_video_stream",
    "selected_video_frames",
    "side_data_list",
    "source_profile_matches",
]
