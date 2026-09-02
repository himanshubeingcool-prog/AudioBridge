"""WASAPI loopback audio capture via PyAudioWPatch.

Uses PyAudioWPatch's WASAPI loopback devices to capture whatever Windows
is currently playing (YouTube, Spotify, games, etc.) without requiring
Stereo Mix. Falls back to Stereo Mix / default input if loopback unavailable.

The captured PCM is fed into an asyncio queue for consumption by the
WebRTC audio track.
"""
from __future__ import annotations

import asyncio
import logging
import queue
import struct
import threading
import time
from dataclasses import dataclass
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)

# Audio constants - WebRTC / Opus prefers 48 kHz stereo
TARGET_SAMPLE_RATE = 48000
TARGET_CHANNELS = 2
TARGET_FORMAT_BYTES = 2  # int16
FRAME_DURATION_MS = 20  # 20ms frames for Opus (960 samples at 48kHz)
SAMPLES_PER_FRAME = TARGET_SAMPLE_RATE * FRAME_DURATION_MS // 1000  # 960

# PyAudio format constant (paInt16 = 8)
_PA_INT16 = 8


@dataclass
class AudioDeviceInfo:
    index: int
    name: str
    sample_rate: float
    channels: int
    is_loopback: bool
    host_api: int


class AudioCapture:
    """WASAPI loopback audio capture.

    Usage:
        cap = AudioCapture()
        await cap.start()
        # read frames via cap.read_frame() or subscribe via cap callback
        cap.stop()
    """

    def __init__(
        self,
        sample_rate: int = TARGET_SAMPLE_RATE,
        channels: int = TARGET_CHANNELS,
        frame_duration_ms: int = FRAME_DURATION_MS,
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.frame_duration_ms = frame_duration_ms
        self.samples_per_frame = sample_rate * frame_duration_ms // 1000

        self._pa = None
        self._stream = None
        self._device_info: AudioDeviceInfo | None = None
        self._running = False
        self._thread: threading.Thread | None = None
        # One queue per peer (fan-out) for multi-device; legacy single-queue for compat
        self._queue: queue.Queue[bytes] = queue.Queue(maxsize=30)
        self._async_queue: asyncio.Queue[bytes] | None = None
        self._async_queues: list[asyncio.Queue[bytes]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._callbacks: list[Callable[[bytes], None]] = []
        self._frames_captured = 0
        self._bytes_captured = 0
        self._last_error: str | None = None
        self._dropped_frames = 0

    # ------------------------------------------------------------------
    # Device discovery
    # ------------------------------------------------------------------

    def list_devices(self) -> list[AudioDeviceInfo]:
        """List available capture devices (including loopback)."""
        devices: list[AudioDeviceInfo] = []
        try:
            import pyaudiowpatch as pyaudio

            pa = pyaudio.PyAudio()
            try:
                # WASAPI loopback devices
                try:
                    for info in pa.get_loopback_device_info_generator():
                        devices.append(
                            AudioDeviceInfo(
                                index=info["index"],
                                name=info["name"],
                                sample_rate=info["defaultSampleRate"],
                                channels=info["maxInputChannels"],
                                is_loopback=bool(info.get("isLoopbackDevice", False)),
                                host_api=info["hostApi"],
                            )
                        )
                except Exception:
                    pass

                # Also list regular input devices (fallback)
                for i in range(pa.get_device_count()):
                    try:
                        d = pa.get_device_info_by_index(i)
                        if d["maxInputChannels"] > 0 and not d.get("isLoopbackDevice", False):
                            devices.append(
                                AudioDeviceInfo(
                                    index=d["index"],
                                    name=d["name"],
                                    sample_rate=d["defaultSampleRate"],
                                    channels=d["maxInputChannels"],
                                    is_loopback=False,
                                    host_api=d["hostApi"],
                                )
                            )
                    except Exception:
                        continue
            finally:
                pa.terminate()
        except ImportError:
            logger.warning("pyaudiowpatch not installed")
        except Exception as e:
            logger.warning("list_devices failed: %s", e)
        return devices

    def _find_best_loopback_device(self) -> dict | None:
        """Find the best WASAPI loopback device (default output's loopback)."""
        try:
            import pyaudiowpatch as pyaudio

            pa = pyaudio.PyAudio()
            try:
                # Try to get the default WASAPI loopback (matches default output)
                try:
                    info = pa.get_default_wasapi_loopback()
                    if info is not None:
                        return info
                except Exception:
                    pass

                # Fallback: iterate loopback devices, prefer "Speakers (Realtek)"
                # which is typically the default playback device
                best = None
                for info in pa.get_loopback_device_info_generator():
                    name = info["name"]
                    # Prefer non-virtual devices (Realtek over Virtual)
                    if "Realtek" in name or "Speakers" in name:
                        if best is None or "Virtual" in best["name"]:
                            best = info
                    if best is None:
                        best = info
                return best
            finally:
                pa.terminate()
        except Exception as e:
            logger.warning("find_best_loopback_device failed: %s", e)
            return None

    def get_device_info(self) -> AudioDeviceInfo | None:
        return self._device_info

    def get_stats(self) -> dict:
        return {
            "running": self._running,
            "frames_captured": self._frames_captured,
            "bytes_captured": self._bytes_captured,
            "device": self._device_info.name if self._device_info else None,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "last_error": self._last_error,
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start capturing. Creates the PyAudio stream on a background thread."""
        if self._running:
            return

        self._last_error = None
        self._loop = asyncio.get_running_loop()
        # Small queue for lowest latency (5 frames = 100ms max live)
        self._async_queue = asyncio.Queue(maxsize=5)
        self._async_queues = []

        # Find loopback device
        loopback_info = self._find_best_loopback_device()
        if loopback_info is None:
            # Check if pyaudiowpatch is available at all
            try:
                import pyaudiowpatch  # noqa: F401
            except ImportError:
                self._last_error = "pyaudiowpatch not installed"
                raise RuntimeError("pyaudiowpatch is required for WASAPI loopback capture. Run: pip install pyaudiowpatch")

            # No loopback device found - try Stereo Mix fallback
            devices = self.list_devices()
            stereo_mix = next((d for d in devices if "Stereo Mix" in d.name), None)
            if stereo_mix is not None:
                logger.warning("No WASAPI loopback device found, using Stereo Mix: %s", stereo_mix.name)
                loopback_info = {
                    "index": stereo_mix.index,
                    "name": stereo_mix.name,
                    "defaultSampleRate": stereo_mix.sample_rate,
                    "maxInputChannels": stereo_mix.channels,
                    "isLoopbackDevice": False,
                    "hostApi": stereo_mix.host_api,
                }
            else:
                self._last_error = "No loopback or Stereo Mix device found"
                raise RuntimeError(
                    "No WASAPI loopback device found. Make sure you have an active playback device. "
                    "Available devices: " + ", ".join(d.name for d in devices[:5])
                )

        # Store device info for diagnostics
        self._device_info = AudioDeviceInfo(
            index=loopback_info["index"],
            name=loopback_info["name"],
            sample_rate=loopback_info["defaultSampleRate"],
            channels=loopback_info["maxInputChannels"],
            is_loopback=bool(loopback_info.get("isLoopbackDevice", False)),
            host_api=loopback_info["hostApi"],
        )

        # Determine effective sample rate - use device rate if it differs
        # We'll resample if needed (for now, try to use target rate)
        device_rate = int(loopback_info["defaultSampleRate"])
        # PyAudioWPatch loopback devices typically report 48000, which matches our target

        import pyaudiowpatch as pyaudio

        self._pa = pyaudio.PyAudio()

        # Accumulation buffer for converting variable-size PortAudio callbacks
        # into fixed 20ms frames for WebRTC
        self._accum = bytearray()
        self._accum_lock = threading.Lock()

        pa_format = pyaudio.paInt16
        # 10ms PortAudio buffer for lowest latency (WASAPI will use smallest stable)
        frames_per_buffer = self.samples_per_frame // 2  # 480 at 48kHz/10ms

        def _callback(in_data, frame_count, time_info, status):
            if status:
                logger.debug("Audio callback status: %s", status)
            # Accumulate and split into fixed frames
            with self._accum_lock:
                self._accum.extend(in_data)
                bytes_per_frame = self.samples_per_frame * self.channels * TARGET_FORMAT_BYTES
                while len(self._accum) >= bytes_per_frame:
                    frame_bytes = bytes(self._accum[:bytes_per_frame])
                    del self._accum[:bytes_per_frame]
                    self._frames_captured += 1
                    self._bytes_captured += len(frame_bytes)
                    # Push to sync queue (bounded, drop oldest if full)
                    try:
                        self._queue.put_nowait(frame_bytes)
                    except queue.Full:
                        try:
                            self._queue.get_nowait()
                        except queue.Empty:
                            pass
                        try:
                            self._queue.put_nowait(frame_bytes)
                        except queue.Full:
                            pass
                    # Fan-out to all per-peer async queues (multi-device) + legacy single queue
                    if self._loop:
                        def _fanout(data=frame_bytes):
                            for q in list(self._async_queues):
                                try:
                                    q.put_nowait(data)
                                except (asyncio.QueueFull, queue.Full):
                                    try:
                                        q.get_nowait()
                                    except Exception:
                                        pass
                                    try:
                                        q.put_nowait(data)
                                    except Exception:
                                        pass
                                except RuntimeError:
                                    pass
                            # Also legacy single queue (for old tracks / tests)
                            if self._async_queue is not None:
                                try:
                                    self._async_queue.put_nowait(data)
                                except (asyncio.QueueFull, queue.Full):
                                    try:
                                        self._async_queue.get_nowait()
                                    except Exception:
                                        pass
                                    try:
                                        self._async_queue.put_nowait(data)
                                    except Exception:
                                        pass

                        try:
                            self._loop.call_soon_threadsafe(_fanout)
                        except RuntimeError:
                            pass
                    # Callbacks
                    for cb in self._callbacks:
                        try:
                            cb(frame_bytes)
                        except Exception:
                            pass
            return (None, pyaudio.paContinue)

        try:
            self._stream = self._pa.open(
                format=pa_format,
                channels=self.channels,
                rate=self.sample_rate,
                frames_per_buffer=frames_per_buffer,
                input=True,
                input_device_index=loopback_info["index"],
                stream_callback=_callback,
            )
            self._stream.start_stream()
        except Exception as e:
            self._last_error = str(e)
            if self._pa:
                try:
                    self._pa.terminate()
                except Exception:
                    pass
                self._pa = None
            raise RuntimeError(f"Failed to open loopback stream on '{loopback_info['name']}': {e}") from e

        self._running = True
        logger.info("Audio capture started on '%s' (%d Hz, %d ch)", loopback_info["name"], self.sample_rate, self.channels)

    def stop(self) -> None:
        """Stop capturing and release resources."""
        self._running = False
        if self._stream is not None:
            try:
                if self._stream.is_active():
                    self._stream.stop_stream()
                self._stream.close()
            except Exception as e:
                logger.debug("Error closing stream: %s", e)
            self._stream = None
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None
        # Drain queues
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        if self._async_queue:
            while not self._async_queue.empty():
                try:
                    self._async_queue.get_nowait()
                except (asyncio.QueueEmpty, queue.Empty):
                    break
        logger.info("Audio capture stopped")

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue[bytes]:
        """Create a dedicated queue for a new peer (fan-out). Call unsubscribe on disconnect."""
        q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=5)
        self._async_queues.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[bytes]) -> None:
        try:
            self._async_queues.remove(q)
        except ValueError:
            pass

    def read_frame(self, timeout: float = 1.0) -> bytes | None:
        """Synchronous read of one 20ms frame. Returns None on timeout."""
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    async def read_frame_async(self, timeout: float = 1.0) -> bytes | None:
        """Async read of one 20ms frame (legacy single-consumer). Drains to newest."""
        if self._async_queue is None:
            return None
        try:
            frame = await asyncio.wait_for(self._async_queue.get(), timeout=timeout)
            # Keep only newest for lowest latency
            while not self._async_queue.empty():
                try:
                    frame = self._async_queue.get_nowait()
                except Exception:
                    break
            return frame
        except (asyncio.TimeoutError, asyncio.QueueEmpty):
            return None

    def get_latency_ms(self) -> float:
        """Approximate queue latency in ms."""
        qsize = self._async_queue.qsize() if self._async_queue else 0
        return qsize * self.frame_duration_ms

    def add_callback(self, cb: Callable[[bytes], None]) -> None:
        self._callbacks.append(cb)

    def remove_callback(self, cb: Callable[[bytes], None]) -> None:
        try:
            self._callbacks.remove(cb)
        except ValueError:
            pass

    @property
    def is_running(self) -> bool:
        return self._running
