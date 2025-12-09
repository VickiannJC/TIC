import os
import time
import curva_eliptica
import preprocesador_texto
import string
import random
import procesador_numerico_password
import procesador_numerico_eliptico
import json
import constantes
import datetime

longitud_minima = constantes.longitud_minima
longitud_maxima = constantes.longitud_maxima
SIMBOLOS_PERMITIDOS = constantes.SIMBOLOS_PERMITIDOS
ALFABETO_EXTENDIDO = constantes.ALFABETO_EXTENDIDO

numero_simbolos = len(SIMBOLOS_PERMITIDOS)


# cadena_usuario => cadena de descripcion del usuario
# longitud => longitud de la contraseña a generar
# desplazamiento => valor del desplazamiento para el cifrado Cesar
# punto_inicio => punto de inicio para la selección de la contraseña en la cadena cifrada

def generar_contrasena(cadena_usuario, longitud, desplazamiento, punto_inicio):
    contrasena = ""
    # Validar la longitud de la cadena de usuario
    if not (longitud_minima <= longitud <= longitud_maxima):
        raise ValueError(f"La longitud para la generación de la contraseña no está dentro de los límites permitidos ({longitud_minima}-{longitud_maxima}).")
    # Generar la contraseña cifrada usando el preprocesador
    cadena_cifrada, indice_cifrado = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
    # Validar el punto de inicio
    if punto_inicio < 0:
        raise ValueError("El punto de inicio y la longitud especificados no son válidos para la cadena cifrada.")

    # Generar la contraseña a partir de la cadena cifrada
    # Extraer la subcadena desde el punto de inicio con la longitud especificada
    #Se hace un corte circular -> si el punto de inicio + logitud sobrepasa
    # el len de la cadena => Se toman los caracteres faltantes del inicio. Es decir, se es circular
    for i in range(longitud):
        indice_real = (punto_inicio + i) % (len(cadena_cifrada))
        contrasena += cadena_cifrada[indice_real]

    # Inspeccionar si dentro de la contraseña hay valores consecutivos del mismo tipo y verificar que no haya el mismo codigo ascii 
    #print("Contraseña antes de ajustes:",contrasena)
    contrasena_modificada= inspeccion_estructural_contrasena(contrasena)    
    #print("Contraseña final generada:",contrasena_modificada)
    return contrasena_modificada

def matriz_grupo_ascii(cadena: str) -> list:
    """ 
    TIPO: 
    1 -> Mayúsculas
    2 -> Minúsculas
    3 -> Caracter especial (dentro de los símbolos permitidos)
    4 -> Numéricos

    Matriz: [tipo, código_ascii]
    """
    matriz = []

    for char in cadena:
        #Se obtiene el codigo Ascii de cada caracter y se clasifica en su grupo
        codigo_ascii = ord(char)
        if char.isupper():
            grupo = 1
        elif char.islower():
            grupo = 2
        elif char.isdigit():
            grupo = 3
        elif char in SIMBOLOS_PERMITIDOS:
            grupo = 4
        else:
            grupo = 0  # Carácter no reconocido

        matriz.append((grupo,codigo_ascii))
    #print("matriz: ", matriz)
    return matriz

