# Servicio de contraseñas -> Autollenado
# Obtiene y descifra la contraseña final usando ECC + AES-GCM + clave privada del KM

import json
from typing import Optional
from km_crypto.aes_gcm import decrypt_with_kdb
from km_crypto.ecc_wrapper import ecc_desencriptar_password, cargar_llave_privada_desde_bytes
from config import K_DB_PASS
from .storage import vault_password
from .key_service import get_key_material


async def get_plain_password_for_user(email: str, platform: str) -> Optional[str]:
    """
    Recupera la contraseña en texto plano para autofill usando:
    - Ciphertext ECC guardado en vault_pass
    - Private key ECC guardada en vault_keys
    """

    # 1. Buscar ciphertext en vault_pass
    entry = await vault_password.find_one({
        "email": email,
        "platform": platform,
        "active": True
    })
    if not entry:
        print("❌ No se encontró ciphertext para el usuario/plataforma.")
        return None

    encrypted_blob = entry["ciphertext_encrypted"]   # AES-GCM ciphertext
    user_id = entry["user_id"]

    # 2. Desencriptar JSON ECC usando AES-GCM(K_DB_PASS)
    try:
        aad = f"{user_id}|{platform}|PASSWORD_CIPHERTEXT".encode()
        plaintext_json_bytes = decrypt_with_kdb(K_DB_PASS, encrypted_blob, aad=aad)
        cipher_json = json.loads(plaintext_json_bytes.decode("utf-8"))
    except Exception as e:
        print("❌ Error descifrando JSON ECC:", e)
        return None

    # 3. Reconstruir cipher_struct en bytes
    try:
        cipher_struct = {
            "ephemeral_public": bytes.fromhex(cipher_json["ephemeral_public"]),
            "iv": bytes.fromhex(cipher_json["iv"]),
            "ciphertext": bytes.fromhex(cipher_json["ciphertext"]),
            "tag": bytes.fromhex(cipher_json["tag"])
        }
    except Exception as e:
        print("❌ Error reconstruyendo cipher_struct:", e)
        return None

    # 4. Recuperar private key ECC desde vault_keys
    private_key_bytes, _ = await get_key_material(
        user_id=user_id,
        email=email,
        module_type="PASSWORD_GENERATOR",
        purpose="ECC_PRIVATE_KEY",
        platform=platform
    )
    if not private_key_bytes:
        print("❌ No se recuperó la clave privada ECC.")
        return None

    try:
        private_key = cargar_llave_privada_desde_bytes(private_key_bytes)
    except Exception as e:
        print("❌ Error cargando clave privada DER:", e)
        return None

    # 5. Descifrar ECC → obtener contraseña
    try:
        password_str = ecc_desencriptar_password(private_key, cipher_struct)
        return password_str
    except Exception as e:
        print("❌ Error descifrando ECC:", e)
        return None
