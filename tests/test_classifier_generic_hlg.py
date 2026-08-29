import unittest
from prototype.contracts import InspectionEvidence, Classification, PROFILE_ID_GENERIC, PROFILE_ID_LOCAL_B, ALLOWED_GENERIC_HLG_PIX_FMTS
from prototype.classifier import classify

def make_generic_hlg(
    pix_fmt="yuv420p10le",
    color_space="bt2020nc",
    color_transfer="arib-std-b67",
    color_primaries="bt2020",
    color_range="tv",
    has_dovi=False,
    is_unspecified=False,
    is_contradictory=False,
    parse_ok=True,
    sha="a"*64,
    size=12345,
):
    return InspectionEvidence(
        sha256=sha,
        size=size,
        display_name="generic.mov",
        codec_name="hevc",
        codec_tag="hvc1",
        pix_fmt=pix_fmt,
        color_space=color_space,
        color_transfer=color_transfer,
        color_primaries=color_primaries,
        color_range=color_range,
        has_dovi=has_dovi,
        dv_profile=None,
        rpu_present=None,
        is_unspecified=is_unspecified,
        is_contradictory=is_contradictory,
        parse_ok=parse_ok,
    )

class TestGenericHLG(unittest.TestCase):
    def test_generic_positive_yuv420p10le(self):
        ev = make_generic_hlg(pix_fmt="yuv420p10le")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)
        self.assertTrue(res.can_convert)
        self.assertEqual(res.profile_id, PROFILE_ID_GENERIC)
        self.assertEqual(res.reason, "hlg_metadata_match")

    def test_generic_positive_yuv422p10le(self):
        ev = make_generic_hlg(pix_fmt="yuv422p10le")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)
        self.assertEqual(res.profile_id, PROFILE_ID_GENERIC)

    def test_generic_positive_yuv444p10le(self):
        ev = make_generic_hlg(pix_fmt="yuv444p10le")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)

    def test_generic_positive_not_require_sha_codec_container(self):
        # Different sha, different codec, different basename should still be generic HLG
        ev = make_generic_hlg(sha="f"*64, size=999)
        ev.codec_name = "avc"
        ev.codec_tag = "avc1"
        ev.display_name = "random_name.mp4"
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)
        self.assertTrue(res.can_convert)

    def test_generic_rejected_8bit(self):
        ev = make_generic_hlg(pix_fmt="yuv420p")
        res = classify(ev)
        self.assertNotEqual(res.classification, Classification.hlgSupported)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)

    def test_generic_rejected_8bit_yuv422p(self):
        ev = make_generic_hlg(pix_fmt="yuv422p")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)

    def test_generic_rejected_missing_color_space(self):
        ev = make_generic_hlg(color_space=None)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)

    def test_generic_rejected_missing_pix_fmt(self):
        ev = make_generic_hlg(pix_fmt=None)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)

    def test_generic_rejected_range_not_tv(self):
        ev = make_generic_hlg(color_range="pc")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        ev2 = make_generic_hlg(color_range=None)
        self.assertEqual(classify(ev2).classification, Classification.uncertain)

    def test_generic_rejected_dovi(self):
        ev = make_generic_hlg(has_dovi=True, is_unspecified=False)
        ev.dv_profile = 8
        res = classify(ev)
        # Has DOVI should be dolbyVisionUnsupported, not hlgSupported, even if HLG metadata otherwise matches
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)
        self.assertFalse(res.can_convert)

    def test_generic_rejected_contradictory(self):
        ev = make_generic_hlg(is_contradictory=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertEqual(res.reason, "contradictory_metadata")

    def test_generic_rejected_unspecified(self):
        ev = make_generic_hlg(is_unspecified=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertEqual(res.reason, "unspecified_metadata")

    def test_generic_rejected_pq_transfer(self):
        ev = make_generic_hlg(color_transfer="smpte2084")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)

    def test_generic_rejected_wrong_triplet(self):
        ev = make_generic_hlg(color_space="bt709")
        self.assertEqual(classify(ev).classification, Classification.uncertain)
        ev2 = make_generic_hlg(color_primaries="bt709")
        self.assertEqual(classify(ev2).classification, Classification.uncertain)
        ev3 = make_generic_hlg(color_transfer="bt709")
        self.assertEqual(classify(ev3).classification, Classification.uncertain)

    def test_generic_rejected_malformed_parse_failed(self):
        ev = make_generic_hlg(parse_ok=False)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertEqual(res.reason, "parse_failed")

    def test_generic_does_not_require_codec(self):
        for pix in ALLOWED_GENERIC_HLG_PIX_FMTS:
            ev = make_generic_hlg(pix_fmt=pix)
            ev.codec_name = None
            ev.codec_tag = None
            res = classify(ev)
            self.assertEqual(res.classification, Classification.hlgSupported, msg=f"pix {pix} should be supported without codec")

    def test_generic_allowed_pix_fmts_all_pass(self):
        for pix in ["yuv420p10le", "yuv422p10le", "yuv444p10le"]:
            ev = make_generic_hlg(pix_fmt=pix)
            res = classify(ev)
            self.assertEqual(res.classification, Classification.hlgSupported, msg=pix)
        # 8-bit should not
        for pix in ["yuv420p8le", "yuv420p", "yuv422p8le"]:
            ev = make_generic_hlg(pix_fmt=pix)
            self.assertNotEqual(classify(ev).classification, Classification.hlgSupported, msg=pix)

    def test_known_local_still_hlgKnownLocal(self):
        from prototype.contracts import KNOWN_SAMPLES, EXPECTED_HLG
        sha1 = "46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593"
        ev = InspectionEvidence(
            sha256=sha1,
            size=18423719,
            display_name="1.MOV",
            codec_name=EXPECTED_HLG["codec_name"],
            codec_tag=EXPECTED_HLG["codec_tag"],
            pix_fmt=EXPECTED_HLG["pix_fmt"],
            color_space=EXPECTED_HLG["color_space"],
            color_transfer=EXPECTED_HLG["color_transfer"],
            color_primaries=EXPECTED_HLG["color_primaries"],
            color_range=EXPECTED_HLG["color_range"],
            level=EXPECTED_HLG["level"],
            dv_profile=EXPECTED_HLG["dv_profile"],
            dv_level=4,
            dv_compat_id=EXPECTED_HLG["dv_compat_id"],
            rpu_present=EXPECTED_HLG["rpu_present"],
            has_dovi=True,
            is_unspecified=False,
            is_contradictory=False,
            parse_ok=True,
        )
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgKnownLocal)
        self.assertEqual(res.profile_id, PROFILE_ID_LOCAL_B)

    def test_generic_with_p12(self):
        ev = make_generic_hlg(pix_fmt="yuv420p12le")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)

    def test_generic_rejected_has_dovi_true_even_if_other_match(self):
        ev = make_generic_hlg(has_dovi=True)
        ev.color_space = "bt2020nc"
        ev.color_transfer = "arib-std-b67"
        ev.color_primaries = "bt2020"
        ev.color_range = "tv"
        ev.pix_fmt = "yuv420p10le"
        res = classify(ev)
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)
