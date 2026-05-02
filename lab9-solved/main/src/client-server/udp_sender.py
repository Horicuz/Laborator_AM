"""
Laborator 9 - VoIP si Conferinta
UDP Audio Sender  pachetizare RTP-like

Structura header-ului (12 bytes, inspirat din RFC 3550 - RTP):

   flags(2)   seq(2)    timestamp(4)       ssrc(4)


  flags    : versiune + padding + tip payload (simplificat: 0x8000)
  seq      : numar de secventa, creste cu 1 la fiecare pachet
  timestamp: offset in samples fata de inceputul sesiunii
  ssrc     : identificatorul sursei (Synchronization Source)

Utilizare:
  python udp_sender.py                          # localhost, port 5004
  python udp_sender.py --ip 192.168.1.10 --port 5004
"""

import argparse
import socket
import struct
import time

import numpy as np
import sounddevice as sd

#
# Configurare audio
#
SAMPLE_RATE = 8000  # Hz  telefonie standard (G.711)
CHANNELS = 1  # mono
DTYPE = "int16"
CHUNK_SIZE = 160  # samples per packet = 20ms la 8000 Hz

#
# Format header RTP-like
#
HEADER_FMT = "!HHI4s"  # big-endian: uint16, uint16, uint32, 4 chars
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # = 12 bytes
SSRC = b"LAB9"  # identificator fix al sursei


def build_rtp_header(seq: int, timestamp: int) -> bytes:
    """
    Construieste un header RTP-like.

    Args:
        seq:       numarul de secventa al pachetului (065535, cu rollover)
        timestamp: numarul de sample de la inceputul sesiunii

    Returns:
        12 bytes de header
    """
    flags = 0x8000  # V=2, P=0, X=0, CC=0, M=0, PT=0 (PCMU)
    return struct.pack(HEADER_FMT, flags, seq & 0xFFFF, timestamp, SSRC)


def main(target_ip: str, target_port: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    seq = 0
    timestamp = 0
    packets_sent = 0
    start_time = time.time()

    print(f"")
    print(f"         UDP Audio Sender  Laborator 9       ")
    print(f"")
    print(f"  Destinatie : {target_ip}:{target_port:<27}")
    print(f"  Sample rate: {SAMPLE_RATE} Hz                          ")
    print(
        f"  Chunk      : {CHUNK_SIZE} samples = {1000 * CHUNK_SIZE // SAMPLE_RATE}ms/pachet          "
    )
    print(f"  Header     : {HEADER_SIZE} bytes (RTP-like)               ")
    print(f"")
    print("Captura microfon pornita. Ctrl+C pentru oprire.\n")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype=DTYPE, blocksize=CHUNK_SIZE
        ) as stream:
            while True:
                audio_chunk, overflowed = stream.read(CHUNK_SIZE)
                if overflowed:
                    print("  Buffer overflow la captura!")

                payload = audio_chunk.tobytes()
                header = build_rtp_header(seq, timestamp)
                packet = header + payload

                sock.sendto(packet, (target_ip, target_port))

                seq = (seq + 1) & 0xFFFF
                timestamp += CHUNK_SIZE
                packets_sent += 1

                # Afisare statistici la fiecare 5 secunde
                elapsed = time.time() - start_time
                if packets_sent % 250 == 0:
                    bps = (packets_sent * (HEADER_SIZE + len(payload)) * 8) / elapsed
                    print(
                        f" Pachete trimise: {packets_sent:6d} | "
                        f"Bitrate: {bps / 1000:.1f} kbps | "
                        f"Timp: {elapsed:.0f}s"
                    )

    except KeyboardInterrupt:
        print(f"\nOprit. Total pachete trimise: {packets_sent}")
    finally:
        sock.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="UDP Audio Sender cu header RTP-like",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--ip", default="127.0.0.1", help="IP destinatie")
    parser.add_argument("--port", type=int, default=5004, help="Port UDP destinatie")
    args = parser.parse_args()

    main(args.ip, args.port)
