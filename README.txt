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


MONGO ATLAS - ALMACENAR CONTRASEÑAS
clusterGenIA
usuario: psy-password
password: pSyG3nIa25$
python -m pip install "pymongo[srv]"
Python:
mongodb+srv://psy-password:pSyG3nIa25$@cluster-genia.e5kwukz.mongodb.net/?appName=cluster-GenIA

Node.js:
mongodb+srv://psy-password:pSyG3nIa25$@cluster-genia.e5kwukz.mongodb.net/?appName=cluster-GenIA

BIOMETRIC MODULE
https://systemb-backend.onrender.com

MOCK BIOMETRIA
https://0f735a0e-90f0-4843-abb1-36ed72dd38e9.mock.pstmn.io




