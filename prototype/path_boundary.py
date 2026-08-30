import os
import stat
from pathlib import Path
from typing import Tuple


_ALLOWED_CANONICAL_ALIASES = {
    "/tmp": "/private/tmp",
    "/var": "/private/var",
    "/etc": "/private/etc",
}


# macOS exposes these compatibility links for ordinary temporary/system paths.
# They are the only symlinks accepted by the source policy.
_ALLOWED_SYSTEM_SYMLINKS = {
    "/tmp": "/private/tmp",
    "/var": "/private/var",
    "/etc": "/private/etc",
}


class PathValidationError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def get_sample_root(repo_root: Path) -> Path:
    return (repo_root / "Sample").resolve()


def _is_within(child: Path, parent: Path) -> bool:
    """Check canonical paths by component, preserving case."""
    try:
        child.relative_to(parent)
        return True
    except (ValueError, TypeError):
        return False


def normalize_canonical_path(value: str, platform: str = None) -> str:
    """Normalize an already-resolved path for cross-runtime policy parity.

    Case is intentionally preserved on every platform. Only the explicit macOS
    compatibility aliases are rewritten, matching Node's source policy.
    """
    if not isinstance(value, str) or not value:
        return ""
    platform = os.sys.platform if platform is None else platform
    normalized = os.path.normpath(os.path.abspath(value))
    if platform == "darwin":
        for alias, target in _ALLOWED_CANONICAL_ALIASES.items():
            if normalized == alias:
                normalized = target
            elif normalized.startswith(alias + os.sep):
                normalized = target + normalized[len(alias):]
    return normalized


def canonical_paths_equal(first: str, second: str, platform: str = None) -> bool:
    return normalize_canonical_path(first, platform) == normalize_canonical_path(second, platform)


def _validate_common_input(path_str: str) -> Path:
    """Shared pre-checks for absolute .mov/.mp4 regular file. Returns Path object."""
    if not path_str or not isinstance(path_str, str):
        raise PathValidationError("missing_path")
    p = Path(path_str)
    if not p.is_absolute():
        raise PathValidationError("not_absolute")
    suffix = p.suffix.lower()
    if suffix not in (".mov", ".mp4"):
        raise PathValidationError("unsupported_extension")
    try:
        lst = os.lstat(p)
    except FileNotFoundError:
        raise PathValidationError("not_found")
    except OSError:
        raise PathValidationError("not_found")
    if stat.S_ISLNK(lst.st_mode):
        raise PathValidationError("symlink_rejected")
    if stat.S_ISDIR(lst.st_mode):
        raise PathValidationError("is_directory")
    if not stat.S_ISREG(lst.st_mode):
        raise PathValidationError("not_regular_file")
    return p


def _validate_symlink_policy(p: Path) -> None:
    """Reject source symlinks consistently, allowing only OS alias links."""
    current = Path(p.anchor)
    for part in p.parts[1:]:
        current /= part
        try:
            item = os.lstat(current)
        except FileNotFoundError:
            raise PathValidationError("not_found")
        except OSError:
            raise PathValidationError("symlink_check_failed")
        if not stat.S_ISLNK(item.st_mode):
            continue
        try:
            resolved = str(current.resolve(strict=True))
        except (FileNotFoundError, RuntimeError, OSError):
            raise PathValidationError("resolve_failed")
        if _ALLOWED_SYSTEM_SYMLINKS.get(str(current)) != resolved:
            raise PathValidationError("symlink_rejected")


def _canonicalize_and_validate_regular(p: Path) -> Path:
    """Resolve strict and validate canonical is regular .mov/.mp4."""
    try:
        canonical = p.resolve(strict=True)
    except (FileNotFoundError, RuntimeError, OSError):
        raise PathValidationError("resolve_failed")
    try:
        cst = os.stat(canonical)
    except OSError:
        raise PathValidationError("stat_failed")
    if not stat.S_ISREG(cst.st_mode):
        raise PathValidationError("not_regular_file")
    if canonical.suffix.lower() not in (".mov", ".mp4"):
        raise PathValidationError("unsupported_extension")
    return canonical


