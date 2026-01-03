print("🚨 SERVER GENERATOR CARGADO")
import os
import json
import hmac
import hashlib
from typing import Dict, Any, List, Optional

import requests
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

# === MÓDULOS LOCALES ===
import procesador_numerico_password
import preprocesador_texto
import procesador_numerico_eliptico
from generator import generar_contrasena
from constantes import ALFABETO_EXTENDIDO  
from dotenv import load_dotenv
load_dotenv()



DEBUG_LOGS = os.environ.get("GEN_SERVER_DEBUG", "false").lower() == "true"

# Secreto HMAC compartido con server_analysis 
GEN_HMAC_SECRET = os.environ.get("GEN_HMAC_SECRET")
if not GEN_HMAC_SECRET:
    raise RuntimeError("GEN_HMAC_SECRET no definido en variables de entorno.")

# Endpoint HTTPS del Key-Manager
KEY_MANAGER_URL = os.environ.get("KEY_MANAGER_URL")
if not KEY_MANAGER_URL:
    raise RuntimeError("KEY_MANAGER_URL no definido en variables de entorno.")

# API KEY para autenticar este servicio frente al Key-Manager
KEY_MANAGER_API_KEY = os.environ.get("KEY_MANAGER_API_KEY")
if not KEY_MANAGER_API_KEY:
    raise RuntimeError("KEY_MANAGER_API_KEY no definido en variables de entorno.")





# ===================
#   MODELOS Pydantic 
# ===================

class PsyProfile(BaseModel):
    predicted_scores: Dict[str, float] = Field(default_factory = dict, description="Big Five scores")
    unique_profile_description: str


class GenerationPayload(BaseModel):
    request_id: str
    user_id: str
    email: str
    platform: str
    session_token: str
    psy_profile: PsyProfile


# ======================================================
#   FASTAPI APP
# ======================================================

app = FastAPI(title="Psy Password Generation Server", version="1.0.0")


# ======================================================
#   FUNCIONES AUXILIARES
# ======================================================

def canonical_json(obj: Any) -> bytes:
    return json.dumps(
        obj,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

def verify_payload_signature(body: Dict[str, Any], header_sig: Optional[str]) -> None:
    """
    Verifica que el payload JSON ha sido firmado por server_analysis
    usando HMAC-SHA256 con GEN_HMAC_SECRET.

    """

    if not header_sig:
        raise HTTPException(status_code=401, detail="Missing X-Payload-Signature header")

    body_canon = canonical_json(body)

    expected_sig = hmac.new(
        GEN_HMAC_SECRET.encode("utf-8"),
        body_canon,
        hashlib.sha256
    ).hexdigest()


    if DEBUG_LOGS:
        print("DEBUG Expected signature:", expected_sig)
        print("DEBUG Header signature:", header_sig)
    if not hmac.compare_digest(expected_sig, header_sig):
        print("❌ Firma inválida")
        raise HTTPException(status_code=401, detail="Invalid payload signature")
    print("✔ Firma válida")


def extract_valores_and_cadena(psy_profile: PsyProfile, email: str, platform: str) -> tuple[list[float], str]:
    """
    A partir de los scores Big Five y la descripción única, construye:

    - valores: lista ordenada [E, A, C, N, O]
    - cadena_usuario: base textual para la generación de contraseña

    """
    trait_order = ["Extraversion", "Agreeableness", "Conscientiousness", "Neuroticism", "Openness"]

    scores = psy_profile.predicted_scores

    try:
        valores = [float(scores[t]) for t in trait_order]
    except KeyError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Missing trait in predicted_scores: {e}"
        )

    # Cadena del usuario con datos importantes
    cadena_usuario = f"{psy_profile.unique_profile_description} | {email} | {platform.lower().strip()}"

    return valores, cadena_usuario


