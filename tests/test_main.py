import unittest
import subprocess
import sys
import os
import time
import signal
import socket
import select
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestMainShutdown(unittest.TestCase):
    def test_sigterm_clean_shutdown(self):
        port = _free_port()
        cmd = [sys.executable, "-m", "prototype", "--port", str(port)]
        proc = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        try:
            # Wait until it prints serving URL
            output = ""
            start = time.time()
            serving_seen = False
            # Use select-based non-blocking read
            while time.time() - start < 5:
                if proc.poll() is not None:
                    # Process exited early, capture output
                    try:
                        rest = proc.stdout.read()
                        if rest:
                            output += rest
                    except Exception:
                        pass
                    break
                rlist, _, _ = select.select([proc.stdout], [], [], 0.2)
                if rlist:
                    line = proc.stdout.readline()
                    if line:
                        output += line
                        if "Serving on" in line:
                            serving_seen = True
                            break
                # Also check if output already contains marker (in case readline coalesced)
                if "Serving on" in output:
                    serving_seen = True
                    break

            if not serving_seen:
                # Drain and fail
                try:
                    # Try to collect any output for diagnostics
                    if proc.poll() is None:
                        # Read available
                        rlist, _, _ = select.select([proc.stdout], [], [], 0.5)
                        if rlist:
                            try:
                                output += proc.stdout.read()
                            except Exception:
                                pass
                    else:
                        try:
                            output += proc.stdout.read() or ""
                        except Exception:
                            pass
                except Exception:
                    pass
                self.fail(f"server did not print serving URL within timeout; output={output!r}")

            # Send SIGTERM
            try:
                proc.send_signal(signal.SIGTERM)
            except Exception:
                os.kill(proc.pid, signal.SIGTERM)

            # Require exit within short timeout
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.fail(f"process did not exit within timeout after SIGTERM; output={output!r}")

            # Collect remaining output
            try:
                # proc.stdout may still have buffered data
                remaining = proc.stdout.read() or ""
                output += remaining
            except Exception:
                pass
            # Also try communicate if needed for full drain (if not already closed)
            # Ensure we capture any flushed output via communicate when available
            # Use proc.communicate only if proc already waited to avoid deadlock
            # Already waited, so stdout is at EOF

            # Fallback: if output empty, try to read via communicate pathway
            # Not needed as we already read

            self.assertIn("Shutdown", output, f"stdout should contain 'Shutdown' after SIGTERM, got: {output!r}")
        finally:
            # Ensure cleanup if failing
            if proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    try:
                        proc.wait(timeout=2)
                    except Exception:
                        pass
            try:
                if proc.stdout:
                    proc.stdout.close()
            except Exception:
                pass
