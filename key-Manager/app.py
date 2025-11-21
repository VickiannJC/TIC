# app.py
from fastapi import FastAPI, HTTPException
from models.schemas import StoreEncryptedItemRequest, GetKeyMaterialRequest
from services.key_service import store_key
from services.storage import vault_items
from services.password_service import get_plain_password_for_user
from services.auth_service import verify_auth_token_with_backend
from datetime import datetime
import uuid

app = FastAPI()

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

@app.post("/get_key_material")
async def get_key_material(req: GetKeyMaterialRequest):
    # 1. validar token
    is_valid = await verify_auth_token_with_backend(req.auth_token, req.user_email)
    if not is_valid:
        raise HTTPException(status_code=401, detail="Invalid auth token")

    # 2. obtener password en claro
    password = await get_plain_password_for_user(req.user_email, req.platform_name)
    if not password:
        raise HTTPException(status_code=404, detail="Password not found")

    return {"password": password}
