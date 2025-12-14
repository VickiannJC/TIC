# app.py
from fastapi import FastAPI, HTTPException, Header
from models.schemas import StoreEncryptedItemRequest, GetKeyMaterialRequest, GenerationServerRequest
from services.key_service import store_key, get_key_material
from services.password_storage import store_password_ciphertext
from services.storage import vault_password
from services.password_service import get_plain_password_for_user
from services.auth_service import verify_auth_token_with_backend
from cryptography.hazmat.primitives import serialization
from km_crypto.aes_gcm import encrypt_with_kdb
from services import password_generation
from services.plugin_handshake_service import (get_or_create_server_private_key, store_plugin_public_key, load_plugin_public_key)
from km_crypto.plugin_channel_crypto import envelope_decrypt, envelope_encrypt, derive_shared_channel_key
from datetime import datetime
from pydantic import BaseModel
from typing import Optional
import uuid, os, json, base64
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
        email=req.email,
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
            "email": req.email,
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
    email: str
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
        print("❌ ERROR: Invalid API key")
        raise HTTPException(status_code=401, detail="Invalid API key")
    
    print("\n======================")
    print("📥 DEBUG: Payload recibido en KeyManager")
    print(req)
    print("======================\n")

    # Validar propósito
    if req.purpose != "PASSWORD":
        raise HTTPException(
            status_code=400,
            detail=f"Invalid purpose: {req.purpose}. Expected 'PASSWORD'."
        )


    try:
        metadata = {
            "request_id": req.request_id,
            "session_token": req.session_token
        }

        # 1) Calcular exponente
        print("➡️ Calculando exponente...")
        exponente = password_generation.calcular_exponente(req.psy_values, req.numeric_code)
        print("✔ Exponente generado:", exponente)

        # 2) ECC private key + public key
        print("➡️ Construyendo clave privada ECC...")
        llave_privada = password_generation.construir_clave_privada(exponente)
        if llave_privada is None:
            raise ValueError("No se pudo construir la clave privada ECC")
        print("✔ Clave privada ECC OK:", type(llave_privada))

        llave_publica = llave_privada.public_key()
        print("✔ Clave pública ECC OK:", type(llave_publica))

        # 3) Cifrar la contraseña
        print("➡️ Cifrando contraseña mediante ECC...")
        pw_bytes = req.password.encode()
        cipher_struct = password_generation.ecc_encriptar_password(llave_publica, pw_bytes)
        print("✔ Cipher_struct generado:")
        print(cipher_struct)

        # 4) Serializar private key
        print("➡️ Serializando clave privada a DER...")
        priv_bytes = llave_privada.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )
        print("✔ private_key_bytes length:", len(priv_bytes))


        # 5) Guardar private key en vault_keys
        print("➡️ Guardando clave privada en vault_keys...")
        key_id = await store_key(
            user_id=req.user_id,
            email=req.email,
            module_type="PASSWORD_GENERATOR",
            purpose="ECC_PRIVATE_KEY",
            platform=req.platform,
            key_material_raw=priv_bytes,
            key_algo="ECC",
            metadata=metadata
        )
        print("✔ Key guardada con key_id:", key_id)

        # 6) Guardar ciphertext en vault_passwords
        print("➡️ Guardando ciphertext en vault_password...")
        await store_password_ciphertext(
            pass_id=key_id,
            user_id=req.user_id,
            email=req.email,
            platform=req.platform,
            cipher_struct=cipher_struct,
            key_algo="ECC",
            metadata=metadata
        )
        print("✔ Ciphertext guardado correctamente")

        return {"status": "ok", "key_id": key_id}

    except Exception as e:
        print("🔥 EXCEPCIÓN DETECTADA EN KM:", str(e))
        raise HTTPException(status_code=500, detail=str(e))
    
@app.get("/init_handshake")
async def init_handshake():
    priv = await get_or_create_server_private_key()
    pub = priv.public_key()

    pub_bytes = pub.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )

    return {
        "server_public_key_b64": base64.b64encode(pub_bytes).decode("utf-8")
    }

class PluginKeyAuthRequest(BaseModel):
    user_id: str
    plugin_id: str
    public_key_b64: str


@app.post("/auth_plugin_key")
async def auth_plugin_key(req: PluginKeyAuthRequest):
    await store_plugin_public_key(
        user_id=req.user_id,
        plugin_id=req.plugin_id,
        public_key_b64=req.public_key_b64
    )
    return {"status": "ok", "message": "Plugin key registered"}

class SendKeysEnvelope(BaseModel):
    user_id: str
    plugin_id: str
    encrypted_payload: str  # AES-GCM(key_channel)
    metadata: dict | None = None


