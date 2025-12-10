# app.py
from fastapi import FastAPI, HTTPException, Header
from models.schemas import StoreEncryptedItemRequest, GetKeyMaterialRequest, GenerationServerRequest
from services.key_service import store_key
from services.password_storage import store_password_ciphertext
from services.storage import vault_password
from services.password_service import get_plain_password_for_user
from services.auth_service import verify_auth_token_with_backend
from cryptography.hazmat.primitives import serialization
from crypto.aes_gcm import encrypt_with_kdb
from crypto import password_generation
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import uuid, os
from config import K_DB_PASS

from dotenv import load_dotenv
load_dotenv()


app = FastAPI(title="Key Manager Secure API")

API_KEY = os.environ["KEY_MANAGER_API_KEY"]

@app.post("/store_encrypted_item")
async def store_encrypted_item(req: StoreEncryptedItemRequest):
    import base64

    key_material_raw = base64.b64decode(req.key_material_raw_b64.encode("utf-8"))

    key_id = await store_key(
        user_id=req.user_id,
        module_type=req.module_type,
        purpose=req.purpose,
        platform=req.platform,
        key_material_raw=key_material_raw,
        key_algo=req.key_algo,
        metadata=req.metadata
    )

    vault_id = None
    if req.ciphertext_b64:
        vault_id = str(uuid.uuid4())

        # DESCODIFICAR ciphertext base64 recibido
        raw_ciphertext = base64.b64decode(req.ciphertext_b64.encode("utf-8"))

        # AAD coherente con el resto del KM
        aad = f"{req.user_id}|{req.module_type}|{req.purpose}".encode("utf-8")

        # Cifrar con AES-GCM(K_DB_PASS)
        encrypted_ct = encrypt_with_kdb(K_DB_PASS, raw_ciphertext, aad=aad)

        doc = {
            "vault_id": vault_id,
            "key_id": key_id,
            "user_id": req.user_id,
            "module_type": req.module_type,
            "purpose": req.purpose,
            "platform": req.platform,
            "ciphertext_encrypted": encrypted_ct,   # <-- unificado
            "ciphertext_type": req.ciphertext_type,
            "metadata": req.metadata or {},
            "created_at": datetime.utcnow(),
            "active": True
        }
        await vault_password.insert_one(doc)

    return {"status": "ok", "key_id": key_id, "vault_id": vault_id}


"""
GENERACION DE CONTRASEÑA

"""

# ---------------------------
# GENERACION
# ---------------------------
class KeyManagerPayload(BaseModel):
    user_id: str
    session_token: Optional[str] 
    user_email: str
    platform_name: str
    purpose: str                           # "PASSWORD"
    password: str                          # contraseña generada
    numeric_code: int                      # valor numérico 
    psy_values: list                       # lista de valores 
    request_id: str


# ---------------------------
#  RECIBIR CONTRASEÑA
# ---------------------------
@app.post("/process_generation")
async def process_generation(
    req: GenerationServerRequest,
    authorization: str = Header(None)
):
    # Validar API KEY
    if not authorization or authorization.replace("Bearer ", "") != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")

    # Validar propósito
    if req.purpose != "PASSWORD":
        raise HTTPException(
            status_code=400,
            detail=f"Invalid purpose: {req.purpose}. Expected 'PASSWORD'."
        )


    try:
        metadata = {
            "request_id": req.request_id,
            "auth_token": req.auth_token,
            "user_email": req.user_email
        }

        # 1) Calcular exponente
        exponente = password_generation.calcular_exponente(req.psy_values, req.numeric_code)

        # 2) ECC private key + public key
        llave_privada = password_generation.construir_clave_privada(exponente)
        if llave_privada is None:
            raise ValueError("No se pudo construir la clave privada ECC")
        llave_publica = llave_privada.public_key()

        # 3) Cifrar la contraseña
        pw_bytes = req.password.encode()
        cipher_struct = password_generation.ecc_encriptar_password(llave_publica, pw_bytes)

        # 4) Serializar private key

        priv_bytes = llave_privada.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )

        # 5) Guardar private key en vault_keys
        key_id = await store_key(
            user_id=req.user_id,
            module_type="PASSWORD_GENERATOR",
            purpose="ECC_PRIVATE_KEY",
            platform=req.platform_name,
            key_material_raw=priv_bytes,
            key_algo="ECC",
            metadata=metadata
        )

        # 6) Guardar ciphertext en vault_passwords
        await store_password_ciphertext(
            pass_id=key_id,
            user_id=req.user_id,
            user_email=req.user_email,
            platform=req.platform_name,
            cipher_struct=cipher_struct,
            key_algo="ECC",
            metadata=metadata
        )

        return {"status": "ok", "key_id": key_id}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))