import hashlib
import os
import uuid
import secrets
import json 
import hmac 


def generar_id_usuario() -> str:
    """Genera un hash seguro para el ID de usuario utilizando SHA-256 con un salt aleatorio."""
    # Generar un salt aleatorio y id_usuario
    id_usuario = str(uuid.uuid4())
    
    clave = secrets.token_bytes(32)  # Clave secreta aleatoria 

def almacenar_clave(clave)


def verificar_id_usuario(id_usuario: str, hash_almacenado: str, salt_almacenado: str) -> bool:
    """Verifica si el ID de usuario coincide con el hash almacenado utilizando el salt almacenado."""
    # Convertir el salt almacenado de hexadecimal a bytes
    try:
        salt = bytes.fromhex(salt_almacenado)

        id_bytes = id_usuario.encode('utf-8')
        
        #hash con PBKDF2 del id_usuario proporcionado
        hash_calculado = hashlib.pbkdf2_hmac(
            algoritmo,
            id_bytes,
            salt,
            iteraciones,
            dklen = dklen
        ).hex()
        
        # Comparar el hash calculado con el hash almacenado
        return secrets.compare_digest(hash_calculado, hash_almacenado)
    except ValueError:
        return False
    
def encriptar_datos(datos: dict, fernet_obj: Fernet)-> str:
    """Encripta los datos proporcionados utilizando el objeto Fernet dado."""

    datos_json = json.dumps(datos) #Convertir a JSON
    datos_bytes = datos_json.encode('utf-8') #Codificar para cifrar

    token = fernet_obj.encrypt(datos_bytes)
    return token.decode('utf-8') #cadena base 64