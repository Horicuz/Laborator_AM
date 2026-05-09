"""
Laborator 9 - VoIP si Conferinta
Server de Procesare Audio/Video  FastAPI + WebSockets

Endpoint WebSocket: ws://localhost:9998/process

Protocolul de mesaje (JSON):

CLIENT  SERVER:
  { "type": "config",       "video_filter": "...", "audio_filter": "..." }
  { "type": "video_frame",  "data": "<base64 JPEG>" }
  { "type": "audio_chunk",  "data": "<base64 PCM int16>", "sample_rate": 44100 }

SERVER  CLIENT:
  { "type": "video_frame",  "data": "<base64 JPEG>" }
  { "type": "audio_chunk",  "data": "<base64 PCM int16>" }
  { "type": "error",        "message": "..." }

Filtre video disponibile:
  normal | blur_slight | blur_heavy | grayscale | edges | cartoon | sepia

Filtre audio disponibile:
  normal | bandpass_telephone | lowpass | highpass | noise_gate
"""

import base64
import json
import logging

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from scipy import signal as scipy_signal

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

app = FastAPI(
    title="VoIP Processing Server",
    description="Server de procesare audio/video pentru laboratorul de VoIP",
)


#
# PROCESARE VIDEO
#


def apply_video_filter(image: np.ndarray, filter_name: str) -> np.ndarray:
    """Aplica un filtru pe un cadru video (numpy array BGR)."""

    if filter_name == "blur_slight":
        return cv2.GaussianBlur(image, (7, 7), 0)

    elif filter_name == "blur_heavy":
        return cv2.GaussianBlur(image, (31, 31), 0)

    elif filter_name == "grayscale":
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    elif filter_name == "edges":
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 80, 180)
        return cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)

    elif filter_name == "cartoon":
        # Bilateral filter pentru efect de vopsea + contururi
        color = cv2.bilateralFilter(image, d=9, sigmaColor=300, sigmaSpace=300)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        blur = cv2.medianBlur(gray, 7)
        edges = cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, blockSize=9, C=2
        )
        edges_bgr = cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR)
        return cv2.bitwise_and(color, edges_bgr)

    elif filter_name == "sepia":
        # Kernel sepia adaptat pentru BGR (coloanele R si B inversate fata de RGB standard)
        kernel = np.array(
            [[0.131, 0.534, 0.272], [0.168, 0.686, 0.349], [0.189, 0.769, 0.393]]
        )
        sepia = cv2.transform(image.astype(np.float32), kernel)
        return np.clip(sepia, 0, 255).astype(np.uint8)

    # "normal" sau orice filtru necunoscut  returneaza original
    return image


def decode_video_frame(b64_data: str) -> np.ndarray | None:
    """Decodeaza un cadru video din Base64 (data URI sau raw)."""
    try:
        # Elimina prefixul data URI daca exista
        if "," in b64_data:
            b64_data = b64_data.split(",", 1)[1]
        raw = base64.b64decode(b64_data)
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as e:
        log.warning(f"Eroare decodare frame: {e}")
        return None


def encode_video_frame(image: np.ndarray, quality: int = 70) -> str:
    """Encodeaza un cadru video in Base64 JPEG."""
    _, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return base64.b64encode(buf).decode()


#
# PROCESARE AUDIO
#


def apply_audio_filter(
    audio_bytes: bytes, filter_name: str, sample_rate: int = 44100
) -> bytes:
    """
    Aplica un filtru pe un chunk audio (PCM int16 raw bytes).

    Banda vocii telefonice clasice: 300 Hz  3400 Hz
    Aceasta este banda standardizata de PSTN/G.711 si reprezinta
    intervalul de frecvente suficient pentru inteligibilitatea vorbirii.
    """
    audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float64)

    if filter_name == "bandpass_telephone":
        # Filtru Butterworth bandpass 3003400 Hz (standard telefonie)
        # Elimina frecventele joase (zgomot de fond) si inalte (siflante)
        sos = scipy_signal.butter(
            N=4, Wn=[300, 3400], btype="bandpass", fs=sample_rate, output="sos"
        )
        audio = scipy_signal.sosfilt(sos, audio)

    elif filter_name == "lowpass":
        # Trece-jos la 4000 Hz  reduce zgomotul de inalta frecventa
        sos = scipy_signal.butter(
            N=4, Wn=4000, btype="lowpass", fs=sample_rate, output="sos"
        )
        audio = scipy_signal.sosfilt(sos, audio)

    elif filter_name == "highpass":
        # Trece-sus la 200 Hz  elimina zgomotul de fundal (hum)
        sos = scipy_signal.butter(
            N=4, Wn=200, btype="highpass", fs=sample_rate, output="sos"
        )
        audio = scipy_signal.sosfilt(sos, audio)

    elif filter_name == "noise_gate":
        # Pune pe zero orice sample cu amplitudine sub pragul de 5% din maximul semnalului
        threshold = 0.05 * np.max(np.abs(audio))
        audio[np.abs(audio) < threshold] = 0

    return np.clip(audio, -32768, 32767).astype(np.int16).tobytes()


#
# ENDPOINT WEBSOCKET
#


@app.websocket("/process")
async def process_stream(websocket: WebSocket):
    await websocket.accept()
    client = websocket.client
    log.info(f"Client conectat: {client}")

    video_filter = "normal"
    audio_filter = "normal"

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "JSON invalid"})
                )
                continue

            msg_type = data.get("type")

            #  Configurare filtre
            if msg_type == "config":
                video_filter = data.get("video_filter", video_filter)
                audio_filter = data.get("audio_filter", audio_filter)
                log.info(
                    f"Config actualizat: video={video_filter}, audio={audio_filter}"
                )

            #  Procesare cadru video
            elif msg_type == "video_frame":
                image = decode_video_frame(data.get("data", ""))
                if image is None:
                    continue

                processed = apply_video_filter(image, video_filter)
                b64_out = encode_video_frame(processed)

                await websocket.send_text(
                    json.dumps({"type": "video_frame", "data": b64_out})
                )

            #  Procesare chunk audio
            elif msg_type == "audio_chunk":
                audio_bytes = base64.b64decode(data.get("data", ""))
                sr = int(data.get("sample_rate", 44100))

                processed = apply_audio_filter(audio_bytes, audio_filter, sr)
                b64_out = base64.b64encode(processed).decode()

                await websocket.send_text(
                    json.dumps({"type": "audio_chunk", "data": b64_out})
                )

            else:
                await websocket.send_text(
                    json.dumps(
                        {"type": "error", "message": f"Tip necunoscut: '{msg_type}'"}
                    )
                )

    except WebSocketDisconnect:
        log.info(f"Client deconectat: {client}")


@app.get("/")
def root():
    return {
        "server": "VoIP Processing Server",
        "websocket_endpoint": "ws://localhost:9998/process",
        "video_filters": [
            "normal",
            "blur_slight",
            "blur_heavy",
            "grayscale",
            "edges",
            "cartoon",
            "sepia",
        ],
        "audio_filters": [
            "normal",
            "bandpass_telephone",
            "lowpass",
            "highpass",
            "noise_gate",
        ],
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=9998, log_level="info")
