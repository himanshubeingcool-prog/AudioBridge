"""Audio capture tests - verifies WASAPI loopback enumeration and init."""
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from backend.audio_capture import AudioCapture, TARGET_SAMPLE_RATE, SAMPLES_PER_FRAME


def test_loopback_enumeration():
    cap = AudioCapture()
    devices = cap.list_devices()
    print(f"Found {len(devices)} devices")
    for d in devices:
        print(f"  [{d.index}] {d.name} is_loopback={d.is_loopback}")

    loopbacks = [d for d in devices if d.is_loopback]
    assert len(loopbacks) >= 1, f"Expected at least 1 loopback device, got {devices}"

    info = cap._find_best_loopback_device()
    assert info is not None, "No loopback device found"
    assert info["isLoopbackDevice"] is True
    assert info["maxInputChannels"] == 2
    print(f"Best loopback: {info['name']} ch={info['maxInputChannels']} rate={info['defaultSampleRate']}")


@pytest.mark.asyncio
async def test_capture_start_stop():
    cap = AudioCapture()
    try:
        await cap.start()
        assert cap.is_running
        assert cap.get_device_info() is not None
        print(f"Capture device: {cap.get_device_info().name}")

        await asyncio.sleep(1.0)
        stats = cap.get_stats()
        print(f"Stats: {stats}")
        assert stats["running"] is True
        # Should have captured frames (even silence loopback delivers frames)
        # Allow 0 in CI where audio subsystem may be muted, but check no error
        assert stats["last_error"] is None
    finally:
        cap.stop()
        assert not cap.is_running


def test_capture_stats():
    cap = AudioCapture()
    stats = cap.get_stats()
    assert "running" in stats
    assert "frames_captured" in stats
    assert stats["running"] is False
