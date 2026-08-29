import unittest
from prototype.contracts import InspectionEvidence, KNOWN_SAMPLES, EXPECTED_HLG
from prototype.classifier import classify
from prototype.contracts import Classification

# Known hashes
HASH1 = "46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593"
SIZE1 = 18423719
HASH2 = "2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a"
SIZE2 = 20313976

def make_hlg_evidence(sha=HASH1, size=SIZE1):
    return InspectionEvidence(
        sha256=sha,
        size=size,
        display_name="1.MOV",
        codec_name=EXPECTED_HLG["codec_name"],
        codec_tag=EXPECTED_HLG["codec_tag"],
        pix_fmt=EXPECTED_HLG["pix_fmt"],
        color_space=EXPECTED_HLG["color_space"],
        color_transfer=EXPECTED_HLG["color_transfer"],
        color_primaries=EXPECTED_HLG["color_primaries"],
        color_range=EXPECTED_HLG["color_range"],
        chroma_location="left",
        dv_profile=EXPECTED_HLG["dv_profile"],
        dv_level=4,
        dv_compat_id=EXPECTED_HLG["dv_compat_id"],
        rpu_present=EXPECTED_HLG["rpu_present"],
        el_present=False,
        bl_present=True,
        has_dovi=True,
        has_mdcv=False,
        has_clli=False,
        is_unspecified=False,
        is_contradictory=False,
        parse_ok=True,
    )

class TestClassifier(unittest.TestCase):
    def test_hlg_known_local_success_hash1(self):
        ev = make_hlg_evidence(HASH1, SIZE1)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgKnownLocal)
        self.assertTrue(res.can_convert)
        self.assertEqual(res.profile_id, "hlg-local-b-v1")
        self.assertEqual(res.reason, "allowlist_hlg_match")

    def test_hlg_known_local_success_hash2(self):
        ev = make_hlg_evidence(HASH2, SIZE2)
        ev.display_name = "2.MOV"
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgKnownLocal)
        self.assertTrue(res.can_convert)

    def test_hash_mismatch_fails_closed(self):
        ev = make_hlg_evidence("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SIZE1)
        res = classify(ev)
        self.assertNotEqual(res.classification, Classification.hlgKnownLocal)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)  # has_dovi true -> dolby
        # but if not dovi, would be uncertain; significant is not hlgKnownLocal

    def test_size_mismatch_fails_closed(self):
        ev = make_hlg_evidence(HASH1, SIZE1+1)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.reason, "allowlist_size_mismatch")

    def test_hlg_evidence_mismatch_fails_closed(self):
        ev = make_hlg_evidence(HASH1, SIZE1)
        ev.color_transfer = "smpte2084"  # PQ instead
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.reason, "allowlist_evidence_mismatch")

    def test_pq_detected(self):
        # Positive static HDR10 now is pqSupported (narrow gate)
        ev = InspectionEvidence(
            sha256="b" * 64,
            size=1000,
            display_name="pq.mov",
            color_transfer="smpte2084",
            color_space="bt2020nc",
            color_primaries="bt2020",
            color_range="tv",
            pix_fmt="yuv420p10le",
            codec_name="hevc",
            codec_tag="hvc1",
            has_dovi=False,
            has_mdcv=True,
            has_clli=True,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)
        self.assertTrue(res.can_convert)
        self.assertEqual(res.profile_id, "pq-rec709-v1")

    def test_pq_missing_mdcv_remains_unsupported(self):
        ev = InspectionEvidence(
            sha256="b" * 64,
            size=1000,
            display_name="pq.mov",
            color_transfer="smpte2084",
            color_space="bt2020nc",
            color_primaries="bt2020",
            color_range="tv",
            pix_fmt="yuv420p10le",
            has_dovi=False,
            has_mdcv=False,
            has_clli=True,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)

    def test_numeric_and_string_pq_transfer(self):
        for transfer in (16, "16"):
            with self.subTest(transfer=transfer):
                ev = InspectionEvidence(
                    sha256="b" * 64,
                    size=1000,
                    display_name="pq.mov",
                    color_transfer=transfer,
                    parse_ok=True,
                )
                res = classify(ev)
                self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
                self.assertFalse(res.can_convert)

    def test_dolby_not_allowlisted(self):
        ev = InspectionEvidence(
            sha256="c" * 64,
            size=1000,
            display_name="dv.mov",
            color_transfer="arib-std-b67",
            color_space="bt2020nc",
            color_primaries="bt2020",
            has_dovi=True,
            dv_profile=5,
            dv_compat_id=1,
            rpu_present=True,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)
        self.assertFalse(res.can_convert)

    def test_unspecified_fails_uncertain(self):
        ev = InspectionEvidence(
            sha256="d" * 64,
            size=1000,
            display_name="unknown.mov",
            color_transfer="unknown",
            color_space="unknown",
            color_primaries="bt2020",
            is_unspecified=True,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)

    def test_contradictory_fails_uncertain(self):
        ev = InspectionEvidence(
            sha256="e" * 64,
            size=1000,
            display_name="contr.mov",
            is_contradictory=True,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)

    def test_parse_failed_uncertain(self):
        ev = InspectionEvidence(sha256="f"*64, size=1000, display_name="bad.mov", parse_ok=False, parse_error="json_parse_failed")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)

    def test_pure_function_no_io(self):
        ev = make_hlg_evidence()
        r1 = classify(ev)
        r2 = classify(ev)
        self.assertEqual(r1.classification, r2.classification)
        self.assertEqual(r1.can_convert, r2.can_convert)

    def test_unknown_evidence_uncertain(self):
        ev = InspectionEvidence(sha256="a"*64, size=1000, display_name="random.mov", parse_ok=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)
