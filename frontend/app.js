(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("btn-toggle");
  const statusDot = $("status-dot");
  const statusText = $("status-text");
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
  const audioEl = $("remote-audio");
  const eqCard = $("eq-card");
  const eqBandsEl = $("eq-bands");
  const spectrum = $("spectrum");
  const meterL = $("meter-l");
  const meterR = $("meter-r");
  const eqBypass = $("eq-bypass");

  let pc = null, ws = null, connected = false, paired = false;
  let latencyTimer = null, spectrumRAF = null, analyser = null;
  let token = new URLSearchParams(location.search).get("token") || "";
  let pairingCode = "";
  let role = localStorage.getItem("pps_role") || "receive";
  if (token) try { localStorage.setItem("pps_token", token); } catch {}

  // --- STUDIO EQ config ---
  const EQ = [
    { label: "60Hz",  freq: 60,    type: "lowshelf",  gain: 0 },
    { label: "250Hz", freq: 250,   type: "peaking",   gain: 0, Q: 1 },
    { label: "1kHz",  freq: 1000,  type: "peaking",   gain: 0, Q: 1 },
    { label: "4kHz",  freq: 4000,  type: "peaking",   gain: 0, Q: 1 },
    { label: "12kHz", freq: 12000, type: "highshelf", gain: 0 },
  ];
  const PRESETS = {
    flat:   [0,0,0,0,0],
    bass:   [6,3,0,-1,-2],
    vocal:  [-1,-2,3,4,1],
    bright: [-1,-1,0,4,6],
    warm:   [4,2,-1,-2,-3],
  };
  let audioCtx = null, gainNode = null, eqNodes = [], splitter = null;

  function buildEqUI() {
    eqBandsEl.innerHTML = "";
    EQ.forEach((b, i) => {
      const div = document.createElement("div");
      div.className = "eq-band";
      div.innerHTML = `<div class="eq-band-label">${b.label}</div>
        <input type="range" class="eq-slider" data-i="${i}" min="-12" max="12" value="${b.gain}" step="0.5" orient="vertical">
        <div class="eq-band-val" id="eq-val-${i}">${b.gain > 0 ? "+"+b.gain : b.gain}dB</div>`;
      eqBandsEl.appendChild(div);
    });
    eqBandsEl.querySelectorAll(".eq-slider").forEach(sl => {
      sl.addEventListener("input", () => {
        const i = +sl.dataset.i;
        EQ[i].gain = parseFloat(sl.value);
        $(`eq-val-${i}`).textContent = (EQ[i].gain > 0 ? "+"+EQ[i].gain : EQ[i].gain) + "dB";
        if (eqNodes[i]) eqNodes[i].gain.value = EQ[i].gain;
        document.querySelectorAll(".eq-preset").forEach(b=>b.classList.remove("active"));
        spectrumRAF && drawSpectrum();
      });
    });
  }
  buildEqUI();
  document.querySelectorAll(".eq-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      document.querySelectorAll(".eq-preset").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      p.forEach((g,i) => {
        EQ[i].gain = g;
        const sl = eqBandsEl.querySelector(`[data-i="${i}"]`);
        if (sl) sl.value = g;
        $(`eq-val-${i}`).textContent = (g>0?"+":"")+g+"dB";
        if (eqNodes[i]) eqNodes[i].gain.value = g;
      });
    });
  });
  eqBypass.addEventListener("change", () => {
    eqNodes.forEach(n => n && (n.gain.value = eqBypass.checked ? 0 : EQ[eqNodes.indexOf(n)].gain));
  });

  // Spectrum & meters
  function drawSpectrum() {
    if (!analyser || !spectrum) return;
    const ctx = spectrum.getContext("2d");
    const W = spectrum.width, H = spectrum.height;
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);
    function frame() {
      if (!analyser) return;
      spectrumRAF = requestAnimationFrame(frame);
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);
      ctx.clearRect(0,0,W,H);
      // gradient
      const grad = ctx.createLinearGradient(0,0,0,H);
      grad.addColorStop(0,"#7c6cff"); grad.addColorStop(1,"#00e6c3");
      ctx.fillStyle = grad;
      const barW = W / freqData.length * 2.2;
      let x = 0;
      for (let i=0;i<freqData.length;i++) {
        const v = freqData[i] / 255;
        const h = v * H * 0.92;
        if (x < W) ctx.fillRect(x, H - h, Math.max(1,barW-1), h);
        x += barW;
        if (x >= W) break;
      }
      // VU from time domain
      let sumL=0,sumR=0; // approximate L/R from interleaved if stereo analyser is on one channel; use max
      let max=0;
      for (let i=0;i<timeData.length;i++) { const v=Math.abs(timeData[i]-128); if(v>max) max=v; }
      const pct = Math.min(100, (max/128)*140);
      meterL.style.width = pct+"%";
      meterR.style.width = (pct*0.92)+"%";
    }
    frame();
  }

  function setupAudioGraph(stream) {
    // Pro HD chain: Source -> 5x Biquad EQ -> Analyser -> Gain -> Destination (48kHz, interactive)
    // If bypass, EQ gains are 0 (flat) still ultra-low.
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("no AC");
      if (audioCtx && audioCtx.state !== "closed") { try{audioCtx.close();}catch{} }
      audioCtx = new AC({ latencyHint: "interactive", sampleRate: 48000 });
      if (audioCtx.state === "suspended") audioCtx.resume();
      const src = audioCtx.createMediaStreamSource(stream);
      // 5-band EQ
      eqNodes = EQ.map(b => {
        const f = audioCtx.createBiquadFilter();
        f.type = b.type; f.frequency.value = b.freq;
        if (b.Q) f.Q.value = b.Q;
        f.gain.value = eqBypass.checked ? 0 : b.gain;
        return f;
      });
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.78;
      gainNode = audioCtx.createGain();
      gainNode.gain.value = volSlider.value/100;
      // chain
      let cur = src;
      eqNodes.forEach(n => { cur.connect(n); cur = n; });
      cur.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      audioEl.muted = true;
      volRow.style.display = "flex";
      eqCard.style.display = "block";
      if (spectrumRAF) cancelAnimationFrame(spectrumRAF);
      drawSpectrum();
    } catch (e) {
      console.warn("Studio graph failed, fallback to element", e);
      audioEl.srcObject = stream;
      audioEl.volume = volSlider.value/100;
      audioEl.muted = false;
      volRow.style.display = "flex";
      eqCard.style.display = "block";
    }
  }

  function setRole(r) {
    role = r; localStorage.setItem("pps_role", r);
    tabReceive.classList.toggle("active", r === "receive");
    tabShare.classList.toggle("active", r === "share");
    if (r === "share") {
      roleHint.textContent = "This device is sharing — others enter your code to listen.";
      pairingLabel.textContent = "Your Pairing Code";
      pairingSub.textContent = "Enter this code on the receiving device";
      pairingInputRow.style.display = "none";
      pairingSub.style.display = "block";
      if (pairingCode) pairingCodeEl.textContent = pairingCode.split("").join(" ");
      btn.style.display = "none"; volRow.style.display = "none";
      startPeerPoll();
      if (pairingCode) { statusText.textContent = "Waiting for device — share your code"; statusDot.className = "status-dot"; }
    } else {
      roleHint.textContent = "This iPhone will play audio from your PC.";
      pairingLabel.textContent = "Enter Pairing Code";
      btn.style.display = "block";
      if (peerPoll) { clearInterval(peerPoll); peerPoll=null; }
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
  tabReceive.addEventListener("click", ()=>setRole("receive"));
  tabShare.addEventListener("click", ()=>setRole("share"));
  let peerPoll=null;
  function startPeerPoll(){
    if(peerPoll) clearInterval(peerPoll);
    peerPoll=setInterval(async()=>{
      if(role!=="share"||!pairingCode) return;
      try{
        const r=await fetch(`/api/info?code=${encodeURIComponent(pairingCode)}`);
        if(!r.ok) return;
        const j=await r.json(); const n=j.peers||0;
        if(n>0){ setStatus("connected", n===1?"1 device connected — streaming":`${n} devices connected`); $("device-row").style.display="block"; $("device-name").textContent=n===1?"1 listener":`${n} listeners`; }
        else { setStatus("","Waiting for device — share your code"); $("device-row").style.display="none"; }
      }catch{}
    },2000);
  }
  async function fetchPairing(){
    try{
      let r=await fetch("/api/pairing");
      if(r.ok){
        const j=await r.json();
        if(j.pairing_code){ pairingCode=j.pairing_code; setRole(role); }
        if(j.lan_ip) pcIpEl.textContent=j.lan_ip+(j.all_ips&&j.all_ips.length>1?` (+${j.all_ips.length-1} more)`:"");
        else if(j.all_ips&&j.all_ips.length) pcIpEl.textContent=j.all_ips[0];
      }
      if(pairingCode&&role==="share"){
        const qrR=await fetch(`/api/qr?code=${encodeURIComponent(pairingCode)}`);
        if(qrR.ok){ const qj=await qrR.json(); if(qj.qr){qrImg.src=qj.qr;qrUrl.textContent=qj.url;qrCard.style.display="block";} }
      }
    }catch{}
    paired=false; pairingStatus.textContent=""; pairingStatus.className="pairing-status";
    if(role==="receive") statusText.textContent="Enter pairing code, then tap Connect";
    if(role==="share") startPeerPoll();
  }
  const urlRole=new URLSearchParams(location.search).get("role");
  if(urlRole==="share"||urlRole==="receive") role=urlRole;
  setRole(role); fetchPairing();

  btnConnect.addEventListener("click", async()=>{
    const code=codeInput.value.trim().replace(/\D/g,"");
    if(code.length!==6){ pairingStatus.textContent="Enter 6 digits"; pairingStatus.className="pairing-status err"; return; }
    btnConnect.disabled=true; pairingStatus.textContent="Checking…"; pairingStatus.className="pairing-status";
    try{
      const r=await fetch(`/api/verify?code=${encodeURIComponent(code)}`);
      const j=await r.json();
      if(r.ok&&j.ok){
        token=j.token; pairingCode=code; paired=true; localStorage.setItem("pps_token",token);
        pairingStatus.textContent="Paired ✓"; pairingStatus.className="pairing-status ok";
        setRole("receive"); statusText.textContent="Tap Start Speaker to begin audio"; statusDot.className="status-dot";
        const qrR=await fetch(`/api/qr?token=${encodeURIComponent(token)}`);
        if(qrR.ok){ const qj=await qrR.json(); if(qj.qr){qrImg.src=qj.qr;qrUrl.textContent=qj.url;} }
      } else { pairingStatus.textContent="Invalid code — check the sharing device"; pairingStatus.className="pairing-status err"; }
    }catch{ pairingStatus.textContent="Could not reach PC — check same Wi-Fi"; pairingStatus.className="pairing-status err"; }
    btnConnect.disabled=false;
  });
  codeInput.addEventListener("keydown", e=>{ if(e.key==="Enter") btnConnect.click(); });
  codeInput.addEventListener("input", ()=>{ codeInput.value=codeInput.value.replace(/\D/g,"").slice(0,6); });

  function setStatus(state,text){ statusDot.className="status-dot "+state; statusText.textContent=text; }
  function wsUrl(){ const proto=location.protocol==="https:"?"wss:":"ws:"; const t=token?`?token=${encodeURIComponent(token)}`:(pairingCode?`?code=${encodeURIComponent(pairingCode)}`:""); return `${proto}//${location.host}/ws${t}`; }

  volSlider.addEventListener("input", ()=>{
    const v=parseInt(volSlider.value,10); volVal.textContent=v+"%";
    if(gainNode) gainNode.gain.value=v/100; else audioEl.volume=v/100;
  });

  async function start(){
    if(!paired){ infoNote.textContent="Tap Connect after entering the 6-digit code."; pairingStatus.textContent="Not paired — tap Connect"; pairingStatus.className="pairing-status err"; codeInput.focus(); return; }
    btn.disabled=true; setStatus("connecting","Connecting…"); infoNote.textContent="";
    try{ const AC=window.AudioContext||window.webkitAudioContext; if(AC){ if(!audioCtx) audioCtx=new AC({latencyHint:"interactive",sampleRate:48000}); if(audioCtx.state==="suspended") await audioCtx.resume(); } }catch{}
    const config={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
    pc=new RTCPeerConnection(config);
    pc.ontrack=(e)=>{
      const stream=e.streams[0]||new MediaStream([e.track]);
      try{
        const recv=pc.getReceivers().find(r=>r.track&&r.track.kind==="audio");
        if(recv&&recv.jitterBufferTarget!==undefined) recv.jitterBufferTarget=0.02;
        pc.getTransceivers().forEach(t=>{ if(t.receiver&&t.receiver.jitterBufferTarget!==undefined) t.receiver.jitterBufferTarget=0.02; if(t.receiver&&t.receiver.playoutDelayHint!==undefined) t.receiver.playoutDelayHint=0.02; });
        e.track.playoutDelayHint=0.02;
      }catch{}
      audioEl.srcObject=stream;
      try{ audioEl.preservesPitch=false; }catch{}
      audioEl.play().catch(err=>{ console.warn(err); infoNote.textContent="Tap again if you don't hear audio (Safari autoplay)."; });
      setupAudioGraph(stream);
      setStatus("connected","Connected — HD streaming");
      $("device-row").style.display="block"; connected=true; btn.textContent="STOP SPEAKER"; btn.className="btn btn-stop"; btn.disabled=false;
      if(latencyTimer) clearInterval(latencyTimer);
      latencyTimer=setInterval(async()=>{
        try{
          const stats=await pc.getStats();
          stats.forEach(r=>{
            if(r.type==="inbound-rtp"&&r.kind==="audio"&&r.jitterBufferDelay!==undefined){
              const d=r.jitterBufferDelay||0; if(d>0) latencyEl.textContent=`~${Math.round(d*1000)} ms`;
            }
            if(r.type==="candidate-pair"&&r.state==="succeeded"&&r.currentRoundTripTime!==undefined){
              const rtt=r.currentRoundTripTime; if(rtt) latencyEl.textContent=`~${Math.round(rtt*1000)} ms`;
            }
          });
        }catch{}
      },1000);
    };
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==="failed"||pc.connectionState==="disconnected"){ setStatus("failed","Connection failed — tap Start again"); stop(false); }
      else if(pc.connectionState==="connected") setStatus("connected","Connected — HD streaming");
    };
    pc.oniceconnectionstatechange=()=>{ if(pc.iceConnectionState==="failed") infoNote.textContent="ICE failed. Same Wi-Fi? Firewall allowed? Try hotspot."; };
    pc.addTransceiver("audio",{direction:"recvonly"});
    const url=wsUrl(); ws=new WebSocket(url);
    ws.onopen=async()=>{ const offer=await pc.createOffer(); await pc.setLocalDescription(offer); ws.send(JSON.stringify({type:"offer",sdp:offer.sdp})); };
    ws.onmessage=async(ev)=>{
      try{
        const msg=JSON.parse(ev.data);
        if(msg.type==="answer"&&msg.sdp) await pc.setRemoteDescription({type:"answer",sdp:msg.sdp});
        else if(msg.type==="error") infoNote.textContent=msg.message||"Signaling error";
      }catch(e){ console.warn(e); }
    };
    ws.onerror=()=>{
      setStatus("failed","Connection failed");
      infoNote.innerHTML=`WS error to <code>${wsUrl().replace(/token=[^&]+/,"token=***")}</code> — close=${ws?ws.readyState:"?"}<br>Open <code>http://${location.hostname}:8080/api/pairing</code> on iPhone — must show JSON<br>Firewall: <code>netsh advfirewall firewall add rule name="PC Speaker" dir=in action=allow protocol=TCP localport=8080 profile=private</code>`;
      btn.disabled=false;
    };
    ws.onclose=(ev)=>{
      if(!connected&&ev.code===4401){ pairingStatus.textContent="Invalid code"; pairingStatus.className="pairing-status err"; setStatus("failed","Invalid code"); btn.disabled=false; }
      else if(!connected){ const reason=ev.reason?` (${ev.reason})`:""; setStatus("failed",`Not connected [${ev.code}${reason}]`); if(!infoNote.textContent) infoNote.innerHTML=`Close ${ev.code}${reason}<br>WS: <code>${wsUrl().replace(/token=[^&]+/,"token=***")}</code>`; btn.disabled=false; }
    };
    pc.onicecandidate=(e)=>{ if(e.candidate&&ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:"candidate",candidate:e.candidate.candidate,sdpMid:e.candidate.sdpMid,sdpMLineIndex:e.candidate.sdpMLineIndex})); };
  }
  function stop(resetBtn=true){
    connected=false;
    if(latencyTimer){clearInterval(latencyTimer);latencyTimer=null;} latencyEl.textContent="—";
    $("device-row").style.display="none";
    if(spectrumRAF) {cancelAnimationFrame(spectrumRAF); spectrumRAF=null;}
    if(ws){try{ws.close();}catch{} ws=null;}
    if(pc){try{pc.close();}catch{} pc=null;}
    audioEl.srcObject=null; audioEl.pause();
    if(audioCtx){ try{analyser&&analyser.disconnect();}catch{} try{gainNode&&gainNode.disconnect();}catch{} }
    // Keep eqCard visible so you can see it was there; hide meters
    if(resetBtn){ setStatus("","Enter pairing code, then tap Connect"); btn.textContent="START SPEAKER"; btn.className="btn btn-start"; btn.disabled=false; infoNote.textContent=""; }
  }
  btn.addEventListener("click", ()=>{ if(connected) stop(); else start(); });
  if(!window.RTCPeerConnection){ setStatus("failed","WebRTC not supported"); btn.disabled=true; infoNote.textContent="Use Safari on iPhone or a modern browser."; }
})();
