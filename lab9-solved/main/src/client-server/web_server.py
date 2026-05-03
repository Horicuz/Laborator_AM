"""Simple HTTP server for the web/ directory."""

import http.server
import socket
import socketserver
from pathlib import Path

PORT = 4321
_WEB_ROOT = Path(__file__).resolve().parent.parent.parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(_WEB_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        pass  # suppress per-request logs


class Server(socketserver.TCPServer):
    def server_bind(self):
        # SO_REUSEADDR + SO_REUSEPORT  needed on macOS to rebind immediately
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except AttributeError:
            pass  # SO_REUSEPORT not available on all platforms
        super().server_bind()


with Server(("", PORT), Handler) as httpd:
    print(f"Web server running on http://localhost:{PORT}")
    httpd.serve_forever()
