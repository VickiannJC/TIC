# El backend d(Node.js) de Extensión 
# llama a este endpoint: /api/biometric-registration
# Recibimos los datos de Extensión que recibio de Biometria
print("🚀 server_analysis import started")

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from datetime import datetime
import uuid, json, hmac, hashlib, os, requests
from seguridad import proteger_id_usuario, descifrar_dict
from mongo_tracking import new_request, update_request, add_log, get_user_history, get_request
import os, json
from typing import Any
from guardar_analisis import col as psy_col
from guardar_analisis import buscar_usuario_por_hmac
import requests

GEN_SECRET = os.environ.get("GEN_HMAC_SECRET")
GENERATION_SERVER_URL = os.environ.get("GEN_SERVER_URL")
if not GEN_SECRET or not GENERATION_SERVER_URL:
    raise RuntimeError("Variables de entorno críticas no definidas")
session = requests.Session()

app = FastAPI()
_analyzer = None

DEBUG_LOGS = os.environ.get("ANALYSIS_DEBUG", "false").lower() == "true"

# Para inicializar el analizador una sola vez
def get_analyzer():
    global _analyzer
    if _analyzer is None:
        from psy_analizer import PsychologicalAnalyzer
        _analyzer = PsychologicalAnalyzer()
    return _analyzer

#Para enviar JSON canónico (para HMAC)
def canonical_json(obj: Any) -> bytes:
    return json.dumps(
        obj,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

# Obtener IP real del cliente (detrás de proxy)
def get_real_client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # Tomar el primer IP (cliente real)
        return xff.split(",")[0].strip()

    x_real = request.headers.get("x-real-ip")
    if x_real:
        return x_real.strip()

    # Fallback (proxy)
    return request.client.host if request.client else "unknown"

# Healthcheck básico
@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}
@app.middleware("http")
async def log_requests(request: Request, call_next):
    print(f" {request.method} {request.url.path}")
    return await call_next(request)

@app.get("/api/biometric-registration")
def biometric_probe():
    return {"status": "ignored"}


"""
Registro
"""

class BioRegistrationPayload(BaseModel):
    email: str
    idUsuario: str
    user_answers: list[int]
    session_token: str
# Endpoint para recibir datos desde Node después de BIOMETRÍA
@app.post("/api/biometric-registration")
async def biometric_registration(data: BioRegistrationPayload):
    print("🔥 POST biometric-registration ejecutado")
    """
    Recibe datos del server Node (backend central) después de que BIOMETRÍA
    completa el registro y provee la cadena de valores psicológicos.
    """
    try:
        print("🔵 —— DATA RECIBIDA DESDE NODE ——")
        print(data.dict())

        analyzer = get_analyzer()
        resultado = analyzer.analyze(
            id_usuario=data.idUsuario,
            user_answers=data.user_answers,
            session_token=data.session_token,
            metadata={"email": data.email}
        )

        print("🔵 —— RESULTADO ANALYZER ——")
        print(resultado)

        # Si devolvió error
        if "error" in resultado:
            
            raise HTTPException(status_code=400, detail=resultado["error"])
        
        # Si se saltó porque ya existía (Para que Node no crea que es un error 500)
        if resultado.get("status") == "skipped":
            # Devolvemos un 200 OK pero con mensaje de que ya existía
            return {"status": "exists", "message": resultado["message"]}

        # Si se actualizó el mail
        if resultado.get("status") == "updated":
            return {"status": "updated", "message": resultado["message"]}

        # Si se creó nuevo
        return {"status": "created", "stored": True}
    except HTTPException as e:
        # Errores previstos (validaciones, analyzer, etc.)
        print(f"❌ Error controlado en analyzer: {e.detail}")
        raise e

    except Exception as e:
        # Errores inesperados → retornar JSON de error claro
        print(f"🔥 ERROR NO CONTROLADO EN ANALYZER: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Error interno en el analizador: {str(e)}"
        )

"""
GENERACION DE CONTRASEÑAS

"""

