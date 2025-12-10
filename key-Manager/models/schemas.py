# Modelo estándar para las solicitudes de almacenamiento 
#  recuperación de claves cifradas
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

class StoreEncryptedItemRequest(BaseModel):
    user_id: str
    module_type: str     # "PASSWORD_GENERATOR", "ANALYZER", etc.
    purpose: str         # "ECC_PRIVATE_KEY", "PROFILE_DATA_KEY", etc.
    platform: Optional[str] = None
    key_algo: str
    key_material_raw_b64: str
    ciphertext_b64: Optional[str] = None
    ciphertext_type: Optional[str] = None
    metadata: Optional[Dict] = None

class GetKeyMaterialRequest(BaseModel):
    auth_token: str
    user_email: str
    platform_name: str

class GenerationServerRequest(BaseModel):
    user_id: str
    session_token: str
    email: str
    platform: str
    purpose: str
    password: str
    numeric_code: int
    psy_values: list
    request_id: str