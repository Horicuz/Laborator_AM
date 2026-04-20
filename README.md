# VoIP Lab - WebRTC

This workspace contains a very small two-tab WebRTC lab.

## What It Does

- `Server.ipynb` runs a minimal local WebSocket pairer on `127.0.0.1:10001`.
- `Client1.ipynb` starts a static web server on `127.0.0.1:8000`.
- `Client2.ipynb` starts a static web server on `127.0.0.1:8001`.
- `web/index.html` and `web/main.js` provide the browser client.
- The first tab becomes Client 1 and the second tab becomes Client 2.
- Remote audio and video are delayed by 3 seconds.

## Start Order

1. Run the install cell and then the server cell in `Server.ipynb`.
2. Run the client cell in `Client1.ipynb`.
3. Run the client cell in `Client2.ipynb`.
4. Open `http://127.0.0.1:8000` and `http://127.0.0.1:8001` in two browser tabs.
5. Click `Join room` in both tabs.

## Notes

- No password is required.
- The signaling server uses `ws://127.0.0.1:10001/ws`.
- Use `await stop_server()` in `Server.ipynb` to stop the pairer.
- Use `stop_web_server()` in the client notebooks to stop the local web servers.
- If camera or microphone access fails, grant the browser permission and try again.