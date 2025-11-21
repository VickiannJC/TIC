import os
import json
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import serialization

# Desemcriptar la contraseña usando curva elíptica
def ecc_desencriptar_password (clave_privada, contrasena):
    try: 
        ephemeral_public = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), contrasena["ephemeral_public"]
        )
        clave_compartida = clave_privada.exchange(ec.ECDH(), ephemeral_public)


        clave_derivada = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"encriptacion ecc password",
            backend=default_backend(),
        ).derive(clave_compartida)

        cifrador = Cipher(algorithms.AES(clave_derivada), modes.GCM(contrasena["iv"], contrasena["tag"]), backend=default_backend())
        desencriptador = cifrador.decryptor()
        texto_plano = desencriptador.update(contrasena["ciphertext"]) + desencriptador.finalize()
        return texto_plano.decode()
    except Exception as e:
        print(f"Error durante la desencriptación ECC: {e}")
        return None
#instalar la librería cryptography si no está instalada
#pip install cryptography

def construir_clave_privada(exponente):
    try:
        clave_privada = ec.derive_private_key(exponente, ec.SECP256R1(), default_backend())
        return clave_privada
    except ValueError:
        print("Error: El exponente proporcionado no es válido para la curva SECP256R1.")
        return None
    
#Encriptar la contraseña usando la curva elíptica
def ecc_encriptar_password(clave_publica, contrasena):
    try:
        efímera_privada = ec.generate_private_key(ec.SECP256R1(), default_backend())
        clave_compartida = efímera_privada.exchange(ec.ECDH(), clave_publica)

        # Derivar una clave simétrica de la clave compartida (aquí simplemente truncamos para el ejemplo)
        clave_derivada = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"encriptacion ecc password",
            backend=default_backend()
        ).derive(clave_compartida)

        vector_inicializacion = os.urandom(12) # AES GCM requiere un IV de 12 bytes NIST SP 800-38D probada bajo IND-CCA
        cifrador = Cipher(
            algorithms.AES(clave_derivada),
            modes.GCM(vector_inicializacion),
            backend=default_backend()
        ).encryptor()
        
         # Asegurar que la contraseña sea bytes
        if isinstance(contrasena, str):
            contrasena_bytes = contrasena.encode()
        else:
            contrasena_bytes = contrasena

        texto_cifrado = cifrador.update(contrasena_bytes) + cifrador.finalize()

        return {
            "ephemeral_public": efímera_privada.public_key().public_bytes(
                encoding=serialization.Encoding.X962,
                format=serialization.PublicFormat.UncompressedPoint,

            ),
            "iv": vector_inicializacion,
            "ciphertext": texto_cifrado,
            "tag": cifrador.tag
        }
    except Exception as e:
        print(f"Error durante la encriptación ECC: {e}")
        return None
    
 
    
# Guardar contraseña en json 
def guardar_en_json(id_usuario, data_encriptada, archivo: str, plataforma:str):
    registro = {
        "id_usuario": id_usuario,
        "plataforma": plataforma.encode('utf-8').hex(),
        "password": {
            "ephemeral_public": data_encriptada["ephemeral_public"].hex(),
            "iv": data_encriptada["iv"].hex(),
            "ciphertext": data_encriptada["ciphertext"].hex(),
            "tag": data_encriptada["tag"].hex(),
        },
    }

    # Cargar archivo si existe
    lista = []
    try:
        if os.path.exists(archivo):
            with open(archivo, "r", encoding= 'utf-8') as f:
                lista = json.load(f)
    except FileNotFoundError:
        # Si el archivo no existe, inicializamos con una lista vacía
        lista = []
    except json.JSONDecodeError:
        # Si el archivo está vacío o corrupto, inicializamos con una lista vacía
        lista = []
    
    # Agregar nuevo registro y guardar, si encuentra un registro que coincida el id de usuario y la plataforma, se actualiza el registro y el viejo se elimina
    registro_encontrado = False
    for i, registro_existente in enumerate(lista):
        if registro_existente["id_usuario"] == id_usuario and registro_existente["plataforma"] == plataforma.encode('utf-8').hex():
            lista.pop(i)
            lista.append(registro)
            registro_encontrado = True
            break
    if not registro_encontrado:
        lista.append(registro)

    with open(archivo, "w", encoding='utf-8') as f:
        json.dump(lista, f, ensure_ascii=False, indent=4)
    print(f"Datos guardados en {archivo}")