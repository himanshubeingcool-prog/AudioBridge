# PC Phone Speaker

Turn your iPhone into a wireless speaker for your Windows PC. No app install, no cloud, no account. Open your PC audio in mobile Safari and it plays.

Works for YouTube, Spotify, games, Discord — anything playing on Windows.

```
Windows (WASAPI loopback → Opus → WebRTC) → Wi-Fi → iPhone (Safari) → Speaker
```

## Requirements

- Windows 10 / 11
- Python 3.10+ (3.12 recommended)
- iPhone or any phone with a modern browser
- PC and phone on the same Wi-Fi (or PC Mobile Hotspot)

## 1. Install

```bat
scripts\install.bat
```

That creates `.venv`, installs deps, and checks install.

Manual install:

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Run

```bat
scripts\start.bat
```

Or:

```bat
.venv\Scripts\activate
python -m backend.main
```

You will see your URL and QR code:

```
============================================================
  PC PHONE SPEAKER
  Status:        PC Online
  URL:           http://192.168.1.25:8080/?token=abc123
  Pairing code:  482 913
  Port:          8080

  Scan with iPhone:
    ██████████████
============================================================
```

Your IP is the `http://192.168.x.x:8080` part. That's what you open on your phone.

## 3. Open on Phone

1. Connect phone to **same Wi-Fi** as PC.
2. **Scan the QR** in the terminal with iPhone Camera, or type the URL manually: `http://192.168.x.x:8080/?token=...`
3. Tap **Connect** (enter the 6-digit pairing code if asked).
4. Tap **START SPEAKER**.
5. Play audio on PC — it comes out of your phone.

To stop: tap **STOP SPEAKER** or press `Ctrl+C` on PC.

## Options

```bat
python -m backend.main --port 8081        # use different port
python -m backend.main --token mytoken    # custom token
python -m backend.main --code 123456      # custom 6-digit code
python -m backend.main --no-token         # disable auth (not recommended)
python -m backend.main --diagnostic       # check audio / network / deps
```

## Firewall (if phone can't connect)

When you first run it, Windows will ask to allow `Python` — click **Allow access** and check **Private networks**.

If you missed it:

1. `Settings → Privacy & security → Windows Security → Firewall & network protection → Allow an app through firewall`
2. `Change settings → Allow another app → Browse` → select:
   - `.venv\Scripts\python.exe` (if you used `install.bat`)
   - or `C:\Users\...\AppData\Local\Programs\Python\...\python.exe`
3. Check **Private**.

Still not connecting? Try:

```bat
python -m backend.main --diagnostic
ipconfig  # find your Wi-Fi IPv4, use that IP on phone
```

`http://<your-ip>:8080/api/pairing` must return JSON when opened on the phone. If it doesn't, it's firewall or AP isolation (disable `Client isolation` / `AP isolation` in router settings). **Windows Mobile Hotspot** also works — connect phone to the hotspot instead.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No loopback device` / `Could not access Windows audio output` | Make sure a playback device is active (Sound settings). Run `--diagnostic`. |
| No audio on phone | Check phone volume / silent switch. Make sure something is playing on PC. Same Wi-Fi. |
| `Port already in use` | `python -m backend.main --port 8081` |
| QR shows wrong IP | Use `ipconfig` Wi-Fi IPv4, or `--diagnostic` `All IPs`. |
| `ICE failed` / `WebRTC failed` | Firewall or AP isolation. Allow Python, disable AP isolation. |
| `pyaudiowpatch not installed` | `pip install pyaudiowpatch` or re-run `install.bat` |
| Safari blank / old page | Hard refresh, make sure URL has `?token=...` |

Latency is ~100-300ms on good Wi-Fi (5GHz is better). UI shows live latency.

## How It Works

- **Capture:** `pyaudiowpatch` WASAPI loopback — no Stereo Mix needed.
- **Transport:** `aiortc` WebRTC, Opus 48kHz stereo, 20ms frames.
- **Signaling:** `FastAPI` WebSocket at `/ws` with per-run token + 6-digit pairing code.
- **Frontend:** Vanilla HTML/CSS/JS, no build step. Needs tap to start (Safari autoplay rule).

## Project Structure

```
backend/main.py          # server, WebSocket signaling, CLI
backend/audio_capture.py # WASAPI capture
backend/webrtc.py        # aiortc peers + Opus
backend/network.py       # LAN IP detection
frontend/                # index.html + app.js + styles.css
scripts/install.bat
scripts/start.bat
```

## Development

```bat
pip install pytest pytest-asyncio
pytest tests/ -v
```

## License

MIT — do what you want, PRs welcome.
