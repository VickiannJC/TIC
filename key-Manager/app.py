# app.py
from fastapi import FastAPI, HTTPException
from models.schemas import StoreEncryptedItemRequest, GetKeyMaterialRequest, GenerationServerRequest
from services.key_service import store_key
from services.password_storage import store_password_ciphertext
from services.storage import vault_items
from services.password_service import get_plain_password_for_user
from services.auth_service import verify_auth_token_with_backend
from crypto import password_generation
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import uuid, os

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
        doc = {
            "vault_id": vault_id,
            "key_id": key_id,
            "user_id": req.user_id,
            "module_type": req.module_type,
            "purpose": "PASSWORD_CIPHERTEXT" if req.module_type == "PASSWORD_GENERATOR" else req.purpose,
            "platform": req.platform,
            "ciphertext": req.ciphertext_b64,
            "ciphertext_type": req.ciphertext_type,
            "metadata": req.metadata or {},
            "created_at": datetime.utcnow(),
            "active": True
        }
        await vault_items.insert_one(doc)

    return {"status": "ok", "key_id": key_id, "vault_id": vault_id}

"""
GENERACION DE CONTRASEÑA

"""

# ---------------------------
# GENERACION
# ---------------------------
class KeyManagerPayload(BaseModel):
    user_id: str
    auth_token: Optional[str] 
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
async def process_generation(req: GenerationServerRequest):
    try:
        # 1. Calcular exponente a partir de psy_values y numeric_code
        exponente = password_generation.calcular_exponente(req.psy_values, req.numeric_code)

        # 2. Construir llave privada ECC y llave pública
        llave_privada = password_generation.construir_clave_privada(exponente)
        llave_publica = llave_privada.public_key()

        # 3. Cifrar la contraseña generada con ECC
        password_bytes = req.password.encode("utf-8")
        cipher_struct = password_generation.ecc_encriptar_password(llave_publica, password_bytes)
        # cipher_struct debería ser un dict con ephemeral_public, iv, ciphertext, tag

        # 4. Serializar la private key a bytes para guardarla en el KM
        #    (ajusta esto según cómo se defina tu tipo de clave)
        from cryptography.hazmat.primitives import serialization

        private_key_bytes = llave_privada.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )

        # 5. Guardar la clave en la DB de KEYS (KM)
        key_id = await store_key(
            user_id=req.user_id,
            module_type="PASSWORD_GENERATOR",
            purpose="ECC_PRIVATE_KEY",
            platform=req.platform,
            key_material_raw=private_key_bytes,
            key_algo="ECC",
            sensitivity="HIGH",
            metadata=req.metadata
        )

        # 6. Guardar el ciphertext ECC en la DB de PASSWORDS
        await store_password_ciphertext(
            pass_id=key_id,
            user_id=req.user_id,
            platform=req.platform,
            cipher_struct=cipher_struct,
            key_algo="ECC",
            metadata=req.metadata
        )

        return {
            "status": "ok",
            "key_id": key_id
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en process_generation: {e}")