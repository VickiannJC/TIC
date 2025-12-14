import os, base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


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
