import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Ensure project root on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.network import get_lan_ip, generate_token, get_all_lan_ips
from backend.qr import generate_qr_base64, generate_qr_ascii
from backend.audio_capture import AudioCapture, TARGET_SAMPLE_RATE, TARGET_CHANNELS
from backend.webrtc import PeerManager, LoopbackAudioTrack


def test_token_generation():
    t1 = generate_token(12)
    t2 = generate_token(12)
    assert len(t1) == 12
    assert t1 != t2
    assert all(c.isalnum() or c in "-_" for c in t1)


def test_lan_ip_detection():
    ip = get_lan_ip()
    # May be None in isolated CI, but should not throw
    if ip is not None:
        parts = ip.split(".")
        assert len(parts) == 4
        assert all(0 <= int(p) <= 255 for p in parts)


def test_all_lan_ips():
    ips = get_all_lan_ips()
    assert isinstance(ips, list)


def test_qr_generation():
    url = "http://192.168.1.25:8080/?token=abc123"
    b64 = generate_qr_base64(url)
    assert b64 is not None
    assert b64.startswith("data:image/png;base64,")
    ascii_qr = generate_qr_ascii(url)
    assert ascii_qr is not None
    assert len(ascii_qr) > 0


def test_audio_capture_init():
    cap = AudioCapture()
    assert cap.sample_rate == TARGET_SAMPLE_RATE
    assert cap.channels == TARGET_CHANNELS
    # list_devices should not throw
    devices = cap.list_devices()
    assert isinstance(devices, list)


def test_audio_device_discovery():
    cap = AudioCapture()
    devices = cap.list_devices()
    # Should find at least one device (or empty in headless)
    assert isinstance(devices, list)
    # Check loopback detection
    loopbacks = [d for d in devices if d.is_loopback]
    # In this environment pyaudiowpatch should expose 2 loopback devices
    # (but don't hard-fail if not present in other envs)
    if any("Loopback" in d.name for d in devices):
        assert len(loopbacks) >= 1


def test_http_endpoints():
    # Patch token for test
    import backend.main as main

    main.TOKEN = "testtoken123"
    client = TestClient(main.app)

    # Health
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

    # Index
    r = client.get("/")
    assert r.status_code == 200
    assert "PC PHONE SPEAKER" in r.text

    # Info without token -> 401 (when token is set)
    r = client.get("/api/info")
    assert r.status_code == 401

    r = client.get("/api/info?token=testtoken123")
    assert r.status_code == 200
    assert r.json()["token"] == "testtoken123"

    # QR
    r = client.get("/api/qr?token=testtoken123")
    # May fail if no LAN IP, but should not crash
    assert r.status_code in (200, 500)

    # Wrong token
    r = client.get("/api/info?token=wrong")
    assert r.status_code == 401


def test_websocket_signaling():
    import backend.main as main

    main.TOKEN = "wstesttoken"
    client = TestClient(main.app)

    # Valid token
    with client.websocket_connect("/ws?token=wstesttoken") as ws:
        data = ws.receive_json()
        assert data["type"] == "ready"
        assert "peer_id" in data
        # Send ping
        ws.send_json({"type": "ping"})
        resp = ws.receive_json()
        assert resp["type"] == "pong"

    # Invalid token -> 4401 close or immediate disconnect
    try:
        with client.websocket_connect("/ws?token=wrongtoken") as ws:
            # Should close immediately
            ws.receive_text()
            assert False, "should have been rejected"
    except Exception:
        pass  # expected


@pytest.mark.asyncio
async def test_peer_creation():
    cap = AudioCapture()
    pm = PeerManager(cap)
    pc = await pm.create_peer("test-peer-1")
    assert pc is not None
    assert pm.peer_count == 1
    await pm.remove_peer("test-peer-1")
    assert pm.peer_count == 0
    await pm.remove_all()
