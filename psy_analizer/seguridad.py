import os, hmac, hashlib, json
from argon2.low_level import hash_secret, Type
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from typing import Dict, Any


_AES_KEY_B64 = os.environ.get("PSY_AES_SECRET").encode()
_HMAC_KEY = os.environ.get("PSY_HMAC_SECRET").encode()
#_ARGON_SALT = os.environ.get("PSY_ARGON_SALT").encode()

if not _HMAC_KEY:
    raise RuntimeError("Falta la variable de entorno PSY_HMAC_SECRET")

"""
if not _ARGON_SALT:
    raise RuntimeError("Falta la variable de entorno PSY_ARGON_SALT")
"""

if not _AES_KEY_B64:
    raise RuntimeError("Falta la variable de entorno CLAVE_SECRETA_AES")

try:
    # Decodificar la clave de Base64 a bytes reales
    _AES_KEY = base64.b64decode(_AES_KEY_B64)

    # Validación estricta para AES-256
    if len(_AES_KEY) != 32:
        raise ValueError(f"Longitud de clave inválida: se requieren 32 bytes, se encontraron {len(_AES_KEY)}")

except Exception as e:
    raise RuntimeError(f"Error crítico validando la clave de cifrado: {e}")

# Inicializamos el motor GCM una sola vez (es thread-safe en cryptography)
_aes_engine = AESGCM(_AES_KEY)


def proteger_id_usuario(id_usuario: str) -> str:
    return hmac.new(_HMAC_KEY, id_usuario.encode(), hashlib.sha256).hexdigest()

def proteger_datos_ARGON(data: dict) -> str:
    payload = json.dumps(data, sort_keys=True).encode()
    hashed = hash_secret(
        payload,
        _ARGON_SALT,
        time_cost=3,
        memory_cost=64*1024,
        parallelism=1,
        hash_len=32,
        type=Type.ID
    )
    return hashed.decode()

def proteger_datos_psicologicos(datos: dict) -> str:
    """
    Toma un diccionario, lo serializa a JSON y lo cifra con AES-256-GCM.
    Retorna un string en Base64 listo para guardar en BD o archivo.
    """
    try:
        # Serializar: Dict -> JSON String -> Bytes
        datos_bytes = json.dumps(datos).encode('utf-8')
        
        # Generar Nonce (IV) único de 12 bytes (OBLIGATORIO para GCM)
        nonce = os.urandom(12)
        encrypted = _aes_engine.encrypt(nonce, datos_bytes, None)

        
        ciphertext = encrypted[:-16]
        tag = encrypted[-16:]
        
        
        
        return {
        "nonce": base64.b64encode(nonce).decode(),
        "ciphertext": base64.b64encode(ciphertext).decode(),
        "tag": base64.b64encode(tag).decode()
    }
        
    except Exception as e:
        raise RuntimeError(f"Error al cifrar el diccionario: {e}")


def descifrar_dict(bundle: str) -> dict:
    """
    Toma el token Base64, extrae el nonce, descifra y reconstruye el diccionario.
    """
    try:
        nonce = base64.b64decode(bundle["nonce"])
        ciphertext = base64.b64decode(bundle["ciphertext"])
        tag = base64.b64decode(bundle["tag"])

        combined = ciphertext + tag  # AES-GCM espera ct+tag en decrypt()

        plaintext_bytes = _aes_engine.decrypt(nonce, combined, associated_data=None)
        return json.loads(plaintext_bytes.decode("utf-8"))
        
    except Exception as e:
        # Si la clave es incorrecta o los datos fueron manipulados, fallará aquí.
        raise RuntimeError("Fallo de autenticación o datos corruptos. No se puede descifrar.")