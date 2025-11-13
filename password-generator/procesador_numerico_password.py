# Extraer valores numéricos del archivo JSON que contiene los resultados de la evaluacion psicológica de los usuarios
import json
import math
import os
import string
from typing import List, Union
import preprocesador_texto
import random
import constantes

# Definición del Alfabeto Extendido (Debe coincidir exactamente con el usado en el cifrado)
SIMBOLOS_PERMITIDOS = constantes.SIMBOLOS_PERMITIDOS
ALFABETO_EXTENDIDO = constantes.ALFABETO_EXTENDIDO


# Límites para la longitud de la contraseña
longitud_minima = constantes.longitud_minima
longitud_maxima = constantes.longitud_maxima


#NOTA: PARA CAMBIAR LAS CONTRASEÑAS GENERADAS ES CAMBIAR EL TAG DE LA PLATAFORMA EN EL ARCHIVO JSON "redes_sociales_con_tags.json"
#cambiar estos números es la forma de actualizar de forma generalizada todas las contraseñas de los usuarios


def cargar_valores_de_usuario(nombre_archivo: str) -> Union[List[float], None]:
    try:
        # Abrir y leer el archivo JSON
        with open(nombre_archivo, 'r', encoding='utf-8') as archivo:
            datos = json.load(archivo)
            # Extraer los valores numéricos del JSON
            scores = datos.get("predicted_scores", {})
            valores = list(scores.values())
            cadena_usuario = datos.get("unique_profile_description", "")
            return valores, cadena_usuario
    except FileNotFoundError:
        print(f"Error: El archivo '{nombre_archivo}' no se encontró.")
        return None
    except json.JSONDecodeError:
        print(f"Error: El archivo '{nombre_archivo}' no tiene un formato JSON válido.")
        return None
    except Exception as e:
        print(f"Ocurrió un error inesperado: {e}")
        return None
    
def cargar_tag_redes(nombre_archivo: str, plataforma_actual: str) -> str | None:
    """
    Carga el contenido de un archivo JSON y devuelve el tag
    asociado a la plataforma especificada.

    """
    try:
        # Abrir y leer el archivo JSON
        with open(nombre_archivo, 'r', encoding='utf-8') as archivo:
            # Los datos cargados son un diccionario: {"Plataforma": "Tag"}
            datos_redes = json.load(archivo)

            # Verificar si la plataforma existe en el diccionario
            if plataforma_actual in datos_redes:
                # Devolver el tag asociado
                return datos_redes[plataforma_actual]
            else:
                print(f"Advertencia: No se encontró la plataforma '{plataforma_actual}' en el archivo JSON.")
                return None

    except FileNotFoundError:
        print(f"Error: El archivo '{nombre_archivo}' no se encontró en la ruta: {os.path.abspath(nombre_archivo)}")
        return None
    except json.JSONDecodeError:
        print(f"Error: El archivo '{nombre_archivo}' no tiene un formato JSON válido.")
        return None
    except Exception as e:
        print(f"Ocurrió un error inesperado al cargar los datos: {e}")
        return None



def calcular_desplazamiento (lista_valores: List[float], tag_plataforma: str, max_rango: int) -> int:
    #rango_maximo => valor máximo del desplazamiento,  menor que la longitud del alfabeto extendido
    phi32 = 2654435769  # Constante dorada -> 32-bit -> 2^32 / φ  ,basada en la proporción áurea
    escala = 1000 # Para eliminar flotantes
    mask32 = (2**32) - 1   # Máscara número final -> 32 bits

    mezcla = 0

    lista_enteros = [int(x * escala) for x in lista_valores]

    for valor in lista_enteros:
        mezcla ^= valor & mask32  # Mezcla XOR con limitación a 32 bits
        mezcla = (mezcla * phi32) & mask32  # Mezcla áurea con limitación a 32 bits
        mezcla = ((mezcla << 13) | (mezcla >> 19)) & mask32  # 13 + 19 = 32 - Rotación izquierda de 13 bits y rotación derecha de 19 bits => no se destruye información (rotación cíclica)

    # Incorporar el tag de la plataforma
    #tag_plataforma (matemáticamente) identificador -> diferencia dominios de mezcla
    tag_num = int(tag_plataforma) & mask32 # Convertir a entero y limitar a 32 bits (precaución)
    mezcla = (mezcla + tag_num * phi32) & mask32  # Mezcla áurea con el tag de la plataforma

    base = mezcla % 1000 # Base entre 0 y 999 -> se toman los últimos 3 dígitos de la mezcla (de hasta 2^32)
    desplazamiento = 1 + int((max_rango -1) * math.log1p(base) / math.log1p(1000)) 
    #El modelulo 1000 define el rango máximo del desplazamiento
    #EL logaritmo controla la sensibilidad del desplazamiento a cambios en la mezcla (no lineal)
    #log1p -> se usa para evitar log(0) y mejorar precisión con valores pequeños (por cautela) -> Resultados mas sensibles en la parte baja del rango
    #La combinación de logaritmos y escala controla lo rápido o lento que cambia el desplazamiento con cambios en la mezcla
    #El +1 asegura que el desplazamiento nunca sea cero (mínimo 1)

    return desplazamiento

def recoger_semilla_longitud(tag_plataforma: str, lista_valores: List[float]) -> int:
    linta_enteros = [int(x * 1000) for x in lista_valores]

    #tomar el penultimo digito del la lista de enteros
    penultimo_digito = linta_enteros[-2] if len(linta_enteros) > 1 else 0
    
    # separar el ultimo digito de tag_plataforma
    ultimo_digito_tag = int(tag_plataforma[-1]) if tag_plataforma and tag_plataforma[-1].isdigit() else 0
    #semilla para la generación de la longitud -> suma de los valores enteros + ultimo digito del tag de la plataforma
    semilla = penultimo_digito * ultimo_digito_tag
    return semilla

def generar_longitud(semilla: int, min_length: int = longitud_minima, max_length: int = longitud_maxima) -> int:
    """Genera una longitud para la contraseña entre min_length y max_length usando una semilla."""
    random.seed(semilla)
    numero = random.randint(min_length, max_length)
    
    random.seed()  # Restablecer la semilla del generador de números aleatorios
    return numero

def generar_punto_inicio() -> int:
    """Genera un punto de inicio aleatorio para la selección de caracteres en la contraseña."""
    punto_inicio = random.randint(constantes.minimos_generacion_punto_inicio, constantes.maximos_generacion_punto_inicio)
    return punto_inicio
    


# Ejemplo de uso
"""nombre_archivo = 'resultado_psicologico_example.json' 

valores = cargar_valores_de_usuario(nombre_archivo)
if valores is not None:
    print("Valores extraídos:", valores)


numero_aleatorio = generador_congruencial(valores)
print("Número aleatorio generado:", numero_aleatorio)"""

"""
# Ejemplo de uso del preprocesador y cálculo de codificación numérica
cadena_usuario = "Hola, Mundo! 123"
nombre_archivo = 'resultado_psicologico_example.json' 

tag = cargar_tag_redes("redes_sociales_con_tags.json", "Instagram")
print("Tag cargado para Instagram:", tag)

valores = cargar_valores_de_usuario(nombre_archivo)
if valores is not None:
    print("Valores extraídos:", valores)
desplazamiento = calcular_desplazamiento(valores, tag, len(ALFABETO_EXTENDIDO)) 
print("desplazamiento: ", desplazamiento)
cadena_cifrada, indice_cifrado = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
print("Cadena original:", cadena_usuario)
print("Cadena cifrada:", cadena_cifrada)
print("Índice de cifrado:", indice_cifrado) """





