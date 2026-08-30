import unittest

from electron.verify_contract import (
    scan_bounded_hdr_side_data,
    scan_semantic_privacy_tags,
    verify_media_contract,
    verify_source_profile,
)


class TestVerifyContract(unittest.TestCase):
    def setUp(self):
        self.source = {
            "format": {"duration": "2.000"},
            "streams": [
                {"codec_type": "video", "width": 1920, "height": 1080,
                 "duration": "2.000", "nb_read_frames": "60",
                 "side_data_list": []},
                {"codec_type": "audio", "codec_name": "pcm_s16le",
                 "channels": 2, "sample_rate": "48000"},
            ],
        }
        self.output = {
            "format": {"duration": "2.001"},
            "streams": [
                {"codec_type": "video", "width": 1920, "height": 1080,
                 "duration": "2.001", "nb_read_frames": "60",
                 "side_data_list": []},
                {"codec_type": "audio", "codec_name": "aac",
                 "channels": 2, "sample_rate": "48000"},
            ],
        }

    def test_media_contract_rejects_dimensions_audio_and_missing_timing(self):
        ok, _ = verify_media_contract(self.source, self.output)
        self.assertTrue(ok)

        wrong_dimensions = {**self.output, "streams": [{**self.output["streams"][0], "width": 1280}, self.output["streams"][1]]}
        self.assertFalse(verify_media_contract(self.source, wrong_dimensions)[0])

        wrong_audio = {**self.output, "streams": [self.output["streams"][0]]}
        self.assertFalse(verify_media_contract(self.source, wrong_audio)[0])

        wrong_codec = {**self.output, "streams": [self.output["streams"][0], {**self.output["streams"][1], "codec_name": "opus"}]}
        self.assertFalse(verify_media_contract(self.source, wrong_codec)[0])

        missing_timing = {**self.output, "streams": [{**self.output["streams"][0], "nb_read_frames": "N/A"}, self.output["streams"][1]]}
        self.assertFalse(verify_media_contract(self.source, missing_timing)[0])

        for invalid_duration in ("0", "-1", "NaN", "Infinity"):
            invalid = {**self.output, "streams": [{**self.output["streams"][0], "duration": invalid_duration}, self.output["streams"][1]]}
            self.assertFalse(verify_media_contract(self.source, invalid)[0], invalid_duration)

    def test_hdr_scan_is_bounded_but_catches_later_frame_in_window(self):
        stream = {"index": 0, "codec_type": "video", "side_data_list": []}
        frames = [{"stream_index": 0} for _ in range(3)]
        frames[1]["side_data_list"] = [{"side_data_type": "Content light level metadata"}]
        self.assertFalse(scan_bounded_hdr_side_data({"streams": [stream], "frames": frames}, 3)[0])
        outside_window = [{"stream_index": 0} for _ in range(5)]
        outside_window[4]["side_data_list"] = [{"side_data_type": "Mastering display metadata"}]
        self.assertTrue(scan_bounded_hdr_side_data({"streams": [stream], "frames": outside_window}, 3)[0])

    def test_video_contract_uses_first_real_video_and_selected_frames_only(self):
        data = {
            "streams": [
                {"index": 0, "codec_type": "audio"},
                {"index": 1, "codec_type": "video", "disposition": {"attached_pic": 1},
                 "width": 1, "height": 1, "duration": "1", "nb_read_frames": "1",
                 "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
                {"index": 2, "codec_type": "video", "disposition": {"default": 0},
                 "width": 1920, "height": 1080, "duration": "2", "nb_read_frames": "60", "side_data_list": []},
                {"index": 3, "codec_type": "video", "disposition": {"default": 1},
                 "width": 1, "height": 1, "duration": "1", "nb_read_frames": "1",
                 "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
            ],
            "frames": [
                {"stream_index": 1, "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
                {"stream_index": 3, "side_data_list": [{"side_data_type": "Mastering display metadata"}]},
            ],
            "format": {"duration": "2"},
        }
        ok, message = scan_bounded_hdr_side_data(data, 2)
        self.assertTrue(ok, message)

    def test_source_profile_regate_rejects_selected_frame_dynamic_metadata(self):
        base = {
            "streams": [{"index": 0, "codec_type": "video", "pix_fmt": "yuv420p10le",
                          "color_space": "bt2020nc", "color_transfer": "arib-std-b67",
                          "color_primaries": "bt2020", "color_range": "tv", "side_data_list": []}],
            "format": {},
        }
        dovi = {**base, "frames": [{"stream_index": 0, "side_data_list": [{"side_data_type": "DOVI configuration record"}]}]}
        hdr10plus = {**base, "frames": [{"stream_index": 0, "side_data_list": [{"side_data_type": "HDR10+ Metadata"}]}]}
        self.assertFalse(verify_source_profile(dovi, "hlg-rec709-v1")[0])
        self.assertFalse(verify_source_profile(hdr10plus, "hlg-rec709-v1")[0])

        pq_base = {**base, "streams": [{**base["streams"][0], "color_transfer": "smpte2084",
                                         "side_data_list": [{"side_data_type": "Mastering display metadata"},
                                                             {"side_data_type": "Content light level metadata"}]}]}
        pq_dovi = {**pq_base, "frames": [{"stream_index": 0, "side_data_list": [{"side_data_type": "DOVI configuration record"}]}]}
        pq_hdr10plus = {**pq_base, "frames": [{"stream_index": 0, "side_data_list": [{"side_data_type": "SMPTE ST 2094-40"}]}]}
        self.assertFalse(verify_source_profile(pq_dovi, "pq-rec709-v1")[0])
        self.assertFalse(verify_source_profile(pq_hdr10plus, "pq-rec709-v1")[0])

    def test_source_profile_regate_ignores_attached_and_other_video_frames(self):
        data = {
            "streams": [
                {"index": 0, "codec_type": "audio"},
                {"index": 1, "codec_type": "video", "disposition": {"attached_pic": 1},
                 "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
                {"index": 2, "codec_type": "video", "disposition": {"default": 0},
                 "pix_fmt": "yuv420p10le", "color_space": "bt2020nc", "color_transfer": "arib-std-b67",
                 "color_primaries": "bt2020", "color_range": "tv", "side_data_list": []},
                {"index": 3, "codec_type": "video", "disposition": {"default": 1},
                 "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
            ],
            "frames": [{"stream_index": 1, "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
                       {"stream_index": 3, "side_data_list": [{"side_data_type": "HDR10+ Metadata"}]}],
            "format": {},
        }
        self.assertTrue(verify_source_profile(data, "hlg-rec709-v1")[0])

    def test_privacy_scan_ignores_unrelated_bytes_and_values(self):
        benign = {"format": {"tags": {"comment": "location date creation_time in a note"}},
                  "streams": [{"tags": {"handler_name": "Video encoder"}}]}
        self.assertTrue(scan_semantic_privacy_tags(benign)[0])
        forbidden = {"format": {"tags": {"com.apple.quicktime.location.ISO6709": "+1-2"}}}
        self.assertFalse(scan_semantic_privacy_tags(forbidden)[0])


if __name__ == "__main__":
    unittest.main()
