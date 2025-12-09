import random
import json
import os

rango_aleatorio_min = 1000
rango_aleatorio_max = 9999

def cargar_tags(nombre_archivo_json: str) -> dict:
    """Carga la lista de tags existentes desde el archivo JSON."""
    if os.path.exists(nombre_archivo_json):
        with open(nombre_archivo_json, 'r', encoding='utf-8') as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                # Error: si el archivo está corrupto o vacío
                print(f"Advertencia: El archivo '{nombre_archivo_json}' está vacío o corrupto. Iniciando con un diccionario vacío.")
                return {}
    return {} # Si el archivo no existe, retorna un diccionario vacío

def guardar_tags(nombre_archivo_json: str, tags: dict):
    """Guarda la lista de tags en el archivo JSON."""
    with open(nombre_archivo_json, 'w', encoding='utf-8') as f:
        json.dump(tags, f, ensure_ascii=False, indent=4)
    print(f"Tags guardados en '{nombre_archivo_json}'.")

def generar_tag_random():
    return random.randint(rango_aleatorio_min, rango_aleatorio_max)

def nueva_red(nombre_red: str, nombre_archivo_json: str = "redes_sociales_con_tags.json"):
    """Genera un nuevo tag para una red social y lo guarda en el archivo JSON."""
    tags = cargar_tags(nombre_archivo_json)
    
    if nombre_red in tags:
        print(f"La red '{nombre_red}' ya existe con el tag {tags[nombre_red]}.")
        return 
    
    tags_existentes = set(tags.values())

    nuevo_tag = None
    intentos = 0
    max_intentos = rango_aleatorio_max

    while intentos < max_intentos:
        tag_propuesto = str(generar_tag_random())
        if tag_propuesto not in tags_existentes:
            nuevo_tag = tag_propuesto
            break
        intentos += 1

    if nuevo_tag is not None:
        tags[nombre_red] = nuevo_tag
        guardar_tags(nombre_archivo_json, tags)
        print(f"Nueva red '{nombre_red}' agregada con el tag {nuevo_tag}.")
        return 
    else:
        print(f"No se pudo generar un tag único para la red '{nombre_red}' después de {max_intentos} intentos.")
        return None
    
def actualizar_todos_tags(nombre_archivo_json: str):
    """Actualiza todos los tags en el archivo JSON, asegurando que sean únicos."""
    tags = cargar_tags(nombre_archivo_json)
    if not tags:
        print("No hay redes para actualizar.")
        return

    redes = list(tags.keys())
    num_redes = len(redes)

    # Rango de tags disponibles (1000 a 9999)
    rango_disponible = range(rango_aleatorio_min, rango_aleatorio_max + 1)
    
    try:
        # Genera 'num_redes' tags únicos entre sí
        nuevos_tags_int = random.sample(rango_disponible, num_redes)
    except ValueError:
        print(f"Error: El número de redes ({num_redes}) excede el rango de tags únicos disponibles (9000).")
        return
        
    # Convertir a cadenas y crear el nuevo diccionario
    nuevos_tags_str = [str(tag) for tag in nuevos_tags_int]
    
    # Creación del nuevo diccionario usando las redes existentes
    nuevo_tags_data = dict(zip(redes, nuevos_tags_str))
    
    # Guardar los datos actualizados
    guardar_tags(nombre_archivo_json,nuevo_tags_data)
    print(f"Se actualizaron los tags de {num_redes} redes sociales a nuevos valores únicos.")



print("--- Ejecutando Demostración ---")
nombre_archivo = "redes_sociales_con_tags.json"

# 1. Intentamos añadir un nuevo elemento
nueva_red("Facebook", nombre_archivo)

"""
# 2. Intentamos añadir un elemento que ya está
nueva_red("Pinterest", nombre_archivo)

# 3. Regeneramos todos los tags
actualizar_todos_tags(nombre_archivo)

# 4. Cargamos y mostramos el resultado final
print("\n--- Contenido actual del archivo JSON ---")
print(cargar_tags(nombre_archivo))

"""
