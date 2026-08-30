import unittest
import json
import sys
import subprocess
import tempfile
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CLI = REPO_ROOT / "prototype" / "inspect_cli.py"

def run_cli(payload_bytes):
    return subprocess.run(
        [sys.executable, str(CLI)],
        input=payload_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
        cwd=str(REPO_ROOT),
    )

class TestInspectCli(unittest.TestCase):
    def test_valid_known_sample_produces_complete(self):
        if os.environ.get("HDRTOSDR_RUN_LIVE_SAMPLES") != "1":
            self.skipTest("live Sample media validation is opt-in; normal checks use owned fakes")
        sample = REPO_ROOT / "Sample" / "1.MOV"
        if not sample.exists():
            self.skipTest("Sample/1.MOV absent")
        payload = json.dumps({"version":1,"path": str(sample.resolve())}).encode()
        res = run_cli(payload)
        self.assertEqual(res.returncode, 0)
        out = res.stdout.decode("utf-8", errors="ignore")
        data = json.loads(out)
        self.assertEqual(data.get("outcome"), "complete")
        r = data.get("result", {})
        self.assertEqual(r.get("classification"), "hlgKnownLocal")
        self.assertEqual(r.get("profileId"), "hlg-local-b-v1")
        self.assertTrue(r.get("canConvert"))
        # privacy: no raw path leaked
        self.assertNotIn(str(sample.resolve()), out)
        self.assertNotIn("Traceback", out)
        # ensure no stderr path leak
        err = res.stderr.decode("utf-8", errors="ignore")
        self.assertNotIn(str(sample.resolve()), err)
        self.assertNotIn("Traceback", err)

    def test_malformed_json_fails_generically(self):
        res = run_cli(b"not json")
        out = res.stdout.decode("utf-8", errors="ignore")
        self.assertIn('"outcome":"error"', out)
        data = json.loads(out)
        self.assertEqual(data.get("outcome"), "error")
        self.assertIsInstance(data.get("reason"), str)
        # no traceback / path
        self.assertNotIn("Traceback", out)
        self.assertNotIn("not json", out)

    def test_outside_root_fails_generically(self):
        with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as f:
            f.write(b"fake")
            tmp = f.name
        try:
            payload = json.dumps({"version":1,"path": tmp}).encode()
            res = run_cli(payload)
            out = res.stdout.decode("utf-8", errors="ignore")
            data = json.loads(out)
            self.assertEqual(data.get("outcome"), "error")
            self.assertIsInstance(data.get("reason"), str)
            # must not include submitted path
            self.assertNotIn(tmp, out)
            self.assertNotIn("Traceback", out)
            self.assertNotIn("Traceback", res.stderr.decode("utf-8", errors="ignore"))
        finally:
            os.unlink(tmp)

    def test_invalid_version_fails_generically(self):
        payload = json.dumps({"version":2,"path": "/tmp/x.mov"}).encode()
        res = run_cli(payload)
        data = json.loads(res.stdout.decode())
        self.assertEqual(data["outcome"], "error")

    def test_boolean_version_is_not_integer_version(self):
        payload = json.dumps({"version": True, "path": "/nonexistent/secret.mov"}).encode()
        res = run_cli(payload)
        data = json.loads(res.stdout.decode())
        self.assertEqual(data["outcome"], "error")
        self.assertEqual(data["reason"], "invalid_request")

    def test_output_does_not_include_path_or_traceback(self):
        # Use sample path with spaces/unicode to ensure not leaked on error path? Use outside path
        payload = json.dumps({"version":1,"path": "/nonexistent/secret.mov"}).encode()
        res = run_cli(payload)
        out = res.stdout.decode()
        self.assertNotIn("/nonexistent", out)
        self.assertNotIn("Traceback", out)
        self.assertNotIn("File \"", out)

    def test_no_output_file_created(self):
        if os.environ.get("HDRTOSDR_RUN_LIVE_SAMPLES") != "1":
            self.skipTest("live Sample media validation is opt-in; normal checks use owned fakes")
        # Run valid inspect and ensure Output not changed
        output_dir = REPO_ROOT / "Output"
        before = set()
        if output_dir.exists():
            for p in output_dir.rglob("*"):
                if p.is_file():
                    before.add(str(p))
        sample = REPO_ROOT / "Sample" / "1.MOV"
        if not sample.exists():
            self.skipTest("Sample absent")
        payload = json.dumps({"version":1,"path": str(sample.resolve())}).encode()
        run_cli(payload)
        after = set()
        if output_dir.exists():
            for p in output_dir.rglob("*"):
                if p.is_file():
                    after.add(str(p))
        self.assertEqual(before, after)

    def test_oversize_request_rejected(self):
        big_path = "a" * 9000
        payload = json.dumps({"version":1,"path": big_path}).encode()
        res = run_cli(payload)
        data = json.loads(res.stdout.decode())
        self.assertEqual(data["outcome"], "error")
        self.assertNotIn(big_path, res.stdout.decode())
