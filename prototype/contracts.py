from dataclasses import dataclass, asdict
from enum import Enum
from typing import Optional, List, Dict, Any


class Classification(str, Enum):
    hlgKnownLocal = "hlgKnownLocal"
    hlgSupported = "hlgSupported"
    pqSupported = "pqSupported"
    pqHdr10Unsupported = "pqHdr10Unsupported"
    dolbyVisionUnsupported = "dolbyVisionUnsupported"
    uncertain = "uncertain"


# Known allowlist – exact trusted local samples
KNOWN_SAMPLES: Dict[str, Dict[str, Any]] = {
    "46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593": {
        "size": 18423719,
        "basename": "1.MOV",
    },
    "2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a": {
        "size": 20313976,
        "basename": "2.MOV",
    },
}

# Expected HLG evidence for known samples
EXPECTED_HLG = {
    "color_space": "bt2020nc",
    "color_transfer": "arib-std-b67",
    "color_primaries": "bt2020",
    "color_range": "tv",
    "pix_fmt": "yuv420p10le",
    "codec_tag": "hvc1",
    "codec_name": "hevc",
    "dv_profile": 8,
    "dv_compat_id": 4,
    "rpu_present": True,
    "level": 120,
}

PROFILE_ID_LOCAL_B = "hlg-local-b-v1"
PROFILE_ID_GENERIC = "hlg-rec709-v1"
PROFILE_ID_PQ = "pq-rec709-v1"
# Backwards alias kept for existing imports
PROFILE_ID = PROFILE_ID_LOCAL_B
# Centralized allowed profile set
ALLOWED_PROFILE_IDS = {PROFILE_ID_LOCAL_B, PROFILE_ID_GENERIC, PROFILE_ID_PQ}
# Explicit >=10-bit YUV pixel formats accepted for generic HLG (small allowlist, fail-closed)
ALLOWED_GENERIC_HLG_PIX_FMTS = {
    "yuv420p10le",
    "yuv422p10le",
    "yuv444p10le",
    "yuv420p12le",
    "yuv422p12le",
    "yuv444p12le",
}


@dataclass
class InspectionEvidence:
    sha256: str
    size: int
    display_name: str  # sanitized basename for display only
    # normalized technical fields (permitted)
    codec_name: Optional[str] = None
    codec_tag: Optional[str] = None
    pix_fmt: Optional[str] = None
    color_space: Optional[str] = None
    color_transfer: Optional[str] = None
    color_primaries: Optional[str] = None
    color_range: Optional[str] = None
    chroma_location: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    duration: Optional[str] = None
    r_frame_rate: Optional[str] = None
    avg_frame_rate: Optional[str] = None
    # Codec level (ffprobe's integer level_idc, e.g. 120 for HEVC level 4.0)
    level: Optional[int] = None
    # Dolby
    dv_profile: Optional[int] = None
    dv_level: Optional[int] = None
    dv_compat_id: Optional[int] = None
    rpu_present: Optional[bool] = None
    el_present: Optional[bool] = None
    bl_present: Optional[bool] = None
    has_dovi: bool = False
    has_hdr10plus: bool = False
    has_mdcv: bool = False
    has_clli: bool = False
    # conflict flags
    is_unspecified: bool = False
    is_contradictory: bool = False
    # raw parse success
    parse_ok: bool = True
    parse_error: Optional[str] = None


@dataclass
class ClassificationResult:
    classification: Classification
    reason: str
    can_convert: bool
    profile_id: Optional[str] = None
    # echo evidence ref for response filtering
    evidence: Optional[InspectionEvidence] = None

    def to_response_dict(self) -> Dict[str, Any]:
        # Only permitted fields – no raw path, no stderr
        ev = self.evidence
        color: Dict[str, Any] = {}
        dovi: Dict[str, Any] = {}
        if ev:
            if ev.color_space is not None:
                color["colorSpace"] = ev.color_space
            if ev.color_transfer is not None:
                color["colorTransfer"] = ev.color_transfer
            if ev.color_primaries is not None:
                color["colorPrimaries"] = ev.color_primaries
            if ev.color_range is not None:
                color["colorRange"] = ev.color_range
            if ev.pix_fmt is not None:
                color["pixFmt"] = ev.pix_fmt
            if ev.codec_tag is not None:
                color["codecTag"] = ev.codec_tag
            if ev.codec_name is not None:
                color["codecName"] = ev.codec_name
            if ev.chroma_location is not None:
                color["chromaLocation"] = ev.chroma_location
            if ev.has_dovi:
                dovi["hasDovi"] = True
                if ev.dv_profile is not None:
                    dovi["dvProfile"] = ev.dv_profile
                if ev.dv_level is not None:
                    dovi["dvLevel"] = ev.dv_level
                if ev.dv_compat_id is not None:
                    dovi["dvCompatId"] = ev.dv_compat_id
                if ev.rpu_present is not None:
                    dovi["rpuPresent"] = ev.rpu_present
                if ev.el_present is not None:
                    dovi["elPresent"] = ev.el_present
                if ev.bl_present is not None:
                    dovi["blPresent"] = ev.bl_present
                dovi["hasMdcv"] = ev.has_mdcv
                dovi["hasClli"] = ev.has_clli
                if ev.has_hdr10plus:
                    dovi["hasHdr10Plus"] = True
            else:
                # still report absence flags if DOVI absent
                if ev.has_mdcv or ev.has_clli or ev.has_hdr10plus:
                    dovi["hasMdcv"] = ev.has_mdcv
                    dovi["hasClli"] = ev.has_clli
                    if ev.has_hdr10plus:
                        dovi["hasHdr10Plus"] = True
        resp: Dict[str, Any] = {}
        if ev:
            resp["displayName"] = ev.display_name
            resp["size"] = ev.size
            resp["sha256"] = ev.sha256
        if color:
            resp["color"] = color
        if dovi:
            resp["dovi"] = dovi
        if ev and ev.duration:
            resp["duration"] = ev.duration
        resp["classification"] = self.classification.value
        resp["reason"] = self.reason
        resp["canConvert"] = self.can_convert
        if self.profile_id:
            resp["profileId"] = self.profile_id
        return resp
