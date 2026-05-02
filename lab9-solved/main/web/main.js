/**
 * Laborator 9 - VoIP si Conferinta
 * WebRTC Client  implementare cu WebSocket pur (fara socket.io)
 *
 * Arhitectura: Mesh topology
 *   - Fiecare peer se conecteaza direct cu TOTI ceilalti peers
 *   - Serverul de signaling doar retransmite mesajele (nu proceseaza media)
 *   - Pentru N participanti: N*(N-1)/2 conexiuni peer-to-peer
 *
 * Fluxul de signaling:
 *   1. Peer nou trimite "join"  primeste "room_info" cu lista peers existenti
 *   2. Peers existenti primesc "peer_joined"  initiaza offer catre noul peer
 *   3. Noul peer primeste offer  raspunde cu answer
 *   4. Se schimba ICE candidates  conexiunea P2P e stabilita
 */

"use strict";

// 
// CONFIGURARE
// 
const SIGNALING_URL    = "ws://localhost:9999";
const PROCESSING_URL   = "ws://localhost:9998/process";
const VIDEO_WIDTH      = 320;
const VIDEO_HEIGHT     = 240;
const STATS_INTERVAL   = 2000;  // ms

// ICE config: folosim STUN-ul public Google pentru teste pe LAN
// Pe retea locala poti folosi si PC_CONFIG = {} (fara STUN)
const PC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// 
// STARE GLOBALA
// 
let signalingWs  = null;    // WebSocket catre serverul de signaling
let processingWs = null;    // WebSocket catre serverul de procesare

let myId         = null;
let isAdmin      = false;
let localStream  = null;
let filteredStream = null;
let roomId       = null;
let isMuted      = false;

// peerConnections: Map<peerId, RTCPeerConnection>
const peerConnections = new Map();

// Timere pentru statistici QoS
const statsTimers = new Map();

// 
// UTILITATI UI
// 

function log(message, type = "info") {
  const logDiv = document.getElementById("log");
  const entry  = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logDiv.prepend(entry);
  // Limitam log-ul la 50 de intrari
  while (logDiv.children.length > 50) logDiv.lastChild.remove();
}

function setStatus(text, color = "#4CAF50") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = color;
}

function createVideoTile(peerId, label) {
  const grid    = document.getElementById("videoGrid");
  const tile    = document.createElement("div");
  tile.id       = `tile-${peerId}`;
  tile.className = "video-tile";

  const video       = document.createElement("video");
  video.id          = `video-${peerId}`;
  video.autoplay    = true;
  video.playsInline = true;
  video.muted       = peerId === "local";
  video.width       = VIDEO_WIDTH;
  video.height      = VIDEO_HEIGHT;

  const lbl       = document.createElement("div");
  lbl.className   = "video-label";
  lbl.textContent = label;

  const statsDiv       = document.createElement("div");
  statsDiv.id          = `stats-${peerId}`;
  statsDiv.className   = "video-stats";
  statsDiv.textContent = "";

  const muteBadge     = document.createElement("div");
  muteBadge.id        = peerId === "local" ? "muteBadge" : null;
  muteBadge.className = "mute-badge";
  muteBadge.textContent = "muted";

  tile.append(video, lbl, statsDiv, muteBadge);
  grid.append(tile);
  return video;
}

function removeVideoTile(peerId) {
  const tile = document.getElementById(`tile-${peerId}`);
  if (tile) tile.remove();

  if (statsTimers.has(peerId)) {
    clearInterval(statsTimers.get(peerId));
    statsTimers.delete(peerId);
  }
}

function updateQosStats(peerId, stats) {
  const el = document.getElementById(`stats-${peerId}`);
  if (!el) return;
  el.textContent =
    `RTT: ${stats.rtt}ms | Jitter: ${stats.jitter}ms | Loss: ${stats.loss}%`;
}

// 
// STREAM LOCAL
// 

async function getLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }
    });

    const localVideo = createVideoTile("local", "Tu (local)");
    localVideo.srcObject = localStream;

    log("Stream local obtinut (camera + microfon)");
    return true;
  } catch (err) {
    log(`Eroare la obtinerea stream-ului: ${err.message}`, "error");
    setStatus("Eroare: nu pot accesa camera/microfonul", "#f44336");
    return false;
  }
}

// 
// SIGNALING  conexiunea cu serverul WebSocket
// 

