#Guardar claves 
#    -ECC privadas, simétricas, etc
#con metadatos 

# services/key_service.py
import uuid
from datetime import datetime
from crypto.aes_gcm import encrypt_with_kdb, decrypt_with_kdb
from config import K_DB
from .storage import vault_keys

async def store_key(
    user_id: str,
    module_type: str,
    purpose: str,
    platform: str | None,
    key_material_raw: bytes,
    key_algo: str,
    sensitivity: str = "HIGH",
    metadata: dict | None = None
) -> str:
    key_id = str(uuid.uuid4())
    aad = f"{user_id}|{module_type}|{purpose}".encode("utf-8")
    enc = encrypt_with_kdb(K_DB, key_material_raw, aad=aad)

    doc = {
        "key_id": key_id,
        "user_id": user_id,
        "module_type": module_type,
        "purpose": purpose,
        "platform": platform,
        "key_material_encrypted": enc,
        "key_algo": key_algo,
        "sensitivity": sensitivity,
        "metadata": metadata or {},
        "created_at": datetime.utcnow(),
        "active": True
    }
    await vault_keys.insert_one(doc)
    return key_id

async def get_key_material(
    user_id: str,
    module_type: str,
    purpose: str,
    platform: str | None
):
    doc = await vault_keys.find_one({
        "user_id": user_id,
        "module_type": module_type,
        "purpose": purpose,
        "platform": platform,
        "active": True
    })
    if not doc:
        return None, None

    aad = f"{doc['user_id']}|{doc['module_type']}|{doc['purpose']}".encode("utf-8")
    key_bytes = decrypt_with_kdb(K_DB, doc["key_material_encrypted"], aad=aad)
    return key_bytes, doc["key_id"]