def validate_user_selected_path(input_path_str: str, repo_root: Path) -> Path:
    """
    Validate arbitrary absolute local .mov/.mp4 regular file selected in Electron.
    No Sample-root restriction; preserves all safe checks:
    absolute, extension, no final symlink, no directory/nonregular,
    strict canonicalization. Identity recheck is done by caller inspector.
    No shell/PATH fallback – caller resolves ffprobe separately.
    """
    p = _validate_common_input(input_path_str)
    _validate_symlink_policy(p)
    canonical = _canonicalize_and_validate_regular(p)
    # No Sample root containment; reject symlink final already done via lstat.
    # Do not leak path – caller maps reason to invalid_path.
    return canonical


def validate_local_path(input_path_str: str, repo_root: Path) -> Path:
    """
    Validate absolute local path under Sample/ root.
    Returns resolved canonical Path on success, raises PathValidationError on failure.
    Checks:
    - absolute
    - resolve(strict=True)
    - no symlink (lstat)
    - regular file only
    - within Sample root
    - extension .mov/.mp4
    """
    if not input_path_str or not isinstance(input_path_str, str):
        raise PathValidationError("missing_path")

    p = Path(input_path_str)

    if not p.is_absolute():
        raise PathValidationError("not_absolute")

    # reject weird extensions early (but need resolved path for actual file)
    # extension check case-insensitive
    suffix = p.suffix.lower()
    if suffix not in (".mov", ".mp4"):
        raise PathValidationError("unsupported_extension")

    # symlink check via lstat before resolving
    try:
        lst = os.lstat(p)
    except FileNotFoundError:
        raise PathValidationError("not_found")
    except OSError:
        raise PathValidationError("not_found")

    if stat.S_ISLNK(lst.st_mode):
        raise PathValidationError("symlink_rejected")
    if stat.S_ISDIR(lst.st_mode):
        raise PathValidationError("is_directory")
    if not stat.S_ISREG(lst.st_mode):
        raise PathValidationError("not_regular_file")

    _validate_symlink_policy(p)

    # canonicalize
    try:
        canonical = p.resolve(strict=True)
    except (FileNotFoundError, RuntimeError, OSError):
        raise PathValidationError("resolve_failed")

    # after resolve, ensure same checks on canonical: not symlink parent escaping?
    # Re-stat canonical
    try:
        cst = os.stat(canonical)
    except OSError:
        raise PathValidationError("stat_failed")

    if not stat.S_ISREG(cst.st_mode):
        raise PathValidationError("not_regular_file")

    # Extension on canonical as well
    if canonical.suffix.lower() not in (".mov", ".mp4"):
        raise PathValidationError("unsupported_extension")

    # Root containment (check before parent symlink walk to prioritize root_escape)
    sample_root = get_sample_root(repo_root)
    if not sample_root.exists():
        raise PathValidationError("sample_root_missing")
    if not _is_within(canonical, sample_root):
        raise PathValidationError("root_escape")

    # Parent symlink check limited to within Sample root ancestry (avoid flagging /tmp -> /private/tmp)
    try:
        for parent in canonical.parents:
            # only care about ancestors inside Sample root
            if not _is_within(parent, sample_root) and parent != sample_root:
                if parent == Path("/"):
                    break
                continue
            # inside Sample root -> check symlink
            try:
                pl = os.lstat(parent)
                if stat.S_ISLNK(pl.st_mode):
                    raise PathValidationError("symlink_rejected")
            except FileNotFoundError:
                continue
            if parent == sample_root:
                break
        # also check sample_root itself if it's symlink (should be resolved but check)
        try:
            pl = os.lstat(sample_root)
            if stat.S_ISLNK(pl.st_mode):
                raise PathValidationError("symlink_rejected")
        except FileNotFoundError:
            pass
    except PathValidationError:
        raise
    except Exception:
        raise PathValidationError("symlink_check_failed")

    return canonical


def snapshot_identity(path: Path) -> Tuple[int, int, int, int]:
    """Return (size, ino, dev, mtime_ns) for identity check."""
    st = os.stat(path)
    return (st.st_size, st.st_ino, st.st_dev, st.st_mtime_ns)
