import os
import curva_eliptica
import preprocesador_texto
import string
import random
import procesador_numerico_password
import procesador_numerico_eliptico
import json

longitud_minima = 10
longitud_maxima = 16
SIMBOLOS_PERMITIDOS = "!@#$%^&*_+-=:;\.?/|"
ALFABETO_EXTENDIDO = string.ascii_letters + "Ññ" + string.digits + SIMBOLOS_PERMITIDOS
 
numero_simbolos = len(SIMBOLOS_PERMITIDOS)


# cadena_usuario => cadena de descripcion del usuario
# longitud => longitud de la contraseña a generar
# desplazamiento => valor del desplazamiento para el cifrado Cesar
# punto_inicio => punto de inicio para la selección de la contraseña en la cadena cifrada

def generar_contrasena(cadena_usuario, longitud, desplazamiento, punto_inicio):
    # Validar la longitud de la cadena de usuario
    if not (longitud_minima <= longitud <= longitud_maxima):
        raise ValueError(f"La longitud para la generación de la contraseña no está dentro de los límites permitidos ({longitud_minima}-{longitud_maxima}).")
    # Generar la contraseña cifrada usando el preprocesador
    cadena_cifrada, indice_cifrado = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
    # Validar el punto de inicio
    if punto_inicio < 0 or punto_inicio + longitud > len(cadena_cifrada):
        raise ValueError("El punto de inicio y la longitud especificados no son válidos para la cadena cifrada.")

    # Generar la contraseña a partir de la cadena cifrada
    # Extraer la subcadena desde el punto de inicio con la longitud especificada
    contrasena_cifrada = cadena_cifrada[punto_inicio:punto_inicio + longitud]
    contrasena_cifrada = list(contrasena_cifrada)  # Convertir a lista para facilitar modificaciones

    # Asegurarse de que la contraseña contiene al menos un dígito y un símbolo permitido
    # se establece un máximo de dos reemplazos para evitar bucles infinitos
    num_reemplazos = 2
    while (not any(char in SIMBOLOS_PERMITIDOS for char in contrasena_cifrada) or
           not any(char.isdigit() for char in contrasena_cifrada) or    
           not any(char.isupper() for char in contrasena_cifrada)):
        
        
        if not any(char in SIMBOLOS_PERMITIDOS for char in contrasena_cifrada):
            
            for i in range(num_reemplazos):
                indice_reemplazo = (indice_cifrado % longitud + i) % longitud 
                #indice_cifrado se usa para variar la posición de reemplazo en cada iteración
                contrasena_cifrada[indice_reemplazo] = SIMBOLOS_PERMITIDOS[(indice_cifrado + i) % numero_simbolos]
        if not any(char.isdigit() for char in contrasena_cifrada):
            for i in range(num_reemplazos):
                indice_reemplazo = (indice_cifrado % longitud + i + num_reemplazos + 1) % longitud
                contrasena_cifrada[indice_reemplazo] = string.digits[(indice_cifrado + i) % 10]
        if not any(char.isupper() for char in contrasena_cifrada):
            for i in range(num_reemplazos):
                indice_reemplazo = (indice_cifrado % longitud + i + 2 * (num_reemplazos + 1)) % longitud
                contrasena_cifrada[indice_reemplazo] = string.ascii_uppercase[(indice_cifrado + i) % 26]
        indice_cifrado += 1 % longitud  # Evitar bucle infinito incrementando el índice 

    contrasena_cifrada = ''.join(contrasena_cifrada)  # Convertir de nuevo a cadena

    return contrasena_cifrada




# Ejemplo de uso
nombre_archivo = 'resultado_psicologico_example.json'
cadena_usuario = preprocesador_texto.frase_usuario
plataforma = "Instagram"
print("Cadena de usuario:", cadena_usuario)
tag = procesador_numerico_password.cargar_tag_redes("redes_sociales_con_tags.json", plataforma)
print("Tag cargado para Instagram:", tag)
valores = procesador_numerico_password.cargar_valores_de_usuario(nombre_archivo)
if valores is not None:
    print("Valores extraídos:", valores)
desplazamiento = procesador_numerico_password.calcular_desplazamiento(valores, tag, len(ALFABETO_EXTENDIDO))
print("desplazamiento: ", desplazamiento) 
cadena_cifrada, indice_generacion = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
print("Cadena cifrada:", cadena_cifrada)
print("Índice de cifrado:", indice_generacion)
semilla = procesador_numerico_password.recoger_semilla_longitud(tag, valores)
print("Semilla recogida:", semilla) 
longitud = procesador_numerico_password.generar_longitud(semilla)  # Generar una longitud aleatoria entre 8 y 64
print("Longitud generada:", longitud)
punto_inicio = 5
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