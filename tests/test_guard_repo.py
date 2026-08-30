import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "guard-repo.py"


def git(repo, *args):
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def run_guard(repo):
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=repo,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


class TestRepositoryGuard(unittest.TestCase):
    def make_repo(self):
        repo = Path(tempfile.mkdtemp(prefix="hdrtosdr-guard-"))
        git(repo, "init", "--quiet")
        git(repo, "config", "user.email", "guard-test@example.invalid")
        git(repo, "config", "user.name", "Repository Guard Test")
        return repo

    def commit_all(self, repo, message):
        git(repo, "add", "--all")
        git(repo, "commit", "--quiet", "-m", message)

    def test_rejects_forbidden_current_names(self):
        repo = self.make_repo()
        try:
            for name in (
                "Sample/current.txt",
                "Output/current.txt",
                "build/current.txt",
                "tools/ffmpeg",
                "tools/ffprobe",
                ".DS_Store",
                "settings.local.json",
                "backup.yedek",
                "old.bak",
                ".env",
                "private.pem",
                "private.key",
            ):
                target = repo / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("not a payload", encoding="utf-8")
            self.commit_all(repo, "forbidden current names")

            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Sample/current.txt", result.stdout)
            self.assertIn("tools/ffmpeg", result.stdout)
            self.assertIn("private.key", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_rejects_forbidden_names_from_added_history_after_removal(self):
        repo = self.make_repo()
        try:
            (repo / "README.md").write_text("safe\n", encoding="utf-8")
            self.commit_all(repo, "safe base")

            old = repo / "Output" / "historical.mov"
            old.parent.mkdir()
            old.write_bytes(b"generated media")
            self.commit_all(repo, "add output by mistake")
            old.unlink()
            (repo / "README.md").write_text("safe still\n", encoding="utf-8")
            self.commit_all(repo, "remove output")

            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Output/historical.mov", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_rejects_private_key_and_user_home_paths_in_tracked_text(self):
        repo = self.make_repo()
        try:
            marker = "-----BEGIN " + "RSA PRIVATE KEY" + "-----"
            home_paths = [
                "/" + "Users" + "/alice/Documents/source.mov",
                "/" + "home" + "/alice/Documents/source.mov",
            ]
            (repo / "leak.txt").write_text(
                marker + "\n" + "\n".join(home_paths) + "\n", encoding="utf-8"
            )
            self.commit_all(repo, "secret-shaped text")

            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("private-key PEM marker", result.stdout)
            self.assertIn("user-home absolute path", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_rejects_deleted_innocuous_file_content_from_full_history(self):
        repo = self.make_repo()
        try:
            (repo / "README.md").write_text("safe base\n", encoding="utf-8")
            self.commit_all(repo, "safe base")

            historical = repo / "notes.txt"
            marker = "-----BEGIN " + "RSA PRIVATE KEY" + "-----"
            historical.write_text(marker + "\n", encoding="utf-8")
            self.commit_all(repo, "add innocuous notes")
            historical.unlink()
            self.commit_all(repo, "remove innocuous notes")

            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("private-key PEM marker", result.stdout)
            self.assertIn("notes.txt", result.stdout)
            self.assertNotIn(marker, result.stdout, "secret-shaped content must never be printed")
        finally:
            shutil.rmtree(repo)

    def test_rejects_deleted_user_home_path_from_full_history(self):
        repo = self.make_repo()
        try:
            (repo / "README.md").write_text("safe base\n", encoding="utf-8")
            self.commit_all(repo, "safe base")

            historical = repo / "notes.txt"
            historical_home = "/" + "Users" + "/alice/private/source.mov"
            historical.write_text("source=" + historical_home + "\n", encoding="utf-8")
            self.commit_all(repo, "add innocuous notes")
            historical.unlink()
            self.commit_all(repo, "remove innocuous notes")

            result = run_guard(repo)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("user-home absolute path", result.stdout)
            self.assertIn("notes.txt", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_allows_benign_content_removed_from_full_history(self):
        repo = self.make_repo()
        try:
            (repo / "README.md").write_text("safe base\n", encoding="utf-8")
            self.commit_all(repo, "safe base")
            historical = repo / "notes.txt"
            historical.write_text("ordinary historical text\n/Library/Application Support/HdrToSdr\n", encoding="utf-8")
            self.commit_all(repo, "add benign notes")
            historical.unlink()
            self.commit_all(repo, "remove benign notes")

            result = run_guard(repo)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Repository guard passed", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_allows_normal_files_documented_system_paths_and_placeholders(self):
        repo = self.make_repo()
        try:
            (repo / "README.md").write_text(
                "normal text\n/Library/Application Support/HdrToSdr\n/opt/homebrew/bin\n"
                "documented placeholder /Users/.../project\n",
                encoding="utf-8",
            )
            fixture = repo / "tests" / "fixtures" / "generated" / "paths.json"
            fixture.parent.mkdir(parents=True)
            generated_home = "/Users/.../fixture/input.mov"
            fixture.write_text(
                '{"fixture_path": "' + generated_home + '"}\n',
                encoding="utf-8",
            )
            self.commit_all(repo, "safe files")

            result = run_guard(repo)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Repository guard passed", result.stdout)
        finally:
            shutil.rmtree(repo)

    def test_fails_closed_when_not_run_in_a_git_repository(self):
        with tempfile.TemporaryDirectory(prefix="hdrtosdr-no-git-") as directory:
            result = run_guard(Path(directory))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("git", result.stdout.lower())


if __name__ == "__main__":
    unittest.main()
