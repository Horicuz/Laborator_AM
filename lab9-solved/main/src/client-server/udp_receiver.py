"""
Laborator 9 - VoIP si Conferinta
UDP Audio Receiver  cu Jitter Buffer simplu

Jitter Buffer:
  Problema jitter-ului: pachetele UDP nu ajung la intervale regulate,
  ci cu variatii de intarziere (jitter). Daca le redam imediat ce ajung,
  auzim discontinuitati. Solutia: introducem un delay fix intentionat
  (buffer), acumulam cateva pachete, si redam din buffer la ritm constant.

  Fara jitter buffer: redam imediat  glitch-uri, pauze, crackling
  Cu jitter buffer:   redam cu N*20ms delay  audio lin si continuu

Structura header-ului asteptat (12 bytes):

   flags(2)   seq(2)    timestamp(4)       ssrc(4)


Utilizare:
  python udp_receiver.py                    # asculta pe portul 5004
  python udp_receiver.py --port 5004 --buffer 5
"""

import argparse
import queue
import socket
import struct
import threading
import time

import numpy as np
import sounddevice as sd

#
# Configurare audio (trebuie sa fie identica cu sender-ul)
#
SAMPLE_RATE = 8000
CHANNELS = 1
DTYPE = "int16"
CHUNK_SIZE = 160

HEADER_FMT = "!HHI4s"
HEADER_SIZE = struct.calcsize(HEADER_FMT)

# Silence = array de zeros (redat in caz de underrun)
SILENCE = np.zeros(CHUNK_SIZE, dtype=np.int16)


def parse_rtp_header(data: bytes) -> dict:
    """Parseaza header-ul RTP-like si returneaza un dict cu campurile sale."""
    flags, seq, timestamp, ssrc = struct.unpack(HEADER_FMT, data[:HEADER_SIZE])
    return {
        "flags": flags,
        "seq": seq,
        "timestamp": timestamp,
        "ssrc": ssrc,
        "payload": data[HEADER_SIZE:],
    }


class JitterBuffer:
    """
    Jitter Buffer simplu cu dimensiune fixa.

    Functionare:
      - Thread-ul de receptie UDP adauga pachete in coada (put)
      - Thread-ul de redare extrage pachete din coada la ritm constant (get)
      - La pornire, asteptam sa se umple `size` pachete inainte de a reda
        (aceasta introduce delay-ul de jitter buffer)
      - Daca buffer-ul e gol la momentul redarii  redam silence (underrun)
      - Daca buffer-ul e plin si vine un pachet nou  eliminam cel mai vechi (overflow)
    """

    def __init__(self, size: int = 5):
        self.size = size
        self._q = queue.Queue(maxsize=size * 3)
        self.stats = {
            "received": 0,
            "lost": 0,
            "underruns": 0,
            "overflows": 0,
            "last_seq": -1,
        }

    def put(self, packet: dict):
        """Adauga un pachet in buffer. Daca e plin, elimina cel mai vechi."""
        # Detectare pachete pierdute
        if self.stats["last_seq"] >= 0:
            expected = (self.stats["last_seq"] + 1) & 0xFFFF
            if packet["seq"] != expected:
                gap = (packet["seq"] - expected) & 0xFFFF
                if gap < 1000:  # ignoram reordonari mari (probabil rollover)
                    self.stats["lost"] += gap
                    print(
                        f"    {gap} pachet(e) pierdut(e) "
                        f"(seq asteptat {expected}, primit {packet['seq']})"
                    )

        self.stats["last_seq"] = packet["seq"]
        self.stats["received"] += 1

        try:
            self._q.put_nowait(packet["payload"])
        except queue.Full:
            self._q.get_nowait()  # elimina cel mai vechi
            self._q.put_nowait(packet["payload"])
            self.stats["overflows"] += 1

    def get(self, timeout: float = 0.1) -> bytes | None:
        """
        Extrage payload-ul urmator din buffer.
        Returneaza None daca buffer-ul este gol (underrun).
        """
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            self.stats["underruns"] += 1
            return None

    def wait_until_ready(self):
        """Blocheaza pana cand buffer-ul are cel putin `size` pachete."""
        while self._q.qsize() < self.size:
            time.sleep(0.005)

    @property
    def loss_percent(self) -> float:
        total = self.stats["received"] + self.stats["lost"]
        return 100.0 * self.stats["lost"] / total if total > 0 else 0.0


