# mongo_tracking.py
from pymongo import MongoClient
from datetime import datetime
import os

client = MongoClient(os.environ["PSY_MONGO_URI"])
db = client[os.environ["PSY_ANALYZER_DB_NAME"]]
requests_col = db["generation_requests"]

def new_request(doc):
    doc["created_at"] = datetime.utcnow()
    doc["updated_at"] = datetime.utcnow()
    requests_col.insert_one(doc)

def update_request(request_id, update):
    update["updated_at"] = datetime.utcnow()
    requests_col.update_one({"request_id": request_id}, {"$set": update})

def add_log(request_id, msg):
    requests_col.update_one(
        {"request_id": request_id},
        {"$push": {"logs": {"at": datetime.utcnow(), "message": msg}}}
    )

def get_request(request_id):
    return requests_col.find_one({"request_id": request_id})

def get_user_history(user_id_hmac):
    return list(requests_col.find({"user_id_hmac": user_id_hmac}).sort("created_at", -1))