function connectSignaling(room) {
  signalingWs = new WebSocket(SIGNALING_URL);

  signalingWs.onopen = () => {
    log(`Conectat la serverul de signaling (${SIGNALING_URL})`);
    signalingWs.send(JSON.stringify({ type: "join", room }));
  };

  signalingWs.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleSignalingMessage(data);
  };

  signalingWs.onerror = (err) => {
    log("Eroare WebSocket signaling", "error");
    setStatus("Eroare conexiune signaling", "#f44336");
  };

  signalingWs.onclose = () => {
    log("Conexiunea de signaling s-a inchis", "warn");
    setStatus("Deconectat", "#FF9800");
  };
}

function sendSignaling(data) {
  if (signalingWs?.readyState === WebSocket.OPEN) {
    signalingWs.send(JSON.stringify(data));
  }
}

async function handleSignalingMessage(data) {
  switch (data.type) {

    case "room_info":
      // Am intrat in camera  primim ID-ul nostru si lista de peers existenti
      myId    = data.your_id;
      isAdmin = data.is_admin;
      setStatus(`In camera '${roomId}' | ID: ${myId} ${isAdmin ? "(admin)" : ""}`, "#4CAF50");
      log(`In camera cu ${data.peers.length} participanti existenti`);

      // Peers existenti vor initia offer-ul catre noi (ei au primit "peer_joined")
      // Noi nu facem nimic acum  asteptam offer-urile lor
      if (isAdmin) {
        document.getElementById("kickControls").style.display = "block";
      }
      break;

    case "peer_joined":
      // Un peer nou a intrat  NOI (ca peer existent) initiem offer-ul
      log(`Peer nou a intrat: ${data.peer_id}`);
      await initiateOffer(data.peer_id);
      break;

    case "peer_left":
      log(`Peer a plecat: ${data.peer_id}`, "warn");
      closePeerConnection(data.peer_id);
      removeVideoTile(data.peer_id);
      break;

    case "offer":
      // Am primit un offer de la un peer existent  cream answer
      log(`Offer primit de la ${data.from}`);
      await handleOffer(data.from, data.sdp);
      break;

    case "answer":
      // Am primit answer la offer-ul nostru
      log(`Answer primit de la ${data.from}`);
      await handleAnswer(data.from, data.sdp);
      break;

    case "candidate":
      // ICE candidate de la un peer
      await handleIceCandidate(data.from, data.candidate);
      break;

    case "kicked":
      log("Ai fost eliminat din camera!", "error");
      setStatus("Eliminat din camera", "#f44336");
      cleanup();
      break;

    case "error":
      log(`Eroare server: ${data.message}`, "error");
      break;
  }
}

