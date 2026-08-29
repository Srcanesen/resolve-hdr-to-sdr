import unittest
from unittest import mock
import subprocess
import json
import hashlib
import tempfile
from pathlib import Path

from prototype.inspector import inspect_local_path, inspect_user_selected_path, inspect_temp_file, get_ffprobe_executable, sha256_file, _parse_ffprobe_json
from prototype.classifier import classify
from prototype.contracts import Classification

REPO_ROOT = Path(__file__).resolve().parents[1]

class TestInspector(unittest.TestCase):
    def test_parser_marks_known_bt2020_conflict_and_classifier_rejects_generic_hlg(self):
        payload = {
            "streams": [{
                "codec_type": "video",
                "codec_name": "hevc",
                "codec_tag_string": "hvc1",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt709",
                "color_transfer": "arib-std-b67",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "side_data_list": [],
            }],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "contradictory.mov", 100, "a" * 64)
        self.assertTrue(ev.parse_ok)
        self.assertTrue(ev.is_contradictory)
        result = classify(ev)
        self.assertEqual(result.classification, Classification.uncertain)
        self.assertFalse(result.can_convert)

    def test_parser_keeps_missing_or_unknown_color_fields_as_uncertainty(self):
        for color_space in (None, "unknown"):
            with self.subTest(color_space=color_space):
                payload = {
                    "streams": [{
                        "codec_type": "video",
                        "pix_fmt": "yuv420p10le",
                        "color_space": color_space,
                        "color_transfer": "arib-std-b67",
                        "color_primaries": "bt2020",
                        "color_range": "tv",
                        "side_data_list": [],
                    }],
                    "format": {},
                }
                ev = _parse_ffprobe_json(json.dumps(payload).encode(), "uncertain.mov", 100, "b" * 64)
                self.assertTrue(ev.parse_ok)
                self.assertFalse(ev.is_contradictory)
                self.assertEqual(classify(ev).classification, Classification.uncertain)

    def test_ffprobe_executable_is_absolute(self):
        exe = get_ffprobe_executable(REPO_ROOT)
        self.assertTrue(exe.is_absolute())
        # must be tools/ffprobe resolved
        self.assertTrue(str(exe).endswith("ffprobe"))
        # ensure it's the repo-resolved absolute, not PATH fallback
        expected = (REPO_ROOT / "tools" / "ffprobe").resolve(strict=True)
        self.assertEqual(exe, expected)

    def test_inspector_uses_exact_executable(self):
        # Mock subprocess.run to capture argv
        fake_output = json.dumps({
            "streams": [{
                "codec_type": "video",
                "codec_name": "hevc",
                "codec_tag_string": "hvc1",
                "pix_fmt": "yuv420p10le",
                "color_space": "bt2020nc",
                "color_transfer": "arib-std-b67",
                "color_primaries": "bt2020",
                "color_range": "tv",
                "chroma_location": "left",
                "width": 1920,
                "height": 1080,
                "duration": "16.375",
                "r_frame_rate": "30/1",
                "avg_frame_rate": "30/1",
                "side_data_list": [{
                    "side_data_type": "DOVI configuration record",
                    "dv_profile": 8,
                    "dv_level": 4,
                    "rpu_present_flag": 1,
                    "el_present_flag": 0,
                    "bl_present_flag": 1,
                    "dv_bl_signal_compatibility_id": 4
                }]
            }],
            "format": {"duration": "16.375", "size": "18423719"}
        }).encode()

        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample/1.MOV absent")

        expected_exe = str(get_ffprobe_executable(REPO_ROOT))

        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout=fake_output, stderr=b"")
            ev, err = inspect_local_path(str(sample_path), REPO_ROOT)
            self.assertIsNotNone(ev)
            self.assertIsNone(err)
            # verify called with exact absolute executable, no shell
            args, kwargs = mock_run.call_args
            argv = args[0]
            self.assertEqual(argv[0], expected_exe)
            self.assertIn("-show_streams", argv)
            self.assertIn("-select_streams", argv)
            self.assertEqual(argv[argv.index("-select_streams") + 1], "v")
            self.assertIn("0%+1", argv)
            self.assertNotIn("%+#1", argv)
            self.assertIn(str(sample_path.resolve(strict=True)), argv)
            self.assertFalse(kwargs.get("shell", False))
            self.assertEqual(kwargs.get("shell"), False)

    def test_malformed_json_fails_closed(self):
        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample absent")
        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout=b"not json", stderr=b"")
            ev, err = inspect_local_path(str(sample_path), REPO_ROOT)
            self.assertIsNotNone(ev)
            self.assertFalse(ev.parse_ok)
            self.assertEqual(ev.parse_error, "json_parse_failed")

    def test_nonzero_ffprobe_fails_closed(self):
        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample absent")
        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=1, stdout=b"", stderr=b"error")
            ev, err = inspect_local_path(str(sample_path), REPO_ROOT)
            self.assertIsNone(ev)
            self.assertEqual(err, "ffprobe_nonzero")

    def test_empty_stdout_fails_closed(self):
        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample absent")
        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout=b"", stderr=b"")
            ev, err = inspect_local_path(str(sample_path), REPO_ROOT)
            self.assertIsNone(ev)
            self.assertEqual(err, "ffprobe_empty")

    def test_identity_changed_fails_closed(self):
        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample absent")
        fake_output = json.dumps({
            "streams": [{"codec_type":"video","codec_name":"hevc","codec_tag_string":"hvc1","pix_fmt":"yuv420p10le","color_space":"bt2020nc","color_transfer":"arib-std-b67","color_primaries":"bt2020","color_range":"tv","side_data_list":[]}],
            "format": {}
        }).encode()
        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout=fake_output, stderr=b"")
            import os
            real_stat = os.stat(sample_path.resolve(strict=True))
            # Need to handle multiple os.stat calls: validate (1), snapshot before (1), re-stat after (1)
            # We'll make snapshot before return real_stat, after return altered
            call_count = {"n": 0}
            orig_stat = os.stat
            def fake_stat(path, *a, **kw):
                # Only alter the last re-stat check; let earlier stats be real
                call_count["n"] += 1
                if call_count["n"] == 3:  # third os.stat call is the re-stat after probe
                    return mock.Mock(st_size=real_stat.st_size+1, st_ino=real_stat.st_ino, st_dev=real_stat.st_dev, st_mtime_ns=real_stat.st_mtime_ns)
                return orig_stat(path, *a, **kw)
            with mock.patch("prototype.inspector.os.stat", side_effect=fake_stat):
                # also mock sha to avoid actual hash mismatch interfering; first hash returns abc, second will differ if identity_changed via size already triggered
                with mock.patch("prototype.inspector.sha256_file", return_value="abc"):
                    ev, err = inspect_local_path(str(sample_path), REPO_ROOT)
                    self.assertIsNone(ev)
                    self.assertEqual(err, "identity_changed")

    def test_inspection_hashes_once_and_detects_mutation(self):
        with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as f:
            f.write(b"original")
            path = Path(f.name)
        try:
            fake_output = json.dumps({"streams": [{"codec_type": "video"}], "format": {}}).encode()
            hash_calls = []

            def mutate_during_hash(candidate):
                hash_calls.append(candidate)
                candidate.write_bytes(b"changed!")
                return "a" * 64

            with mock.patch("prototype.inspector.sha256_file", side_effect=mutate_during_hash):
                with mock.patch("prototype.inspector.subprocess.run") as mock_run:
                    mock_run.return_value = mock.Mock(returncode=0, stdout=fake_output, stderr=b"")
                    ev, err = inspect_user_selected_path(str(path), REPO_ROOT)
            self.assertEqual(len(hash_calls), 1)
            self.assertIsNone(ev)
            self.assertEqual(err, "identity_changed")
        finally:
            path.unlink(missing_ok=True)

    def test_upload_inspection_reuses_precomputed_hash(self):
        with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as f:
            f.write(b"upload")
            path = Path(f.name)
        try:
            fake_output = json.dumps({"streams": [{"codec_type": "video"}], "format": {}}).encode()
            with mock.patch("prototype.inspector.sha256_file") as mock_hash:
                with mock.patch("prototype.inspector.subprocess.run") as mock_run:
                    mock_run.return_value = mock.Mock(returncode=0, stdout=fake_output, stderr=b"")
                    ev, err = inspect_temp_file(path, "upload.mov", REPO_ROOT, precomputed_sha256="a" * 64)
            self.assertIsNone(err)
            self.assertIsNotNone(ev)
            mock_hash.assert_not_called()
        finally:
            path.unlink(missing_ok=True)

    def test_primary_real_video_ignores_audio_and_attached_picture_frames(self):
        payload = {
            "streams": [
                {"index": 0, "codec_type": "audio"},
                {"index": 1, "codec_type": "video", "disposition": {"attached_pic": 1}, "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 5}]},
                {"index": 2, "codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hvc1", "pix_fmt": "yuv420p10le", "color_space": "bt2020nc", "color_transfer": "arib-std-b67", "color_primaries": "bt2020", "color_range": "tv", "side_data_list": []},
            ],
            "frames": [
                {"stream_index": 1, "media_type": "video", "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 5}]},
                {"stream_index": 2, "media_type": "video", "side_data_list": [{"side_data_type": "Mastering display metadata"}]},
            ],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "multi.mov", 100, "a" * 64)
        self.assertTrue(ev.parse_ok)
        self.assertEqual(ev.codec_name, "hevc")
        self.assertFalse(ev.has_dovi)
        self.assertTrue(ev.has_mdcv)

    def test_frame_dovi_conflict_fails_closed(self):
        payload = {
            "streams": [{"index": 0, "codec_type": "video", "codec_name": "hevc", "codec_tag_string": "hvc1", "pix_fmt": "yuv420p10le", "color_space": "bt2020nc", "color_transfer": "arib-std-b67", "color_primaries": "bt2020", "color_range": "tv", "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 8, "dv_level": 4, "dv_bl_signal_compatibility_id": 4}]}],
            "frames": [{"stream_index": 0, "media_type": "video", "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 5}]}],
            "format": {},
        }
        ev = _parse_ffprobe_json(json.dumps(payload).encode(), "conflict.mov", 100, "b" * 64)
        self.assertTrue(ev.parse_ok)
        self.assertTrue(ev.is_contradictory)
        self.assertEqual(classify(ev).classification, Classification.uncertain)
        self.assertFalse(classify(ev).can_convert)

    def test_dovi_flags_are_strict_and_zero_is_false(self):
        base = {"codec_type": "video", "side_data_list": [{"side_data_type": "DOVI configuration record", "rpu_present_flag": "0", "el_present_flag": "1", "bl_present_flag": 0}]}
        ev = _parse_ffprobe_json(json.dumps({"streams": [base], "format": {}}).encode(), "flags.mov", 100, "c" * 64)
        self.assertTrue(ev.parse_ok)
        self.assertFalse(ev.rpu_present)
        self.assertTrue(ev.el_present)
        self.assertFalse(ev.bl_present)

        malformed = {"streams": [{"codec_type": "video", "side_data_list": [{"side_data_type": "DOVI configuration record", "rpu_present_flag": "false"}]}], "format": {}}
        bad = _parse_ffprobe_json(json.dumps(malformed).encode(), "bad-flags.mov", 100, "d" * 64)
        self.assertFalse(bad.parse_ok)

    def test_no_shell_fallback(self):
        # ensure inspector never uses shell=True
        sample_path = REPO_ROOT / "Sample" / "1.MOV"
        if not sample_path.exists():
            self.skipTest("Sample absent")
        with mock.patch("prototype.inspector.subprocess.run") as mock_run:
            # simulate failure to detect shell usage
            mock_run.return_value = mock.Mock(returncode=0, stdout=b'{"streams":[{"codec_type":"video"}],"format":{}}', stderr=b"")
            inspect_local_path(str(sample_path), REPO_ROOT)
            _, kwargs = mock_run.call_args
            self.assertIn("shell", kwargs)
            self.assertFalse(kwargs["shell"])
