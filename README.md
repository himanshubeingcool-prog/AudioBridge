# PC Phone Speaker

Use your **iPhone as a wireless speaker for your Windows 11 PC** — no cloud, no App Store, just your browser.

Windows system audio (YouTube, Spotify, games, Discord, etc.) is captured via **WASAPI loopback**, encoded as **Opus**, and streamed to your iPhone over **WebRTC** on your local Wi-Fi.

```
Windows PC → WASAPI loopback → PCM (48kHz stereo) → Opus → WebRTC → Wi-Fi → iPhone Safari → Speaker
```

## Requirements

- Windows 11 (Windows 10 should also work)
- Python 3.10+ (3.12+ recommended)
- iPhone with Safari (or any modern browser)
- PC and iPhone on the same Wi-Fi / Mobile Hotspot

## Installation

```bat
scripts\install.bat
```

This will:
1. Check Python version
2. Create a virtual environment (`.venv/`)
3. Install all dependencies
4. Verify the installation

Or manually:

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## How to Start

```bat
scripts\start.bat
```

Or:

```bat
.venv\Scripts\activate
python -m backend.main
```

On start you will see:

```
============================================================
  PC PHONE SPEAKER
============================================================
  Status:        PC Online
  URL:           http://192.168.1.25:8080/?token=abc123
  Token:         abc123
  Port:          8080

  Scan with iPhone:
    ██████████████
    ...

  iPhone: Scan QR -> Safari -> Tap START SPEAKER
============================================================
```

Options:

```bat
python -m backend.main --port 8081          # different port
python -m backend.main --token mytoken123   # custom token
python -m backend.main --no-token           # disable auth (not recommended)
python -m backend.main --diagnostic         # diagnostic checks
```

## How to Connect iPhone

1. Make sure PC and iPhone are on the **same Wi-Fi** (or Windows Mobile Hotspot).
2. Scan the QR code shown in the terminal / browser, or type the URL manually.
3. Safari opens the web UI.
4. Tap **START SPEAKER**.
5. Play something on your PC — audio comes from your iPhone.

To stop: tap **STOP SPEAKER**. Reconnect by tapping Start again. Closing the browser or restarting the server also works.

## Windows Firewall Setup

If your iPhone cannot connect:

1. Open **Settings → Privacy & security → Windows Security → Firewall & network protection → Allow an app through firewall**
2. Click **Change settings → Allow another app → Browse** → select your Python executable:
   - If using `.venv`: `pc-phone-speaker\.venv\Scripts\python.exe`
   - If using system Python: `C:\Users\...\AppData\Local\Programs\Python\...\python.exe`
3. Enable **Private** networks for Python.
4. Also allow `pythonw.exe` if present.

Alternatively, when Windows shows the firewall prompt after starting the server, click **Allow access** and ensure **Private networks** is checked.

## Same Wi-Fi Requirements

- Both devices must be on the same subnet (e.g., both on `192.168.1.x`).
- **AP isolation** (client isolation) on the router will block connections — disable it in router settings if needed.
- **Windows Mobile Hotspot** works: enable it on your PC and connect your iPhone to the hotspot.
- No port forwarding, public IP, or domain is needed.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not access Windows audio output` | Make sure a playback device is active. Check Sound settings. Run `python -m backend.main --diagnostic`. |
| No audio on iPhone | Check iPhone volume/silent switch. Make sure something is playing on PC. Verify both on same Wi-Fi. |
| `Port already in use` | `python -m backend.main --port 8081` |
| QR shows wrong IP | Use the IP shown in `ipconfig` for your Wi-Fi adapter, or check `python -m backend.main --diagnostic`. |
| WebRTC failed / ICE failed | Usually firewall or AP isolation. Allow Python in firewall, disable AP isolation on router. |
| `pyaudiowpatch not installed` | `pip install pyaudiowpatch` or re-run `install.bat`. |
| Safari shows blank / old page | Hard refresh, or add `?token=...` URL param. |

### Diagnostic Mode

```bat
python -m backend.main --diagnostic
```

Reports Python version, Windows version, audio devices, LAN IP, port, WASAPI/pyaudiowpatch status, and dependency versions.

### Latency

- Target is low hundreds of ms on good Wi-Fi.
- The UI shows an approximate latency (RTT / jitter buffer delay).
- For lower latency: use 5 GHz Wi-Fi, move closer to the router, close other streaming apps.
- Don't sacrifice stability for lowest latency — the app uses 20ms Opus frames with bounded buffering.

## How to Stop

- Press `Ctrl+C` in the terminal.
- Or close the terminal window.

## How It Works

- **Capture**: `pyaudiowpatch` (PortAudio + WASAPI) loopback device `[Loopback]` — no Stereo Mix needed.
- **Transport**: `aiortc` WebRTC with Opus (48 kHz stereo, 20ms frames).
- **Signaling**: FastAPI WebSocket at `/ws` with random per-run token.
- **Frontend**: Vanilla HTML/CSS/JS, works in Safari/Chrome/Edge. Requires user gesture to start audio (Safari autoplay policy).
- **Security**: Random token in URL (`?token=...`), validated on WebSocket. No cloud, no accounts.

## Tests

```bat
pip install pytest pytest-asyncio
pytest tests/ -v
```

## Project Structure

```
pc-phone-speaker/
├── backend/
│   ├── main.py          # FastAPI app + WebSocket signaling + CLI
│   ├── audio_capture.py # WASAPI loopback via pyaudiowpatch
│   ├── webrtc.py        # aiortc PeerManager + LoopbackAudioTrack
│   ├── signaling.py     # Token validation
│   ├── network.py       # LAN IP detection
│   └── qr.py            # QR generation
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── tests/
│   ├── test_server.py
│   └── test_audio.py
├── scripts/
│   ├── install.bat
│   └── start.bat
├── requirements.txt
└── README.md
```
