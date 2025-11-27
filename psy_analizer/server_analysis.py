# El backend d(Node.js) de Extensión 
# llama a este endpoint: /api/biometric-registration
# Recibimos los datos de Extensión que recibio de Biometria
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from pydantic import BaseModel
from psy_analizer import PsychologicalAnalyzer



app = FastAPI()
analyzer = PsychologicalAnalyzer()

class BioRegistrationPayload(BaseModel):
    email: str
    idUsuario: str
    jwt: str
    cadenaValores: list[int]
    sessionToken: str

@app.post("/api/biometric-registration")
async def biometric_registration(data: BioRegistrationPayload):
    """
    Recibe datos del server Node (backend central) después de que BIOMETRÍA
    completa el registro y provee la cadena de valores psicológicos.
    """
    
    analyzer.analyze_and_store(
        id_usuario=data.idUsuario,
        respuestas_usuario=data.cadenaValores,
        session_token=data.sessionToken,
        metadata={"email": data.email}
    )

    return {"status": "stored"}
