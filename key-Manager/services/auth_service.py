# El KM valida tokens de autenticación con el backend
#cuando el usuario aprueba el login del movil por el momento
import httpx
from config import BACKEND_BASE_URL

async def verify_auth_token_with_backend(auth_token: str, user_email: str) -> bool:
    # ejemplo simple: pide al backend que valide
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BACKEND_BASE_URL}/validate-km-token",
            json={"token": auth_token, "email": user_email}
        )
    return resp.status_code == 200
