import unittest
from unittest import mock
import subprocess
import json
import hashlib
from pathlib import Path

from prototype.inspector import inspect_local_path, get_ffprobe_executable, sha256_file, _parse_ffprobe_json
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
