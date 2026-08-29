import unittest

from electron.verify_contract import (
    scan_bounded_hdr_side_data,
    scan_semantic_privacy_tags,
    verify_media_contract,
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

    def test_hdr_scan_is_bounded_but_catches_later_frame_in_window(self):
        frames = [{} for _ in range(3)]
        frames[1] = {"side_data_list": [{"side_data_type": "Content light level metadata"}]}
        self.assertFalse(scan_bounded_hdr_side_data({"streams": [], "frames": frames}, 3)[0])
        outside_window = [{} for _ in range(5)]
        outside_window[4] = {"side_data_list": [{"side_data_type": "Mastering display metadata"}]}
        self.assertTrue(scan_bounded_hdr_side_data({"streams": [], "frames": outside_window}, 3)[0])

    def test_privacy_scan_ignores_unrelated_bytes_and_values(self):
        benign = {"format": {"tags": {"comment": "location date creation_time in a note"}},
                  "streams": [{"tags": {"handler_name": "Video encoder"}}]}
        self.assertTrue(scan_semantic_privacy_tags(benign)[0])
        forbidden = {"format": {"tags": {"com.apple.quicktime.location.ISO6709": "+1-2"}}}
        self.assertFalse(scan_semantic_privacy_tags(forbidden)[0])


if __name__ == "__main__":
    unittest.main()
