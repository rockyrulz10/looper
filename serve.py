"""
Local dev server for the Looper PWA.

Runs two servers:
  - HTTPS on port 8443, serving the app itself (mic access requires a secure
    context, so this is the URL you open on your iPhone).
  - Plain HTTP on port 8080, serving ONLY certs/ca.crt, so Safari can fetch
    the root CA and offer to install it as a trusted profile (a plain file
    download does not need HTTPS, avoiding the chicken-and-egg problem of
    fetching a cert over a connection nothing trusts yet).

Both bind 0.0.0.0 so other devices on the same Wi-Fi (e.g. your iPhone) can
reach them via this machine's LAN IP.
"""
import http.server
import ssl
import socketserver
import threading
import os
import socket

ROOT = os.path.dirname(os.path.abspath(__file__))
CERTS = os.path.join(ROOT, "certs")
HTTPS_PORT = 8443
CERT_HTTP_PORT = 8080


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class AppHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Never cache during development so edits show up on reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class CertOnlyHandler(http.server.BaseHTTPRequestHandler):
    """Serves only certs/ca.crt, with the MIME type iOS needs to offer
    installing it as a configuration profile."""

    def do_GET(self):
        if self.path in ("/", "/ca.crt", "/ca.pem"):
            path = os.path.join(CERTS, "ca.crt")
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="looper-ca.crt"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        print(f"[cert-server] {self.address_string()} - {fmt % args}")


def run_https():
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", HTTPS_PORT), AppHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(
        certfile=os.path.join(CERTS, "server-cert.pem"),
        keyfile=os.path.join(CERTS, "server-key.pem"),
    )
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"[https] serving {ROOT} on https://0.0.0.0:{HTTPS_PORT}")
    httpd.serve_forever()


def run_cert_http():
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", CERT_HTTP_PORT), CertOnlyHandler)
    print(f"[http]  serving certs/ca.crt on http://0.0.0.0:{CERT_HTTP_PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    ip = get_lan_ip()
    print("=" * 60)
    print(" Looper local server")
    print("=" * 60)
    print(f" 1) On your iPhone, first install the CA cert:")
    print(f"      http://{ip}:{CERT_HTTP_PORT}/ca.crt")
    print(f" 2) Then open the app:")
    print(f"      https://{ip}:{HTTPS_PORT}/")
    print("=" * 60)

    t = threading.Thread(target=run_cert_http, daemon=True)
    t.start()
    run_https()
