#!/usr/bin/env python3
"""Pure, bounded media-contract checks used by verify-spike.sh."""
import json
import math
import re
import sys
from pathlib import Path

# This verifier is also executed as a standalone script from electron/.
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from prototype.evidence import (  # noqa: E402
    EvidenceError,
    extract_evidence,
    selected_video_frames,
    select_primary_video_stream,
    side_data_list,
    source_profile_matches,
)


def _load(value, label):
    try:
        data = json.loads(value) if isinstance(value, (str, bytes, bytearray)) else value
    except Exception:
        return None, f"FAIL: malformed {label} probe"
    if not isinstance(data, dict) or not isinstance(data.get("streams"), list):
        return None, f"FAIL: invalid {label} probe"
    return data, None


def _number(value, label, field):
    if value is None or str(value).strip().upper() in {"", "N/A", "NA", "NONE"}:
        return None, f"FAIL: missing {field} for {label}"
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None, f"FAIL: invalid {field} for {label}"
    if not math.isfinite(number):
        return None, f"FAIL: invalid {field} for {label}"
    return number, None


def _video(data, label):
    try:
        _, video, _, _ = select_primary_video_stream(data["streams"])
    except EvidenceError:
        return None, f"FAIL: missing or invalid primary video stream for {label}"
    width, error = _number(video.get("width"), label, "video width")
    if error:
        return None, error
    height, error = _number(video.get("height"), label, "video height")
    if error:
        return None, error
    if width <= 0 or height <= 0 or width != int(width) or height != int(height):
        return None, f"FAIL: invalid video dimensions for {label}"
    frames, error = _number(video.get("nb_read_frames"), label, "video frame count")
    if error:
        return None, error
    if frames < 0 or frames != int(frames):
        return None, f"FAIL: invalid video frame count for {label}"
    duration_value = video.get("duration")
    if duration_value is None or str(duration_value).strip().upper() in {"", "N/A", "NA", "NONE"}:
        media_format = data.get("format")
        duration_value = media_format.get("duration") if isinstance(media_format, dict) else None
    duration, error = _number(duration_value, label, "video duration")
    if error:
        return None, error
    if duration <= 0:
        return None, f"FAIL: invalid video duration for {label}"

    # ffmpeg may autorotate a source with a display matrix. Compare presentation
    # dimensions rather than only the stored raster dimensions.
    rotation = 0.0
    for side_item in video.get("side_data_list", []) or []:
        if isinstance(side_item, dict) and str(side_item.get("side_data_type", "")).lower() == "display matrix":
            try:
                rotation = float(side_item.get("rotation", 0))
            except (TypeError, ValueError):
                rotation = 0.0
            break
    if int(abs(rotation)) % 180 == 90:
        width, height = height, width
    return (int(width), int(height), int(frames), duration), None


