# crypto/aes_gcm.py
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import os, base64

def encrypt_with_kdb(kdb: bytes, plaintext: bytes, aad: bytes = b"") -> str:
    aesgcm = AESGCM(kdb)
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, plaintext, aad)
    return base64.b64encode(nonce + ct).decode("utf-8")

def decrypt_with_kdb(kdb: bytes, token: str, aad: bytes = b"") -> bytes:
    data = base64.b64decode(token.encode("utf-8"))
    nonce, ct = data[:12], data[12:]
    aesgcm = AESGCM(kdb)
    return aesgcm.decrypt(nonce, ct, aad)
