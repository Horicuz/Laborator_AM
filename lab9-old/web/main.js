const SIGNALING_URL = "ws://127.0.0.1:10001/ws";
const REMOTE_DELAY_MS = 3000;
const FRAME_CAPTURE_MS = 80;
const FRAME_RENDER_MS = 33;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const connectionPill = document.getElementById("connection-pill");
const startPanel = document.getElementById("start-panel");
const sessionScreen = document.getElementById("session-screen");
const statusMsg = document.getElementById("status-msg");
const localTitle = document.getElementById("local-title");
const localSubtitle = document.getElementById("local-subtitle");
const remoteTitle = document.getElementById("remote-title");
const remoteSubtitle = document.getElementById("remote-subtitle");
const localCard = document.getElementById("local-card");
const remoteCard = document.getElementById("remote-card");
const localVideo = document.getElementById("local-video");
const remoteCanvas = document.getElementById("remote-canvas");
const remoteCanvasCtx = remoteCanvas.getContext("2d");
const remoteSourceVideo = document.getElementById("remote-source-video");
const joinBtn = document.getElementById("join-btn");
const muteBtn = document.getElementById("mute-btn");
const cameraBtn = document.getElementById("camera-btn");
const blurBtn = document.getElementById("blur-btn");
const noiseBtn = document.getElementById("noise-btn");

let signalingSocket = null;
let localStream = null;
let peerConnection = null;
let audioContext = null;
let remoteAudioGraph = null;
let localRole = null;
let peerRole = null;
let isJoining = false;
let callStarted = false;
let remoteStream = null;
let capturingFrame = false;
let captureTimer = null;
let renderTimer = null;
let frameQueue = [];
let displayedBitmap = null;

function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function setStatus(message, color = "#fbbf24") {
  statusMsg.textContent = message;
  statusMsg.style.color = color;
  log(`STATUS: ${message}`);
}

function setConnectionPill(message, color = "#94a3b8") {
  connectionPill.textContent = message;
  connectionPill.style.color = color;
}

function showTodo6Placeholder(featureName) {
  setStatus(`${featureName} is reserved for TODO 6.`, "#fbbf24");
}

function showSessionScreen() {
  startPanel.classList.add("hidden");
  sessionScreen.classList.remove("hidden");
}

function showStartScreen() {
  startPanel.classList.remove("hidden");
  sessionScreen.classList.add("hidden");
}

function updateRoleLabels() {
  const myRoleLabel =
    localRole === "client2" ? "Client 2 - You" : "Client 1 - You";
  const peerRoleLabel =
    localRole === "client2"
      ? "Client 1 - Delayed preview"
      : "Client 2 - Delayed preview";

  localTitle.textContent = myRoleLabel;
  remoteTitle.textContent = peerRoleLabel;
  localSubtitle.textContent = "Your live camera and microphone.";
  remoteSubtitle.textContent = "Remote audio and video appear 3 seconds late.";
}

function getPeerLabel() {
  return localRole === "client2" ? "Client 1" : "Client 2";
}

function syncRemoteCanvasSize() {
  const rect = remoteCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (remoteCanvas.width !== width || remoteCanvas.height !== height) {
    remoteCanvas.width = width;
    remoteCanvas.height = height;
  }
}

function drawRemotePlaceholder(message) {
  syncRemoteCanvasSize();

  const width = remoteCanvas.width;
  const height = remoteCanvas.height;
  const gradient = remoteCanvasCtx.createLinearGradient(0, 0, width, height);

  gradient.addColorStop(0, "rgba(103, 232, 249, 0.12)");
  gradient.addColorStop(1, "rgba(52, 211, 153, 0.08)");

  remoteCanvasCtx.fillStyle = "#020617";
  remoteCanvasCtx.fillRect(0, 0, width, height);
  remoteCanvasCtx.fillStyle = gradient;
  remoteCanvasCtx.fillRect(0, 0, width, height);

  remoteCanvasCtx.strokeStyle = "rgba(148, 163, 184, 0.18)";
  remoteCanvasCtx.lineWidth = Math.max(1, width * 0.003);
  remoteCanvasCtx.strokeRect(
    remoteCanvasCtx.lineWidth / 2,
    remoteCanvasCtx.lineWidth / 2,
    width - remoteCanvasCtx.lineWidth,
    height - remoteCanvasCtx.lineWidth,
  );

  remoteCanvasCtx.fillStyle = "rgba(248, 250, 252, 0.92)";
  remoteCanvasCtx.font = `${Math.max(18, Math.round(width * 0.028))}px Inter, Segoe UI, sans-serif`;
  remoteCanvasCtx.textAlign = "center";
  remoteCanvasCtx.textBaseline = "middle";
  remoteCanvasCtx.fillText(message, width / 2, height / 2);
}

