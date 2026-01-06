import string  # Manejo de cadenas de texto
from typing import Union
import unicodedata   # Anotaciones de tipos
import constantes
import random

# Para el cifrado Cesar de los párrafos de descripción del usuario se usa un alfabeto extendido que incluye letras, dígitos y signos de puntuación
alfabeto_extendido = constantes.ALFABETO_EXTENDIDO
simbolos_permitidos = constantes.SIMBOLOS_PERMITIDOS
numeros_permitidos = string.digits

# Cifrado de Sustitución por Desplazamiento con Preprocesamiento de Datos y Ofuscación de Ruido -> Basado en <Cifrado César Cíclico del párrafo
def preprocesador_cadena(cadena_usuario, desplazamiento):

    cadena_cifrada = ""
    cadena_usuario = cadena_usuario.replace(" ", "")  # Eliminar espacios en blanco
    cadena_usuario = unicodedata.normalize('NFD', cadena_usuario)
    cadena_usuario = "".join([c for c in cadena_usuario if not unicodedata.combining(c)])  # Eliminar acentos y diacríticos
    for caracter in cadena_usuario:
        if caracter in alfabeto_extendido:
            indice_original = alfabeto_extendido.index(caracter)
            # Se suma el desplazamiento y se usa el modulo para evitar salir del rango del alfabeto
            indice_cifrado = (indice_original + desplazamiento) % len(alfabeto_extendido)
            #Reemplazo del caracter original por el caracter cifrado
            cadena_cifrada += alfabeto_extendido[indice_cifrado]
    
        else:
            cadena_cifrada += random.choice(simbolos_permitidos + numeros_permitidos)  # Reemplazar caracteres no permitidos con un carácter aleatorio del alfabeto extendido
    cadena_cifrada = cadena_cifrada.strip()  # Eliminar espacios en blanco al inicio y al final
    #indice_cifrado = desplazamiento  # Retornar el índice de cifrado usado

    return cadena_cifrada, indice_cifrado
"""# Ejemplo de uso
cadena_usuario = "Hola, Mundo! 123"
cadena_cifrada = preprocesador_cadena(cadena_usuario, 8)  
# Imprimir el resultado
print("Cadena original:", cadena_usuario)
print("Cadena cifrada:", cadena_cifrada)"""