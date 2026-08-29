import os
import json
import stat
import hashlib
import tempfile
import mimetypes
import shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import urlparse

from .contracts import Classification, ClassificationResult, InspectionEvidence
from .classifier import classify
from .inspector import inspect_local_path, inspect_temp_file, get_ffprobe_executable

# Separate upload-protocol cap (not user-source path limit). Browser upload is the only
# remaining 32 MiB enforcement; Electron local-path inspection has no size cap.
MAX_UPLOAD_BYTES = 32 * 1024 * 1024

REPO_ROOT = Path(__file__).resolve().parents[1]

# CSP and no-store headers
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
NO_STORE = "no-store"


def _sanitize_x_filename(v: str) -> str:
    if not v:
        return "upload"
    # take basename, filter
    name = v.strip().split("/")[-1].split("\\")[-1]
    name = name[:255]
    name = "".join(c for c in name if c.isprintable() and c not in "\0\r\n")
    # remove path traversal patterns
    name = name.replace("..", "")
    if not name:
        name = "upload"
    # ensure extension .mov/.mp4 else keep but display only
    # sanitize further: allow alphanum . _ -
    # keep as is for display but remove dangerous chars
    # For display only, we keep cleaned name
    return name


class Handler(BaseHTTPRequestHandler):
    # per-connection socket timeout so slow clients do not consume an unbounded thread
    timeout = 15

    # explicit static routes
    STATIC_MAP = {
        "/": "index.html",
        "/index.html": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
    }

    def _set_common_headers(self, content_type="text/html; charset=utf-8", content_length=None):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", NO_STORE)
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.send_header("Content-Type", content_type)
        if content_length is not None:
            self.send_header("Content-Length", str(content_length))

    def send_error(self, code, message=None, explain=None):
        # Override to ensure CSP, no-store and Connection: close on every error/404.
        try:
            short, longmsg = self.responses[code]
        except KeyError:
            short, longmsg = ("???", "???")
        msg = message if message else short
        reason = "not_found" if code == 404 else (msg.lower().replace(" ", "_") if msg else str(code))
        obj = {
            "error": reason,
            "classification": Classification.uncertain.value,
            "reason": reason,
            "canConvert": False,
        }
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code, msg)
        self._set_common_headers(content_type="application/json; charset=utf-8", content_length=len(body))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _serve_static(self, filename: str):
        web_root = REPO_ROOT / "prototype" / "web"
        path = (web_root / filename).resolve()
        # ensure within web root and explicit allowlist
        try:
            path.relative_to(web_root.resolve())
        except ValueError:
            self.send_error(404, "Not Found")
            return
        if not path.is_file():
            self.send_error(404, "Not Found")
            return
        # only allow listed files
        # check filename in allowed set
        allowed = set(Handler.STATIC_MAP.values())
        if filename not in allowed:
            self.send_error(404, "Not Found")
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if filename.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif filename.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif filename.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        self.send_response(200)
        self._set_common_headers(content_type=ctype, content_length=len(data))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path
        if p in Handler.STATIC_MAP:
            return self._serve_static(Handler.STATIC_MAP[p])
        # health? not needed
        self.send_error(404, "Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path

        if p == "/api/inspect-path":
            return self._handle_inspect_path()
        elif p == "/api/inspect-upload":
            return self._handle_inspect_upload()
        else:
            self.send_error(404, "Not Found")

    def _handle_inspect_path(self):
        # read bounded body
        clen = self.headers.get("Content-Length")
        try:
            n = int(clen) if clen is not None else 0
        except:
            n = 0
        if n <= 0 or n > 8192:
            self._json_error(400, "invalid_content_length")
            return
        try:
            body = self.rfile.read(n)
            if len(body) != n:
                self._json_error(400, "incomplete_body")
                return
            payload = json.loads(body.decode("utf-8"))
            path_val = payload.get("path")
            if not isinstance(path_val, str) or not path_val:
                self._json_error(400, "missing_path")
                return
        except json.JSONDecodeError:
            self._json_error(400, "invalid_json")
            return
        except Exception:
            self._json_error(400, "invalid_request")
            return

        ev, err = inspect_local_path(path_val, REPO_ROOT)

        if err is not None and ev is None:
            # validation / probe failure -> fail closed uncertain, no path leak
            # Map errors to reason codes
            # Return 400 for path boundary violations, 200 with uncertain for probe failures? Spec says fail closed with uncertain.
            # For boundary errors, return 400 with classification uncertain but no path.
            # Use 400 to indicate invalid input while still returning privacy-safe payload
            dummy_ev = InspectionEvidence(
                sha256="",
                size=0,
                display_name=_sanitize_x_filename(Path(path_val).name) if path_val else "unknown",
                parse_ok=False,
                parse_error=err,
            )
            # But we shouldn't expose sha for invalid path; use zeroed?
            # For boundary errors, we produce uncertain result with minimal fields
            # To keep privacy, we will not echo size/sha for invalid paths; instead produce error json
            if err in ("not_absolute", "unsupported_extension", "symlink_rejected", "is_directory", "not_regular_file", "resolve_failed", "stat_failed", "root_escape", "not_found", "sample_root_missing"):
                self._json_error(400, err)
                return
            # For ffprobe errors, return uncertain 200
            cr = ClassificationResult(
                classification=Classification.uncertain,
                reason=err or "inspect_failed",
                can_convert=False,
                evidence=InspectionEvidence(
                    sha256="",
                    size=0,
                    display_name=_sanitize_x_filename(Path(path_val).name),
                    parse_ok=False,
                ),
            )
            resp = cr.to_response_dict()
            # Remove empty sha/size for probe failures? Keep but empty
            # Ensure no path leak
            # Override to not include empty sha? Keep consistent but privacy says no raw path – we already sanitize
            # Remove empty fields for probe error to avoid confusion
            resp.pop("sha256", None)
            resp.pop("size", None)
            self._json_response(200, resp)
            return

        if ev is not None and err is not None and not ev.parse_ok:
            # parse failed -> uncertain
            cr = classify(ev)
            resp = cr.to_response_dict()
            # privacy: already sanitized
            self._json_response(200, resp)
            return

        if ev is None:
            self._json_error(400, err or "unknown_error")
            return

        # success inspection
        cr = classify(ev)
        resp = cr.to_response_dict()
        self._json_response(200, resp)

    def _handle_inspect_upload(self):
        # Require Content-Length >0 and <= MAX_UPLOAD_BYTES (upload-protocol cap only)
        clen_h = self.headers.get("Content-Length")
        if clen_h is None:
            self._json_error(400, "missing_content_length")
            return
        try:
            clen = int(clen_h)
        except:
            self._json_error(400, "invalid_content_length")
            return
        if clen <= 0 or clen > MAX_UPLOAD_BYTES:
            self._json_error(400, "invalid_content_length")
            return

        # content-type must be application/octet-stream (allow missing? require)
        ctype = self.headers.get("Content-Type", "")
        # Enforce octet-stream, but tolerate without charset?
        if ctype and "application/octet-stream" not in ctype:
            # reject non-octet?
            # For strictness, allow only octet-stream; otherwise 400
            self._json_error(400, "invalid_content_type")
            return

        xfname = self.headers.get("X-Filename", "upload")
        display_hint = _sanitize_x_filename(xfname)

        # Stream exactly Content-Length bytes directly into private 0600 temp file in bounded chunks
        tmpdir = None
        tmpfile = None
        hasher = hashlib.sha256()
        written = 0

        def _cleanup():
            try:
                if tmpfile is not None and Path(tmpfile).exists():
                    Path(tmpfile).unlink()
            except:
                pass
            try:
                if tmpdir is not None and Path(tmpdir).exists():
                    shutil.rmtree(tmpdir, ignore_errors=True)
            except:
                pass

        try:
            tmpdir = tempfile.mkdtemp(prefix="hdr_upload_")
            os.chmod(tmpdir, 0o700)
            suffix = Path(display_hint).suffix.lower()
            if suffix not in (".mov", ".mp4"):
                suffix = ".bin"
            tmpfile = Path(tmpdir) / ("upload" + suffix)
            # stream bounded chunks directly to file without retaining in memory
            try:
                with open(tmpfile, "wb") as out:
                    remaining = clen
                    while remaining > 0:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        hasher.update(chunk)
                        written += len(chunk)
                        remaining -= len(chunk)
                        if written > MAX_UPLOAD_BYTES:
                            _cleanup()
                            self._json_error(400, "oversize")
                            return
                    if written != clen:
                        _cleanup()
                        self._json_error(400, "incomplete_body")
                        return
                os.chmod(tmpfile, 0o600)
            except Exception:
                # read/write failure includes truncated body already handled
                # if we haven't already sent a response, send generic
                _cleanup()
                try:
                    self._json_error(400, "read_failed")
                except Exception:
                    pass
                return

            # Inspect temp file
            ev, err = inspect_temp_file(
                tmpfile, display_hint, REPO_ROOT,
                precomputed_sha256=hasher.hexdigest(),
            )

            if ev is None and err is not None:
                # Map oversize etc
                if err in ("oversize_or_empty", "stat_failed", "hash_failed"):
                    _cleanup()
                    self._json_error(400, err)
                    return
                # ffprobe failures -> uncertain 200
                dummy = InspectionEvidence(
                    sha256=hasher.hexdigest(),
                    size=written,
                    display_name=display_hint,
                    parse_ok=False,
                )
                cr = ClassificationResult(
                    classification=Classification.uncertain,
                    reason=err or "inspect_failed",
                    can_convert=False,
                    evidence=dummy,
                )
                # Build privacy-safe response without leaking ffprobe stderr
                # Use dummy evidence but classification uncertain
                # We can construct response directly without exposing raw bytes
                resp = cr.to_response_dict()
                _cleanup()
                self._json_response(200, resp)
                return

            if ev is not None and err is not None and not ev.parse_ok:
                cr = classify(ev)
                resp = cr.to_response_dict()
                _cleanup()
                self._json_response(200, resp)
                return

            # success
            cr = classify(ev)
            resp = cr.to_response_dict()
            _cleanup()
            self._json_response(200, resp)

        finally:
            # Always delete temp file and directory; never retain uploaded bytes in memory
            _cleanup()

    def _json_response(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._set_common_headers(content_type="application/json; charset=utf-8", content_length=len(body))
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code: int, reason: str):
        # Privacy: no path, no stderr, no GPS, no raw bytes
        obj = {
            "error": reason,
            "classification": Classification.uncertain.value,
            "reason": reason,
            "canConvert": False,
        }
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._set_common_headers(content_type="application/json; charset=utf-8", content_length=len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Suppress default logging or keep minimal
        pass


def create_server(port: int = 8765) -> ThreadingHTTPServer:
    # Validate ffprobe exists at startup
    ffprobe = get_ffprobe_executable(REPO_ROOT)
    # Ensure absolute
    if not ffprobe.is_absolute():
        raise RuntimeError("ffprobe must be absolute")

    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, Handler)
    httpd.daemon_threads = True
    httpd.allow_reuse_address = True
    return httpd


def run_server(port: int = 8765):
    httpd = create_server(port)
    host, p = httpd.server_address
    url = f"http://{host}:{p}/"
    print(f"Serving on {url} (127.0.0.1 only, prototype)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print("\nShutdown")
