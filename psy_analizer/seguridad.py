import os, hmac, hashlib, json
from argon2.low_level import hash_secret, Type



_HMAC_KEY = os.environ.get("PSY_HMAC_SECRET").encode()
_ARGON_SALT = os.environ.get("PSY_ARGON_SALT").encode()

if not _HMAC_KEY:
    raise RuntimeError("Falta la variable de entorno PSY_HMAC_SECRET")

if not _ARGON_SALT:
    raise RuntimeError("Falta la variable de entorno PSY_ARGON_SALT")


def proteger_id_usuario(id_usuario: str) -> str:
    return hmac.new(_HMAC_KEY, id_usuario.encode(), hashlib.sha256).hexdigest()

def proteger_datos_psicologicos(data: dict) -> str:
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