function cleanupRemoteAudioGraph() {
  if (!remoteAudioGraph) return;

  try {
    remoteAudioGraph.source.disconnect();
    remoteAudioGraph.delay.disconnect();
    remoteAudioGraph.gain.disconnect();
  } catch (error) {
    log(`Audio cleanup failed: ${error.message}`);
  }

  remoteAudioGraph = null;
}

function stopRemoteTimers() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }

  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}

function clearRemoteFrames() {
  while (frameQueue.length > 0) {
    const frame = frameQueue.shift();
    frame.bitmap.close();
  }

  if (displayedBitmap) {
    displayedBitmap.close();
    displayedBitmap = null;
  }
}

function resetRemotePlayback() {
  stopRemoteTimers();
  clearRemoteFrames();
  cleanupRemoteAudioGraph();

  remoteStream = null;
  remoteSourceVideo.pause();
  remoteSourceVideo.srcObject = null;

  drawRemotePlaceholder(
    localRole
      ? `Waiting for ${getPeerLabel()}...`
      : "Waiting for remote stream...",
  );
}

async function setupDelayedRemoteAudio(stream) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    log("AudioContext is not supported in this browser.");
    return;
  }

  if (!audioContext) {
    audioContext = new AudioContextCtor();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  cleanupRemoteAudioGraph();

  const source = audioContext.createMediaStreamSource(stream);
  const delay = audioContext.createDelay(10);
  delay.delayTime.value = REMOTE_DELAY_MS / 1000;
  const gain = audioContext.createGain();
  gain.gain.value = 1;

  source.connect(delay).connect(gain).connect(audioContext.destination);
  remoteAudioGraph = { source, delay, gain };
}

async function captureRemoteFrame() {
  if (capturingFrame || !remoteSourceVideo.srcObject) return;

  if (remoteSourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  capturingFrame = true;

  try {
    const bitmap = await createImageBitmap(remoteSourceVideo);
    frameQueue.push({ capturedAt: performance.now(), bitmap });

    if (frameQueue.length > 120) {
      const dropped = frameQueue.shift();
      dropped.bitmap.close();
    }
  } catch (error) {
    log(`Frame capture failed: ${error.message}`);
  } finally {
    capturingFrame = false;
  }
}

function renderDelayedFrame() {
  syncRemoteCanvasSize();

  const now = performance.now();
  let latestFrame = null;

  while (
    frameQueue.length > 0 &&
    frameQueue[0].capturedAt <= now - REMOTE_DELAY_MS
  ) {
    latestFrame = frameQueue.shift();
  }

  if (latestFrame) {
    if (displayedBitmap) {
      displayedBitmap.close();
    }

    displayedBitmap = latestFrame.bitmap;
  }

  if (displayedBitmap) {
    remoteCanvasCtx.clearRect(0, 0, remoteCanvas.width, remoteCanvas.height);
    remoteCanvasCtx.drawImage(
      displayedBitmap,
      0,
      0,
      remoteCanvas.width,
      remoteCanvas.height,
    );
    return;
  }

  drawRemotePlaceholder(
    remoteStream
      ? "Buffering delayed remote stream..."
      : `Waiting for ${getPeerLabel()}...`,
  );
}

function startRemotePlaybackTimers() {
  stopRemoteTimers();
  captureTimer = setInterval(captureRemoteFrame, FRAME_CAPTURE_MS);
  renderTimer = setInterval(renderDelayedFrame, FRAME_RENDER_MS);
}

async function startRemotePlayback(stream) {
  stopRemoteTimers();
  clearRemoteFrames();
  cleanupRemoteAudioGraph();

  remoteStream = stream;
  remoteSourceVideo.srcObject = stream;
  remoteSourceVideo.muted = true;

  try {
    await remoteSourceVideo.play();
  } catch (error) {
    log(`Remote video autoplay blocked: ${error.message}`);
  }

  await setupDelayedRemoteAudio(stream);
  startRemotePlaybackTimers();
  setStatus(
    `Remote ${getPeerLabel()} connected. Playback is delayed by 3 seconds.`,
    "#34d399",
  );
}

function closePeerConnection() {
  if (!peerConnection) return;

  try {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  } catch (error) {
    log(`Peer connection close error: ${error.message}`);
  }

  peerConnection = null;
}

function createPeerConnection() {
  closePeerConnection();

  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream && stream !== remoteStream) {
      startRemotePlayback(stream);
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) return;

    sendSignal(
      "webrtc_ice_candidate",
      event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
    );
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    log(`Peer connection state: ${state}`);

    if (state === "connected") {
      setStatus("Peer connection established.", "#34d399");
    }

    if (state === "failed" || state === "disconnected") {
      setStatus(`Peer connection ${state}.`, "#fb7185");
    }
  };
}

