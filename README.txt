Para funcionamiento
https://hamilton-cocktail-bumper-tests.trycloudflare.com
cambiar en:
sw1
mobile-register
background
server

EXTENSION

cd C:\cloudflare\
.\cloudflared.exe tunnel --url http://localhost:3000 --protocol auto --no-tls-verify

cd extensión
cd server_backend
node server.js

PSY_ANALIZER

uvicorn server_analysis:app --host 0.0.0.0 --port 8000
 Python3.10 venv
uvicorn server_analysis:app --reload



