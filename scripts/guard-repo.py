#!/usr/bin/env python3
"""Offline repository hygiene guard.

This guard examines Git names, current tracked regular files, and bounded
textual patches across the complete Git history. It never shells out through a
command string, downloads anything, or runs product tooling. The history check
is intentionally dependent on complete Git history; CI uses checkout
fetch-depth 0 for that reason.
"""

from __future__ import annotations

import codecs
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_DIAGNOSTIC_CHARS = 1_000
MAX_REPORTED_FINDINGS = 50
GIT_TIMEOUT_SECONDS = 30
TEXT_CHUNK_BYTES = 64 * 1024

FORBIDDEN_PAYLOAD_RE = re.compile(r"(?:^|/)(?:Sample|Output|build)(?:/|$)")
FORBIDDEN_TOOL_RE = re.compile(r"(?:^|/)tools/(?:ffmpeg|ffprobe)$")
FORBIDDEN_BASENAME = ".DS_Store"
# Keep this expression deliberately narrow: these are path names, not generic
# words such as "token" or "secret".
LEAK_PATH_RE = re.compile(
    r"settings\.local\.json|\.yedek|\.bak$|(^|/)\.env$|\.pem$|\.key$"
)
PRIVATE_KEY_PEM_RE = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"
)
PRIVATE_KEY_PEM_BYTES_RE = re.compile(
    rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"
)
USER_HOME_PATH_RE = re.compile(r"/(?:Users|home)/[^/\s\"'<>:`]+(?:/[^/\s\"'<>:`]+)*")
USER_HOME_PATH_BYTES_RE = re.compile(rb"/(?:Users|home)/[^/\s\"'<>:`]+(?:/[^/\s\"'<>:`]+)*")
DOCUMENTED_HOME_PLACEHOLDER_RE = re.compile(r"^/(?:Users|home)/(?:\.\.\.|<[^/]+>)(?:/|$)")
DOCUMENTED_HOME_PLACEHOLDER_BYTES_RE = re.compile(rb"^/(?:Users|home)/(?:\.\.\.|<[^/]+>)(?:/|$)")
HISTORY_PATCH_ARGUMENTS = [
    "log", "--all", "--patch", "--text", "--diff-merges=separate",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--format=",
]
# `/Library/` and `/opt/homebrew/` are intentionally outside
# USER_HOME_PATH_RE, so documented system paths are allowed.
class GuardError(RuntimeError):
    """An inability to inspect the repository, which must fail closed."""


@dataclass(frozen=True)
class Finding:
    category: str
    path: str
    source: str


@dataclass(frozen=True)
class GuardReport:
    current_names: tuple[str, ...]
    added_history_names: tuple[str, ...]
    scanned_text_files: int
    findings: tuple[Finding, ...]
    history_patch_bytes: int = 0

    @property
    def passed(self) -> bool:
        return not self.findings


