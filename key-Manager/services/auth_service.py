# El KM valida tokens de autenticación con el backend
#cuando el usuario aprueba el login del movil por el momento
import httpx
import hmac
import hashlib
import time
import json
from config import BACKEND_BASE_URL
from config import NODE_KM_SECRET

async def verify_auth_token_with_backend(session_token: str, email: str) -> bool:
    # Verificacion comunicacion segura con Node para autofill de constraseña
    #Con HMAC SHA 256
    ts = str(int(time.time() * 1000))
    body = {"session_token": session_token, "email": email}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))

    sig = hmac.new(
        NODE_KM_SECRET.encode(),
        f"{ts}.{canonical}".encode(),
        hashlib.sha256
    ).hexdigest()

    headers = {
        "X-Timestamp": ts,
        "X-Signature": sig
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BACKEND_BASE_URL}/validate-km-token",
            json=body,
            headers=headers
        )
    return resp.status_code == 200

