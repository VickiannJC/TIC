import os, base64, hmac, hashlib, time
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from config import SIGNING_SECRET

def derive_shared_channel_key(server_private_key, plugin_public_bytes: bytes) -> bytes:
    """
    Deriva la clave compartida del canal entre Plug-in y KM usando ECDH + HKDF.
    """
    plugin_public_key = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), plugin_public_bytes
    )

    shared_secret = server_private_key.exchange(ec.ECDH(), plugin_public_key)

    k = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=plugin_public_bytes,
        info=b"plugin-km-channel",
    ).derive(shared_secret)

    return k


def envelope_encrypt(channel_key: bytes, plaintext: bytes, aad: bytes = b"") -> str:
    aes = AESGCM(channel_key)
    nonce = os.urandom(12)
    ct = aes.encrypt(nonce, plaintext, aad)
    return base64.b64encode(nonce + ct).decode("utf-8")


def envelope_decrypt(channel_key: bytes, token: str, aad: bytes = b"") -> bytes:
    data = base64.b64decode(token.encode("utf-8"))
    nonce, ct = data[:12], data[12:]
    aes = AESGCM(channel_key)
    return aes.decrypt(nonce, ct, aad)

# ================= Verificación de firma HMAC-SHA256 Extension ================== 

def verify_request_signature(request_body: bytes, header_signature: str, header_timestamp: str) -> bool:
    """
    Verifica que la petición venga de la extensión y no haya sido alterada.
    Usa HMAC-SHA256 con el SIGNING_SECRET compartido.
    """
    if not header_signature or not header_timestamp:
        return False

    # Protección contra Replay Attack -> valido 5 minutos
    current_time = int(time.time() * 1000)
    try:
        req_time = int(header_timestamp)
    except ValueError:
        return False # Timestamp no es un número válido

    # Validar ventana de tiempo (300,000 ms = 5 min)
    if abs(current_time - req_time) > 300000: 
        print(f"❌ Rechazado por Timestamp expirado: {current_time - req_time}ms de diferencia")
        return False

    # Construir el mensaje a firmar
    mensaje = f"{header_timestamp}.".encode("utf-8") + request_body

    #  Calcular HMAC localmente usando la clave secreta importada de config
    if not SIGNING_SECRET:
        print("❌ Error Crítico: SIGNING_SECRET no está configurado en config.py")
        return False
        
    secret_bytes = SIGNING_SECRET.encode('utf-8') 
    hmac_calculado = hmac.new(secret_bytes, mensaje, hashlib.sha256).hexdigest()

    # Comparar (secure compare para evitar timing attacks)
    es_valido = hmac.compare_digest(hmac_calculado, header_signature)
    
    if not es_valido:
        print(f"❌ Firma inválida. Recibida: {header_signature} | Calculada: {hmac_calculado}")
        
    return es_valido