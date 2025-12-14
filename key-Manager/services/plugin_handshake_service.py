# services/plugin_handshake_service.py
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

from services.key_service import get_key_material, store_key
from services.storage import vault_keys, plugin_keys  # plugin_keys → agregar en storage.py
from km_crypto.plugin_channel_crypto import derive_shared_channel_key


SERVER_USER = "KM_SERVER"
SERVER_EMAIL = "km@internal"
MODULE = "PLUGIN_HANDSHAKE"
PURPOSE = "SERVER_PRIVATE_KEY"


async def get_or_create_server_private_key():
    """
    Recupera o crea la clave privada ECC del servidor para handshake.
    """
    priv_bytes, _ = await get_key_material(
        user_id=SERVER_USER,
        email=SERVER_EMAIL,
        module_type=MODULE,
        purpose=PURPOSE,
        platform=None
    )

    if priv_bytes:
        return serialization.load_der_private_key(priv_bytes, password=None)

    # Si no existe, generar
    priv = ec.generate_private_key(ec.SECP256R1())
    priv_bytes = priv.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    await store_key(
        user_id=SERVER_USER,
        email=SERVER_EMAIL,
        module_type=MODULE,
        purpose=PURPOSE,
        platform=None,
        key_material_raw=priv_bytes,
        key_algo="ECC"
    )

    return priv


async def store_plugin_public_key(user_id: str, plugin_id: str, public_key_b64: str):
    """
    Guarda clave pública del plug-in asociada al usuario.
    """
    raw = base64.b64decode(public_key_b64.encode("utf-8"))

    await plugin_keys.update_one(
        {"user_id": user_id, "plugin_id": plugin_id},
        {"$set": {"public_key": raw}},
        upsert=True
    )


async def load_plugin_public_key(user_id: str, plugin_id: str):
    doc = await plugin_keys.find_one({"user_id": user_id, "plugin_id": plugin_id})
    if not doc:
        return None
    return doc["public_key"]