// 
// WebRTC  gestionarea conexiunilor peer-to-peer
// 

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(PC_CONFIG);

  // Ambele track-uri asociate cu localStream  remote-ul le vede in acelasi stream  audio + video functioneaza
  const audioTrack = localStream.getAudioTracks()[0];
  const videoTrack = (filteredStream ?? localStream).getVideoTracks()[0];
  if (audioTrack) pc.addTrack(audioTrack, localStream);
  if (videoTrack) pc.addTrack(videoTrack, localStream);

  // ICE candidate generat local  trimite la peer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignaling({
        type:      "candidate",
        target:    peerId,
        candidate: event.candidate
      });
    }
  };

  // Schimbari de stare ICE
  pc.oniceconnectionstatechange = () => {
    log(`ICE state cu ${peerId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "failed") {
      log(`Conexiunea ICE cu ${peerId} a esuat  incerc restart`, "warn");
      pc.restartIce();
    }
  };

  // Track primit de la peer  afisare in video tile
  // Nu folosim event.streams[0] (nesigur cand video vine din captureStream)  construim manual
  pc.ontrack = (event) => {
    log(`Track primit de la ${peerId}: ${event.track.kind}`);

    let videoEl = document.getElementById(`video-${peerId}`);
    if (!videoEl) {
      videoEl = createVideoTile(peerId, `Peer ${peerId}`);
      videoEl.srcObject = new MediaStream();
      startQosCollection(peerId, pc);
    }
    videoEl.srcObject.addTrack(event.track);
  };

  peerConnections.set(peerId, pc);
  return pc;
}

async function initiateOffer(peerId) {
  const pc    = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendSignaling({
    type:   "offer",
    target: peerId,
    sdp:    offer
  });
  log(`Offer trimis la ${peerId}`);
}

async function handleOffer(fromId, offerSdp) {
  const pc = createPeerConnection(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  sendSignaling({
    type:   "answer",
    target: fromId,
    sdp:    answer
  });
  log(`Answer trimis la ${fromId}`);
}

async function handleAnswer(fromId, answerSdp) {
  const pc = peerConnections.get(fromId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
  }
}

async function handleIceCandidate(fromId, candidate) {
  const pc = peerConnections.get(fromId);
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      log(`Eroare ICE candidate: ${e.message}`, "warn");
    }
  }
}

function closePeerConnection(peerId) {
  const pc = peerConnections.get(peerId);
  if (pc) {
    pc.close();
    peerConnections.delete(peerId);
  }
}

// 
// METRICI QoS  colectare prin getStats() API
// 

function startQosCollection(peerId, pc) {
  const timer = setInterval(async () => {
    try {
      const stats  = await pc.getStats();
      const result = parseQosStats(stats);
      if (result) updateQosStats(peerId, result);
    } catch (e) {
      clearInterval(timer);
    }
  }, STATS_INTERVAL);

  statsTimers.set(peerId, timer);
}

function parseQosStats(statsReport) {
  let rtt    = "";
  let jitter = "";
  let loss   = "";

  statsReport.forEach(report => {
    if (report.type === "candidate-pair" && report.state === "succeeded") {
      if (report.currentRoundTripTime !== undefined) {
        rtt = (report.currentRoundTripTime * 1000).toFixed(0);
      }
    }

    if (report.type === "inbound-rtp" && report.kind === "audio") {
      if (report.jitter !== undefined) {
        jitter = (report.jitter * 1000).toFixed(1);
      }
      if (report.packetsLost !== undefined && report.packetsReceived > 0) {
        const total = report.packetsReceived + report.packetsLost;
        loss = ((report.packetsLost / total) * 100).toFixed(1);
      }
    }
  });

  return { rtt, jitter, loss };
}

// 
// SERVER DE PROCESARE  filtre audio/video via FastAPI WebSocket
// 

function connectProcessingServer() {
  processingWs = new WebSocket(PROCESSING_URL);

  processingWs.onopen = () => {
    log("Conectat la serverul de procesare audio/video");
  };

  processingWs.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "video_frame") {
      // Desenam frame-ul procesat pe canvas
      const img = new Image();
      img.src   = "data:image/jpeg;base64," + data.data;
      img.onload = () => {
        const canvas = document.getElementById("processedCanvas");
        const ctx    = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
    }
  };

  processingWs.onerror = () => {
    log("Eroare la serverul de procesare (ruleaza ws_processing_server.py?)", "warn");
  };
}

// Filtrul video se aplica client-side pe canvas  fara round-trip la server
function applyLocalFilter(videoElement) {
  const canvas = document.getElementById("processedCanvas");
  const ctx    = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const filter = document.getElementById("videoFilter").value;

  if (filter === "edges") {
    ctx.filter = "none";
    ctx.drawImage(videoElement, 0, 0, w, h);
    applySobel(ctx, w, h);
    return;
  }

  const cssFilter = {
    normal:      "none",
    blur_slight: "blur(3px)",
    blur_heavy:  "blur(15px)",
    grayscale:   "grayscale(100%)",
    cartoon:     "saturate(180%) contrast(140%)",
    sepia:       "sepia(100%)",
  }[filter] ?? "none";

  ctx.filter = cssFilter;
  ctx.drawImage(videoElement, 0, 0, w, h);
  ctx.filter = "none";
}

function applySobel(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const d   = out.data;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const lum = (x1, y1) => {
        const i = ((y + y1) * w + (x + x1)) * 4;
        return 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
      };
      const gx = -lum(-1,-1) - 2*lum(-1,0) - lum(-1,1) + lum(1,-1) + 2*lum(1,0) + lum(1,1);
      const gy = -lum(-1,-1) - 2*lum(0,-1) - lum(1,-1) + lum(-1,1) + 2*lum(0,1) + lum(1,1);
      const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = mag;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
}

function updateFilters() {
  // Video filter aplicat local; doar filtrul audio merge la server
  if (processingWs?.readyState === WebSocket.OPEN) {
    processingWs.send(JSON.stringify({
      type:         "config",
      audio_filter: document.getElementById("audioFilter").value
    }));
  }
  log("Filtre actualizate");
}

// Bucla de trimitere a frame-urilor la serverul de procesare (30 FPS)
let processingLoop = null;
function startProcessingLoop() {
  if (processingLoop) return;
  processingLoop = setInterval(() => {
    const video = document.getElementById("video-local");
    if (video) applyLocalFilter(video);
  }, 1000 / 30);
}

//
// KICK  functionalitate admin
//
// TODO (exercitiu): aceasta functie trimite cererea de kick catre server.
//   Implementarea serverului se face in signaling_server.py (vezi TODO de acolo).
//
//   Cum functioneaza fluxul complet:
//   Pasul 1: adminul introduce ID-ul peer-ului in input si apasa butonul Kick
//   Pasul 2: kickPeer() citeste ID-ul si trimite { type: "kick", target: targetId }
//            catre signaling server via WebSocket
//   Pasul 3: serverul verifica daca expeditorul este admin al camerei
//   Pasul 4: serverul trimite { type: "kicked" } catre peer-ul tinta
//   Pasul 5: peer-ul tinta primeste mesajul si trebuie sa inchida conexiunea
//            - trateaza acest caz in handleSignalingMessage() pentru type === "kicked"
//            - ex: inchide toate conexiunile WebRTC si afiseaza un mesaj utilizatorului
//
function kickPeer() {
  const targetId = parseInt(document.getElementById("kickTarget").value);
  if (!targetId) {
    log("Introdu ID-ul peer-ului de eliminat", "warn");
    return;
  }
  // Pasul 2: trimite cererea de kick catre server
  sendSignaling({ type: "kick", target: targetId });
  log(`Cerere kick trimisa pentru peer ${targetId}`);
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  const btn = document.getElementById("muteBtn");
  if (btn) {
    btn.classList.toggle("muted", isMuted);
    btn.querySelector("span").textContent = isMuted ? "Unmute" : "Mute";
  }
  const badge = document.getElementById("muteBadge");
  if (badge) badge.style.display = isMuted ? "block" : "none";
  log(isMuted ? "Microfon dezactivat" : "Microfon activat");
}

// 
// ENTRY POINT & CLEANUP
// 

async function joinRoom() {
  roomId = document.getElementById("roomInput").value.trim() || "default";

  document.getElementById("joinSection").style.display  = "none";
  document.getElementById("mainSection").style.display  = "block";
  document.getElementById("roomName").textContent = roomId;

  setStatus("Se obtine accesul la camera...", "#FF9800");

  const ok = await getLocalStream();
  if (!ok) return;

  // Initializeaza filteredStream din canvas-ul procesat.
  // Seed-uim canvas-ul cu primul frame raw ca peers sa nu vada negru la start.
  const processedCanvas = document.getElementById("processedCanvas");
  const seedVideo = document.getElementById("video-local");
  if (seedVideo) {
    const ctx = processedCanvas.getContext("2d");
    const drawSeed = () => {
      if (seedVideo.readyState >= 2) {
        ctx.drawImage(seedVideo, 0, 0, processedCanvas.width, processedCanvas.height);
      } else {
        seedVideo.addEventListener("loadeddata", () =>
          ctx.drawImage(seedVideo, 0, 0, processedCanvas.width, processedCanvas.height),
        { once: true });
      }
    };
    drawSeed();
  }
  filteredStream = processedCanvas.captureStream(30);

  setStatus("Conectare la serverul de signaling...", "#FF9800");
  connectSignaling(roomId);
  connectProcessingServer();
  startProcessingLoop();
}

function cleanup() {
  peerConnections.forEach((pc) => { pc.close(); });
  peerConnections.clear();
  statsTimers.forEach(t => clearInterval(t));
  statsTimers.clear();
  if (processingLoop) { clearInterval(processingLoop); processingLoop = null; }
  if (signalingWs)    signalingWs.close();
  if (processingWs)   processingWs.close();
  if (localStream)    localStream.getTracks().forEach(t => t.stop());
  if (filteredStream) { filteredStream.getTracks().forEach(t => t.stop()); filteredStream = null; }
  localStream = null;
  isMuted = false;
}

function leaveRoom() {
  cleanup();
  // Reset UI
  document.getElementById("videoGrid").innerHTML = "";
  document.getElementById("log").innerHTML = "";
  document.getElementById("kickControls").style.display = "none";
  document.getElementById("mainSection").style.display = "none";
  document.getElementById("joinSection").style.display  = "flex";
  setStatus("Conectare...", "#FF9800");
  // Reset mute button
  const btn = document.getElementById("muteBtn");
  if (btn) { btn.classList.remove("muted"); btn.querySelector("span").textContent = "Mute"; }
}

window.addEventListener("beforeunload", cleanup);