def inspeccion_estructural_contrasena(cadena: str) -> str:
    """ Inspecciona la estructura de la contraseña y se asegura de no tener más de dos caracteres consecutivos del mismo grupo ASCII
        y devuelve la cadena corregida si es necesario y asegurarse de que los caracteres no se repiten ni una sola vez.

        Se usan diccionarios uno por columna, se usan los valores de la columna como claves 
        como valor el índice de la fila donde se encuentra el valor. 
        Si se encuentra el valor más de una vez, se registrará más de una posición 
        Solo se guardan los valores que tengan más de un índice (duplicados)
    """
    contrasena_lista = list(cadena)
    matriz = matriz_grupo_ascii(cadena)

    """
    TIPO: 
    1 -> Mayúsculas
    2 -> Minúsculas
    3 -> Caracter especial (dentro de los símbolos permitidos)
    4 -> Numéricos

    matriz [tipo, ascii]

    """

    #Inspección para verificar que el tipo no se repita con el elemento anterior o el siguiente
    n = len(matriz)
    for i in range(n):
        #matriz (tipo, codigo_ascii)
        actual_tipo = matriz[i][0]
        anterior_tipo = matriz[i-1][0] if i > 0 else None

        if actual_tipo == anterior_tipo:
            nuevo_tipo = actual_tipo
            
            # Generar un nuevo tipo que sea diferente al actual
            while nuevo_tipo == anterior_tipo:
                nuevo_tipo = random.randint(1, 4)
            if nuevo_tipo == 1: # Mayúscula
                nuevo_ascii = random.randint(constantes.ascii_inicio_Mayusculas, constantes.ascii_fin_Mayusculas)
            elif nuevo_tipo == 2: # Minúscula
                nuevo_ascii = random.randint(constantes.ascii_inicio_minuscula, constantes.ascii_fin_minuscula)
            elif nuevo_tipo == 3: # Símbolo
                nuevo_ascii = random.choice(constantes.SIMBOLOS_PERMITIDOS_ascii)
            elif nuevo_tipo == 4: # Número
                nuevo_ascii = random.randint(constantes.ascii_inicio_numerico, constantes.ascii_fin_numerico)
            else:
                print(f"Error: Tipo de dato no válido generado ({nuevo_tipo}) en el índice {i}")
                nuevo_ascii = matriz[i][1] # Mantener el valor viejo si hay error
                
            # Debugging
           # print(f"Corrección de Tipo en {i}: {matriz[i]} -> ({nuevo_tipo}, {nuevo_ascii})")
                
            #Actualización
            matriz[i] = (nuevo_tipo, nuevo_ascii)
            #print("matriz_nueva:" , matriz)
            contrasena_lista[i] = chr(nuevo_ascii)
            
    # print("Contraseña después de corregir tipos:", contrasena_lista)
    # print("Matriz después de corregir tipos:", matriz)

    #Asegurar que al menos haya 3 símbolos
    simbolos_actuales = sum(1 for tipo, _ in matriz if tipo ==3)
    simbolos_faltantes = 3 - simbolos_actuales

    if simbolos_faltantes > 0:
        #print(f"\nDetectados {simbolos_actuales} símbolos. Faltan {simbolos_faltantes} para el mínimo de 3.")
    
        indices_no_simbolos = [i for i, (tipo, _) in enumerate(matriz) if tipo != 3]
        
        # 3. Sortear índices a cambiar (asegurando no exceder los disponibles)
        if len(indices_no_simbolos) >= simbolos_faltantes:
            indices_a_cambiar = random.sample(indices_no_simbolos, simbolos_faltantes)
        else:
            # Si la matriz es muy pequeña, cambia todos los que no son símbolos
            indices_a_cambiar = indices_no_simbolos 

        # 4. Realizar los cambios
        for i in indices_a_cambiar:
            nuevo_tipo = 3
            
            # Generar el nuevo código ASCII 
            nuevo_ascii = random.choice(constantes.SIMBOLOS_PERMITIDOS_ascii)
            
            # Actualizar la matriz y la lista de contraseña
            # El valor anterior es: matriz[i]
            matriz[i] = (nuevo_tipo, nuevo_ascii)
            contrasena_lista[i] = chr(nuevo_ascii)


    #Corregir Códigos ASCII Duplicados 
    # Inicializa diccionarios para inspeccionar duplicados de código ASCII 
    duplicados_codigo = {}
    # El bucle debe iterar sobre la MATRIZ YA CORREGIDA
    for i, (tipo, codigo) in enumerate(matriz): # Desempaquetamos para obtener el código
        if codigo in duplicados_codigo:
            duplicados_codigo[codigo].append(i)
        else: 
            duplicados_codigo[codigo]=[i]

    # Filtrar solo los verdaderos duplicados
    duplicados_codigo = {valor: indices for valor, indices in duplicados_codigo.items() if len(indices) > 1}
    # print("Lista Duplicados de Código:", duplicados_codigo)

    # Reemplazo de códigos duplicados
    for codigo, indices in duplicados_codigo.items():
        cantidad_duplicados = len(indices)
        
        # Determinar cuántos cambiar (lógica: 2->1 cambio, 3+-> cantidad_duplicados-1)
        if cantidad_duplicados == 2:
            num_cambios = 1
        elif cantidad_duplicados >= 3:
            # Se cambia la mayoría para reducir la duplicación, dejando 1 original
            num_cambios = cantidad_duplicados - 1
            
        # Sorteo de índices a cambiar
        indices_cambiar = random.sample(indices, num_cambios)

        # Escoger randomicamente segun el tipo
        for indice in indices_cambiar:
            tipo_original = matriz[indice][0]
            valor_original = matriz[indice][1]
            
            # Inicializar nuevo_ascii para evitar UnboundLocalError
            nuevo_ascii = valor_original 
            
            # Función para generar un nuevo ASCII
            def generar_nuevo_ascii(valor_original, tipo):
                nuevo_ascii = valor_original
                
                # Bucle de re-generación (mientras esté en el rango valor_original +/- 2)
                while (nuevo_ascii >= valor_original - 2) and (nuevo_ascii <= valor_original + 2):
                    if tipo == 1: # Mayúscula
                        nuevo_ascii = random.randint(constantes.ascii_inicio_Mayusculas, constantes.ascii_fin_Mayusculas)
                    elif tipo == 2: # Minúscula
                        nuevo_ascii = random.randint(constantes.ascii_inicio_minuscula, constantes.ascii_fin_minuscula)
                    elif tipo == 3: # Símbolo
                        nuevo_ascii = random.choice(constantes.SIMBOLOS_PERMITIDOS_ascii)
                    elif tipo == 4: # Número
                        nuevo_ascii = random.randint(constantes.ascii_inicio_numerico, constantes.ascii_fin_numerico)
                    else:
                        print(f"Error: Tipo de dato no válido en reeplazo ({tipo})")
                        break # Salir del bucle while para evitar loop infinito
                return nuevo_ascii

            # Generar y asignar el nuevo código
            nuevo_ascii = generar_nuevo_ascii(valor_original, tipo_original)

            # Actualizar la matriz y la lista de contraseña
            matriz[indice] = (tipo_original, nuevo_ascii)
            contrasena_lista[indice] = chr(nuevo_ascii)

    return ''.join(contrasena_lista)

