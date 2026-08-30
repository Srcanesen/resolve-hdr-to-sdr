from .contracts import (
    Classification,
    ClassificationResult,
    InspectionEvidence,
    KNOWN_SAMPLES,
    EXPECTED_HLG,
    PROFILE_ID_LOCAL_B,
    PROFILE_ID_GENERIC,
    PROFILE_ID_PQ,
    ALLOWED_GENERIC_HLG_PIX_FMTS,
)
from .evidence import is_generic_hlg_evidence, is_pq_evidence


def _is_pq_transfer(ev: InspectionEvidence) -> bool:
    if ev.color_transfer is None:
        return False
    try:
        # ffprobe normally emits strings, but callers/parsers may preserve a numeric enum.
        t = (ev.color_transfer if isinstance(ev.color_transfer, str) else str(ev.color_transfer)).strip().lower()
    except Exception:
        return False
    # ffprobe values: smpte2084, arib-std-b67, bt709, etc. Also numeric alias? Check "smpte2084" includes "2084"
    # PQ is 16 / smpte2084
    if t in ("smpte2084", "smpte2084(pq)", "pq"):
        return True
    if "2084" in t or "pq" == t:
        return True
    # numeric string "16" could appear if mapping integer
    if t == "16":
        return True
    return False


def _expected_hlg_match(ev: InspectionEvidence) -> bool:
    # Check all expected HLG evidence fields match exactly
    if ev.color_space != EXPECTED_HLG["color_space"]:
        return False
    if ev.color_transfer != EXPECTED_HLG["color_transfer"]:
        return False
    if ev.color_primaries != EXPECTED_HLG["color_primaries"]:
        return False
    if ev.color_range != EXPECTED_HLG["color_range"]:
        return False
    if ev.pix_fmt != EXPECTED_HLG["pix_fmt"]:
        return False
    if ev.codec_tag != EXPECTED_HLG["codec_tag"]:
        return False
    if ev.codec_name != EXPECTED_HLG["codec_name"]:
        return False
    if ev.dv_profile != EXPECTED_HLG["dv_profile"]:
        return False
    if ev.dv_compat_id != EXPECTED_HLG["dv_compat_id"]:
        return False
    if ev.rpu_present != EXPECTED_HLG["rpu_present"]:
        return False
    # The HEVC level is part of the trusted local-sample contract; presence alone is insufficient.
    if ev.level != EXPECTED_HLG["level"]:
        return False
    # must have DOVI
    if not ev.has_dovi:
        return False
    # no mdcv/clli for these samples
    if ev.has_mdcv or ev.has_clli:
        return False
    # check unspecified/contradictory flags must be false
    if ev.is_unspecified or ev.is_contradictory:
        return False
    return True


def _is_generic_hlg_supported(ev: InspectionEvidence) -> bool:
    # The evidence helper is shared with the verifier, including selected-frame
    # DOVI/HDR10+ rejection and canonical color aliases.
    return is_generic_hlg_evidence(ev)


def _is_pq_supported(ev: InspectionEvidence) -> bool:
    # The evidence helper is shared with the verifier, including selected-frame
    # DOVI/HDR10+ rejection and both static HDR10 metadata requirements.
    return is_pq_evidence(ev)


