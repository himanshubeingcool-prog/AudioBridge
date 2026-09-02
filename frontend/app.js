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
  // Always require code on Receive — ignore stored token (user wants mandatory code)
  let token = new URLSearchParams(location.search).get("token") || "";
  let pairingCode = "";
  let role = localStorage.getItem("pps_role") || "receive";
  // If token came via QR, consider paired immediately but still show code entry for manual
  if (token) {
    try { localStorage.setItem("pps_token", token); } catch {}
  }

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
      btn.style.display = "none";
      volRow.style.display = "none";
      startPeerPoll();
      if (pairingCode) {
        statusText.textContent = "Waiting for device — share your code";
        statusDot.className = "status-dot";
      }
    } else {
      roleHint.textContent = "This iPhone will play audio from your PC.";
      pairingLabel.textContent = "Enter Pairing Code";
      btn.style.display = "block";
      if (peerPoll) { clearInterval(peerPoll); peerPoll = null; }
      pairingCodeEl.textContent = "— — —";
      pairingSub.textContent = "Get the 6-digit code from the sharing device";
      pairingInputRow.style.display = "flex";
      pairingSub.style.display = "block";
      if (paired) {
        pairingCodeEl.textContent = pairingCode.split("").join(" ");
        pairingSub.textContent = "Paired — tap Start Speaker (or re-enter code)";
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
          setRole(role);
        }
        if (j.lan_ip) pcIpEl.textContent = j.lan_ip + (j.all_ips && j.all_ips.length > 1 ? ` (+${j.all_ips.length - 1} more)` : "");
        else if (j.all_ips && j.all_ips.length) pcIpEl.textContent = j.all_ips[0];
      }
      // QR only on Share (Receive uses code)
      if (pairingCode && role === "share") {
        const qrR = await fetch(`/api/qr?code=${encodeURIComponent(pairingCode)}`);
        if (qrR.ok) {
          const qj = await qrR.json();
          if (qj.qr) {
            qrImg.src = qj.qr;
            qrUrl.textContent = qj.url;
            qrCard.style.display = "block";
          }
        }
      }
    } catch {}
    // Mandatory code on Receive — never auto-pair from stored token
    paired = false;
    pairingStatus.textContent = "";
    pairingStatus.className = "pairing-status";
    if (role === "receive") {
      statusText.textContent = "Enter pairing code, then tap Connect";
    }
    if (role === "share") startPeerPoll();
  }

  // Auto-detect role
  const urlRole = new URLSearchParams(location.search).get("role");
  if (urlRole === "share" || urlRole === "receive") role = urlRole;
  else if (token) { role = "receive"; paired = true; pairingCode = token; /* token is legacy, treat as paired */ }
  setRole(role);
  fetchPairing();

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
    if (!paired) {
      infoNote.textContent = "Tap Connect after entering the 6-digit code.";
      pairingStatus.textContent = "Not paired — tap Connect";
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
      // Lowest latency: tiny jitter buffer + raw playout
      try {
        const recv = pc.getReceivers().find(r => r.track && r.track.kind === "audio");
        if (recv && recv.jitterBufferTarget !== undefined) recv.jitterBufferTarget = 0.02;
        pc.getTransceivers().forEach(t => {
          if (t.receiver && t.receiver.jitterBufferTarget !== undefined) t.receiver.jitterBufferTarget = 0.02;
          if (t.receiver && t.receiver.playoutDelayHint !== undefined) t.receiver.playoutDelayHint = 0.02;
        });
        e.track.playoutDelayHint = 0.02;
      } catch {}
      audioEl.srcObject = stream;
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