def _audio(data):
    return [stream for stream in data["streams"]
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"]


def verify_media_contract(source, output, tolerance=0.05):
    """Return (ok, diagnostic) for timing, dimensions, and the AAC audio policy."""
    source, error = _load(source, "source timing/media")
    if error:
        return False, error
    output, error = _load(output, "output timing/media")
    if error:
        return False, error
    source_video, error = _video(source, "source")
    if error:
        return False, error
    output_video, error = _video(output, "output")
    if error:
        return False, error
    source_width, source_height, source_frames, source_duration = source_video
    output_width, output_height, output_frames, output_duration = output_video
    if (source_width, source_height) != (output_width, output_height):
        return False, (f"FAIL: video dimensions changed source={source_width}x{source_height} "
                       f"output={output_width}x{output_height}")
    if source_frames != output_frames:
        return False, f"FAIL: video frame count changed source={source_frames} output={output_frames}"
    delta = abs(output_duration - source_duration)
    if delta > float(tolerance):
        return False, f"FAIL: video duration delta {delta:.6f}s exceeds {float(tolerance):.3f}s"

    # Every source audio stream is retained in order and re-encoded as AAC. No
    # source audio means no output audio. This matches -map 0:a? and -c:a aac.
    source_audio = _audio(source)
    output_audio = _audio(output)
    if len(source_audio) != len(output_audio):
        return False, (f"FAIL: audio stream count changed source={len(source_audio)} "
                       f"output={len(output_audio)}")
    for index, (source_stream, output_stream) in enumerate(zip(source_audio, output_audio)):
        if str(output_stream.get("codec_name", "")).lower() != "aac":
            return False, f"FAIL: output audio stream {index} is not AAC"
        for field in ("channels", "sample_rate"):
            source_value = source_stream.get(field)
            output_value = output_stream.get(field)
            if source_value not in (None, "", "N/A") and output_value not in (None, "", "N/A"):
                if str(source_value) != str(output_value):
                    return False, f"FAIL: audio stream {index} {field} changed"

    return True, (f"OK: timing source={source_duration:.6f}s output={output_duration:.6f}s "
                  f"delta={delta:.6f}s frames={source_frames} "
                  f"dimensions={source_width}x{source_height} "
                  f"audio_streams={len(source_audio)}")


def _side_data_kind(name):
    normalized = str(name).lower().replace("_", " ")
    compact = normalized.replace(" ", "")
    if "mastering display metadata" in normalized or "mastering display" in normalized or "mdcv" in normalized:
        return "MDCV"
    if "content light level metadata" in normalized or "content light" in normalized or "clli" in normalized:
        return "CLLI"
    if ("hdr10+" in compact or "hdr10plus" in compact or "st2094" in compact
            or "dynamic hdr plus" in normalized):
        return "HDR10+"
    if "dovi" in normalized or "dolby vision" in normalized:
        return "DOVI"
    if "hdr vivid" in normalized or "dynamic hdr vivid" in normalized:
        return "HDR Vivid"
    if "ambient viewing environment" in normalized or "ambient hdr" in normalized or "amve" in normalized:
        return "ambient HDR"
    return None


def scan_bounded_hdr_side_data(probe, limit=32):
    """Return (ok, diagnostic), scanning only the primary real video stream."""
    data, error = _load(probe, "bounded output HDR side-data")
    if error:
        return False, error
    try:
        _, video, stream_index, real_video_count = select_primary_video_stream(data["streams"])
        frames = selected_video_frames(data, stream_index, real_video_count)
        selected_frames = []
        for frame in frames:
            if len(selected_frames) >= int(limit):
                break
            selected_frames.append(frame)
        items = [video, *selected_frames]
        forbidden = []
        for item in items:
            for side_item in side_data_list(item):
                if not isinstance(side_item, dict):
                    return False, "FAIL: invalid bounded output side-data"
                kind = _side_data_kind(side_item.get("side_data_type", ""))
                if kind:
                    forbidden.append(f"{kind} ({side_item.get('side_data_type', '')})")
    except (EvidenceError, TypeError, ValueError):
        return False, "FAIL: invalid bounded output video evidence"
    if forbidden:
        return False, "FAIL: output contains forbidden HDR frame side data in bounded scan: " + ", ".join(forbidden)
    return True, f"OK: bounded output scan of up to {int(limit)} frames contains no forbidden HDR side data"


def verify_source_profile(probe, profile_id):
    """Re-gate a source using the exact normalized evidence used by inspection."""
    data, error = _load(probe, "source profile")
    if error:
        return False, error
    if profile_id not in {"hlg-rec709-v1", "pq-rec709-v1"}:
        return False, "FAIL: unsupported source profile"
    try:
        evidence = extract_evidence(data, "source", 0, "")
    except EvidenceError:
        return False, "FAIL: invalid source video evidence"
    if not source_profile_matches(evidence, profile_id):
        return False, f"FAIL: source evidence does not match {profile_id}"
    return True, f"OK: source evidence matches {profile_id}"


def scan_semantic_privacy_tags(probe):
    """Inspect only ffprobe format/stream tag maps, never compressed media bytes."""
    data, error = _load(probe, "output metadata")
    if error:
        return False, error
    media_format = data.get("format", {})
    if not isinstance(media_format, dict):
        return False, "FAIL: invalid output metadata probe"
    streams = data.get("streams", [])
    if any(not isinstance(stream, dict) for stream in streams):
        return False, "FAIL: invalid output metadata probe"

    def inspect_node(node):
        if isinstance(node, dict):
            if "tags" in node:
                tags = node["tags"]
                if not isinstance(tags, dict):
                    return False
                for key in tags:
                    key_text = str(key).lower()
                    normalized = re.sub(r"[^a-z0-9]+", "_", key_text).strip("_")
                    compact = normalized.replace("_", "")
                    if (key_text.startswith("com.apple.quicktime.")
                            or compact.startswith("iso6709")
                            or normalized in {"location", "location_eng", "creation_time", "creation_date", "date_created"}
                            or normalized.startswith("location_")
                            or normalized.startswith("creation_time_")
                            or normalized.startswith("creation_date_")):
                        return False
            return all(inspect_node(child) for child in node.values())
        if isinstance(node, list):
            return all(inspect_node(child) for child in node)
        return True

    if not inspect_node(data):
        return False, "FAIL: output contains forbidden semantic privacy metadata"
    return True, "OK: no forbidden semantic QuickTime, ISO6709, location, or creation-time tags"


def _read_nul_records():
    records = sys.stdin.buffer.read().split(b"\0")
    return [record for record in records if record]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    mode = argv.pop(0) if argv else ""
    if mode == "media" and len(argv) == 1:
        records = _read_nul_records()
        if len(records) != 2:
            print("FAIL: timing/media probe record count invalid", file=sys.stderr)
            return 1
        ok, message = verify_media_contract(records[0], records[1], float(argv[0]))
    elif mode == "hdr" and len(argv) == 1:
        ok, message = scan_bounded_hdr_side_data(sys.stdin.buffer.read(), int(argv[0]))
    elif mode == "source" and len(argv) == 1:
        ok, message = verify_source_profile(sys.stdin.buffer.read(), argv[0])
    elif mode == "privacy" and not argv:
        ok, message = scan_semantic_privacy_tags(sys.stdin.buffer.read())
    else:
        print("FAIL: verifier helper request invalid", file=sys.stderr)
        return 1
    print(message, file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
