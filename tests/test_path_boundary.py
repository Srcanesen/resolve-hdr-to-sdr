import os
import stat
import tempfile
import unittest
from pathlib import Path

from prototype.path_boundary import validate_local_path, validate_user_selected_path, PathValidationError

REPO_ROOT = Path(__file__).resolve().parents[1]
SAMPLE_ROOT = REPO_ROOT / "Sample"

class TestPathBoundary(unittest.TestCase):
    def setUp(self):
        # ensure Sample root exists
        SAMPLE_ROOT.mkdir(exist_ok=True)

    def test_valid_known_sample(self):
        # Sample/1.MOV exists
        p = SAMPLE_ROOT / "1.MOV"
        if not p.exists():
            self.skipTest("Sample/1.MOV absent")
        canonical = validate_local_path(str(p), REPO_ROOT)
        self.assertTrue(canonical.is_absolute())
        self.assertTrue(str(canonical).startswith(str(SAMPLE_ROOT.resolve())))

    def test_root_escape_rejected(self):
        # try /etc/passwd or outside Sample
        with self.assertRaises(PathValidationError) as cm:
            validate_local_path("/etc/passwd", REPO_ROOT)
        self.assertIn(cm.exception.reason, ("unsupported_extension", "root_escape", "not_found", "resolve_failed"))

        # create a file outside Sample and try with .mov extension
        with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as f:
            f.write(b"test")
            tmp = f.name
        try:
            with self.assertRaises(PathValidationError) as cm2:
                validate_local_path(tmp, REPO_ROOT)
            self.assertIn(cm2.exception.reason, ("root_escape", "symlink_rejected"))
        finally:
            os.unlink(tmp)

        # path traversal via .. 
        traversal = str(SAMPLE_ROOT / ".." / "Sample" / "1.MOV")
        # This resolves inside Sample, so should pass if file exists, but test escape:
        outside = str(SAMPLE_ROOT.resolve().parents[0] / "outside.mov")
        # ensure file exists outside
        Path(outside).write_bytes(b"hi")
        try:
            with self.assertRaises(PathValidationError):
                validate_local_path(outside, REPO_ROOT)
        finally:
            if Path(outside).exists():
                Path(outside).unlink()

        # explicit escape via ../etc
        escape_path = str(REPO_ROOT / "Sample" / ".." / ".." / "etc" / "passwd")
        # This path with .mov extension trick: use .mov outside
        with self.assertRaises(PathValidationError):
            validate_local_path("/tmp/traversal.mov", REPO_ROOT)

    def test_symlink_rejected(self):
        target = SAMPLE_ROOT / "1.MOV"
        if not target.exists():
            self.skipTest("Sample/1.MOV absent")
        link = SAMPLE_ROOT / "link.mov"
        try:
            if link.exists() or link.is_symlink():
                link.unlink()
            link.symlink_to(target)
            with self.assertRaises(PathValidationError) as cm:
                validate_local_path(str(link), REPO_ROOT)
            self.assertEqual(cm.exception.reason, "symlink_rejected")
        finally:
            if link.is_symlink() or link.exists():
                link.unlink()
        # symlink parent test: create tmp dir symlinked inside Sample
        with tempfile.TemporaryDirectory() as tmpd:
            real_file = Path(tmpd) / "real.mov"
            real_file.write_bytes(b"hello")
            link_dir = SAMPLE_ROOT / "linkdir"
            try:
                if link_dir.exists() or link_dir.is_symlink():
                    # cleanup
                    if link_dir.is_symlink():
                        link_dir.unlink()
                    else:
                        link_dir.rmdir()
                link_dir.symlink_to(tmpd)
                # Try to access via symlink dir
                via_link = link_dir / "real.mov"
                # lstat on via_link's parent should be detected
                with self.assertRaises(PathValidationError) as cm2:
                    validate_local_path(str(via_link), REPO_ROOT)
                self.assertIn(cm2.exception.reason, ("symlink_rejected", "root_escape"))
            finally:
                if link_dir.is_symlink():
                    link_dir.unlink()

    def test_directory_rejected(self):
        with self.assertRaises(PathValidationError) as cm:
            validate_local_path(str(SAMPLE_ROOT), REPO_ROOT)
        self.assertIn(cm.exception.reason, ("unsupported_extension", "is_directory", "not_regular_file", "symlink_rejected"))

        # directory with .mov suffix (mkdir)
        with tempfile.TemporaryDirectory() as tmpd:
            dir_mov = Path(tmpd) / "dir.mov"
            dir_mov.mkdir()
            # Move it inside Sample via not symlink but we test extension check still fails because is directory
            # need to test via absolute path that is dir
            with self.assertRaises(PathValidationError):
                validate_local_path(str(dir_mov), REPO_ROOT)

    def test_extension_rejected(self):
        # .txt file inside Sample
        txt = SAMPLE_ROOT / "test.txt"
        txt.write_bytes(b"hello")
        try:
            with self.assertRaises(PathValidationError) as cm:
                validate_local_path(str(txt), REPO_ROOT)
            self.assertEqual(cm.exception.reason, "unsupported_extension")
        finally:
            txt.unlink()

        # no extension
        noext = SAMPLE_ROOT / "noext"
        noext.write_bytes(b"hi")
        try:
            with self.assertRaises(PathValidationError):
                validate_local_path(str(noext), REPO_ROOT)
        finally:
            noext.unlink()

    def test_oversize_no_longer_enforced_on_user_source(self):
        # User-source (Electron) path has no size cap; local Sample path also no longer
        # enforces 32 MiB. Large regular .mov must pass boundary checks (size not a reason).
        from prototype.path_boundary import validate_user_selected_path
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix=".mov", delete=False) as f:
            f.truncate(33 * 1024 * 1024)
            tmp = f.name
        try:
            # user-selected path should NOT raise oversize (may resolve to realpath, but size ignored)
            try:
                canonical = validate_user_selected_path(tmp, REPO_ROOT)
                self.assertTrue(canonical.is_absolute())
            except PathValidationError as e:
                self.assertNotEqual(e.reason, "oversize", "user-source must not reject on oversize")
        finally:
            try:
                os.unlink(tmp)
            except:
                pass
        # Also Sample-root file >32MiB must not be rejected for size
        big = SAMPLE_ROOT / "big.mov"
        try:
            with open(big, "wb") as f:
                f.truncate(33 * 1024 * 1024)
            # Should either succeed or fail for other boundary reasons, never oversize
            try:
                validate_local_path(str(big), REPO_ROOT)
            except PathValidationError as e:
                self.assertNotEqual(e.reason, "oversize")
        finally:
            if big.exists():
                try:
                    big.unlink()
                except:
                    pass

    def test_relative_path_rejected(self):
        with self.assertRaises(PathValidationError) as cm:
            validate_local_path("Sample/1.MOV", REPO_ROOT)
        self.assertEqual(cm.exception.reason, "not_absolute")

    def test_not_found_rejected(self):
        with self.assertRaises(PathValidationError) as cm:
            validate_local_path(str(SAMPLE_ROOT / "nonexistent.mov"), REPO_ROOT)
        self.assertIn(cm.exception.reason, ("not_found", "resolve_failed"))

    def test_nonregular_file_rejected(self):
        fifo = SAMPLE_ROOT / "fifo.mov"
        try:
            os.mkfifo(str(fifo))
            with self.assertRaises(PathValidationError) as cm:
                validate_local_path(str(fifo), REPO_ROOT)
            self.assertEqual(cm.exception.reason, "not_regular_file")
        except OSError as e:
            self.skipTest(f"mkfifo not supported: {e}")
        finally:
            if fifo.exists():
                try:
                    fifo.unlink()
                except:
                    pass
