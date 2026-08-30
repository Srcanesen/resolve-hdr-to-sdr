#!/usr/bin/env python3
"""Bounded, owned DaVinci Resolve -nogui scripting smoke.

The parent process owns one directly-spawned Resolve child.  A separate worker
performs the official scripting calls so its deadline can be enforced by the
parent.  The worker never touches a project other than its uniquely named
scratch project; the parent never signals any process except its child.
"""

import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


RESULT_LIMIT = 8192
TEXT_LIMIT = 120
ERROR_CODE_LIMIT = 48
POLL_SECONDS = 0.25
RESOLVE_BINARY = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve")
SCRIPT_API = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting")
SCRIPT_MODULES = SCRIPT_API / "Modules"
SCRIPT_LIB = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so")
FIXTURE_NAME = "hdrtosdr_resolve_smoke_fixture.mp4"
PROJECT_PREFIX = "HdrToSdr_ResolveSmoke_"
TIMELINE_PREFIX = "HdrToSdr_ResolveSmokeTimeline_"


def _on_termination_signal(signum, _frame):
    raise KeyboardInterrupt(f"signal-{signum}")


def _install_termination_handlers():
    for _sig in (signal.SIGTERM, getattr(signal, "SIGHUP", None), signal.SIGINT):
        if _sig is None:
            continue
        try:
            signal.signal(_sig, _on_termination_signal)
        except (ValueError, OSError):
            continue


