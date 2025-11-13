import string  # Manejo de cadenas de texto
from typing import Union   # Anotaciones de tipos

# Para el cifrado Cesar de los párrafos de descripción del usuario se usa un alfabeto extendido que incluye letras, dígitos y signos de puntuación

frase_usuario = "Un ejemplo de frase para procesar. 12345!@#"

# Cifrado César Cíclico del párrafo
def preprocesador_cadena(cadena_usuario, desplazamiento):
    simbolos_permitidos = "!@#$%^&*_+-=:;\.?/|"
    alfabeto_extendido = string.ascii_letters + "Ññ" +string.digits + simbolos_permitidos
    

    cadena_cifrada = ""
    cadena_usuario = cadena_usuario.replace(" ", "")  # Eliminar espacios en blanco
    for caracter in cadena_usuario:
        if caracter in alfabeto_extendido:
            indice_original = alfabeto_extendido.index(caracter)
            # Se suma el desplazamiento y se usa el modulo para evitar salir del rango del alfabeto
            indice_cifrado = (indice_original + desplazamiento) % len(alfabeto_extendido)
            #Reemplazo del caracter original por el caracter cifrado
            cadena_cifrada += alfabeto_extendido[indice_cifrado]
    
        else:
            cadena_cifrada += caracter  # Si el carácter no está en el alfabeto, se deja igual
    cadena_cifrada = cadena_cifrada.replace(" ", "")  # Eliminar espacios en blanco
    #indice_cifrado = desplazamiento  # Retornar el índice de cifrado usado

    return cadena_cifrada, indice_cifrado
"""# Ejemplo de uso
cadena_usuario = "Hola, Mundo! 123"
cadena_cifrada = preprocesador_cadena(cadena_usuario, 8)  
# Imprimir el resultado
print("Cadena original:", cadena_usuario)
print("Cadena cifrada:", cadena_cifrada)"""