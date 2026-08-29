import os
import stat
from pathlib import Path
from typing import Tuple


class PathValidationError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def get_sample_root(repo_root: Path) -> Path:
    return (repo_root / "Sample").resolve()


def _is_within(child: Path, parent: Path) -> bool:
    """Check if child is within parent, handling APFS case-insensitive filesystem."""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        pass
    # Fallback for case-insensitive filesystems (macOS APFS): compare lowercased strings
    # Use os.path.commonpath equivalent with case folding on Darwin
    try:
        # Normalize both to lower for comparison on case-insensitive FS
        cs = str(child).lower()
        ps = str(parent).lower()
        # Ensure ps ends without trailing slash for prefix check
        if cs == ps or cs.startswith(ps.rstrip("/") + "/"):
            return True
    except Exception:
        pass
    return False


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
