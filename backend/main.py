"""FastAPI main application - HTTP + WebSocket signaling + WebRTC."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import secrets
import sys
import time
from pathlib import Path
from typing import Dict

import uvicorn
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .audio_capture import AudioCapture
from .network import get_lan_ip, get_all_lan_ips, generate_token, get_hostname, get_subnet_base
from .qr import generate_qr_base64, generate_qr_ascii
from .signaling import validate_token, parse_message
from .webrtc import PeerManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# Global state
TOKEN: str = ""
PAIRING_CODE: str = ""  # 6-digit numeric code, maps to TOKEN for easy entry
PORT: int = 8080
HOST: str = "0.0.0.0"
capture: AudioCapture | None = None
peer_manager: PeerManager | None = None
start_time: float = 0


def _check_auth(provided: str | None) -> bool:
    """Accept either the full token or the short pairing code."""
    if not TOKEN and not PAIRING_CODE:
        return True
    if not provided:
        return False
    # exact token match
    if provided == TOKEN:
        return True
    # pairing code match (normalize: strip spaces/dashes)
    norm = provided.strip().replace(" ", "").replace("-", "")
    if norm == PAIRING_CODE:
        return True
    return False

@asynccontextmanager
async def lifespan(app: FastAPI):
    global capture, peer_manager, start_time
    start_time = time.time()
    capture = AudioCapture()
    try:
        await capture.start()
        logger.info("Audio capture started")
    except Exception as e:
        logger.warning("Audio capture failed to start: %s", e)
        logger.warning("Server will run but audio will be silent until capture is available")
    peer_manager = PeerManager(capture)
    logger.info("Peer manager ready")
    yield
    if peer_manager:
        await peer_manager.remove_all()
    if capture:
        capture.stop()


# FastAPI app
app = FastAPI(title="PC Phone Speaker", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Frontend dir
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


# ------------------------------------------------------------------
# HTTP routes
# ------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "peers": peer_manager.peer_count if peer_manager else 0}


@app.get("/api/info")
async def api_info(request: Request, token: str | None = Query(default=None), code: str | None = Query(default=None)):
    provided = token or code
    if not _check_auth(provided):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    lan_ip = get_lan_ip()
    return {
        "token": TOKEN,
        "pairing_code": PAIRING_CODE,
        "lan_ip": lan_ip,
        "all_ips": get_all_lan_ips(),
        "port": PORT,
        "url": f"http://{lan_ip}:{PORT}/?token={TOKEN}" if lan_ip else None,
        "peers": peer_manager.peer_count if peer_manager else 0,
        "capture": capture.get_stats() if capture else None,
        "uptime": time.time() - start_time if start_time else 0,
    }


# Public endpoint: no auth needed, just returns pairing code status + LAN IPs for diagnostics
@app.get("/api/pairing")
async def api_pairing():
    lan_ip = get_lan_ip()
    return {
        "pairing_code": PAIRING_CODE,
        "lan_ip": lan_ip,
        "all_ips": get_all_lan_ips(),
        "port": PORT,
        "hostname": get_hostname(),
    }


@app.get("/api/discover")
async def api_discover():
    """Scan local subnet for other PC Speaker servers. Returns list of reachable devices."""
    import asyncio
    import socket as _sock

    subnet = get_subnet_base()
    if not subnet:
        return {"subnet": None, "devices": [], "self": {"hostname": get_hostname(), "ip": get_lan_ip(), "port": PORT}}

    # Fast scan: try to connect to port on each IP in subnet
    # Only check common range, limit concurrency
    async def check_ip(ip: str):
        try:
            # Use asyncio timeout for quick check
            reader, writer = await asyncio.wait_for(asyncio.open_connection(ip, PORT), timeout=0.35)
            # Try to fetch pairing info to confirm it's PC Speaker
            # Just check if port is open; detailed fetch is done by frontend if needed
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            # Now try HTTP fetch for confirmation
            import httpx

            async with httpx.AsyncClient(timeout=0.6) as client:
                r = await client.get(f"http://{ip}:{PORT}/api/pairing")
                if r.status_code == 200:
                    j = r.json()
                    return {
                        "ip": ip,
                        "hostname": j.get("hostname") or ip,
                        "pairing_code": j.get("pairing_code"),
                        "port": j.get("port", PORT),
                        "is_self": ip == get_lan_ip(),
                    }
                return {"ip": ip, "hostname": ip, "port": PORT, "is_self": ip == get_lan_ip()}
        except Exception:
            return None

    # Scan near-neighbors only (fast, low-impact) — 1..40 covers most home nets
    sem = asyncio.Semaphore(20)

    async def bounded_check(ip):
        async with sem:
            return await check_ip(ip)

    tasks = [bounded_check(f"{subnet}{i}") for i in range(1, 41)]
    results = await asyncio.gather(*tasks)
    devices = [r for r in results if r is not None]
    # Always include self
    if not any(d["is_self"] for d in devices):
        devices.insert(0, {"ip": get_lan_ip(), "hostname": get_hostname(), "pairing_code": PAIRING_CODE, "port": PORT, "is_self": True})

    return {"subnet": subnet + "0/24", "devices": devices, "self": {"hostname": get_hostname(), "ip": get_lan_ip(), "port": PORT}}


@app.get("/api/verify")
async def api_verify(token: str | None = Query(default=None), code: str | None = Query(default=None)):
    """Verify a token or pairing code without exposing the real token."""
    provided = token or code
    if _check_auth(provided):
        return {"ok": True, "token": TOKEN}
    return JSONResponse({"ok": False, "error": "invalid code"}, status_code=401)


@app.get("/api/qr")
async def api_qr(token: str | None = Query(default=None), code: str | None = Query(default=None)):
    provided = token or code
    if provided is not None and not _check_auth(provided):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    lan_ip = get_lan_ip()
    if not lan_ip:
        return JSONResponse({"error": "no LAN IP found"}, status_code=500)
    url = f"http://{lan_ip}:{PORT}/?token={TOKEN}"
    qr_b64 = generate_qr_base64(url)
    return {"url": url, "qr": qr_b64, "pairing_code": PAIRING_CODE}


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    # Serve frontend/index.html with token injection
    html_path = FRONTEND_DIR / "index.html"
    if not html_path.exists():
        return HTMLResponse("<h1>Frontend not found</h1><p>Run from project root.</p>", status_code=500)
    html = html_path.read_text(encoding="utf-8")
    # Inject token and config for the frontend
    # The frontend reads token from URL query param, so we just serve the file as-is
    # But we also inject a meta tag for the expected token (for WS auth)
    return HTMLResponse(html)


# Serve static files (app.js, styles.css) under /static and also at root for simplicity
# Mount frontend as static at /static, plus also handle direct file requests
if FRONTEND_DIR.exists():
    # Also serve files directly at /app.js, /styles.css for the HTML that references them as ./app.js
    @app.get("/app.js")
    async def serve_app_js():
        p = FRONTEND_DIR / "app.js"
        if p.exists():
            return HTMLResponse(p.read_text(encoding="utf-8"), media_type="application/javascript")
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.get("/styles.css")
    async def serve_styles():
        p = FRONTEND_DIR / "styles.css"
        if p.exists():
            return HTMLResponse(p.read_text(encoding="utf-8"), media_type="text/css")
        return JSONResponse({"error": "not found"}, status_code=404)


# ------------------------------------------------------------------
# WebSocket signaling
# ------------------------------------------------------------------

@app.websocket("/ws")
async def ws_signaling(websocket: WebSocket):
    # Accept either token or pairing code
    token = websocket.query_params.get("token", "") or websocket.query_params.get("code", "")
    if not _check_auth(token):
        await websocket.close(code=4401, reason="unauthorized")
        return

    await websocket.accept()
    peer_id = f"peer-{secrets.token_hex(4)}"
    logger.info("WS connected: %s", peer_id)

    # Ensure peer_manager exists (for tests without lifespan)
    global peer_manager, capture
    if peer_manager is None:
        if capture is None:
            capture = AudioCapture()
        peer_manager = PeerManager(capture)

    pc = None
    try:
        pc = await peer_manager.create_peer(peer_id)

        # Notify client that peer is ready
        await websocket.send_text(json.dumps({"type": "ready", "peer_id": peer_id}))

        while True:
            raw = await websocket.receive_text()
            msg = parse_message(raw)
            if not msg:
                await websocket.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue

            mtype = msg.get("type", "")

            if mtype == "offer":
                # Client sent SDP offer, create answer
                from aiortc import RTCSessionDescription

                sdp = msg.get("sdp", "")
                offer = RTCSessionDescription(sdp=sdp, type="offer")
                await pc.setRemoteDescription(offer)
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await websocket.send_text(json.dumps({"type": "answer", "sdp": pc.localDescription.sdp}))

            elif mtype == "ice-candidate" or mtype == "candidate":
                cand = msg.get("candidate")
                if cand:
                    from aiortc import RTCIceCandidate

                    # Parse candidate string
                    # aiortc expects RTCIceCandidate with sdpMid, sdpMLineIndex
                    try:
                        candidate = RTCIceCandidate(
                            sdpMid=msg.get("sdpMid", cand.get("sdpMid") if isinstance(cand, dict) else None),
                            sdpMLineIndex=msg.get("sdpMLineIndex", cand.get("sdpMLineIndex") if isinstance(cand, dict) else 0),
                            candidate=cand if isinstance(cand, str) else cand.get("candidate", ""),
                        )
                        await pc.addIceCandidate(candidate)
                    except Exception as e:
                        logger.warning("addIceCandidate failed: %s", e)

            elif mtype == "ping":
                await websocket.send_text(json.dumps({"type": "pong", "t": time.time()}))

            else:
                logger.debug("Unknown message type: %s", mtype)

    except WebSocketDisconnect:
        logger.info("WS disconnected: %s", peer_id)
    except Exception as e:
        logger.warning("WS error for %s: %s", peer_id, e)
    finally:
        if peer_id and peer_manager:
            try:
                await peer_manager.remove_peer(peer_id)
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


# ------------------------------------------------------------------
# Diagnostic mode
# ------------------------------------------------------------------

def run_diagnostic() -> None:
    print("=" * 60)
    print("PC Phone Speaker - Diagnostic")
    print("=" * 60)
    print(f"Python:        {platform.python_version()} ({sys.executable})")
    print(f"Platform:      {platform.platform()} {platform.machine()}")
    print(f"Windows:       {platform.version()}")

    # Audio devices
    print("\n--- Audio Devices ---")
    try:
        cap = AudioCapture()
        devices = cap.list_devices()
        if not devices:
            print("  No devices found!")
        for d in devices:
            flag = "[LOOPBACK]" if d.is_loopback else ""
            print(f"  [{d.index}] {d.name} | {d.channels}ch {d.sample_rate:.0f}Hz {flag}")
        # Try to find best loopback
        from .audio_capture import AudioCapture as AC

        ac = AC()
        info = ac._find_best_loopback_device()
        if info:
            print(f"\n  Best loopback: [{info['index']}] {info['name']}")
            print(f"  WASAPI loopback available: YES")
        else:
            print(f"\n  WASAPI loopback available: NO")
            print(f"  (Make sure an audio playback device is active)")
    except Exception as e:
        print(f"  Audio check failed: {e}")
        import traceback

        traceback.print_exc()

    # Network
    print("\n--- Network ---")
    lan_ip = get_lan_ip()
    all_ips = get_all_lan_ips()
    print(f"  LAN IP:        {lan_ip or 'NOT FOUND'}")
    print(f"  All IPs:       {all_ips}")
    print(f"  Port:          {PORT}")

    # Dependencies
    print("\n--- Dependencies ---")
    for pkg in ["fastapi", "uvicorn", "aiortc", "pyaudiowpatch", "numpy", "qrcode", "av"]:
        try:
            m = __import__(pkg)
            ver = getattr(m, "__version__", "?")
            print(f"  {pkg:16s} {ver}  OK")
        except ImportError:
            print(f"  {pkg:16s} NOT INSTALLED")

    # Port check
    print("\n--- Port Check ---")
    import socket as _sock

    s = _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", PORT))
        print(f"  Port {PORT} is available")
    except OSError as e:
        print(f"  Port {PORT} is IN USE: {e}")
        print(f"  Try: --port 8081")
    finally:
        s.close()

    print("\n" + "=" * 60)
    if lan_ip:
        print(f"  URL would be: http://{lan_ip}:{PORT}/?token=<token>")
        # Show current pairing code if server was started
        if PAIRING_CODE:
            print(f"  Pairing code: {PAIRING_CODE}")
    print("=" * 60)


# ------------------------------------------------------------------
# Startup / shutdown handled by lifespan above
# ------------------------------------------------------------------


def print_banner():
    lan_ip = get_lan_ip()
    all_ips = get_all_lan_ips()
    url = f"http://{lan_ip}:{PORT}/?token={TOKEN}" if lan_ip else f"http://<LAN_IP>:{PORT}/?token={TOKEN}"

    print()
    print("=" * 60)
    print("  PC PHONE SPEAKER")
    print("=" * 60)
    print(f"  Status:        PC Online")
    print(f"  URL:           {url}")
    if len(all_ips) > 1:
        for ip in all_ips[1:3]:
            print(f"  Also:          http://{ip}:{PORT}/?token={TOKEN}")
    print(f"  Pairing code:  {PAIRING_CODE}  (enter on iPhone if QR fails)")
    print(f"  Token:         {TOKEN}")
    print(f"  Port:          {PORT}")
    if lan_ip:
        try:
            qr_ascii = generate_qr_ascii(url)
            if qr_ascii:
                print()
                print("  Scan with iPhone:")
                print()
                for line in qr_ascii.split("\n"):
                    try:
                        print(f"    {line}")
                    except UnicodeEncodeError:
                        print(f"    [QR: {url}]")
                        break
                print()
        except Exception:
            pass
    else:
        print()
        print("  WARNING: Could not detect LAN IP!")
        print("  Make sure you're connected to Wi-Fi.")
        print("  Try: ipconfig")
    print()
    print("  iPhone: Scan QR or enter pairing code, then tap START SPEAKER")
    print("  Roles:  PC = Share Audio  |  iPhone = Receive Audio")
    print()
    print("  Firewall: If iPhone can't connect, allow Python")
    print("            through Windows Firewall (Private networks).")
    print("  Tip: If 'Could not connect', make sure both devices are on")
    print("       the same Wi-Fi (or PC hotspot) and server is running.")
    print("=" * 60)
    print()


def main():
    global TOKEN, PAIRING_CODE, PORT, HOST

    parser = argparse.ArgumentParser(description="PC Phone Speaker - Use iPhone as wireless speaker")
    parser.add_argument("--port", type=int, default=8080, help="HTTP port (default 8080)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Bind host (default 0.0.0.0)")
    parser.add_argument("--token", type=str, default=None, help="Custom token (default random)")
    parser.add_argument("--code", type=str, default=None, help="Custom 6-digit pairing code")
    parser.add_argument("--diagnostic", action="store_true", help="Run diagnostic checks and exit")
    parser.add_argument("--no-token", action="store_true", help="Disable token auth (not recommended)")
    args = parser.parse_args()

    PORT = args.port
    HOST = args.host

    if args.diagnostic:
        run_diagnostic()
        return

    if args.no_token:
        TOKEN = ""
        PAIRING_CODE = ""
    else:
        if args.token:
            TOKEN = args.token
        else:
            TOKEN = generate_token(12)
        if args.code:
            PAIRING_CODE = args.code.strip().replace(" ", "").replace("-", "")
        else:
            from .network import generate_pairing_code

            PAIRING_CODE = generate_pairing_code(6)

    # Check port available
    import socket as _sock

    s = _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM)
    try:
        s.bind((HOST, PORT))
    except OSError as e:
        print(f"ERROR: Port {PORT} is already in use: {e}")
        print(f"Try: python -m backend.main --port 8081")
        sys.exit(1)
    finally:
        s.close()

    # Check Python version
    if sys.version_info < (3, 10):
        print(f"WARNING: Python {platform.python_version()} is old. Recommend 3.12+")

    print_banner()

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