function sendSignal(type, data = null) {
  if (!signalingSocket || signalingSocket.readyState !== WebSocket.OPEN) {
    log(`Cannot send ${type}; signaling socket is not open.`);
    return;
  }

  signalingSocket.send(JSON.stringify({ type, data }));
}

function buildDisplayState() {
  updateRoleLabels();
  showSessionScreen();
  connectionPill.textContent =
    localRole === "client2" ? "Client 2" : "Client 1";
  setConnectionPill(
    connectionPill.textContent,
    localRole === "client2" ? "#67e8f9" : "#34d399",
  );
}

function handleRoleMessage(payload) {
  localRole = payload.role;
  peerRole = payload.peer_role;
  buildDisplayState();
  setStatus(payload.message || "Role assigned.", "#fbbf24");

  if (localRole === "client1") {
    localCard.style.borderColor = "rgba(52, 211, 153, 0.45)";
    remoteCard.style.borderColor = "rgba(251, 191, 36, 0.45)";
  } else {
    localCard.style.borderColor = "rgba(103, 232, 249, 0.45)";
    remoteCard.style.borderColor = "rgba(251, 191, 36, 0.45)";
  }

  if (peerRole && payload.message && payload.message.includes("Both clients")) {
    setStatus(payload.message, "#34d399");
  }
}

