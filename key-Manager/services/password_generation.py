from typing import List
import time, os
import hashlib
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import serialization


"""
CALCULO DE EXPONENTE

"""
def calcular_exponente(lista_valores: List[float], num_codificacion: int = 0) -> int:

    n_hex= "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551" # Orden del grupo de la curva secp256r1
    n= int(n_hex,16)  # Orden del grupo de la curva secp256r1
    # Constantes para difusión y mezcla
    escala = 1000 # Para eliminar flotantes
    phi64 = 11400714819323198485   # Constante dorada -> 64-bit -> 2^64 / φ  (basada en la proporción áurea)
    m = 2**64  # Módulo de 64-bit para realizar operación en un solo ciclo
    mask256 = 2**256 - 1   # Máscara número final -> 256 bits
    
    # Conversión a enteros
    lista_enteros = [int(x * escala) for x in lista_valores]

    # x = (c * x + a) mod m
    # Acumulación y mezcla base
    c = sum(lista_enteros)# Sumatorio
    a = sum(x % escala for x in lista_enteros)  # Suma de los decimales escalados

    #  Ajustes y limitaciones de tamaño 
    c = c * phi64 # Multiplicar por el número áureo para aumentar dispoersión
    c = (c | 1) 
    a = (a | 1)
    
    # Inspiración GLC: combinación modular de tres fuentes (a, c, num_codificación)
    tiempo1=tiempo_a_int()
    semilla_1 = (c * tiempo1 + a) % m #primera mezcla -> para difuminar la correlación con la entrada
    semilla_2 = ((c + num_codificacion) * tiempo1 + a) % m  # segunda mezcla -> para reforzar la entropía

    # Cálculo de resultados intermedios
    resultado_1 = (c * semilla_1 + a) % m
    resultado_2 = (c * semilla_2 + a) % m

    # Cálculo final modular
    resultado = pow(resultado_1, resultado_2, mask256)
    
    # Verificación del tamaño
    if resultado.bit_length() < 256:
        tiempo2 = tiempo_a_int()
        resultado = (resultado * tiempo2 + phi64) & mask256

    resultado = hashear_a_entero(resultado)
    resultado = resultado | 1  # Forzar impar
    resultado = resultado % n  # Asegurar que el exponente está dentro del orden del grupo de la curva
    #print("Tamaño del exponente (bits):", resultado.bit_length())
    
    return resultado  

def tiempo_a_int() -> int:
    """Convierte el tiempo actual en un entero de alta entropía."""
    tiempo_actual = time.time()
    tiempo_entero = int(tiempo_actual * 1e6)  # Convertir a microsegundos para mayor precisión
    return tiempo_entero

def hashear_a_entero(numero: int) -> int:
    """Aplica SHA-256 al número dado y devuelve un entero de alta entropía."""
    numero_bytes = numero.to_bytes((numero.bit_length() + 7) // 8, byteorder='big') # Convertir el número a bytes, 7 para redondear hacia arriba y 8 bits por byte esto asegura que todos los bits se incluyan
    hash_obj = hashlib.sha256(numero_bytes)
    hash_bytes = hash_obj.digest()
    hash_entero = int.from_bytes(hash_bytes, byteorder='big')
    return hash_entero

"""
    CLAVE PRIVADA CON EL EXPONENTE

"""
def construir_clave_privada(exponente):
    try:
        clave_privada = ec.derive_private_key(exponente, ec.SECP256R1(), default_backend())
        return clave_privada
    except ValueError:
        print("Error: El exponente proporcionado no es válido para la curva SECP256R1.")
        return None
    
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
        return texto_plano.decode()
    except Exception as e:
        print(f"Error durante la desencriptación ECC: {e}")
        return None
    
def ecc_encriptar_password(clave_publica, contrasena):
    try:
        efimera_privada = ec.generate_private_key(ec.SECP256R1(), default_backend())
        ephemeral_public_obj = efimera_privada.public_key()
        ephemeral_public_bytes = ephemeral_public_obj.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        clave_compartida = efimera_privada.exchange(ec.ECDH(), clave_publica)

        # Derivar una clave simétrica de la clave compartida (aquí simplemente truncamos para el ejemplo)
        clave_derivada = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=ephemeral_public_bytes,
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
            "ephemeral_public": ephemeral_public_bytes,
            "iv": vector_inicializacion,
            "ciphertext": texto_cifrado,
            "tag": cifrador.tag
        }
    except Exception as e:
        print(f"Error durante la encriptación ECC: {e}")
        return None
    