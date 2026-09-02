(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("btn-toggle");
  const statusDot = $("status-dot");
  const statusText = $("status-text");
  const deviceRow = $("device-row");
  const audioEl = $("remote-audio");
  const volSlider = $("volume");
  const volVal = $("vol-val");
  const volRow = $("volume-row");
  const latencyEl = $("latency");
  const pcIpEl = $("pc-ip");
  const infoNote = $("info-note");
  const qrCard = $("qr-card");
  const qrImg = $("qr-img");
  const qrUrl = $("qr-url");
  const tabReceive = $("tab-receive");
  const tabShare = $("tab-share");
  const roleHint = $("role-hint");
  const pairingCodeEl = $("pairing-code");
  const pairingLabel = $("pairing-label");
  const pairingSub = $("pairing-sub");
  const pairingInputRow = $("pairing-input-row");
  const codeInput = $("code-input");
  const btnConnect = $("btn-connect");
  const pairingStatus = $("pairing-status");

  let pc = null;
  let ws = null;
  let connected = false;
  let paired = false;
  let audioCtx = null;
  let gainNode = null;
  let latencyTimer = null;
  let token = new URLSearchParams(location.search).get("token") || localStorage.getItem("pps_token") || "";
  let pairingCode = "";
  let role = localStorage.getItem("pps_role") || "receive";

  function setRole(r) {
    role = r;
    localStorage.setItem("pps_role", r);
    tabReceive.classList.toggle("active", r === "receive");
    tabShare.classList.toggle("active", r === "share");
    if (r === "share") {
      roleHint.textContent = "This device is sharing — others enter your code to listen.";
      pairingLabel.textContent = "Your Pairing Code";
      pairingSub.textContent = "Enter this code on the receiving device";
      pairingInputRow.style.display = "none";
      pairingSub.style.display = "block";
      if (pairingCode) pairingCodeEl.textContent = pairingCode.split("").join(" ");
      startPeerPoll();
      if (pairingCode) {
        statusText.textContent = "Waiting for device — share your code";
        statusDot.className = "status-dot";
      }
    } else {
      roleHint.textContent = "This iPhone will play audio from your PC.";
      pairingLabel.textContent = "Enter Pairing Code";
      if (peerPoll) { clearInterval(peerPoll); peerPoll = null; }
      if (paired) {
        pairingCodeEl.textContent = pairingCode.split("").join(" ");
        pairingSub.textContent = "Paired — tap Start Speaker";
        pairingSub.style.display = "block";
        pairingInputRow.style.display = "none";
      } else {
        pairingCodeEl.textContent = "— — —";
        pairingSub.textContent = "Get the 6-digit code from the sharing device";
        pairingInputRow.style.display = "flex";
      }
    }
  }

  tabReceive.addEventListener("click", () => setRole("receive"));
  tabShare.addEventListener("click", () => setRole("share"));

  let peerPoll = null;
  function startPeerPoll() {
    if (peerPoll) clearInterval(peerPoll);
    peerPoll = setInterval(async () => {
      if (role !== "share" || !pairingCode) return;
      try {
        const r = await fetch(`/api/info?code=${encodeURIComponent(pairingCode)}`);
        if (!r.ok) return;
        const j = await r.json();
        const n = j.peers || 0;
        if (n > 0) {
          setStatus("connected", n === 1 ? "1 device connected — streaming" : `${n} devices connected`);
          $("device-row").style.display = "block";
          $("device-name").textContent = n === 1 ? "1 listener" : `${n} listeners`;
        } else {
          setStatus("", "Waiting for device — share your code");
          $("device-row").style.display = "none";
        }
      } catch {}
    }, 2000);
  }

  async function fetchPairing() {
    try {
      let r = await fetch("/api/pairing");
      if (r.ok) {
        const j = await r.json();
        if (j.pairing_code) {
          pairingCode = j.pairing_code;
          if (token) {
            paired = true;
            pairingStatus.textContent = "";
            pairingStatus.className = "pairing-status";
          }
          setRole(role);
        }
        if (j.lan_ip) pcIpEl.textContent = j.lan_ip + (j.all_ips && j.all_ips.length > 1 ? ` (+${j.all_ips.length - 1} more)` : "");
        else if (j.all_ips && j.all_ips.length) pcIpEl.textContent = j.all_ips[0];
      }
      if (token) {
        const qrR = await fetch(`/api/qr?token=${encodeURIComponent(token)}`);
        if (qrR.ok) {
          const qj = await qrR.json();
          if (qj.qr) {
            qrImg.src = qj.qr;
            qrUrl.textContent = qj.url;
            qrCard.style.display = "block";
          }
        }
      } else if (pairingCode) {
        const qrR = await fetch(`/api/qr?code=${encodeURIComponent(pairingCode)}`);
        if (qrR.ok) {
          const qj = await qrR.json();
          if (qj.qr) {
            qrImg.src = qj.qr;
            qrUrl.textContent = qj.url;
            if (role === "share") qrCard.style.display = "block";
          }
        }
      }
    } catch {}
    if (token && !paired) {
      paired = true;
      setRole(role);
    }
    if (!paired && role === "receive") {
      statusText.textContent = "Enter pairing code, then tap Start";
    } else if (paired && role === "receive") {
      statusText.textContent = "Tap Start Speaker to begin audio";
    }
    // Share side: show peers immediately
    if (role === "share") startPeerPoll();
  }

  // Devices on this WiFi — scan via backend /api/discover
  const devicesList = $("devices-list");
  const devicesSub = $("devices-sub");
  const devicesSubnet = $("devices-subnet");
  const btnRefresh = $("btn-refresh");

  async function scanDevices() {
    devicesList.innerHTML = '<div class="device-item skeleton">Scanning…</div>';
    devicesSub.textContent = "Scanning…";
    try {
      const r = await fetch("/api/discover");
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      devicesSubnet.textContent = j.subnet || "—";
      devicesSub.textContent = `WiFi ${j.subnet || ""} — ${j.devices.length} device(s)`;
      if (!j.devices.length) {
        devicesList.innerHTML = '<div class="device-item skeleton">No other PC Speaker devices on this WiFi. Start one on another PC.</div>';
        return;
      }
      devicesList.innerHTML = "";
      j.devices.forEach(d => {
        const div = document.createElement("div");
        div.className = "device-item" + (d.is_self ? " is-self" : "");
        div.innerHTML = `<div class="device-icon">▶</div>
          <div class="device-info"><div class="device-name">${d.hostname}</div><div class="device-meta">${d.ip}:${d.port}${d.pairing_code ? " · code " + d.pairing_code : ""}</div></div>
          <span class="device-badge ${d.is_self ? "you" : ""}">${d.is_self ? "YOU" : "TAP"}</span>`;
        if (!d.is_self) {
          div.addEventListener("click", () => {
            // Auto-fill code and connect
            if (d.pairing_code) {
              codeInput.value = d.pairing_code;
              setRole("receive");
              btnConnect.click();
            }
          });
        }
        devicesList.appendChild(div);
      });
    } catch (e) {
      devicesList.innerHTML = '<div class="device-item skeleton">Scan failed — check server running and WiFi.</div>';
      devicesSub.textContent = "Scan failed";
    }
  }

  btnRefresh.addEventListener("click", scanDevices);

  // Auto-detect role: if we have ?token in URL, likely this device was the receiver via QR
  const urlRole = new URLSearchParams(location.search).get("role");
  if (urlRole === "share" || urlRole === "receive") role = urlRole;
  else if (token) role = "receive";
  setRole(role);
  fetchPairing();
  // Initial scan after pairing fetch, then every 15s
  setTimeout(scanDevices, 800);
  setInterval(scanDevices, 15000);

  btnConnect.addEventListener("click", async () => {
    const code = codeInput.value.trim().replace(/\D/g, "");
    if (code.length !== 6) {
      pairingStatus.textContent = "Enter 6 digits";
      pairingStatus.className = "pairing-status err";
      return;
    }
    btnConnect.disabled = true;
    pairingStatus.textContent = "Checking…";
    pairingStatus.className = "pairing-status";
    try {
      const r = await fetch(`/api/verify?code=${encodeURIComponent(code)}`);
      const j = await r.json();
      if (r.ok && j.ok) {
        token = j.token;
        pairingCode = code;
        paired = true;
        localStorage.setItem("pps_token", token);
        pairingStatus.textContent = "Paired ✓";
        pairingStatus.className = "pairing-status ok";
        setRole("receive");
        statusText.textContent = "Tap Start Speaker to begin audio";
        statusDot.className = "status-dot";
        // Fetch QR now that we are paired
        const qrR = await fetch(`/api/qr?token=${encodeURIComponent(token)}`);
        if (qrR.ok) {
          const qj = await qrR.json();
          if (qj.qr) {
            qrImg.src = qj.qr;
            qrUrl.textContent = qj.url;
          }
        }
      } else {
        pairingStatus.textContent = "Invalid code — check the sharing device";
        pairingStatus.className = "pairing-status err";
      }
    } catch {
      pairingStatus.textContent = "Could not reach PC — check same Wi-Fi";
      pairingStatus.className = "pairing-status err";
    }
    btnConnect.disabled = false;
  });

  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnConnect.click();
  });
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  });

  function setStatus(state, text) {
    statusDot.className = "status-dot " + state;
    statusText.textContent = text;
  }

  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const t = token ? `?token=${encodeURIComponent(token)}` : (pairingCode ? `?code=${encodeURIComponent(pairingCode)}` : "");
    return `${proto}//${location.host}/ws${t}`;
  }

  // Low-latency playback: use <audio> directly and control volume via element
  // (Web Audio MediaStreamSource->Gain->destination adds ~20-50ms extra)
  function setupVolume(stream) {
    audioEl.volume = volSlider.value / 100;
    audioEl.muted = false;
    volRow.style.display = "flex";
  }

  volSlider.addEventListener("input", () => {
    const v = parseInt(volSlider.value, 10);
    volVal.textContent = v + "%";
    audioEl.volume = v / 100;
  });

  async function start() {
    if (!paired && !token) {
      infoNote.textContent = "Enter the 6-digit pairing code first, then tap Connect.";
      pairingStatus.textContent = "Code required";
      pairingStatus.className = "pairing-status err";
      codeInput.focus();
      return;
    }
    btn.disabled = true;
    setStatus("connecting", "Connecting…");
    infoNote.textContent = "";

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") await audioCtx.resume();
      }
    } catch {}

    const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    pc = new RTCPeerConnection(config);

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      // Reduce jitter buffer for low latency (default ~100ms, we want ~20-40ms on LAN)
      try {
        const recv = pc.getReceivers().find(r => r.track && r.track.kind === "audio");
        if (recv && recv.jitterBufferTarget !== undefined) recv.jitterBufferTarget = 0.04;
        // Also try via transceiver
        pc.getTransceivers().forEach(t => {
          if (t.receiver && t.receiver.jitterBufferTarget !== undefined) t.receiver.jitterBufferTarget = 0.04;
        });
      } catch {}
      audioEl.srcObject = stream;
      // Hint low latency
      try { audioEl.preservesPitch = false; } catch {}
      audioEl.play().catch((err) => {
        console.warn("audio play failed", err);
        infoNote.textContent = "Tap again if you don't hear audio (Safari autoplay).";
      });
      setupVolume(stream);
      setStatus("connected", "Connected — playing PC audio");
      $("device-row").style.display = "block";
      connected = true;
      btn.textContent = "STOP SPEAKER";
      btn.className = "btn btn-stop";
      btn.disabled = false;
      if (latencyTimer) clearInterval(latencyTimer);
      latencyTimer = setInterval(async () => {
        try {
          const stats = await pc.getStats();
          stats.forEach((r) => {
            if (r.type === "inbound-rtp" && r.kind === "audio" && r.jitterBufferDelay !== undefined) {
              const delay = r.jitterBufferDelay || 0;
              if (delay > 0) latencyEl.textContent = `~${Math.round(delay * 1000)} ms`;
            }
            if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime !== undefined) {
              const rtt = r.currentRoundTripTime;
              if (rtt) latencyEl.textContent = `~${Math.round(rtt * 1000)} ms`;
            }
          });
        } catch {}
      }, 1000);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setStatus("failed", "Connection failed — tap Start again");
        stop(false);
      } else if (pc.connectionState === "connected") {
        setStatus("connected", "Connected — playing PC audio");
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        infoNote.textContent = "ICE failed. Same Wi-Fi? Firewall allowed? Try hotspot.";
      }
    };

    pc.addTransceiver("audio", { direction: "recvonly" });

    const url = wsUrl();
    ws = new WebSocket(url);

    ws.onopen = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
    };

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "answer" && msg.sdp) {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        } else if (msg.type === "error") {
          infoNote.textContent = msg.message || "Signaling error";
        }
      } catch (e) {
        console.warn("ws message error", e);
      }
    };

    ws.onerror = () => {
      setStatus("failed", "Connection failed");
      infoNote.innerHTML = `WS error to <code>${wsUrl().replace(/token=[^&]+/, "token=***")}</code> — close=${ws ? ws.readyState : "?"}<br>
        1) Open <code>http://${location.hostname}:8080/api/pairing</code> on iPhone — must show JSON<br>
        2) If not, firewall blocks port 8080: run on PC as Admin: <code>netsh advfirewall firewall add rule name="PC Speaker" dir=in action=allow protocol=TCP localport=8080 profile=private</code><br>
        3) Or Settings → Firewall → Allow app → Python → Private`;
      btn.disabled = false;
    };

    ws.onclose = (ev) => {
      if (!connected && ev.code === 4401) {
        pairingStatus.textContent = "Invalid code";
        pairingStatus.className = "pairing-status err";
        setStatus("failed", "Invalid code");
        btn.disabled = false;
      } else if (!connected) {
        const reason = ev.reason ? ` (${ev.reason})` : "";
        setStatus("failed", `Not connected [${ev.code}${reason}]`);
        // Only show detailed help once (ws.onerror already did); avoid overwriting it
        if (!infoNote.textContent) {
          infoNote.innerHTML = `Close ${ev.code}${reason}<br>
            WS: <code>${wsUrl().replace(/token=[^&]+/, "token=***")}</code><br>
            1) Same Wi-Fi? iPhone and PC <code>192.168.x.x</code> first 3 parts same<br>
            2) Server still running on PC? Check terminal<br>
            3) Firewall: see above`;
        }
        btn.disabled = false;
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }));
      }
    };
  }

  function stop(resetBtn = true) {
    connected = false;
    if (latencyTimer) { clearInterval(latencyTimer); latencyTimer = null; }
    latencyEl.textContent = "—";
    $("device-row").style.display = "none";
    volRow.style.display = "none";
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    audioEl.srcObject = null;
    audioEl.pause();
    if (audioCtx && gainNode) {
      try { gainNode.disconnect(); } catch {}
      gainNode = null;
    }
    if (resetBtn) {
      setStatus("", paired ? "Tap Start Speaker to begin audio" : "Enter pairing code, then tap Start");
      btn.textContent = "START SPEAKER";
      btn.className = "btn btn-start";
      btn.disabled = false;
      infoNote.textContent = "";
    }
  }

  btn.addEventListener("click", () => {
    if (connected) stop();
    else start();
  });

  if (!window.RTCPeerConnection) {
    setStatus("failed", "WebRTC not supported in this browser");
    btn.disabled = true;
    infoNote.textContent = "Use Safari on iPhone or a modern browser.";
  }
})();
