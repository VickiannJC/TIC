from pymongo import MongoClient
from datetime import datetime
import os

_MONGO_URI = os.environ.get("PSY_MONGO_URI")
_DB = os.environ.get("PSY_ANALYZER_DB_NAME")
_COL = os.environ.get("PSY_ANALYZER_COL_NAME")

client = MongoClient(_MONGO_URI)
col = client[_DB][_COL]

def guardar_analisis_mongo(doc):
    doc["created_at"] = datetime.utcnow()
    res = col.insert_one(doc)
    return str(res.inserted_id)



def buscar_usuario_por_hmac(id_hmac):
    """
    Busca si existe un documento con este ID Hmac.
    Retorna el documento completo si existe, o None si no.
    """
    try:
        usuario = col.find_one({"user_id_hmac": id_hmac})
        return usuario
    except Exception as e:
        print(f"Error buscando usuario: {e}")
        return None

def agregar_email_a_metadata(id_hmac, nuevo_email):
    """
    Agrega el nuevo email a la lista de emails en metadata.
    Usamos $addToSet para evitar duplicados automáticos en el array.
    """
    try:
        # Esto transformará metadata.email (si era string) o agregará a metadata.emails
        # Nota: Para ser robustos, te sugiero guardar los emails en una lista 'emails' dentro de metadata
        result = col.update_one(
            {"user_id_hmac": id_hmac},
            {
                "$addToSet": { "metadata.emails": nuevo_email } 
            }
        )
        return result.modified_count > 0
    except Exception as e:
        print(f"Error actualizando email: {e}")
        return False