def _bounded_diagnostic(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace").strip()
    if len(text) <= MAX_DIAGNOSTIC_CHARS:
        return text
    return text[: MAX_DIAGNOSTIC_CHARS - 3] + "..."


def _run_git(repo_root: Path, arguments: list[str]) -> bytes:
    """Run one Git argv command with bounded captured output and no shell."""
    command = ["git", "-C", os.fspath(repo_root), *arguments]
    try:
        completed = subprocess.run(
            command,
            check=False,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GuardError(f"git inspection failed: {error}") from error

    if completed.returncode != 0:
        detail = _bounded_diagnostic(completed.stderr)
        suffix = f": {detail}" if detail else ""
        raise GuardError(f"git inspection failed (exit {completed.returncode}){suffix}")
    if len(completed.stdout) > MAX_GIT_OUTPUT_BYTES:
        raise GuardError("git inspection output exceeded the safety limit")
    return completed.stdout


def _git_names(repo_root: Path, arguments: list[str]) -> tuple[str, ...]:
    output = _run_git(repo_root, arguments)
    try:
        return tuple(os.fsdecode(item) for item in output.split(b"\0") if item)
    except (TypeError, UnicodeError) as error:
        raise GuardError(f"git returned invalid path data: {error}") from error


def current_names(repo_root: Path) -> tuple[str, ...]:
    return _git_names(repo_root, ["ls-files", "-z"])


def added_history_names(repo_root: Path) -> tuple[str, ...]:
    return _git_names(
        repo_root,
        ["log", "--all", "--name-only", "--diff-filter=A", "--format=", "-z"],
    )


def _name_finding(path: str, source: str) -> Finding | None:
    if FORBIDDEN_PAYLOAD_RE.search(path):
        return Finding("forbidden payload path", path, source)
    if FORBIDDEN_TOOL_RE.search(path):
        return Finding("forbidden tool binary path", path, source)
    if path.rsplit("/", 1)[-1] == FORBIDDEN_BASENAME:
        return Finding("forbidden macOS metadata path", path, source)
    if LEAK_PATH_RE.search(path):
        return Finding("forbidden leak path", path, source)
    return None


def _is_documented_home_placeholder(match: re.Match[str]) -> bool:
    return bool(DOCUMENTED_HOME_PLACEHOLDER_RE.match(match.group(0)))


def _scan_tracked_text(path: Path, display_path: str) -> tuple[str, ...]:
    """Return policy categories found in a UTF-8 tracked regular text file.

    Files are streamed and scanned with a small overlap, so a large text file
    cannot create unbounded memory use and a marker split across chunks is not
    missed. Non-UTF-8 or NUL-containing files are treated as binary.
    """
    try:
        file_stat = path.lstat()
    except OSError as error:
        raise GuardError(f"cannot inspect tracked file {display_path}: {error}") from error
    if not stat.S_ISREG(file_stat.st_mode):
        return ()

    decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
    categories: set[str] = set()
    carry = ""
    try:
        with path.open("rb") as tracked_file:
            first_chunk = tracked_file.read(TEXT_CHUNK_BYTES)
            if b"\0" in first_chunk:
                return ()
            try:
                text = decoder.decode(first_chunk, final=False)
            except UnicodeDecodeError:
                return ()
            if _scan_text_window(text, display_path, categories, carry):
                return tuple(sorted(categories))
            carry = (carry + text)[-256:]

            while True:
                chunk = tracked_file.read(TEXT_CHUNK_BYTES)
                if not chunk:
                    break
                if b"\0" in chunk:
                    return ()
                try:
                    text = decoder.decode(chunk, final=False)
                except UnicodeDecodeError:
                    return ()
                if _scan_text_window(text, display_path, categories, carry):
                    return tuple(sorted(categories))
                carry = (carry + text)[-256:]
            try:
                text = decoder.decode(b"", final=True)
            except UnicodeDecodeError:
                return ()
            _scan_text_window(text, display_path, categories, carry)
    except OSError as error:
        raise GuardError(f"cannot read tracked file {display_path}: {error}") from error
    return tuple(sorted(categories))


def _scan_text_window(
    text: str,
    display_path: str,
    categories: set[str],
    carry: str,
) -> bool:
    window = carry + text
    if PRIVATE_KEY_PEM_RE.search(window):
        categories.add("private-key PEM marker")
    for match in USER_HOME_PATH_RE.finditer(window):
        if not _is_documented_home_placeholder(match):
            categories.add("user-home absolute path")
            break
    return len(categories) >= 2


def _history_patch_path(line: bytes) -> str:
    """Extract only the patch path; never return patch content in diagnostics."""
    prefix = b"diff --git a/"
    if not line.startswith(prefix):
        return "<historical patch>"
    remainder = line[len(prefix):]
    marker = b" b/"
    if marker not in remainder:
        return "<historical patch>"
    _old_path, new_path = remainder.split(marker, 1)
    return os.fsdecode(new_path) or "<historical patch>"


def _scan_history_patch(repo_root: Path) -> tuple[int, tuple[Finding, ...]]:
    """Scan bounded added/deleted patch lines across every reachable commit.

    Git's ``--text`` forces textual patch emission even for an innocuously
    named file that was later deleted. Only policy categories and a safe path
    label leave this function; secret-shaped bytes are never reported.
    """
    patch = _run_git(repo_root, HISTORY_PATCH_ARGUMENTS)
    findings: list[Finding] = []
    seen: set[str] = set()
    display_path = "<historical patch>"
    for line in patch.splitlines():
        if line.startswith(b"diff --git "):
            display_path = _history_patch_path(line)
            continue
        # Added and deleted file content both matter. Exclude patch metadata so
        # a filename/header cannot be mistaken for file content.
        if line.startswith((b"+++", b"---")) or line[:1] not in (b"+", b"-"):
            continue
        content = line[1:]
        categories: set[str] = set()
        if PRIVATE_KEY_PEM_BYTES_RE.search(content):
            categories.add("private-key PEM marker")
        for match in USER_HOME_PATH_BYTES_RE.finditer(content):
            if not DOCUMENTED_HOME_PLACEHOLDER_BYTES_RE.match(match.group(0)):
                categories.add("user-home absolute path")
                break
        for category in sorted(categories):
            if category not in seen:
                seen.add(category)
                findings.append(Finding(category, display_path, "full-history patch text"))
    return len(patch), tuple(findings)


def inspect_repo(repo_root: os.PathLike[str] | str) -> GuardReport:
    root = Path(repo_root)
    if not root.exists() or not root.is_dir():
        raise GuardError(f"repository path is not a directory: {root}")
    root = root.resolve()

    names = current_names(root)
    history_names = added_history_names(root)
    findings: list[Finding] = []
    seen: set[tuple[str, str, str]] = set()

    def add(finding: Finding | None) -> None:
        if finding is None:
            return
        key = (finding.category, finding.path, finding.source)
        if key not in seen:
            seen.add(key)
            findings.append(finding)

    for path in names:
        add(_name_finding(path, "current tracked name"))
    for path in history_names:
        add(_name_finding(path, "added-file history"))

    history_patch_bytes, history_findings = _scan_history_patch(root)
    for finding in history_findings:
        add(finding)

    scanned_text_files = 0
    for relative_path in names:
        path = root / Path(*relative_path.split("/"))
        try:
            file_stat = path.lstat()
        except OSError as error:
            raise GuardError(f"cannot inspect tracked file {relative_path}: {error}") from error
        if not stat.S_ISREG(file_stat.st_mode):
            continue
        scanned_text_files += 1
        categories = _scan_tracked_text(path, relative_path)
        for category in categories:
            add(Finding(category, relative_path, "tracked text"))

    return GuardReport(names, history_names, scanned_text_files, tuple(findings), history_patch_bytes)


# Small public alias for callers that prefer verb-style naming.
guard_repo = inspect_repo


def _bounded_path(path: str) -> str:
    if len(path) <= 240:
        return path
    return path[:237] + "..."


def _print_report(report: GuardReport) -> None:
    if report.passed:
        print(
            "Repository guard passed "
            f"({len(report.current_names)} tracked names, "
            f"{len(report.added_history_names)} added-history names, "
            f"{report.scanned_text_files} regular files scanned, "
            f"{report.history_patch_bytes} history patch bytes scanned)."
        )
        return

    print("Repository guard failed:")
    for finding in report.findings[:MAX_REPORTED_FINDINGS]:
        print(f"- {finding.category}: {_bounded_path(finding.path)} [{finding.source}]")
    remaining = len(report.findings) - MAX_REPORTED_FINDINGS
    if remaining > 0:
        print(f"- ... {remaining} additional finding(s) omitted")


def main(argv: Iterable[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    if len(args) > 1:
        print("usage: guard-repo.py [repository-root]")
        return 2
    root = Path(args[0]) if args else Path.cwd()
    try:
        report = inspect_repo(root)
    except GuardError as error:
        print(f"Repository guard failed closed: {error}")
        return 2
    _print_report(report)
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
