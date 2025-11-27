from pymongo import MongoClient
from datetime import datetime
import os

_MONGO_URI = os.environ.get("PSY_MONGO_URI")
_DB = os.environ.get("PSY_ANALYZER_DB_NAME")
_COL = os.environ.get("PSY_ANALYZER_COL_NAME")

print("DB:", repr(_DB))
print("URI:", repr(_MONGO_URI))

client = MongoClient(_MONGO_URI)
col = client[_DB][_COL]

def guardar_analisis_mongo(doc):
    doc["created_at"] = datetime.utcnow()
    res = col.insert_one(doc)
    return str(res.inserted_id)
