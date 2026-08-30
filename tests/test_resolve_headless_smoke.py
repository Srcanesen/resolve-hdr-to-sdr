import importlib.util
import json
import signal
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve-headless-smoke.py"
SPEC = importlib.util.spec_from_file_location("resolve_headless_smoke", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TestResolveHeadlessSmokeHelpers(unittest.TestCase):
    def test_pid_set_parser_and_exact_ownership_are_fail_closed(self):
        self.assertEqual(MODULE.parse_pid_output("41\n42\n"), {41, 42})
        self.assertTrue(MODULE.owns_only_pid({42}, 42))
        self.assertFalse(MODULE.owns_only_pid({42, 43}, 42))
        self.assertFalse(MODULE.owns_only_pid(set(), 42))
        with self.assertRaises(ValueError):
            MODULE.parse_pid_output("42 nope\n")

    def test_resolve_command_is_direct_nogui_invocation(self):
        command = MODULE.build_resolve_command(Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve"))
        self.assertEqual(
            command,
            ["/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve", "-nogui"],
        )
        self.assertNotIn("open", command)
        self.assertNotIn("-a", command)

    def test_official_script_environment_is_explicit_and_bounded(self):
        env = MODULE.build_script_env(
            Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"),
            Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"),
            {"PYTHONPATH": "/existing"},
        )
        self.assertEqual(
            env["RESOLVE_SCRIPT_API"],
            "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
        )
        self.assertEqual(
            env["RESOLVE_SCRIPT_LIB"],
            "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
        )
        self.assertEqual(env["PYTHONPATH"].split(":")[-1], "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")

    def test_result_is_whitelisted_json_and_does_not_leak_paths(self):
        result = MODULE.sanitize_result(
            {
                "ok": True,
                "evidence": {
                    "resolve_version": "21.0.3",
                    "imported_clip_name": "fixture.mp4",
                    "unexpected_path": "/Users/.../source.mov",
                },
                "error": "ignored",
            }
        )
        encoded = json.dumps(result, separators=(",", ":"))
        self.assertTrue(result["ok"])
        self.assertNotIn("unexpected_path", result["evidence"])
        self.assertNotIn("/Users/.../", encoded)
        self.assertLessEqual(len(encoded), MODULE.RESULT_LIMIT)


class TestResolveHeadlessRobustnessFixes(unittest.TestCase):
    def test_termination_handler_raises_keyboard_interrupt(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.assertRaises(KeyboardInterrupt) as ctx:
                MODULE._on_termination_signal(sig, None)
            self.assertIn(str(int(sig)), str(ctx.exception))
        if hasattr(signal, "SIGHUP"):
            with self.assertRaises(KeyboardInterrupt):
                MODULE._on_termination_signal(signal.SIGHUP, None)

    def test_install_termination_handlers_registers_sigterm_sighup_sigint(self):
        calls = {}

        def fake_signal(sig, handler):
            calls[sig] = handler
            return None

        with mock.patch.object(MODULE.signal, "signal", side_effect=fake_signal):
            MODULE._install_termination_handlers()
        self.assertIs(calls.get(signal.SIGTERM), MODULE._on_termination_signal)
        self.assertIs(calls.get(signal.SIGINT), MODULE._on_termination_signal)
        if hasattr(signal, "SIGHUP"):
            self.assertIs(calls.get(signal.SIGHUP), MODULE._on_termination_signal)

    def test_scratch_project_suffix_uses_public_uuid_hex(self):
        fake_uuid = mock.MagicMock()
        fake_uuid.hex = "abc123def456abc123def456abc123ab"
        with mock.patch.object(MODULE.uuid, "uuid4", return_value=fake_uuid):
            suffix = MODULE.uuid.uuid4().hex
            name = MODULE.PROJECT_PREFIX + suffix
            self.assertEqual(name, "HdrToSdr_ResolveSmoke_abc123def456abc123def456abc123ab")
            self.assertEqual(len(suffix), 32)
        source = Path(MODULE.__file__).read_text()
        self.assertIn("uuid.uuid4().hex", source)
        self.assertNotIn("_get_candidate_names", source)

    def test_parent_main_interrupted_is_sanitized_and_runs_finally_cleanup(self):
        # Deterministic offline interrupted path: parent_main must catch
        # KeyboardInterrupt raised from a termination signal and still run
        # owned child/temp/residue cleanup in finally, emitting sanitized
        # interrupted failure without launching Resolve.
        fake_tempdir = Path("/tmp/hdrtosdr-resolve-smoke-test")
        fake_child = mock.MagicMock()
        fake_child.pid = 424242
        fake_child.poll.return_value = None
        with mock.patch.object(MODULE, "_install_termination_handlers", lambda: None), \
             mock.patch.object(MODULE.sys, "platform", "darwin"), \
             mock.patch.object(MODULE, "target_pids", return_value=set()), \
             mock.patch.object(MODULE, "validate_file", return_value=True), \
             mock.patch.object(MODULE.Path, "is_dir", return_value=True), \
             mock.patch.object(MODULE.tempfile, "mkdtemp", return_value=str(fake_tempdir)), \
             mock.patch.object(MODULE, "run_quiet", return_value=True), \
             mock.patch.object(MODULE, "build_script_env", return_value={}), \
             mock.patch.object(MODULE.subprocess, "Popen", return_value=fake_child), \
             mock.patch.object(MODULE, "wait_for_exact_pid", side_effect=KeyboardInterrupt("signal-15")), \
             mock.patch.object(MODULE, "stop_process", return_value="terminated") as mock_stop, \
             mock.patch.object(MODULE, "remove_tempdir", return_value=True) as mock_rm, \
             mock.patch.object(MODULE, "process_counts", return_value={"resolve_residue": 0, "fuscript_residue": 0}), \
             mock.patch.object(MODULE.Path, "is_file", return_value=True):
            result = MODULE.parent_main()
        sanitized = MODULE.sanitize_result(result)
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("error", {}).get("code"), "interrupted")
        self.assertEqual(sanitized.get("error", {}).get("code"), "interrupted")
        self.assertIn("scope", sanitized)
        mock_stop.assert_called_once_with(fake_child)
        mock_rm.assert_called_once_with(fake_tempdir)

    def test_parent_main_interrupt_during_finally_residue_settle_is_interruption_safe(self):
        # P1 gap: SIGTERM/SIGHUP/SIGINT during finally residue settle
        # time.sleep() must not escape sanitized path. Inject interrupt
        # specifically during finally's sleep and prove parent_main returns
        # sanitized interrupted failure, child/temp cleanup still happen,
        # and no KeyboardInterrupt escapes.
        fake_tempdir = Path("/tmp/hdrtosdr-resolve-smoke-test-residue-interrupt")
        fake_child = mock.MagicMock()
        fake_child.pid = 424243
        fake_child.poll.return_value = None

        call_count = {"n": 0}

        def fake_target_pids():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return set()
            return {999}

        def fake_run_worker(python, mode, env, timeout_seconds):
            if mode == "main":
                return {
                    "ok": True,
                    "evidence": {},
                    "cleanup": {
                        "project_closed": True,
                        "project_deleted": True,
                    },
                }
            if mode == "quit":
                return {"ok": True, "cleanup": {"pid_set_exact_before_quit": True, "quit_requested": True}}
            return None

        with mock.patch.object(MODULE, "_install_termination_handlers", lambda: None), \
             mock.patch.object(MODULE.sys, "platform", "darwin"), \
             mock.patch.object(MODULE, "target_pids", side_effect=fake_target_pids), \
             mock.patch.object(MODULE, "validate_file", return_value=True), \
             mock.patch.object(MODULE.Path, "is_dir", return_value=True), \
             mock.patch.object(MODULE.tempfile, "mkdtemp", return_value=str(fake_tempdir)), \
             mock.patch.object(MODULE, "run_quiet", return_value=True), \
             mock.patch.object(MODULE, "build_script_env", return_value={}), \
             mock.patch.object(MODULE.subprocess, "Popen", return_value=fake_child), \
             mock.patch.object(MODULE, "wait_for_exact_pid", return_value=True), \
             mock.patch.object(MODULE, "run_worker", side_effect=fake_run_worker), \
             mock.patch.object(MODULE, "stop_process", return_value="terminated") as mock_stop, \
             mock.patch.object(MODULE, "remove_tempdir", return_value=True) as mock_rm, \
             mock.patch.object(MODULE, "process_counts", return_value={"resolve_residue": 0, "fuscript_residue": 0}), \
             mock.patch.object(MODULE.time, "sleep", side_effect=KeyboardInterrupt("signal-15")), \
             mock.patch.object(MODULE.Path, "is_file", return_value=True):
            try:
                result = MODULE.parent_main()
            except KeyboardInterrupt:
                self.fail("KeyboardInterrupt escaped parent_main residue settle path")
            except Exception as exc:
                self.fail(f"unexpected exception escaped: {exc!r}")

        sanitized = MODULE.sanitize_result(result)
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("error", {}).get("code"), "interrupted")
        self.assertEqual(sanitized.get("error", {}).get("code"), "interrupted")
        self.assertIn("scope", sanitized)
        self.assertFalse(sanitized.get("ok") is True)
        mock_stop.assert_called_once_with(fake_child)
        mock_rm.assert_called_once_with(fake_tempdir)
        cleanup = result.get("cleanup", {})
        self.assertIn("resolve_residue", cleanup)
        self.assertIn("fuscript_residue", cleanup)


if __name__ == "__main__":
    unittest.main()
