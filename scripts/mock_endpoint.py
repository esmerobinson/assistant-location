#!/usr/bin/env python3
"""Tiny mock of the location-ingest server, for the simulator test. Logs every
received POST body to a file so the CI can assert the app sent a well-formed
location payload. Mirrors the real server's /overland contract.

The Authorization scheme is logged alongside the body because the real server
rejects on auth, and a mock that accepts everything cannot see that. A build
that captured points, posted them, and carried no Authorization header looked
completely green here while the real server answered 401 auth=none.
"""
import base64
import http.server
import json
import sys

LOG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/received.log"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8399

# Smallest possible valid PNG (1x1 transparent pixel) -- for GET
# /sessions/upload/<id>, standing in for the real location-server's stored
# upload. Real bytes, not a stub string, since session.html renders this
# straight into an <img src> and a non-image body would show as a broken
# image in a screenshot the same way a wrong id would.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY"
    "42YAAAAASUVORK5CYII="
)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace")
        header = self.headers.get("Authorization", "")
        # Scheme only, never the credential.
        scheme = header.split(" ")[0] if header else "none"
        with open(LOG, "a") as f:
            f.write(f"POST {self.path} auth={scheme}\n{body}\n---\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"result":"ok"}')

    # GET /sessions/projects and GET /sessions/recent -- added for the
    # Sessions sim-test coverage (session.html's loadProjects()/loadRecent(),
    # via GLWebModuleViewController's UITEST_WEBPAGE_API_BASE hook). Logged
    # the same way POST is, so the workflow step can grep this file for
    # "GET /sessions/projects auth=Bearer" as proof the request actually
    # reached a server with the real Authorization header, not just that the
    # page rendered its non-error state (which alone would only prove the
    # error PATH, never the real one -- see GLWebModuleViewController.m's
    # bootScriptSource comment on why CI never exercised this before).
    def do_GET(self):
        header = self.headers.get("Authorization", "")
        scheme = header.split(" ")[0] if header else "none"
        with open(LOG, "a") as f:
            f.write(f"GET {self.path} auth={scheme}\n---\n")

        # GET /sessions/upload/<id> -- mirrors the real server's stored-upload
        # fetch (see ShareToDesktop's /sessions/upload contract). Serves a
        # real tiny PNG rather than JSON, since this is what session.html's
        # addAttachments() is expected to render into an <img src>.
        if self.path.startswith("/sessions/upload/"):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(TINY_PNG)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        # Load-bearing: session.html runs from file://, so this fetch is
        # cross-origin and WebKit rejects the response without it.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.path.startswith("/sessions/projects"):
            self.wfile.write(json.dumps({"projects": ["assistant"]}).encode())
        elif self.path.startswith("/sessions/recent"):
            self.wfile.write(json.dumps({"sessions": []}).encode())
        else:
            self.wfile.write(b'{"result":"ok"}')

    # CORS preflight. The page's fetches carry an Authorization header, so
    # WebKit sends OPTIONS first; without this handler BaseHTTPRequestHandler
    # answers 501, the GET is never sent, and the page shows "Load failed"
    # (sim-test run 34773801122). Mirrors location-server's preflight answer.
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Filename")
        self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    open(LOG, "w").close()
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