# Datos que envía el backend Node.js de la Extensión para iniciar la generación de contraseña
class GeneratorInit(BaseModel):
    user_id: str
    session_token: str
    email: str
    authenticated: bool
    platform: str

@app.post("/generator-init")
async def generator_init(request: Request, data: GeneratorInit):

    # Datos de seguridad
    ip = get_real_client_ip(request) if request.client else "unknown"
    user_agent = request.headers.get("user-agent", "unknown")
    # Convertir el user_id real → HMAC para empatar en Mongo
    user_id_hmac = proteger_id_usuario(data.user_id)
    # Buscar usuario por HMAC
    print("DEBUG find_user TYPE:", buscar_usuario_por_hmac)

    user = buscar_usuario_por_hmac(user_id_hmac)

    if not user:
        return {"success": False, "message": "Usuario no encontrado"}

    # Validar email en metadata
    emails = user.get("metadata", {}).get("emails", [])
    if data.email not in emails:
        return {"success": False, "message": "Email no coincide"}

    # Generar un request_id único
    request_id = str(uuid.uuid4())

    # Crear registro inicial de tracking
    new_request({
        "request_id": request_id,
        "user_id_hmac": user_id_hmac,
        "email": data.email,
        "platform": data.platform,
        "session_token": data.session_token,
        "status": "processing",
        "security": {
            "ip": ip,
            "user_agent": user_agent
        },
        "logs": [
            {"at": datetime.utcnow(), "message": "Callback aceptado. Buscando perfil psicológico"}
        ]
    })

   # 2) Obtener perfil psicológico cifrado
    psy_doc = psy_col.find_one({"user_id_hmac": user_id_hmac})
    if not psy_doc:
        update_request(request_id, {"status": "failed"})
        return {"success": False, "message": "Perfil no encontrado", "request_id": request_id}

    try:
        profile = descifrar_dict(psy_doc["psy_profile"])
        add_log(request_id, "Perfil psicológico descifrado correctamente")
    except Exception as e:
        update_request(request_id, {"status": "failed"})
        add_log(request_id, f"Error descifrando AES: {e}")
        return {"success": False, "message": "Error descifrando perfil", "request_id": request_id}

    # 3) Enviar perfil al servidor generador
    outbound_payload = {
        "request_id": request_id,
        "user_id": data.user_id,
        "email": data.email,
        "platform": data.platform,
        "session_token": data.session_token,
        "psy_profile": profile
        
    }

    body_bytes = canonical_json(outbound_payload)
    signature = hmac.new(
        GEN_SECRET.encode("utf-8"),
        body_bytes,
        hashlib.sha256
    ).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Payload-Signature": signature
    }
    
    if DEBUG_LOGS:
        print("DEBUG Enviando al generador final:")
        print("DEBUG Headers:", headers)
        print("DEBUG Body:", outbound_payload)

    try:
        resp = requests.post(f"{GENERATION_SERVER_URL}/generate", json=outbound_payload, headers=headers, timeout=5)
        if resp.status_code != 200:
            raise Exception(resp.text)
        add_log(request_id, "Datos enviados al generador final")
        update_request(request_id, {"status": "completed"})
    except Exception as e:
        add_log(request_id, f"Error enviando a generador final: {e}")
        update_request(request_id, {"status": "failed"})
        return {"success": False, "message": "Error enviando datos", "request_id": request_id}

    return {
        "success": True,
        "message": "Generación exitosa.",
        "request_id": request_id
    }

"""
TRACKING

"""
@app.get("/generator-status/{request_id}")
async def generator_status(request_id: str):
    req = get_request(request_id)
    if not req:
        return {"error": "request_not_found"}
    req["_id"] = str(req["_id"])
    return req
@app.get("/generator-history/{user_id_hmac}")
async def generator_history(user_id_hmac: str):
    history = get_user_history(user_id_hmac)
    for h in history:
        h["_id"] = str(h["_id"])
    return history
