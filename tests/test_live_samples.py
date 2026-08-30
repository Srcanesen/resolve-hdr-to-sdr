import os
import unittest
from pathlib import Path

from prototype.inspector import inspect_local_path, inspect_temp_file
from prototype.classifier import classify

REPO_ROOT = Path(__file__).resolve().parents[1]

class TestLiveSamples(unittest.TestCase):
    def _require_opt_in(self):
        if os.environ.get("HDRTOSDR_RUN_LIVE_SAMPLES") != "1":
            self.skipTest("live Sample media validation is opt-in; normal checks use owned fakes")

    def test_sample1_produces_hlgKnownLocal(self):
        self._require_opt_in()
        sample = REPO_ROOT / "Sample" / "1.MOV"
        if not sample.exists():
            self.skipTest("Sample/1.MOV absent")
        ev, err = inspect_local_path(str(sample.resolve()), REPO_ROOT)
        self.assertIsNotNone(ev, f"inspect failed: {err}")
        self.assertIsNone(err)
        res = classify(ev)
        self.assertEqual(res.classification.value, "hlgKnownLocal")
        self.assertEqual(res.profile_id, "hlg-local-b-v1")
        self.assertTrue(res.can_convert)
        self.assertEqual(ev.sha256, "46dad3fdcea157e3578b7f286485df978ec8d7e9b327b91cd5e87cd33aa88593")
        self.assertEqual(ev.size, 18423719)

    def test_sample2_produces_hlgKnownLocal(self):
        self._require_opt_in()
        sample = REPO_ROOT / "Sample" / "2.MOV"
        if not sample.exists():
            self.skipTest("Sample/2.MOV absent")
        ev, err = inspect_local_path(str(sample.resolve()), REPO_ROOT)
        self.assertIsNotNone(ev, f"inspect failed: {err}")
        self.assertIsNone(err)
        res = classify(ev)
        self.assertEqual(res.classification.value, "hlgKnownLocal")
        self.assertEqual(res.profile_id, "hlg-local-b-v1")
        self.assertTrue(res.can_convert)
        self.assertEqual(ev.sha256, "2780c7f568cb6ebaee20abbf6d2c3924ee083c96056603807a5057834ea4a82a")
        self.assertEqual(ev.size, 20313976)

    def test_live_samples_no_conversion_called(self):
        self._require_opt_in()
        # Ensure neither inspect nor classify triggers output creation
        output_dir = REPO_ROOT / "Output"
        before = set()
        if output_dir.exists():
            for p in output_dir.rglob("*"):
                if p.is_file():
                    before.add(str(p))
        for name in ["1.MOV", "2.MOV"]:
            sample = REPO_ROOT / "Sample" / name
            if not sample.exists():
                continue
            ev, err = inspect_local_path(str(sample.resolve()), REPO_ROOT)
            self.assertIsNotNone(ev)
            _ = classify(ev)
        after = set()
        if output_dir.exists():
            for p in output_dir.rglob("*"):
                if p.is_file():
                    after.add(str(p))
        self.assertEqual(before, after, "no Output should be created")

    def test_upload_live_samples_produce_hlgKnownLocal(self):
        self._require_opt_in()
        # Test via temp file upload path (same as server upload)
        import tempfile, os
        for name in ["1.MOV", "2.MOV"]:
            sample = REPO_ROOT / "Sample" / name
            if not sample.exists():
                self.skipTest(f"Sample/{name} absent")
            data = sample.read_bytes()
            # create private temp dir/file 0700/0600 like server does
            tmpdir = tempfile.mkdtemp()
            os.chmod(tmpdir, 0o700)
            tmpfile = Path(tmpdir) / "upload.mov"
            tmpfile.write_bytes(data)
            os.chmod(tmpfile, 0o600)
            try:
                ev, err = inspect_temp_file(tmpfile, name, REPO_ROOT)
                self.assertIsNotNone(ev, f"inspect_temp failed: {err}")
                res = classify(ev)
                self.assertEqual(res.classification.value, "hlgKnownLocal")
                self.assertTrue(res.can_convert)
            finally:
                try:
                    tmpfile.unlink()
                    Path(tmpdir).rmdir()
                except:
                    import shutil
                    shutil.rmtree(tmpdir, ignore_errors=True)
