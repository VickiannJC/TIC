#Servicio de contraseñas ->Autollenado
#Obtiene la contraseña en texto plano para autollenado en la plataforma
from .storage import vault_items
from .key_service import get_key_material
from crypto.ecc_wrapper import ecc_decrypt_password

async def get_plain_password_for_user(email: str, platform: str) -> str | None:
    user_id = email  # por ahora, email = user_id lógico

    item = await vault_items.find_one({
        "user_id": user_id,
        "module_type": "PASSWORD_GENERATOR",
        "purpose": "PASSWORD_CIPHERTEXT",
        "platform": platform,
        "active": True
    })
    if not item:
        return None

    ciphertext_b64 = item["ciphertext"]

    key_bytes, _ = await get_key_material(
        user_id=user_id,
        module_type="PASSWORD_GENERATOR",
        purpose="ECC_PRIVATE_KEY",
        platform=platform
    )
    if not key_bytes:
        return None

    password = ecc_decrypt_password(private_key_bytes=key_bytes, ciphertext_b64=ciphertext_b64)
    return password
