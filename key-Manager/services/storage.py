from motor.motor_asyncio import AsyncIOMotorClient
from config import MONGO_URI_KEYS, MONGO_URI_PASS, MONGO_DB_KEY, MONGO_DB_PASS

# STORAGE KEY VAULT
client_key = AsyncIOMotorClient(MONGO_URI_KEYS)
db_key = client_key[MONGO_DB_KEY]

vault_keys = db_key["vault_keys"]
vault_key_items = db_key["vault_items"]
# STORAGE PLUGIN KEYS
plugin_keys = db_key["plugin_keys"]

#STORAGE PASSWORD VAULT

client_pass = AsyncIOMotorClient(MONGO_URI_PASS)
db_pass = client_pass[MONGO_DB_PASS]

vault_password = db_pass["vault_password"]
vault_password_items = db_pass["vault_items"]

