import os
import curva_eliptica
import json

def leer_entrada_por_id(id_usuario: str, archivo:str) -> dict:
    if not os.path.exists(archivo):
        raise FileNotFoundError(f"No existe {archivo}")
    with open(archivo, "r", encoding="utf-8") as f:
        lista = json.load(f)
    for e in lista:
        if e.get("id_usuario") == id_usuario:
            return e
    raise KeyError(f"No se encontró id_usuario={id_usuario} en {archivo}")