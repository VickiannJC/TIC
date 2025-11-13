import json 
from generator import generar_contrasena
import os
import preprocesador_texto
import procesador_numerico_password
import constantes

alfabeto_extendido = constantes.ALFABETO_EXTENDIDO
longitud_minima = constantes.longitud_minima
longitud_maxima = constantes.longitud_maxima
simbolos_permitidos = constantes.SIMBOLOS_PERMITIDOS

input_json = 'resultado_palabras_sensible.json'
output_contrasena_texto = 'contrasenas_evaluacion.txt'
plataforma = "Instagram"

def main():
    print("Inicio de la evaluación de la clave privada masiva...")
    # Borrar el archivo binario si existe para asegurar un inicio limpio
    if os.path.exists(output_contrasena_texto):
        os.remove(output_contrasena_texto)
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
            semilla = procesador_numerico_password.recoger_semilla_longitud(tag, valores)
            longitud = procesador_numerico_password.generar_longitud(semilla)  # Generar una longitud aleatoria entre 8 y 64
            punto_inicio = procesador_numerico_password.generar_punto_inicio()
            contrasena = generar_contrasena(cadena_usuario, longitud, desplazamiento, punto_inicio)
            
            
            with open(output_contrasena_texto, 'a') as archivo_texto:
                archivo_texto.write(contrasena + '\n')
        print("Evaluación completada. Claves privadas almacenadas en el archivo de texto.")
    except Exception as e:
        print(f"Error durante la evaluación masiva: {e}")

if __name__ == "__main__":
    main()