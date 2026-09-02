"""WebRTC peer management and custom audio track fed by WASAPI loopback."""
from __future__ import annotations

import asyncio
import fractions
import logging
import time
from typing import Dict

import numpy as np
from av import AudioFrame
from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer
from aiortc.mediastreams import MediaStreamTrack
from aiortc.rtcrtpsender import RTCRtpSender

from .audio_capture import AudioCapture, TARGET_SAMPLE_RATE, TARGET_CHANNELS, SAMPLES_PER_FRAME

logger = logging.getLogger(__name__)


class LoopbackAudioTrack(MediaStreamTrack):
    """Audio track that pulls 20ms PCM frames from AudioCapture and emits AudioFrames.
    Each track gets its own fan-out queue so multiple iPhones can listen simultaneously.
    """

    kind = "audio"

    def __init__(self, capture: AudioCapture) -> None:
        super().__init__()
        self._capture = capture
        self._queue = capture.subscribe()  # dedicated low-latency queue (5 frames)
        self._timestamp = 0
        self._sample_rate = TARGET_SAMPLE_RATE
        self._channels = TARGET_CHANNELS
        self._samples_per_frame = SAMPLES_PER_FRAME
        self._frame_duration = fractions.Fraction(1, self._sample_rate) * self._samples_per_frame
        self._start_time: float | None = None

    def stop(self):
        # Unsubscribe on track stop
        try:
            self._capture.unsubscribe(self._queue)
        except Exception:
            pass
        super().stop()

    async def recv(self) -> AudioFrame:
        # Per-peer queue, drain to newest for lowest latency, no share conflict
        try:
            frame_bytes = await asyncio.wait_for(self._queue.get(), timeout=0.05)
            while not self._queue.empty():
                try:
                    frame_bytes = self._queue.get_nowait()
                except Exception:
                    break
        except (asyncio.TimeoutError, asyncio.QueueEmpty):
            frame_bytes = None

        if frame_bytes is None:
            pcm = np.zeros((self._samples_per_frame * self._channels,), dtype=np.int16)
        else:
            pcm = np.frombuffer(frame_bytes, dtype=np.int16)
            expected = self._samples_per_frame * self._channels
            if len(pcm) < expected:
                pcm = np.pad(pcm, (0, expected - len(pcm)))
            elif len(pcm) > expected:
                pcm = pcm[:expected]

        frame = AudioFrame(format="s16", layout="stereo" if self._channels == 2 else "mono", samples=self._samples_per_frame)
        frame.sample_rate = self._sample_rate
        frame.planes[0].update(pcm.tobytes())
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        self._timestamp += self._samples_per_frame
        return frame


class PeerManager:
    """Manages RTCPeerConnections. One per browser client."""

    def __init__(self, capture: AudioCapture) -> None:
        self._capture = capture
        self._peers: Dict[str, RTCPeerConnection] = {}
        self._tracks: Dict[str, LoopbackAudioTrack] = {}
        # Use public STUN for better NAT traversal, but local network works without it too
        self._config = RTCConfiguration(
            iceServers=[RTCIceServer(urls="stun:stun.l.google.com:19302")]
        )

    async def create_peer(self, peer_id: str) -> RTCPeerConnection:
        """Create a new peer connection with a LoopbackAudioTrack."""
        # Close existing peer with same ID
        if peer_id in self._peers:
            await self.remove_peer(peer_id)

        pc = RTCPeerConnection(configuration=self._config)
        track = LoopbackAudioTrack(self._capture)

        sender = pc.addTrack(track)
        # Raw/original voice: Opus at max quality that Safari still accepts
        # 510k is Opus max, 48000 stereo, keep params minimal to not break negotiation
        try:
            codecs = RTCRtpSender.getCapabilities("audio").codecs
            opus = [c for c in codecs if c.mimeType == "audio/opus"]
            for c in opus:
                c.parameters["stereo"] = "1"
                c.parameters["maxaveragebitrate"] = "510000"
            if opus:
                sender.transceiver.setCodecPreferences(opus)
        except Exception as e:
            logger.debug("setCodecPreferences failed: %s", e)

        @pc.on("connectionstatechange")
        async def on_state_change():
            logger.info("Peer %s state: %s", peer_id, pc.connectionState)
            if pc.connectionState in ("failed", "closed", "disconnected"):
                # Don't auto-remove on disconnected (might be transient), but clean up failed/closed
                if pc.connectionState in ("failed", "closed"):
                    await self.remove_peer(peer_id)

        @pc.on("iceconnectionstatechange")
        async def on_ice():
            logger.debug("Peer %s ICE: %s", peer_id, pc.iceConnectionState)

        self._peers[peer_id] = pc
        self._tracks[peer_id] = track
        logger.info("Created peer %s", peer_id)
        return pc

    async def remove_peer(self, peer_id: str) -> None:
        pc = self._peers.pop(peer_id, None)
        track = self._tracks.pop(peer_id, None)
        if track is not None:
            try:
                track.stop()
            except Exception:
                pass
        if pc is not None:
            try:
                await pc.close()
            except Exception:
                pass
            logger.info("Removed peer %s", peer_id)

    async def remove_all(self) -> None:
        for pid in list(self._peers.keys()):
            await self.remove_peer(pid)

    def get_peer(self, peer_id: str) -> RTCPeerConnection | None:
        return self._peers.get(peer_id)

    @property
    def peer_count(self) -> int:
        return len(self._peers)

    @property
    def peers(self) -> Dict[str, RTCPeerConnection]:
        return dict(self._peers)
