# El backend d(Node.js) de Extensión 
# llama a este endpoint: /api/biometric-registration
# Recibimos los datos de Extensión que recibio de Biometria
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from psy_analizer import PsychologicalAnalyzer



app = FastAPI()
analyzer = PsychologicalAnalyzer()

class BioRegistrationPayload(BaseModel):
    email: str
    idUsuario: str
    user_answers: list[int]
    session_token: str

@app.post("/api/biometric-registration")
async def biometric_registration(data: BioRegistrationPayload):
    """
    Recibe datos del server Node (backend central) después de que BIOMETRÍA
    completa el registro y provee la cadena de valores psicológicos.
    """
    try:
        print("🔵 —— DATA RECIBIDA DESDE NODE ——")
        print(data.dict())

        
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