class SmokeFailure(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def parse_pid_output(output):
    """Parse strict pgrep output; malformed process state fails closed."""
    if isinstance(output, bytes):
        output = output.decode("ascii", "strict")
    pids = set()
    for token in str(output).split():
        if not token.isdigit() or int(token) <= 0:
            raise ValueError("invalid pid output")
        pids.add(int(token))
    return pids


def owns_only_pid(pids, pid):
    """Return true only for a non-empty exact one-process ownership proof."""
    return isinstance(pid, int) and pid > 0 and pids == {pid}


def build_resolve_command(binary):
    """Build the direct bundle-binary invocation; never use open(1)."""
    return [str(binary), "-nogui"]


def build_script_env(script_api, script_lib, base_env=None):
    """Set the three official Resolve scripting environment variables."""
    env = dict(os.environ if base_env is None else base_env)
    modules = str(Path(script_api) / "Modules")
    existing = env.get("PYTHONPATH", "")
    env["RESOLVE_SCRIPT_API"] = str(script_api)
    env["RESOLVE_SCRIPT_LIB"] = str(script_lib)
    env["PYTHONPATH"] = os.pathsep.join(part for part in (existing, modules) if part)
    return env


def safe_text(value, limit=TEXT_LIMIT):
    if value is None:
        return None
    try:
        text = " ".join(str(value).split())
    except Exception:
        return None
    return text[:limit]


def sanitize_result(result):
    """Whitelist the bounded public result and discard arbitrary API data."""
    result = result if isinstance(result, dict) else {}
    output = {"ok": result.get("ok") is True}
    if isinstance(result.get("error"), dict):
        code = safe_text(result["error"].get("code"), ERROR_CODE_LIMIT)
        if code:
            output["error"] = {"code": code}
    if isinstance(result.get("evidence"), dict):
        source = result["evidence"]
        evidence = {}
        for key in (
            "resolve_version",
            "imported_clip_name",
            "duration",
            "resolution",
            "frame_rate",
            "video_codec",
        ):
            value = safe_text(source.get(key))
            if value is not None:
                evidence[key] = value
        for key in (
            "media_pool_clip_count",
            "timeline_count",
            "timeline_item_count",
        ):
            value = source.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 1000:
                evidence[key] = value
        for key in ("file_path_matches_fixture", "timeline_exists", "pid_set_exact_before_mutation"):
            if isinstance(source.get(key), bool):
                evidence[key] = source[key]
        if evidence:
            output["evidence"] = evidence
    if isinstance(result.get("cleanup"), dict):
        source = result["cleanup"]
        cleanup = {}
        for key in (
            "project_closed",
            "project_deleted",
            "media_deleted",
            "quit_requested",
            "pid_set_exact_before_quit",
            "worker_cleanup_recovered",
        ):
            if isinstance(source.get(key), bool):
                cleanup[key] = source[key]
        if source.get("resolve_exit") in ("graceful", "terminated", "killed", "not-started", "still-running"):
            cleanup["resolve_exit"] = source["resolve_exit"]
        for key in ("resolve_residue", "fuscript_residue"):
            value = source.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and -1 <= value <= 1000:
                cleanup[key] = value
        if cleanup:
            output["cleanup"] = cleanup
    output["scope"] = "temporary fixture and uniquely named scratch project only"
    return output


def emit_result(result):
    payload = sanitize_result(result)
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    if len(encoded) > RESULT_LIMIT:
        payload = {"ok": False, "error": {"code": "result-too-large"}, "scope": "temporary fixture and uniquely named scratch project only"}
        encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


def _pgrep(comm):
    completed = subprocess.run(
        ["pgrep", "-x", comm],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode == 1:
        return set()
    if completed.returncode != 0:
        raise SmokeFailure("process-check-failed")
    try:
        return parse_pid_output(completed.stdout)
    except (UnicodeError, ValueError):
        raise SmokeFailure("process-check-failed")


def resolve_pids():
    """Return exact-comm Resolve PIDs; failure is never treated as empty."""
    return _pgrep("Resolve")


def target_pids():
    """Return all exact-comm Resolve/fuscript PIDs for safety/residue checks."""
    return resolve_pids() | _pgrep("fuscript")


def process_counts():
    resolve = resolve_pids()
    fuscript = _pgrep("fuscript")
    return {"resolve_residue": len(resolve), "fuscript_residue": len(fuscript)}


def wait_for_exact_pid(pid, timeout_seconds):
    """Prove the only running Resolve process is this direct child.

    Resolve may start its own fuscript helper while becoming scripting-ready;
    that helper is separately refused at preflight and separately checked for
    residue, but is not the Resolve PID whose Quit ownership is proven here.
    """
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            if owns_only_pid(resolve_pids(), pid):
                return True
        except SmokeFailure:
            return False
        time.sleep(POLL_SECONDS)
    return False


def stop_process(process, term_seconds=10, kill_seconds=5):
    """Bounded TERM -> KILL cleanup for the one owned Popen child."""
    if process.poll() is not None:
        return "graceful"
    try:
        process.send_signal(signal.SIGTERM)
    except OSError:
        pass
    try:
        process.wait(timeout=term_seconds)
        return "terminated"
    except subprocess.TimeoutExpired:
        pass
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=kill_seconds)
        return "killed"
    except subprocess.TimeoutExpired:
        return "still-running"


def run_quiet(argv, timeout_seconds):
    """Run a bounded no-output command and kill it if its deadline expires."""
    process = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return process.wait(timeout=timeout_seconds) == 0
    except subprocess.TimeoutExpired:
        stop_process(process, term_seconds=1, kill_seconds=1)
        return False


def build_fixture_command(ffmpeg, output):
    return [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=16x16:r=1:d=1",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-n",
        str(output),
    ]


def require_owned(expected_pid):
    try:
        pids = resolve_pids()
    except SmokeFailure:
        raise
    if not owns_only_pid(pids, expected_pid):
        raise SmokeFailure("resolve-ownership-unproven")


def env_value(name):
    value = os.environ.get(name)
    if not value:
        raise SmokeFailure("worker-environment-missing")
    return value


def connect_resolve(deadline):
    try:
        import DaVinciResolveScript as bmd
    except Exception:
        raise SmokeFailure("scripting-api-import-failed")
    resolve = None
    while time.monotonic() < deadline:
        try:
            resolve = bmd.scriptapp("Resolve")
            if resolve is not None:
                pm = resolve.GetProjectManager()
                projects = pm.GetProjectListInCurrentFolder() if pm is not None else None
                if pm is not None and isinstance(projects, list):
                    return resolve, pm
        except Exception:
            resolve = None
        time.sleep(POLL_SECONDS)
    raise SmokeFailure("resolve-connect-timeout")


def api_call(fn, code):
    try:
        return fn()
    except Exception:
        raise SmokeFailure(code)


def fixture_path_matches(api_value, fixture):
    if not isinstance(api_value, str) or not api_value:
        return False
    try:
        return os.path.realpath(api_value) == os.path.realpath(str(fixture))
    except (OSError, ValueError):
        return False


def cleanup_owned_project(pm, project_name, expected_pid):
    """Close/delete only the exact project created by this invocation."""
    outcome = {"project_closed": False, "project_deleted": False}
    current = api_call(pm.GetCurrentProject, "project-cleanup-read-failed")
    current_name = None
    if current is not None:
        current_name = api_call(current.GetName, "project-cleanup-read-failed")
    if current_name == project_name:
        require_owned(expected_pid)
        closed = api_call(lambda: pm.CloseProject(current), "project-close-failed")
        if closed is False:
            raise SmokeFailure("project-close-failed")
    outcome["project_closed"] = True

    projects = api_call(pm.GetProjectListInCurrentFolder, "project-cleanup-read-failed")
    if not isinstance(projects, list):
        raise SmokeFailure("project-cleanup-read-failed")
    if project_name in projects:
        require_owned(expected_pid)
        deleted = api_call(lambda: pm.DeleteProject(project_name), "project-delete-failed")
        if deleted is False:
            raise SmokeFailure("project-delete-failed")
    remaining = api_call(pm.GetProjectListInCurrentFolder, "project-cleanup-read-failed")
    if not isinstance(remaining, list) or project_name in remaining:
        raise SmokeFailure("project-delete-unverified")
    outcome["project_deleted"] = True
    return outcome


def worker_main(mode):
    """Run one bounded scripting phase; no worker phase calls Resolve.Quit."""
    expected_raw = env_value("RESOLVE_SMOKE_CHILD_PID")
    if not expected_raw.isdigit():
        raise SmokeFailure("worker-environment-invalid")
    expected_pid = int(expected_raw)
    project_name = env_value("RESOLVE_SMOKE_PROJECT")
    fixture = Path(env_value("RESOLVE_SMOKE_FIXTURE"))
    try:
        deadline_seconds = float(env_value("RESOLVE_SMOKE_DEADLINE_SECONDS"))
    except ValueError:
        raise SmokeFailure("worker-environment-invalid")
    deadline = time.monotonic() + max(1.0, deadline_seconds)

    resolve, pm = connect_resolve(deadline)
    if mode == "quit":
        if not wait_for_exact_pid(expected_pid, max(0.1, deadline - time.monotonic())):
            return {"ok": False, "error": {"code": "resolve-ownership-unproven"}, "cleanup": {"pid_set_exact_before_quit": False, "quit_requested": False}}
        api_call(resolve.Quit, "resolve-quit-failed")
        return {"ok": True, "cleanup": {"pid_set_exact_before_quit": True, "quit_requested": True}}

    if mode == "cleanup":
        cleanup = cleanup_owned_project(pm, project_name, expected_pid)
        cleanup["worker_cleanup_recovered"] = True
        return {"ok": True, "cleanup": cleanup}

    evidence = {}
    created = False
    cleanup = {"project_closed": False, "project_deleted": False}
    project = None
    try:
        version = api_call(resolve.GetVersionString, "resolve-read-failed")
        evidence["resolve_version"] = safe_text(version)
        existing = api_call(pm.GetProjectListInCurrentFolder, "project-list-read-failed")
        if not isinstance(existing, list) or project_name in existing:
            raise SmokeFailure("scratch-project-name-not-unique")

        # This is the first mutation. Ownership is proven immediately before it.
        require_owned(expected_pid)
        project = api_call(lambda: pm.CreateProject(project_name), "project-create-failed")
        if project is None:
            raise SmokeFailure("project-create-failed")
        created = True

        media_pool = api_call(project.GetMediaPool, "media-pool-read-failed")
        storage = api_call(resolve.GetMediaStorage, "media-storage-read-failed")
        root = api_call(media_pool.GetRootFolder, "media-pool-read-failed")

        require_owned(expected_pid)
        imported = api_call(lambda: storage.AddItemListToMediaPool([str(fixture)]), "media-import-failed")
        if not isinstance(imported, list) or len(imported) != 1:
            raise SmokeFailure("media-import-unverified")

        clips = api_call(root.GetClipList, "media-pool-read-failed")
        if not isinstance(clips, list) or len(clips) != 1:
            raise SmokeFailure("media-pool-clip-count-unexpected")
        clip = clips[0]
        clip_name = api_call(clip.GetName, "clip-read-failed")
        properties = {}
        for property_name, result_name in (
            ("File Path", "file_path"),
            ("Duration", "duration"),
            ("Resolution", "resolution"),
            ("Frame Rate", "frame_rate"),
            ("Video Codec", "video_codec"),
        ):
            try:
                properties[result_name] = clip.GetClipProperty(property_name)
            except Exception:
                properties[result_name] = None
        if safe_text(clip_name) != FIXTURE_NAME or not fixture_path_matches(properties["file_path"], fixture):
            raise SmokeFailure("clip-import-readback-mismatch")
        evidence.update(
            {
                "media_pool_clip_count": len(clips),
                "imported_clip_name": safe_text(clip_name),
                "file_path_matches_fixture": True,
                "duration": safe_text(properties["duration"]),
                "resolution": safe_text(properties["resolution"]),
                "frame_rate": safe_text(properties["frame_rate"]),
                "video_codec": safe_text(properties["video_codec"]),
                "pid_set_exact_before_mutation": True,
            }
        )

        require_owned(expected_pid)
        timeline_name = TIMELINE_PREFIX + project_name[len(PROJECT_PREFIX):]
        timeline = api_call(
            lambda: media_pool.CreateTimelineFromClips(timeline_name, [clip]),
            "timeline-create-failed",
        )
        if timeline is None:
            raise SmokeFailure("timeline-create-failed")
        timeline_count = api_call(project.GetTimelineCount, "timeline-read-failed")
        timeline_name_read = api_call(timeline.GetName, "timeline-read-failed")
        if timeline_count != 1 or timeline_name_read != timeline_name:
            raise SmokeFailure("timeline-readback-mismatch")
        item_count = 0
        for track_type in ("video", "audio"):
            track_count = api_call(lambda: timeline.GetTrackCount(track_type), "timeline-read-failed")
            if not isinstance(track_count, int) or track_count < 0 or track_count > 100:
                raise SmokeFailure("timeline-read-failed")
            for index in range(1, track_count + 1):
                items = api_call(
                    lambda track_type=track_type, index=index: timeline.GetItemListInTrack(track_type, index),
                    "timeline-read-failed",
                )
                if not isinstance(items, list):
                    raise SmokeFailure("timeline-read-failed")
                item_count += len(items)
        if item_count != 1:
            raise SmokeFailure("timeline-item-count-unexpected")
        evidence.update({"timeline_count": timeline_count, "timeline_exists": True, "timeline_item_count": item_count})
    except SmokeFailure:
        raise
    finally:
        if created:
            try:
                cleanup = cleanup_owned_project(pm, project_name, expected_pid)
            except SmokeFailure:
                cleanup = {"project_closed": False, "project_deleted": False}
    if not cleanup.get("project_deleted"):
        return {"ok": False, "error": {"code": "project-cleanup-failed"}, "evidence": evidence, "cleanup": cleanup}
    return {"ok": True, "evidence": evidence, "cleanup": cleanup}


def worker_entry(mode):
    try:
        emit_result(worker_main(mode))
        return 0
    except SmokeFailure as failure:
        emit_result({"ok": False, "error": {"code": failure.code}})
        return 1
    except Exception:
        emit_result({"ok": False, "error": {"code": "worker-failed"}})
        return 1


def run_worker(python, mode, env, timeout_seconds):
    process = subprocess.Popen(
        [python, str(Path(__file__).resolve()), "--worker", mode],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    output_limit = RESULT_LIMIT * 2
    output = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            for key, _ in selector.select(min(0.25, remaining)):
                chunk = key.fileobj.read1(4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if len(output) < output_limit:
                    output.extend(chunk[: output_limit - len(output)])
            if process.poll() is not None and not selector.get_map():
                break
    finally:
        selector.close()
    if timed_out:
        stop_process(process, term_seconds=1, kill_seconds=1)
        return None
    try:
        process.wait(timeout=max(0.1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        stop_process(process, term_seconds=1, kill_seconds=1)
        return None
    stdout = bytes(output).decode("utf-8", "replace")
    for line in reversed(stdout.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return sanitize_result(value)
    return None


def validate_file(path, executable=False):
    try:
        if not path.is_file():
            return False
        return not executable or os.access(str(path), os.X_OK)
    except OSError:
        return False


def remove_tempdir(tempdir):
    try:
        shutil.rmtree(tempdir)
    except OSError:
        return False
    return not tempdir.exists()


def parent_main():
    _install_termination_handlers()
    base_cleanup = {
        "project_closed": False,
        "project_deleted": False,
        "media_deleted": False,
        "quit_requested": False,
        "pid_set_exact_before_quit": False,
        "resolve_exit": "not-started",
        "resolve_residue": -1,
        "fuscript_residue": -1,
    }
    result = {"ok": False, "cleanup": base_cleanup}
    child = None
    tempdir = None
    project_name = PROJECT_PREFIX + uuid.uuid4().hex

    try:
        if sys.platform != "darwin":
            result["error"] = {"code": "unsupported-platform"}
            return result
        try:
            existing = target_pids()
        except SmokeFailure as failure:
            result["error"] = {"code": failure.code}
            return result
        if existing:
            result["error"] = {"code": "resolve-or-fuscript-already-active"}
            return result
        if not validate_file(RESOLVE_BINARY, executable=True) or not validate_file(SCRIPT_LIB):
            result["error"] = {"code": "resolve-install-invalid"}
            return result
        if not SCRIPT_API.is_dir() or not SCRIPT_MODULES.is_dir():
            result["error"] = {"code": "scripting-api-invalid"}
            return result

        repo_root = Path(__file__).resolve().parents[1]
        ffmpeg = repo_root / "tools" / "ffmpeg"
        if not validate_file(ffmpeg, executable=True):
            result["error"] = {"code": "repo-ffmpeg-invalid"}
            return result

        tempdir = Path(tempfile.mkdtemp(prefix="hdrtosdr-resolve-smoke-"))
        fixture = tempdir / FIXTURE_NAME
        if not run_quiet(build_fixture_command(ffmpeg, fixture), 20) or not fixture.is_file():
            result["error"] = {"code": "fixture-generation-failed"}
            return result

        env = build_script_env(SCRIPT_API, SCRIPT_LIB)
        env.update(
            {
                "RESOLVE_SMOKE_CHILD_PID": "0",
                "RESOLVE_SMOKE_PROJECT": project_name,
                "RESOLVE_SMOKE_FIXTURE": str(fixture),
                "RESOLVE_SMOKE_DEADLINE_SECONDS": "75",
            }
        )
        child = subprocess.Popen(build_resolve_command(RESOLVE_BINARY), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env["RESOLVE_SMOKE_CHILD_PID"] = str(child.pid)

        if child.pid is None or not wait_for_exact_pid(child.pid, 45):
            result["error"] = {"code": "resolve-child-ownership-unproven"}
            return result

        worker_result = run_worker(sys.executable, "main", env, 85)
        if worker_result is not None:
            result.update({key: value for key, value in worker_result.items() if key in ("ok", "error", "evidence", "cleanup")})
        else:
            result["error"] = {"code": "scripting-worker-timeout-or-invalid"}

        cleanup = result.setdefault("cleanup", dict(base_cleanup))
        if not cleanup.get("project_deleted"):
            recovered = run_worker(sys.executable, "cleanup", env, 35)
            if recovered is not None and recovered.get("cleanup", {}).get("project_deleted") is True:
                cleanup.update(recovered.get("cleanup", {}))
                cleanup["worker_cleanup_recovered"] = True

        if cleanup.get("project_deleted") and child.poll() is None:
            quit_result = run_worker(sys.executable, "quit", env, 35)
            if quit_result is not None:
                quit_cleanup = quit_result.get("cleanup", {})
                cleanup["pid_set_exact_before_quit"] = quit_cleanup.get("pid_set_exact_before_quit") is True
                cleanup["quit_requested"] = quit_cleanup.get("quit_requested") is True

    except KeyboardInterrupt:
        result["error"] = {"code": "interrupted"}
    except (OSError, subprocess.SubprocessError):
        result["error"] = {"code": "process-launch-or-cleanup-failed"}
    finally:
        if child is not None:
            if child.poll() is None:
                cleanup_kind = stop_process(child)
            else:
                cleanup_kind = "graceful"
            result.setdefault("cleanup", dict(base_cleanup))["resolve_exit"] = cleanup_kind
        if tempdir is not None:
            result.setdefault("cleanup", dict(base_cleanup))["media_deleted"] = remove_tempdir(tempdir)
        # Resolve can release its scripting helper shortly after the owned
        # app exits. Give that helper a bounded settle window before declaring
        # residue; unknown process state remains a cleanup failure.
        # This settle/count phase is interruption-safe: SIGTERM/SIGHUP/SIGINT
        # during time.sleep() must not escape the sanitized result path.
        try:
            residue_deadline = time.monotonic() + 10
            while time.monotonic() < residue_deadline:
                try:
                    if not target_pids():
                        break
                except SmokeFailure:
                    break
                except KeyboardInterrupt:
                    result["ok"] = False
                    result["error"] = {"code": "interrupted"}
                    break
                try:
                    time.sleep(POLL_SECONDS)
                except KeyboardInterrupt:
                    result["ok"] = False
                    result["error"] = {"code": "interrupted"}
                    break
            try:
                counts = process_counts()
                result.setdefault("cleanup", dict(base_cleanup)).update(counts)
            except SmokeFailure:
                result.setdefault("cleanup", dict(base_cleanup)).update({"resolve_residue": -1, "fuscript_residue": -1})
            except KeyboardInterrupt:
                result["ok"] = False
                result["error"] = {"code": "interrupted"}
                result.setdefault("cleanup", dict(base_cleanup)).update({"resolve_residue": -1, "fuscript_residue": -1})
        except KeyboardInterrupt:
            result["ok"] = False
            result["error"] = {"code": "interrupted"}
            result.setdefault("cleanup", dict(base_cleanup)).update({"resolve_residue": -1, "fuscript_residue": -1})

    cleanup = result.setdefault("cleanup", dict(base_cleanup))
    cleanup_ok = (
        cleanup.get("project_deleted") is True
        and cleanup.get("media_deleted") is True
        and cleanup.get("resolve_exit") in ("graceful", "terminated", "killed")
        and cleanup.get("resolve_residue") == 0
        and cleanup.get("fuscript_residue") == 0
    )
    result["ok"] = result.get("ok") is True and cleanup_ok
    if not result["ok"] and "error" not in result:
        result["error"] = {"code": "smoke-or-cleanup-failed"}
    return result


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker" and sys.argv[2] in ("main", "cleanup", "quit"):
        sys.exit(worker_entry(sys.argv[2]))
    final = parent_main()
    emit_result(final)
    sys.exit(0 if final.get("ok") is True else 1)