def receive_thread(sock: socket.socket, jb: JitterBuffer):
    """Thread care asculta pe socket UDP si alimenteaza jitter buffer-ul."""
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            if len(data) < HEADER_SIZE:
                continue
            packet = parse_rtp_header(data)
            jb.put(packet)
        except OSError:
            break


def playback_thread(jb: JitterBuffer):
    """Thread care extrage din jitter buffer si reda audio la ritm constant."""
    delay_ms = jb.size * CHUNK_SIZE * 1000 // SAMPLE_RATE
    print(
        f"   Astept umplerea jitter buffer-ului "
        f"({jb.size} pachete = {delay_ms}ms delay introdus)..."
    )
    jb.wait_until_ready()
    print(f"    Redare pornita (delay jitter buffer: {delay_ms}ms)\n")

    with sd.OutputStream(
        samplerate=SAMPLE_RATE, channels=CHANNELS, dtype=DTYPE, blocksize=CHUNK_SIZE
    ) as stream:
        while True:
            payload = jb.get()
            if payload is not None:
                audio = np.frombuffer(payload, dtype=np.int16)
                if len(audio) == CHUNK_SIZE:
                    stream.write(audio)
            else:
                # Underrun  scriem silence pentru a evita blocajul
                stream.write(SILENCE)


def stats_thread(jb: JitterBuffer, interval: float = 5.0):
    """Thread care afiseaza periodic statistici de receptie."""
    while True:
        time.sleep(interval)
        s = jb.stats
        print(
            f"   Stats | Primite: {s['received']:6d} | "
            f"Pierdute: {s['lost']:4d} ({jb.loss_percent:.1f}%) | "
            f"Underruns: {s['underruns']:3d} | "
            f"Overflows: {s['overflows']:3d} | "
            f"Buffer: {jb._q.qsize():2d}/{jb.size * 3} pachete"
        )


def main(port: int, buffer_size: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", port))

    jb = JitterBuffer(size=buffer_size)

    print(f"")
    print(f"        UDP Audio Receiver  Laborator 9      ")
    print(f"")
    print(f"  Port ascultare : {port:<27}")
    print(
        f"  Jitter buffer  : {buffer_size} pachete = "
        f"{buffer_size * CHUNK_SIZE * 1000 // SAMPLE_RATE}ms delay          "
    )
    print(f"\n")

    threads = [
        threading.Thread(target=receive_thread, args=(sock, jb), daemon=True),
        threading.Thread(target=playback_thread, args=(jb,), daemon=True),
        threading.Thread(target=stats_thread, args=(jb,), daemon=True),
    ]

    for t in threads:
        t.start()

    print("Astept pachete UDP... Ctrl+C pentru oprire.\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print(f"\nOprit.")
        s = jb.stats
        print(f"Statistici finale:")
        print(f"  Pachete primite : {s['received']}")
        print(f"  Pachete pierdute: {s['lost']} ({jb.loss_percent:.1f}%)")
        print(f"  Underruns       : {s['underruns']}")
        print(f"  Overflows       : {s['overflows']}")
    finally:
        sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="UDP Audio Receiver cu Jitter Buffer",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--port", type=int, default=5004, help="Port UDP pe care se asculta"
    )
    parser.add_argument(
        "--buffer",
        type=int,
        default=5,
        help="Dimensiunea jitter buffer-ului in pachete (1 pachet = 20ms)",
    )
    args = parser.parse_args()

    main(args.port, args.buffer)
