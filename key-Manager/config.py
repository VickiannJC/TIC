# Conexión con MongoDB 
# Configuración -> derivar clave maestra -> con Argon2id para cifrado en reposo
import os
from dotenv import load_dotenv
from crypto.kdf import derive_kdb

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "psy_key_manager")

MASTER_SECRET = os.getenv("KM_MASTER_SECRET", "dev-secret-change-me").encode("utf-8")
KDB_SALT = os.getenv("KM_KDB_SALT", "dev-salt-change-me").encode("utf-8")

K_DB = derive_kdb(MASTER_SECRET, KDB_SALT)

KEY_MANAGER_ALLOWED_CLIENTS = os.getenv("KM_ALLOWED_CLIENTS", "").split(",")

BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "Extension\chrome_extension\background.js")
