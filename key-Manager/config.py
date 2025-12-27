# Conexión con MongoDB 
# Configuración -> derivar clave maestra -> con Argon2id para cifrado en reposo
import os
from dotenv import load_dotenv
from km_crypto.kdf import derive_kdb

load_dotenv()

# ====== DB de KEYS (KM) ======
MONGO_URI_KEYS = os.getenv("MONGO_URI_KEYS")
MONGO_DB_KEY = os.getenv("MONGO_DB_KEY")

# ====== DB de PASSWORD CIPHERTEXTS ======
MONGO_URI_PASS = os.getenv("MONGO_URI_PASS")
MONGO_DB_PASS = os.getenv("MONGO_DB_PASS")

# ====== KDF para almacenar KEYS (K_DB_KEYS) ======
MASTER_SECRET_KEYS = os.getenv("KM_MASTER_SECRET_KEYS").encode("utf-8")
KDB_SALT_KEYS = os.getenv("KM_KDB_SALT_KEYS").encode("utf-8")
K_DB_KEYS = derive_kdb(MASTER_SECRET_KEYS, KDB_SALT_KEYS)

# ====== KDF para almacenar PASSWORDS (K_DB_PASS) ======
MASTER_SECRET_PASS = os.getenv("KM_MASTER_SECRET_PASS").encode("utf-8")
KDB_SALT_PASS = os.getenv("KM_KDB_SALT_PASS").encode("utf-8")
K_DB_PASS = derive_kdb(MASTER_SECRET_PASS, KDB_SALT_PASS)


BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL")

# ===== Configuración de seguridad para plugin ======
KEY_MANAGER_ALLOWED_CLIENTS = os.getenv("KM_ALLOWED_CLIENTS", "").split(",")
KM_PLUGIN_REG_SECRET = os.environ.get("KM_PLUGIN_REG_SECRET")
if not KM_PLUGIN_REG_SECRET:
    raise RuntimeError("KM_PLUGIN_REG_SECRET no definido en variables de entorno.")

NODE_KM_SECRET = os.environ.get("NODE_KM_SECRET")
if not NODE_KM_SECRET:
    raise RuntimeError("NODE_KM_SECRET  no definido en variables de entorno.")