async function startCall() {
  try {
    if (!peerConnection) {
      createPeerConnection();
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal("webrtc_offer", offer);
    setStatus(`Calling ${getPeerLabel()}...`, "#fbbf24");
  } catch (error) {
    log(`startCall error: ${error.message}`);
    callStarted = false;
    setStatus("Unable to start the call.", "#fb7185");
  }
}

async function flushQueuedIceCandidates() {
  while (
    peerConnection &&
    peerConnection.remoteDescription &&
    queuedIceCandidates.length > 0
  ) {
    await peerConnection.addIceCandidate(queuedIceCandidates.shift());
  }
}

const queuedIceCandidates = [];

async function handleOffer(offer) {
  try {
    if (!peerConnection) {
      createPeerConnection();
    }

    await peerConnection.setRemoteDescription(offer);
    await flushQueuedIceCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal("webrtc_answer", answer);
    setStatus("Answer sent. Waiting for delayed playback...", "#34d399");
    callStarted = true;
  } catch (error) {
    log(`handleOffer error: ${error.message}`);
    callStarted = false;
    setStatus("Failed to process the incoming offer.", "#fb7185");
  }
}

async function handleAnswer(answer) {
  try {
    if (!peerConnection) return;

    await peerConnection.setRemoteDescription(answer);
    await flushQueuedIceCandidates();
    callStarted = true;
    setStatus(
      `Call established. ${getPeerLabel()} is delayed by 3 seconds.`,
      "#34d399",
    );
  } catch (error) {
    log(`handleAnswer error: ${error.message}`);
    callStarted = false;
    setStatus("Failed to process the answer.", "#fb7185");
  }
}

async function handleIceCandidate(candidate) {
  if (!candidate) return;

  try {
    const iceCandidate = new RTCIceCandidate(candidate);

    if (!peerConnection || !peerConnection.remoteDescription) {
      queuedIceCandidates.push(iceCandidate);
      return;
    }

    await peerConnection.addIceCandidate(iceCandidate);
  } catch (error) {
    log(`handleIceCandidate error: ${error.message}`);
  }
}

function handlePeerConnected() {
  setStatus(`The other tab joined. Calling ${getPeerLabel()}...`, "#34d399");

  if (localRole === "client1" && !callStarted) {
    callStarted = true;
    startCall();
  }
}

function handlePeerDisconnected() {
  setStatus(
    `The other tab disconnected. Waiting for ${getPeerLabel()}...`,
    "#fbbf24",
  );
  callStarted = false;
  closePeerConnection();
  resetRemotePlayback();
}

function handleServerError(payload) {
  setStatus(payload.message || "Signaling error.", "#fb7185");
}

function handleFullRoom(payload) {
  setStatus(payload.message || "Room is full.", "#fb7185");
  setConnectionPill("Room full", "#fb7185");
  joinBtn.disabled = false;
  isJoining = false;
  showStartScreen();
}

function handleSocketClose(event) {
  signalingSocket = null;
  setConnectionPill("Disconnected", "#94a3b8");

  if (!isJoining) {
    return;
  }

  joinBtn.disabled = false;
  isJoining = false;
  callStarted = false;
  closePeerConnection();
  resetRemotePlayback();
  showStartScreen();
  setStatus(`Connection closed (${event.code || "closed"}).`, "#fb7185");
}

function handleServerMessage(event) {
  let payload;

  try {
    payload = JSON.parse(event.data);
  } catch (error) {
    log(`Invalid server message: ${error.message}`);
    return;
  }

  switch (payload.type) {
    case "role":
      handleRoleMessage(payload);
      break;
    case "peer_connected":
      handlePeerConnected(payload);
      break;
    case "peer_disconnected":
      handlePeerDisconnected(payload);
      break;
    case "webrtc_offer":
      handleOffer(payload.data);
      break;
    case "webrtc_answer":
      handleAnswer(payload.data);
      break;
    case "webrtc_ice_candidate":
      handleIceCandidate(payload.data);
      break;
    case "full":
      handleFullRoom(payload);
      break;
    case "error":
      handleServerError(payload);
      break;
    default:
      log(`Unknown message type: ${payload.type}`);
  }
}

function connectSignaling() {
  signalingSocket = new WebSocket(SIGNALING_URL);

  signalingSocket.addEventListener("open", () => {
    setConnectionPill("Connected", "#67e8f9");
    setStatus("Connected to the local signaling server.", "#fbbf24");
  });

  signalingSocket.addEventListener("message", handleServerMessage);
  signalingSocket.addEventListener("close", handleSocketClose);
  signalingSocket.addEventListener("error", () => {
    setStatus("The signaling server is not reachable.", "#fb7185");
    if (isJoining) {
      joinBtn.disabled = false;
      isJoining = false;
      showStartScreen();
      setConnectionPill("Disconnected", "#94a3b8");
    }
  });
}

async function prepareLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access.");
  }

  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (AudioContextCtor && !audioContext) {
    audioContext = new AudioContextCtor();
  }

  if (audioContext && audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

joinBtn.addEventListener("click", async () => {
  if (isJoining) return;

  isJoining = true;
  joinBtn.disabled = true;

  try {
    setStatus("Requesting camera and microphone access...", "#fbbf24");
    await prepareLocalMedia();
    showSessionScreen();
    drawRemotePlaceholder("Waiting for the second client...");
    connectSignaling();
  } catch (error) {
    log(`Join failed: ${error.message}`);
    setStatus(error.message, "#fb7185");
    joinBtn.disabled = false;
    isJoining = false;
    showStartScreen();
  }
});

muteBtn.addEventListener("click", (event) => {
  if (!localStream) return;

  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;

  audioTrack.enabled = !audioTrack.enabled;
  event.target.textContent = audioTrack.enabled
    ? "Mute microphone"
    : "Unmute microphone";
});

cameraBtn.addEventListener("click", (event) => {
  if (!localStream) return;

  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;

  videoTrack.enabled = !videoTrack.enabled;
  event.target.textContent = videoTrack.enabled
    ? "Turn off camera"
    : "Turn on camera";
});

blurBtn.addEventListener("click", () => {
  showTodo6Placeholder("Camera blur");
});

noiseBtn.addEventListener("click", () => {
  showTodo6Placeholder("Noise suppression");
});

window.addEventListener("resize", () => {
  if (sessionScreen.classList.contains("hidden")) return;
  renderDelayedFrame();
});

window.addEventListener("beforeunload", () => {
  if (signalingSocket) {
    signalingSocket.close();
  }

  stopRemoteTimers();
  clearRemoteFrames();
  cleanupRemoteAudioGraph();

  if (peerConnection) {
    peerConnection.close();
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
  }
});

drawRemotePlaceholder("Waiting for the second client...");
