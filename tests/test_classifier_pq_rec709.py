import unittest
import json
from prototype.contracts import InspectionEvidence, Classification, PROFILE_ID_PQ, ALLOWED_GENERIC_HLG_PIX_FMTS
from prototype.classifier import classify
from prototype.inspector import _parse_ffprobe_json

def mk(pix="yuv420p10le", cs="bt2020nc", tr="smpte2084", prim="bt2020", rng="tv", mdcv=True, clli=True, dovi=False, hdr10plus=False, uns=False, contra=False, parse_ok=True):
    return InspectionEvidence(sha256="f"*64, size=12345, display_name="pq.mov",
        codec_name="hevc", codec_tag="hvc1", pix_fmt=pix, color_space=cs, color_transfer=tr, color_primaries=prim, color_range=rng,
        has_dovi=dovi, has_hdr10plus=hdr10plus, has_mdcv=mdcv, has_clli=clli, is_unspecified=uns, is_contradictory=contra, parse_ok=parse_ok)

class TestPqRec709(unittest.TestCase):
    def test_positive_pq_supported(self):
        ev = mk()
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)
        self.assertTrue(res.can_convert)
        self.assertEqual(res.profile_id, PROFILE_ID_PQ)
        self.assertEqual(res.reason, "pq_metadata_match")

    def test_missing_mdcv(self):
        ev = mk(mdcv=False)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.reason, "pq_missing_mdcv_or_clli")

    def test_missing_clli(self):
        ev = mk(clli=False)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)

    def test_missing_both(self):
        ev = mk(mdcv=False, clli=False)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)

    def test_8bit_rejected(self):
        ev = mk(pix="yuv420p")
        res = classify(ev)
        self.assertNotEqual(res.classification, Classification.pqSupported)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)

    def test_wrong_color_space(self):
        ev = mk(cs="bt709")
        res = classify(ev)
        self.assertNotEqual(res.classification, Classification.pqSupported)
        # contradictory -> uncertain per narrow gate
        self.assertEqual(res.classification, Classification.uncertain)

    def test_wrong_color_primaries(self):
        ev = mk(prim="bt709")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)

    def test_wrong_range(self):
        ev = mk(rng="pc")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)

    def test_wrong_transfer_hlg_not_pq(self):
        ev = mk(tr="arib-std-b67")
        res = classify(ev)
        self.assertNotEqual(res.classification, Classification.pqSupported)
        # HLG with correct other fields would be hlgSupported, but has_mdcv/clli true would block HLG? Actually HLG with mdcv true would be not HLG; it would be uncertain or dolby etc.
        # For this case, HLG transfer but pqRequired mdcv true => not pq, will fall through to generic HLG check which fails due to mdcv? But still not pqSupported is sufficient.
        self.assertNotEqual(res.classification, Classification.pqSupported)

    def test_numeric_string_transfer_16(self):
        for tr in ("16", 16):
            with self.subTest(tr=tr):
                ev = mk(tr=tr)
                res = classify(ev)
                self.assertEqual(res.classification, Classification.pqSupported)

    def test_dovi_priority(self):
        ev = mk(dovi=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)
        self.assertFalse(res.can_convert)

    def test_hdr10plus_reject(self):
        ev = mk(hdr10plus=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)
        self.assertEqual(res.reason, "hdr10plus_detected")

    def test_hdr10plus_non_pq_also_reject(self):
        ev = InspectionEvidence(sha256="a"*64, size=1000, display_name="hdrplus.mov", color_transfer="bt709", color_space="bt709", color_primaries="bt709", color_range="tv", pix_fmt="yuv420p8le", has_hdr10plus=True, parse_ok=True)
        res = classify(ev)
        # Should be fail-closed, not pqSupported
        self.assertNotEqual(res.classification, Classification.pqSupported)
        self.assertFalse(res.can_convert)

    def test_unspecified_fails(self):
        ev = mk(uns=True)
        res = classify(ev)
        # For PQ, unspecified is pqHdr10Unsupported per narrow gate
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
        self.assertFalse(res.can_convert)

    def test_contradictory_fails_uncertain(self):
        ev = mk(contra=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)
        self.assertFalse(res.can_convert)

    def test_parse_failed_uncertain(self):
        ev = mk(parse_ok=False)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.uncertain)

    def test_p12_allowed(self):
        ev = mk(pix="yuv420p12le")
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)

    def test_all_allowlist_pix_fmts_pass(self):
        for pix in ALLOWED_GENERIC_HLG_PIX_FMTS:
            ev = mk(pix=pix)
            res = classify(ev)
            self.assertEqual(res.classification, Classification.pqSupported, msg=pix)

    def test_no_sha_codec_gate(self):
        ev = mk()
        ev.sha256 = "deadbeef"*8
        ev.codec_name = "avc"
        ev.codec_tag = "avc1"
        ev.display_name = "random.mp4"
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)

    def test_hlg_still_supported(self):
        # Ensure HLG still works and is not misclassified as PQ
        ev = InspectionEvidence(sha256="a"*64, size=1000, display_name="hlg.mov", color_space="bt2020nc", color_transfer="arib-std-b67", color_primaries="bt2020", color_range="tv", pix_fmt="yuv420p10le", has_dovi=False, has_mdcv=False, has_clli=False, parse_ok=True)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.hlgSupported)

    # Parser first-frame side data tests
    def test_parser_detects_mdcv_clli_from_stream(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "codec_name": "hevc",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ],
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "pq.mov", 100, "a"*64)
        self.assertTrue(ev.has_mdcv)
        self.assertTrue(ev.has_clli)
        self.assertFalse(ev.has_hdr10plus)
        self.assertFalse(ev.has_dovi)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)

    def test_parser_detects_mdcv_clli_from_first_frame_only(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [],
            }],
            "frames": [{
                "side_data_list": [
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ]
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "pq_frame.mov", 100, "b"*64)
        self.assertTrue(ev.has_mdcv)
        self.assertTrue(ev.has_clli)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqSupported)

    def test_parser_first_frame_mdcv_clli_absent_stream_present_frame(self):
        # Also test side_data key variant (ffprobe may use side_data instead of side_data_list for frames)
        payload = {
            "streams": [{
                "codec_type": "video",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [],
            }],
            "frames": [{
                "side_data": [
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ]
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "pq_frame2.mov", 100, "c"*64)
        self.assertTrue(ev.has_mdcv)
        self.assertTrue(ev.has_clli)

    def test_parser_hdr10plus_separate_from_dovi(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [
                    {"side_data_type": "HDR10+ Metadata"},
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ],
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "hdrplus.mov", 100, "d"*64)
        self.assertTrue(ev.has_hdr10plus)
        self.assertFalse(ev.has_dovi)
        self.assertTrue(ev.has_mdcv)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)

    def test_parser_dovi_vs_hdr10plus_in_frames(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [],
            }],
            "frames": [{
                "side_data_list": [
                    {"side_data_type": "DOVI configuration record", "dv_profile": 5},
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ]
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "dovi_frame.mov", 100, "e"*64)
        self.assertTrue(ev.has_dovi)
        self.assertFalse(ev.has_hdr10plus)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.dolbyVisionUnsupported)

    def test_parser_hdr10plus_st2094_in_frame(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "smpte2084",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [],
            }],
            "frames": [{
                "side_data_list": [
                    {"side_data_type": "HDMV ST2094-40 metadata"},
                    {"side_data_type": "Mastering display metadata"},
                    {"side_data_type": "Content light level metadata"},
                ]
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "st2094.mov", 100, "f"*64)
        self.assertTrue(ev.has_hdr10plus)
        res = classify(ev)
        self.assertEqual(res.classification, Classification.pqHdr10Unsupported)