@app.post("/send_keys_enveloped")
async def send_keys_enveloped(req: SendKeysEnvelope):
    server_priv = await get_or_create_server_private_key()
    plugin_pub = await load_plugin_public_key(req.user_id, req.plugin_id)

    if plugin_pub is None:
        raise HTTPException(status_code=400, detail="Plugin key not registered")

    channel_key = derive_shared_channel_key(server_priv, plugin_pub)

    # Descifrar
    plaintext_json = envelope_decrypt(channel_key, req.encrypted_payload)

    # guardamos el contenido usando store_key()
    data = json.loads(plaintext_json.decode("utf-8"))

    key_bytes = base64.b64decode(data["key_b64"])
    key_id = await store_key(
        user_id=req.user_id,
        email=data.get("email", "unknown"),
        module_type=data["module_type"],
        purpose=data["purpose"],
        platform=data.get("platform"),
        key_material_raw=key_bytes,
        key_algo=data["key_algo"],
        metadata=req.metadata
    )

    return {"status": "ok", "stored_key_id": key_id}

class GetKeysEnvelope(BaseModel):
    user_id: str
    email: str
    plugin_id: str
    module_type: str
    purpose: str
    platform: str | None
    


@app.post("/get_keys_enveloped")
async def get_keys_enveloped(req: GetKeysEnvelope):
    server_priv = await get_or_create_server_private_key()
    plugin_pub = await load_plugin_public_key(req.user_id, req.plugin_id)

    if plugin_pub is None:
        raise HTTPException(status_code=400, detail="Plugin key not registered")

    channel_key = derive_shared_channel_key(server_priv, plugin_pub)

    key_bytes, key_id = await get_key_material(
        user_id=req.user_id,
        email=req.email,  
        module_type=req.module_type,
        purpose=req.purpose,
        platform=req.platform
    )

    if key_bytes is None:
        raise HTTPException(status_code=404, detail="Key not found")

    payload = {
        "key_id": key_id,
        "key_b64": base64.b64encode(key_bytes).decode("utf-8")
    }

    encrypted = envelope_encrypt(channel_key, json.dumps(payload).encode("utf-8"))

    return {"encrypted_payload": encrypted}


# GET PASSWORD (ECC) PROTEGIDA CON ENVELOPE


class GetPasswordEnvelope(BaseModel):
    user_id: str
    plugin_id: str
    platform: Optional[str] = None


@app.post("/get_password_enveloped")
async def get_password_enveloped(req: GetPasswordEnvelope):
    """
    Recupera la contraseña final del usuario:
    - Busca ciphertext ECC en vault_password
    - Recupera la ECC private key desde vault_keys
    - Descifra la contraseña en KM
    - La cifra con envelope (AES-GCM(channel_key)) y la devuelve al plugin
    """

    # Recuperar server ECC private (para handshake / channel)
    server_priv = await get_or_create_server_private_key()

    #  Recuperar publicKey del plugin (registrada durante handshake)
    plugin_pub = await load_plugin_public_key(req.user_id, req.plugin_id)
    if plugin_pub is None:
        raise HTTPException(status_code=400, detail="Plugin key not registered")

    # Derivar canal seguro KM ↔ Plugin (ECDH + HKDF)
    channel_key = derive_shared_channel_key(server_priv, plugin_pub)

    # Buscar ciphertext ECC real de la contraseña

    password_entry = await vault_password.find_one({
        "user_id": req.user_id,
        "platform": req.platform,
        "active": True
    })

    if password_entry is None:
        raise HTTPException(status_code=404, detail="Password ciphertext not found")

    cipher_struct = password_entry["cipher_struct"]


    # Buscar ECC PRIVATE KEY del usuario (guardada en vault_keys)
   
    priv_bytes, _ = await get_key_material(
        user_id=req.user_id,
        email=password_entry["email"],
        module_type="PASSWORD_GENERATOR",
        purpose="ECC_PRIVATE_KEY",
        platform=req.platform
    )

    if priv_bytes is None:
        raise HTTPException(status_code=500, detail="ECC private key not found")

    # Importar clave privada ECC desde DER
    try:
        private_key = serialization.load_der_private_key(priv_bytes, password=None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load ECC private key: {str(e)}")

    #  DESCIFRAR CONTRASEÑA ECC (KM LO HACE LOCALMENTE)
   
    try:
        from km_crypto.ecc_wrapper import ecc_desencriptar_password
        plain_bytes = ecc_desencriptar_password(private_key, cipher_struct)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ECC decrypt error: {str(e)}")

 
    #Envelope encryption (AES-GCM(channel_key))
  
    encrypted_payload = envelope_encrypt(channel_key, plain_bytes)

    # Enviar contraseña protegida por envelope
  
    return {
        "status": "ok",
        "encrypted_password": encrypted_payload
    }
