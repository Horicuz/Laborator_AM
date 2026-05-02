"""
Laborator 9 - VoIP si Conferinta
Server de Signaling WebRTC  implementare cu WebSockets pur (fara socket.io)

Protocolul de mesaje:

CLIENT  SERVER:
  { "type": "join",      "room": "<room_id>" }
  { "type": "offer",     "target": <peer_id>, "sdp": {...} }
  { "type": "answer",    "target": <peer_id>, "sdp": {...} }
  { "type": "candidate", "target": <peer_id>, "candidate": {...} }
  { "type": "kick",      "target": <peer_id> }

SERVER  CLIENT:
  { "type": "room_info",   "your_id": <id>, "peers": [<id>, ...] }
  { "type": "peer_joined", "peer_id": <id> }
  { "type": "peer_left",   "peer_id": <id> }
  { "type": "offer",       "from": <id>, "sdp": {...} }
  { "type": "answer",      "from": <id>, "sdp": {...} }
  { "type": "candidate",   "from": <id>, "candidate": {...} }
  { "type": "kicked" }
  { "type": "error",       "message": "..." }
"""

import asyncio
import json
import logging
from collections import defaultdict

import websockets

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# rooms[room_id] = { peer_id: websocket }
rooms: dict[str, dict[int, websockets.WebSocketServerProtocol]] = defaultdict(dict)

# admins[room_id] = peer_id (primul care intra e admin)
admins: dict[str, int] = {}


async def send_json(ws: websockets.WebSocketServerProtocol, data: dict):
    """Trimite un mesaj JSON la un client, ignorand erorile de conexiune inchisa."""
    try:
        await ws.send(json.dumps(data))
    except websockets.exceptions.ConnectionClosed:
        pass


async def broadcast(room_id: str, data: dict, exclude_id: int = None):
    """Trimite un mesaj tuturor peers din camera, cu exceptia optionala a unuia."""
    for pid, ws in list(rooms[room_id].items()):
        if pid != exclude_id:
            await send_json(ws, data)


async def handler(websocket: websockets.WebSocketServerProtocol):
    peer_id = id(websocket)
    current_room: str | None = None

    log.info(f"Conexiune noua: peer_id={peer_id}")

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_json(websocket, {"type": "error", "message": "JSON invalid"})
                continue

            msg_type = data.get("type")

            #
            # JOIN  intrare intr-o camera
            #
            if msg_type == "join":
                if current_room:
                    await send_json(
                        websocket,
                        {"type": "error", "message": "Esti deja intr-o camera"},
                    )
                    continue

                room_id = str(data.get("room", "default")).strip()
                if not room_id:
                    room_id = "default"

                current_room = room_id
                existing_peers = list(rooms[room_id].keys())
                rooms[room_id][peer_id] = websocket

                # Primul peer devine admin
                if room_id not in admins:
                    admins[room_id] = peer_id

                # Trimite room_info peer-ului care tocmai a intrat
                await send_json(
                    websocket,
                    {
                        "type": "room_info",
                        "your_id": peer_id,
                        "peers": existing_peers,
                        "is_admin": admins[room_id] == peer_id,
                    },
                )

                # Anunta peers existenti ca a intrat cineva nou
                await broadcast(
                    room_id,
                    {"type": "peer_joined", "peer_id": peer_id},
                    exclude_id=peer_id,
                )

                log.info(
                    f"Peer {peer_id} a intrat in camera '{room_id}' "
                    f"({len(rooms[room_id])} participanti total)"
                )

            #
            # OFFER / ANSWER / CANDIDATE  forwarding direct
            #
            elif msg_type in ("offer", "answer", "candidate"):
                if not current_room:
                    await send_json(
                        websocket,
                        {"type": "error", "message": "Nu esti in nicio camera"},
                    )
                    continue

                target_id = data.get("target")
                target_ws = rooms[current_room].get(target_id)

                if target_ws:
                    await send_json(target_ws, {**data, "from": peer_id})
                else:
                    await send_json(
                        websocket,
                        {
                            "type": "error",
                            "message": f"Peer-ul {target_id} nu exista in camera",
                        },
                    )

            #
            # KICK  doar adminul poate elimina un participant
            #
            # TODO (exercitiu): implementeaza logica de kick
            #   Pasul 1: verifica daca peer-ul curent este admin al camerei
            #     - foloseste admins.get(current_room) si compara cu peer_id
            #     - daca nu este admin, trimite un mesaj de eroare si continua
            #
            #   Pasul 2: extrage ID-ul peer-ului de eliminat din mesaj
            #     - target_id = data.get("target")
            #
            #   Pasul 3: gaseste websocket-ul peer-ului tinta
            #     - cauta in rooms[current_room] dupa target_id
            #
            #   Pasul 4: daca peer-ul exista in camera:
            #     a) trimite-i un mesaj {"type": "kicked"} ca sa stie ca a fost eliminat
            #     b) sterge-l din dictionar: del rooms[current_room][target_id]
            #     c) anunta restul camerei cu {"type": "peer_left", "peer_id": target_id}
            #     d) logeaza evenimentul
            #
            elif msg_type == "kick":
                if not current_room:
                    continue

                # Pasul 1: verifica daca peer-ul curent este admin
                if admins.get(current_room) != peer_id:
                    await send_json(
                        websocket,
                        {"type": "error", "message": "Doar adminul poate da kick"},
                    )
                    continue

                # Pasul 2: extrage target-ul din mesaj
                target_id = data.get("target")
                # Pasul 3: gaseste websocket-ul tintei
                target_ws = rooms[current_room].get(target_id)

                if target_ws:
                    # Pasul 4a: notifica peer-ul eliminat
                    await send_json(target_ws, {"type": "kicked"})
                    # Pasul 4b: sterge-l din camera
                    del rooms[current_room][target_id]
                    # Pasul 4c: anunta restul camerei
                    await broadcast(
                        current_room, {"type": "peer_left", "peer_id": target_id}
                    )
                    # Pasul 4d: logeaza evenimentul
                    log.info(
                        f"Peer {target_id} dat afara din '{current_room}' de admin {peer_id}"
                    )

            else:
                await send_json(
                    websocket,
                    {
                        "type": "error",
                        "message": f"Tip de mesaj necunoscut: '{msg_type}'",
                    },
                )

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        # Cleanup la deconectare
        if current_room and peer_id in rooms[current_room]:
            del rooms[current_room][peer_id]

            # Transfera admin daca cel care a plecat era admin
            if admins.get(current_room) == peer_id:
                remaining = list(rooms[current_room].keys())
                if remaining:
                    admins[current_room] = remaining[0]
                    log.info(f"Admin nou in '{current_room}': {admins[current_room]}")
                else:
                    del admins[current_room]

            # Anunta peers ramasi
            await broadcast(current_room, {"type": "peer_left", "peer_id": peer_id})

            # Curata camera goala
            if not rooms[current_room]:
                del rooms[current_room]
                log.info(f"Camera '{current_room}' a fost stearsa (goala)")

        log.info(f"Peer {peer_id} deconectat")


async def main():
    host = "0.0.0.0"
    port = 9999
    log.info(f"Server de signaling pornit pe ws://{host}:{port}")
    log.info("Astept conexiuni WebRTC...")

    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # ruleaza pentru totdeauna


if __name__ == "__main__":
    asyncio.run(main())