def send_to_key_manager(payload: dict) -> None:
    """
    Envía la información final al Key-Manager usando HTTPS y API KEY.

    """
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {KEY_MANAGER_API_KEY}",
    }

    try:
        resp = requests.post(
            url = f"{KEY_MANAGER_URL}/process_generation",
            json=payload,
            headers=headers,
            timeout=5,       # Evita que se quede colgado
        )
    except requests.RequestException as exc:
        #Manejo de errores
        raise HTTPException(
            status_code=502,
            detail=f"Error connecting to Key-Manager: {type(exc).__name__}"
        )

    if resp.status_code != 200:
        # Respuesta controlada hacia server_analysis
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Key-Manager error: returned (status{resp.status_code})"
        )


# ======================================================
#   ENDPOINT PRINCIPAL -> ANALYSIS -> GENERATOR -> SERVER KEYMANAGER
# ======================================================

@app.post("/generate", summary="Generar contraseña y enviarla al Key-Manager")
async def generate_password(request: Request):
    """
    Endpoint que recibe el perfil psicológico desde server_analysis,
    genera una contraseña personalizada y envía los datos al Key-Manager.

    """

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    # Verificar firma HMAC del payload
    header_sig = request.headers.get("X-Payload-Signature")
    verify_payload_signature(body, header_sig)

    #  Validar estructura con Pydantic
    try:
        data = GenerationPayload(**body)
        print("✔ Payload Pydantic validado correctamente")
    except ValidationError as e:
        print("❌ Error Pydantic:", e.json())
        raise HTTPException(status_code=400, detail=f"Invalid payload structure: {e}")

    platform = data.platform.lower().strip()

    # Logs mínimos, sin datos sensibles
    if DEBUG_LOGS:
        print(f"[GEN-SERVER] request_id={data.request_id} platform={platform}")
        print(f"[GEN-SERVER] user_id={data.user_id} email={data.email}")
    
    #  Extraer valores numéricos y cadena de usuario
    valores, cadena_usuario = extract_valores_and_cadena(
        psy_profile=data.psy_profile,
        email=data.email,
        platform=platform
    )

    # ==================================================
    #   PIPELINE DE GENERACIÓN SEGÚN TU ESPECIFICACIÓN
    # ==================================================

    # Tag de la plataforma
    # "redes_sociales_con_tags.json" debe estar accesible para este servicio
    tag = procesador_numerico_password.cargar_tag_redes(
        "redes_sociales_con_tags.json",
        platform
    )
    # Calcular desplazamiento
    desplazamiento = procesador_numerico_password.calcular_desplazamiento(
        valores,
        tag,
        len(ALFABETO_EXTENDIDO)
    )

    # Preprocesar/cifrar cadena de usuario
    cadena_cifrada, indice_generacion = preprocesador_texto.preprocesador_cadena(
        cadena_usuario,
        desplazamiento
    )

    #  Generar semilla, longitud y punto de inicio
    #semilla = procesador_numerico_password.recoger_semilla_longitud(tag, valores)
    # Se decide no usar una semilla de generación para la longitud para evitar que todas las contraseñas del mismo usuario tengan la misma longitud
    longitud = procesador_numerico_password.generar_longitud()
    punto_inicio = procesador_numerico_password.generar_punto_inicio()

    #  Generar contraseña final
    contrasena = generar_contrasena(
        cadena_usuario,
        longitud,
        desplazamiento,
        punto_inicio
    )

    # Codificación numérica 
    valor_numerico_cod = procesador_numerico_eliptico.calcular_codificacion_numerica(
        cadena_cifrada
    )

    # ==================================================
    #   ENVÍO SEGURO AL KEY-MANAGER
    # ==================================================
    km_payload = {
        "user_id": data.user_id,
        "session_token": data.session_token, 
        "email": data.email,
        "platform": platform,
        "purpose": "PASSWORD",
        "password": contrasena,
        "numeric_code": valor_numerico_cod,
        "psy_values": valores,
        "request_id": data.request_id,
    }
    print("✔  km_payload generado")

    # Enviar al Key-Manager (HTTPS + API KEY)
    send_to_key_manager(km_payload)

    if DEBUG_LOGS:
        print(f"✔ Datos enviados al Key-Manager para request_id={data.request_id}")

    # Respuesta al server_analysis 
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "message": "Password generated and sent to Key-Manager",
            "request_id": data.request_id,
            "platform": platform
        }
    )