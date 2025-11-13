from flask import json


def guardar_palabras(lista_palabras, archivo_json):
    """Guarda únicamente la lista de palabras descriptivas en un archivo JSON."""
    with open(archivo_json, "w", encoding='utf-8') as f:
        json.dump(lista_palabras, f, indent=4, ensure_ascii=False)
    print(f"\nLista de palabras guardada correctamente en {archivo_json}")

