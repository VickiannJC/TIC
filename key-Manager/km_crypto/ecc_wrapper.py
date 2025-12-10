# Se envuelve las funciones de ECC para usarlas desde el KM
#Desencriptar password del cliente
#Para autollenar en la plataforma 
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend


# Desemcriptar la contraseña usando curva elíptica
def ecc_desencriptar_password (clave_privada, contrasena):
    try: 
        ephemeral_public_bytes = contrasena["ephemeral_public"]
        ephemeral_public = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), ephemeral_public_bytes
        )
        clave_compartida = clave_privada.exchange(ec.ECDH(), ephemeral_public)


        clave_derivada = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=ephemeral_public_bytes,
            info=b"encriptacion ecc password",
            backend=default_backend(),
        ).derive(clave_compartida)

        cifrador = Cipher(algorithms.AES(clave_derivada), modes.GCM(contrasena["iv"], contrasena["tag"]), backend=default_backend())
        desencriptador = cifrador.decryptor()
        texto_plano = desencriptador.update(contrasena["ciphertext"]) + desencriptador.finalize()
        return texto_plano.decode('utf-8')
    except Exception as e:
        print(f"Error durante la desencriptación ECC: {e}")
        return None
    
def cargar_llave_privada_desde_bytes(llave_privada_bytes: bytes, contrasena: bytes = None):
    
    try:
        # Usa load_pem_private_key para cargar la clave. 
        # Esta función es versátil para varios formatos comunes.
        llave_privada = serialization.load_der_private_key(
            data=llave_privada_bytes,
            password=contrasena,
            backend=default_backend()
        )
        return llave_privada

    except ValueError as e:
        # Aquí se capturan errores como formato inválido, clave corrupta o contraseña incorrecta
        print(f"Error al cargar la clave privada desde bytes: {e}")
        raise

    except TypeError as e:
        # Puede ocurrir si la 'contrasena' no es bytes
        print(f"Error de tipo: Asegúrate de que la clave y la contraseña sean bytes. {e}")
        raise

def ecc_decrypt_password(private_key_bytes: bytes, ciphertext_b64: str) -> str:
    ciphertext = base64.b64decode(ciphertext_b64.encode("utf-8"))
    private_key = cargar_llave_privada_desde_bytes(private_key_bytes)
    pw_str = ecc_desencriptar_password(private_key, ciphertext)
    return pw_str



