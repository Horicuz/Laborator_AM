"""
Cross-platform launcher for Lab 9 servers.
Works on Windows (Conda), macOS and Linux.

Usage:
    python start.py
"""
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

SERVERS = [
    ("Signaling server  (ws://localhost:9999)", ["signaling_server.py"]),
    ("Processing server (ws://localhost:9998)", ["ws_processing_server.py"]),
    ("Web server        (http://localhost:4321)", ["web_server.py"]),
]

processes = []


def main():
    print("Starting Lab 9 servers...\n")

    for label, args in SERVERS:
        p = subprocess.Popen([sys.executable] + args, cwd=SCRIPT_DIR)
        processes.append(p)
        print(f"  {label}")
        time.sleep(0.8)

    print("\nOpen in browser: http://localhost:4321")
    print("Press Ctrl+C to stop all servers.\n")

    try:
        for p in processes:
            p.wait()
    except KeyboardInterrupt:
        print("\nStopping servers...")
        for p in processes:
            p.terminate()
        print("Done.")


if __name__ == "__main__":
    main()
