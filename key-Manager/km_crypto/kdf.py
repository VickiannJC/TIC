from argon2.low_level import hash_secret_raw, Type

def derive_kdb(master_secret: bytes, salt: bytes) -> bytes:
    return hash_secret_raw(
        secret=master_secret,
        salt=salt,
        time_cost=3,
        memory_cost=64 * 1024,  # 64MB
        parallelism=2,
        hash_len=32,
        type=Type.ID
    )