"""
#---PRUEBAS DE ENTRADA Y SALIDA DE FUNCIONES INDIVIDUAL---#
# Ejemplo de uso
nombre_archivo = 'resultado_psicologico_example.json'
plataforma = "mock_extaer de la info que manda server_analizer"
tag = procesador_numerico_password.cargar_tag_redes("redes_sociales_con_tags.json", plataforma)
print("Tag cargado para Instagram:", tag)
valores, cadena_usuario = procesador_numerico_password.cargar_valores_de_usuario(nombre_archivo)
print("valores: ",valores)
print("cadena_usuario:", cadena_usuario)
    
desplazamiento = procesador_numerico_password.calcular_desplazamiento(valores, tag, len(ALFABETO_EXTENDIDO))
print("desplazamiento: ", desplazamiento) 
cadena_cifrada, indice_generacion = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
print("len_cadena_usuario:", len(cadena_usuario))
print("Cadena cifrada:", cadena_cifrada)
print("Índice de cifrado:", indice_generacion)
semilla = procesador_numerico_password.recoger_semilla_longitud(tag, valores)
print("Semilla recogida:", semilla) 
longitud = procesador_numerico_password.generar_longitud(semilla)  # Generar una longitud aleatoria entre 8 y 64
print("Longitud generada:", longitud)
punto_inicio = procesador_numerico_password.generar_punto_inicio()
print("Punto_inicio:", punto_inicio)
contrasena = generar_contrasena(cadena_usuario, longitud, desplazamiento, punto_inicio)
print("Contraseña generada:", contrasena)

print("\n--- GENERACIÓN DE EXPONENTE Y ENCRIPTACIÓN ---")
valor_numerico_cod = procesador_numerico_eliptico.calcular_codificacion_numerica(cadena_cifrada)
print("Valor numérico de la cadena cifrada:", valor_numerico_cod)
exponente = procesador_numerico_eliptico.calcular_exponente(valores, valor_numerico_cod)
print("Exponente generado:", exponente)

llave_privada = curva_eliptica.construir_clave_privada(exponente)
print("Llave privada generada:", llave_privada)
llave_publica = llave_privada.public_key()
print("Llave pública generada:", llave_publica)
mensaje = contrasena.encode('utf-8')
print("Mensaje a encriptar (contraseña):", mensaje)
mensaje_encriptado = curva_eliptica.ecc_encriptar_password(llave_publica, mensaje)
print("Mensaje encriptado (bytes):", mensaje_encriptado)

curva_eliptica.guardar_en_json("12345", mensaje_encriptado, "passwords.json", plataforma)
print("Mensaje encriptado guardado en 'passwords.json'")

# Verificar desencriptado
recuperado = curva_eliptica.ecc_desencriptar_password(llave_privada, mensaje_encriptado)
print("Mensaje desencriptado:", recuperado)

"""