def classify(ev: InspectionEvidence) -> ClassificationResult:
    """
    Pure classifier: given normalized evidence, return closed ClassificationResult.
    No I/O, no path access.
    """
    # Malformed evidence -> uncertain fail-closed
    if not ev.parse_ok:
        return ClassificationResult(
            classification=Classification.uncertain,
            reason="parse_failed",
            can_convert=False,
            evidence=ev,
        )

    # Check hash/size allowlist + HLG evidence for hlgKnownLocal
    # Must be exact match on both hash and size and expected HLG state
    allow = KNOWN_SAMPLES.get(ev.sha256)
    if allow is not None:
        # size must match allowlist
        expected_size = allow["size"]
        if ev.size == expected_size and _expected_hlg_match(ev):
            return ClassificationResult(
                classification=Classification.hlgKnownLocal,
                reason="allowlist_hlg_match",
                can_convert=True,
                profile_id=PROFILE_ID_LOCAL_B,
                evidence=ev,
            )
        else:
            # hash matches but size or evidence mismatch -> uncertain (fail closed, not supported)
            # Could be considered uncertain because allowlist entry exists but evidence contradictory
            # Return uncertain with specific reason
            if ev.size != expected_size:
                return ClassificationResult(
                    classification=Classification.uncertain,
                    reason="allowlist_size_mismatch",
                    can_convert=False,
                    evidence=ev,
                )
            else:
                return ClassificationResult(
                    classification=Classification.uncertain,
                    reason="allowlist_evidence_mismatch",
                    can_convert=False,
                    evidence=ev,
                )

    # Conflicting metadata is distinct from merely unsupported Dolby metadata and must fail closed.
    if ev.is_contradictory:
        return ClassificationResult(
            classification=Classification.uncertain,
            reason="contradictory_metadata",
            can_convert=False,
            evidence=ev,
        )

    # Dolby Vision precedence over PQ (fail-closed)
    if ev.has_dovi:
        return ClassificationResult(
            classification=Classification.dolbyVisionUnsupported,
            reason="dovi_not_allowlisted",
            can_convert=False,
            evidence=ev,
        )

    # HDR10+ dynamic metadata must remain unsupported/fail-closed (separately from Dolby)
    if ev.has_hdr10plus:
        # Even if PQ transfer detected, HDR10+ dynamic is not supported in v1
        if _is_pq_transfer(ev):
            return ClassificationResult(
                classification=Classification.pqHdr10Unsupported,
                reason="hdr10plus_detected",
                can_convert=False,
                evidence=ev,
            )
        # Non-PQ HDR10+ also fail-closed (generic)
        return ClassificationResult(
            classification=Classification.pqHdr10Unsupported,
            reason="hdr10plus_detected",
            can_convert=False,
            evidence=ev,
        )

    # PQ narrow gate – only positively confirmed static HDR10 is pqSupported
    if _is_pq_transfer(ev):
        # Contradictory semantic metadata is uncertain (fail-closed)
        if ev.is_contradictory:
            return ClassificationResult(
                classification=Classification.uncertain,
                reason="contradictory_metadata",
                can_convert=False,
                evidence=ev,
            )
        if ev.is_unspecified:
            return ClassificationResult(
                classification=Classification.pqHdr10Unsupported,
                reason="unspecified_metadata",
                can_convert=False,
                evidence=ev,
            )
        if _is_pq_supported(ev):
            return ClassificationResult(
                classification=Classification.pqSupported,
                reason="pq_metadata_match",
                can_convert=True,
                profile_id=PROFILE_ID_PQ,
                evidence=ev,
            )
        # Distinguish specific fail-closed reasons for PQ
        # Missing pixel format or not in allowlist
        if ev.pix_fmt is None or str(ev.pix_fmt).strip().lower() not in ALLOWED_GENERIC_HLG_PIX_FMTS:
            return ClassificationResult(
                classification=Classification.pqHdr10Unsupported,
                reason="missing_10bit_pix_fmt",
                can_convert=False,
                evidence=ev,
            )
        # Wrong triplet or range
        cs_norm = str(ev.color_space).strip().lower() if ev.color_space is not None else ""
        cp_norm = str(ev.color_primaries).strip().lower() if ev.color_primaries is not None else ""
        cr_norm = str(ev.color_range).strip().lower() if ev.color_range is not None else ""
        if cs_norm not in ("bt2020nc", "9") or cp_norm not in ("bt2020", "9") or cr_norm != "tv":
            # Semantic contradict if transfer is PQ but primaries/space not bt2020
            if cs_norm and cs_norm not in ("bt2020nc", "9") or cp_norm and cp_norm not in ("bt2020", "9"):
                return ClassificationResult(
                    classification=Classification.uncertain,
                    reason="contradictory_metadata",
                    can_convert=False,
                    evidence=ev,
                )
            return ClassificationResult(
                classification=Classification.pqHdr10Unsupported,
                reason="pq_missing_metadata",
                can_convert=False,
                evidence=ev,
            )
        if not ev.has_mdcv or not ev.has_clli:
            return ClassificationResult(
                classification=Classification.pqHdr10Unsupported,
                reason="pq_missing_mdcv_or_clli",
                can_convert=False,
                evidence=ev,
            )
        # Generic PQ fallback
        return ClassificationResult(
            classification=Classification.pqHdr10Unsupported,
            reason="pq_transfer_detected",
            can_convert=False,
            evidence=ev,
        )

    # Also detect unspecified/contradictory => uncertain (fail-closed before generic)
    if ev.is_unspecified:
        return ClassificationResult(
            classification=Classification.uncertain,
            reason="unspecified_metadata",
            can_convert=False,
            evidence=ev,
        )
    if ev.is_contradictory:
        return ClassificationResult(
            classification=Classification.uncertain,
            reason="contradictory_metadata",
            can_convert=False,
            evidence=ev,
        )

    # Generic metadata-confirmed non-DOVI HLG (positive only, no SHA/codec/container required)
    if _is_generic_hlg_supported(ev):
        return ClassificationResult(
            classification=Classification.hlgSupported,
            reason="hlg_metadata_match",
            can_convert=True,
            profile_id=PROFILE_ID_GENERIC,
            evidence=ev,
        )

    # Missing or unknown -> uncertain
    # If no evidence at all or unknown transfer
    return ClassificationResult(
        classification=Classification.uncertain,
        reason="unknown_or_missing_evidence",
        can_convert=False,
        evidence=ev,
    )
