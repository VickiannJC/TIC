import json 
from cryptography.hazmat.primitives import serialization
import cryptography.hazmat.primitives.asymmetric as ec
import os
import curva_eliptica
import preprocesador_texto
import procesador_numerico_password
import procesador_numerico_eliptico
import constantes

alfabeto_extendido = constantes.ALFABETO_EXTENDIDO
longitud_minima = constantes.longitud_minima
longitud_maxima = constantes.longitud_maxima
simbolos_permitidos = constantes.SIMBOLOS_PERMITIDOS

input_json = 'resultado_palabras_sensible.json'
output_claves_binario = 'claves_privadas_sensibles_hash_phi_evaluacion.bin'
plataforma = "Instagram"

def main():
    print("Inicio de la evaluación de la clave privada masiva...")
    # Borrar el archivo binario si existe para asegurar un inicio limpio
    if os.path.exists(output_claves_binario):
        os.remove(output_claves_binario)
    try:
        with open(input_json, 'r', encoding='utf-8') as archivo:
            datos_usuarios = json.load(archivo)
        for usuario in datos_usuarios:
            cadena_usuario = usuario.get('unique_profile_description', '')
            id_usuario = usuario.get('id_usuario', '')
            scores = usuario.get("predicted_scores", {})
            valores = list(scores.values())
            if valores is None:
                print(f"Advertencia: No se encontraron valores para el usuario ID {id_usuario}. Se omite este usuario.")
                continue
            tag = procesador_numerico_password.cargar_tag_redes("redes_sociales_con_tags.json", plataforma)
            desplazamiento = procesador_numerico_password.calcular_desplazamiento(valores, tag, len(alfabeto_extendido))
            cadena_cifrada, indice_generacion = preprocesador_texto.preprocesador_cadena(cadena_usuario, desplazamiento)
            valor_numerico_cod = procesador_numerico_eliptico.calcular_codificacion_numerica(cadena_cifrada)
            exponente = procesador_numerico_eliptico.calcular_exponente(valores, valor_numerico_cod)
            #llave_privada = curva_eliptica.construir_clave_privada(exponente)
            llave_privada_bytes = exponente.to_bytes(256, byteorder='big')#BigEndian
            with open(output_claves_binario, 'ab') as archivo_binario:
                archivo_binario.write(llave_privada_bytes)
        print("Evaluación completada. Claves privadas almacenadas en el archivo binario.")
    except Exception as e:
        print(f"Error durante la evaluación masiva: {e}")

if __name__ == "__main__":
    main()