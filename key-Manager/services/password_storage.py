import uuid
from datetime import datetime
import json
from crypto.aes_gcm import encrypt_with_kdb
from config import K_DB_PASS
from .storage import vault_password

async def store_password_ciphertext(
    pass_id: str,
    user_id: str,
    user_email: str,
    platform: str,
    cipher_struct: dict,
    key_algo: str,
    metadata: dict | None = None
):
    cipher_json = json.dumps({
        "ephemeral_public": cipher_struct["ephemeral_public"].hex(),
        "iv": cipher_struct["iv"].hex(),
        "ciphertext": cipher_struct["ciphertext"].hex(),
        "tag": cipher_struct["tag"].hex()
    })

    """
    Guarda el ciphertext ECC de la contraseña en la DB de passwords,
    protegido en reposo con AES-GCM(K_DB_PASS).
    """
    aad = f"{user_id}|{platform}|PASSWORD_CIPHERTEXT".encode("utf-8")

    encrypted = encrypt_with_kdb(
        K_DB_PASS,
        cipher_json.encode(),
        aad=aad
    )

    doc = {
        "pass_id": pass_id,
        "user_id": user_id,
        "user_email": user_email,
        "platform": platform,
        "ciphertext_encrypted": encrypted,
        "key_algo": key_algo,
        "metadata": metadata or {},
        "created_at": datetime.utcnow(),
        "active": True
    }
    await vault_password.insert_one(doc)
    return pass_id
