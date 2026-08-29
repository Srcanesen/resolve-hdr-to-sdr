import argparse
import signal
import sys
import threading
from .server import create_server

def main():
    parser = argparse.ArgumentParser(description="HdrToSdr inspection prototype")
    parser.add_argument("--port", type=int, default=8765, help="port to bind (127.0.0.1 only)")
    args = parser.parse_args()

    try:
        httpd = create_server(args.port)
    except Exception as e:
        print(f"Failed to start server: {e}", file=sys.stderr)
        sys.exit(1)

    host, port = httpd.server_address
    url = f"http://{host}:{port}/"
    print(f"Serving on {url}")
    sys.stdout.flush()

    _shutdown_initiated = False

    def handle_sigint(signum, frame):
        nonlocal _shutdown_initiated
        if _shutdown_initiated:
            return
        _shutdown_initiated = True
        print("\nShutting down...")
        sys.stdout.flush()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print("Shutdown")

if __name__ == "__main__":
    main()
