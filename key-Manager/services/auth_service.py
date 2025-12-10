# El KM valida tokens de autenticación con el backend
#cuando el usuario aprueba el login del movil por el momento
import httpx
from config import BACKEND_BASE_URL

async def verify_auth_token_with_backend(session_token: str, email: str) -> bool:
    # ejemplo simple: pide al backend que valide
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BACKEND_BASE_URL}/validate-km-token",
            json={"token": session_token, "email": email}
        )
        print("DEBUG Backend auth response:", resp.status_code, resp.text)
    return resp.status_code == 200
