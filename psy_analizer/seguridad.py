import hashlib
import os
import uuid
import secrets

algoritmo = 'sha256'
longitud_salt = 16  # Longitud del salt en bytes
iteracione = 480000
dklen = 32  # Longitud del hash resultante en bytes para SHA-256

def generar_id_usuario() -> str:
    """Genera un hash seguro para el ID de usuario utilizando SHA-256 con un salt aleatorio."""
    # Generar un salt aleatorio y id_usuario
    id_usuario = str(uuid.uuid4())
    salt = os.urandom(longitud_salt)
    id_bytes = id_usuario.encode('utf-8')

    #Se usa PBKDF2 para derivar una clave segura a partir del id_usuario y el salt
    hash_bytes = hashlib.pbkdf2_hmac(
        algoritmo,
        id_bytes,
        salt,
        iteracione,
        dklen
    )
    # Convertir el hash y el salt a formato hexadecimal para almacenamiento
    hash_hex = hash_bytes.hex()
    salt_hex = salt.hex()
    # Devolver el hash junto con el salt en formato hexadecimal para futuras verificaciones
    return hash_hex, salt_hex

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
            iteracione,
            dklen = dklen
        ).hex()
        
        # Comparar el hash calculado con el hash almacenado
        return secrets.compare_digest(hash_calculado, hash_almacenado)
    except ValueError:
        return False
    
def encriptar_datos()