import string
from typing import List

# Definición del Alfabeto Extendido (Debe coincidir exactamente con el usado en el cifrado)
SIMBOLOS_PERMITIDOS = "!@#$%^&*_+-=:;\.?/|"
ALFABETO_EXTENDIDO = string.ascii_letters + "Ññ" + string.digits + SIMBOLOS_PERMITIDOS


#Codificación numérica del la cadena cifrada del usuario(descripción psicológica)
def calcular_codificacion_numerica(cadena_cifrada:str) -> int:
    """Calcula el valor numérico total de la cadena cifrada sumando los índices del Alfabeto Extendido."""
    suma_total = 0

    try:
        if not cadena_cifrada:
            raise ValueError("La cadena cifrada está vacía.")
    except ValueError as ve:
        print(f"Error: {ve}")
        return 0
    # Recorrer cada carácter en la cadena cifrada y sumar su índice en el Alfabeto Extendido
    for caracter in cadena_cifrada:
        if caracter in ALFABETO_EXTENDIDO:
            indice = ALFABETO_EXTENDIDO.index(caracter)
            suma_total += indice
        else:
            print(f"Advertencia: El carácter '{caracter}' no está en el Alfabeto Extendido y será ignorado.")

    return suma_total

#Calcula el exponenete que se usará en el cifrado de curva elíptica de la contraseña 
#Genera un número entero de alta entropía (256 bits) a partir de la lista de valores numéricos del analisis psicológico y el valor numérico de la cadena de descripción psicológica cifrada
#Inspirado en el modelo GLC, pero con mezcla áurea de 64 bits.
def calcular_exponente(lista_valores: List[float], num_codificacion: int = 0) -> int:

    n_hex= "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551" # Orden del grupo de la curva secp256r1
    n= int(n_hex,16)  # Orden del grupo de la curva secp256r1
    # Constantes para difusión y mezcla
    escala = 1000 # Para eliminar flotantes
    phi64 = 11400714819323198485   # Constante dorada -> 64-bit -> 2^64 / φ  (basada en la proporción áurea)
    m = 2**64  # Módulo de 64-bit para realizar operación en un solo ciclo
    mask256 = 2**256 - 1   # Máscara número final -> 256 bits
    
    # Conversión a enteros
    lista_enteros = [int(x * escala) for x in lista_valores]

    # x = (a * x + c) mod m
    # Acumulación y mezcla base
    c = sum(lista_enteros)# Sumatorio
    a = sum(x % escala for x in lista_enteros)  # Suma de los decimales escalados

    #  Ajustes y limitaciones de tamaño 
    a = (a | 1) % (2 ** 8)  # Forzar impar y limitar a 8 bits
#impar para que recorra el espacio completo del módulo y no perder entropía
# 8 bits porque la suma de los decimales escalados no será muy grande y se busca difuminar su valor( por si acaso)
    c = c % (2 ** 64)       # Limitar a 64 bits
    
    # Mezcla áurea con codificación
    # Inspiración GLC: combinación modular de tres fuentes (a, c, num_codificación)
    semilla_1 = (c * phi64 + a) % m #primera mezcla -> para difuminar la correlación con la entrada
    semilla_2 = ((c + num_codificacion) * phi64 + a * 3) % m  # segunda mezcla -> para reforzar la entropía
    
    # Cálculo de resultados intermedios
    resultado_1 = (a * semilla_1 + c) % m
    resultado_2 = (a * semilla_2 + c) % m

    # Cálculo final modular
    resultado = pow(resultado_1, resultado_2, mask256)
    
    # Verificación del tamaño
    if resultado.bit_length() < 256:
        # Ajuste adicional si la entropía es baja
        resultado = (resultado * phi64 + 0x9E3779B97F4A7C15) & mask256
    resultado = resultado % n  # Asegurar que el exponente está dentro del orden del grupo de la curva
    print("Tamaño del exponente (bits):", resultado.bit_length())
    
    return resultado  
