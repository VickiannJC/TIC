import psutil
import time
import csv
import datetime
import os
import json
import uuid
from threading import Thread, Event
from typing import List, Dict, Any
import monitorear_proceso
import tensorflow.lite as tflite
import numpy as np
import pandas as pd
import guardar_analisis
import seguridad

# --- Constantes ---
RESPUESTAS_JSON = "resultado_palabras_sensible.json"
INPUT_CSV_FILE = "Simulacion_prueba_respuestas_psy.csv"
MODEL_PATH = 'bfi10_mode_sensiblel.tflite'

class PsychologicalAnalyzer:
    def __init__(self, model_path=MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"El archivo del modelo '{model_path}' no se encuentra.")
        
        try:
            self.interpreter = tflite.Interpreter(model_path=model_path)
        except Exception as e:
            raise RuntimeError(f"Error al cargar el modelo TFLite: {e}")
        self.interpreter.allocate_tensors()
        self.input_details = self.interpreter.get_input_details()
        self.output_details = self.interpreter.get_output_details()

        #Lógica de Generación de Texto
        self.keyword_map = {
            'Extraversion': ['Sociabilidad', 'Asertividad', 'Energía', 'Entusiasmo', 'Dominancia', 'Búsqueda de emociones', 'Gregarismo', 'Habilidad social', 'Comunicación', 'Liderazgo', 'Optimismo', 'Visibilidad', 'Audacia', 'Espontaneidad', 'Vivacidad'],
            'Agreeableness': ['Empatía', 'Confianza', 'Altruismo', 'Cooperación', 'Modestia', 'Sensibilidad', 'Conciliación', 'Tolerancia', 'Cordialidad', 'Compasión', 'Generosidad', 'Paciencia', 'Respeto', 'Sinceridad', 'Humildad'],
            'Conscientiousness': ['Disciplina', 'Organización', 'Fiabilidad', 'Eficiencia', 'Perseverancia', 'Planificación', 'Sentido del deber', 'Autocontrol', 'Puntualidad', 'Meticulosidad', 'Prudencia', 'Responsabilidad', 'Laboriosidad', 'Precisión', 'Orden'],
            'Neuroticism': ['Ansiedad', 'Vulnerabilidad', 'Inseguridad', 'Preocupación', 'Ira', 'Depresión', 'Timidez', 'Impulsividad', 'Sensibilidad al estrés', 'Pesimismo', 'Reactividad emocional', 'Tensión', 'Irritabilidad', 'Melancolía', 'Inestabilidad'],
            'Openness': ['Imaginación', 'Curiosidad', 'Creatividad', 'Intelecto', 'Originalidad', 'Apertura a ideas', 'Intereses artísticos', 'Apertura a emociones', 'Complejidad cognitiva', 'Independencia de juicio', 'Flexibilidad', 'Innovación', 'Profundidad', 'Experimentación', 'No convencionalismo']
        }
        self.trait_translation = {
            'Extraversion': 'Extraversión', 'Agreeableness': 'Amabilidad',
            'Conscientiousness': 'Responsabilidad', 'Neuroticism': 'Neuroticismo',
            'Openness': 'Apertura'
        }

    def _get_advanced_description(self, scores_df):
        """
        Genera la descripción psicológica para el usuario
        """
        row = scores_df.iloc[0]
        descriptions_list = []
        thresholds = {
            (4.5, 5.0): "Alto en", (3.8, 4.49): "Moderadamente alto en",
            (2.6, 3.79): "Moderado en", (1.8, 2.59): "Moderadamente bajo en",
            (1.0, 1.79): "Bajo en"
        }
        for trait, score in row.items():
            for (low, high), prefix in thresholds.items():
                # Comparación del puntaje con el umbral establecido
                if low <= score <= high:
                    word = np.random.choice(self.keyword_map[trait])
                    descriptions_list.append(f"{prefix} {word}")
                    break
        #Identificación de rasgo dominante y área de contraste
        highest_trait = row.idxmax()
        lowest_trait = row.idxmin()
        highest_word = np.random.choice(self.keyword_map[highest_trait])
        lowest_word = np.random.choice(self.keyword_map[lowest_trait])
        descriptions_list.append(f"Rasgo dominante: {self.trait_translation[highest_trait]} ({highest_word})")
        descriptions_list.append(f"Área de contraste: {self.trait_translation[lowest_trait]} ({lowest_word})")
        
        # Devuelve tanto la cadena de texto unida como la lista de frases
        return ", ".join(descriptions_list), descriptions_list

    def analyze(self, user_answers):
        # Realiza el análisis psicológico basado en las respuestas del usuario
        if len(user_answers) != 10:
            return {"error": "Se requiere un arreglo de exactamente 10 respuestas."}

        #Preparación de datos de entrada
        #Los datos ingresados son numeros del 1 al 5 -> no se necesita normalización
        input_data = np.array([user_answers], dtype=np.float32)
        #64 neuronas de entrada -> 32 neuronas ocultas -> 5 salidas
        #Carga del modelo
        self.interpreter.set_tensor(self.input_details[0]['index'], input_data)
        #Ejecutar inferencia
        self.interpreter.invoke()
        # Obtener resultados
        output_data = self.interpreter.get_tensor(self.output_details[0]['index'])
        
        # Escalar resultados a rango 1-5
        predicted_scores = output_data[0] 
        predicted_scores = np.clip(predicted_scores, 1.0, 5.0)
        
        trait_names = ['Extraversion', 'Agreeableness', 'Conscientiousness', 'Neuroticism', 'Openness']
        scores_df = pd.DataFrame([predicted_scores], columns=trait_names)

        # Recibe ambos valores desde la función de descripción
        final_description_str, final_description_list = self._get_advanced_description(scores_df)

        usuario_id = seguridad.generar_id_usuario()[0]  # Generar ID de usuario seguro
        
        return {
            "id_usuario": usuario_id,
            "predicted_scores": {name: float(score) for name, score in zip(trait_names, predicted_scores)},
            "unique_profile_description": final_description_str,
            #"descriptive_words": final_description_list # Nueva clave con la lista de palabras
        }
"""
def obtener_respuestas_dinamicamente():
    respuestas = []
    print("--- Cuestionario de Personalidad BFI-10 ---")
    print("Por favor, responda a las siguientes 10 preguntas con un número del 1 al 5.")
    print("(1 = Muy en desacuerdo, 5 = Muy de acuerdo)\n")
    for i in range(1, 11):
        while True:
            try:
                prompt = f"Respuesta a la pregunta {i}/10: "
                respuesta_str = input(prompt)
                respuesta_num = int(respuesta_str)
                if 1 <= respuesta_num <= 5:
                    respuestas.append(respuesta_num)
                    break
                else:
                    print("Error: El número debe estar entre 1 y 5. Inténtelo de nuevo.")
            except ValueError:
                print("Error: Entrada no válida. Por favor, ingrese solo un número.")
    return respuestas
""" 


def main():
    print(f"\n{'='*60}")
    print("INICIO DEL ANÁLISIS PSICOLÓGICO MASIVO (Lectura Fila por Fila)")
    print(f"Fuente de datos: {INPUT_CSV_FILE}")
    print(f"Salida de resultados: {RESPUESTAS_JSON}")
    print(f"{'='*60}")


    analyzer = PsychologicalAnalyzer()

    
    primer_elemento = True # Controla la escritura de la coma en JSON
    elementos_procesados = 0
    
    try:
        # ABRIR AMBOS ARCHIVOS (CSV para lectura y JSON para escritura)
        with open(INPUT_CSV_FILE, 'r', newline='', encoding='utf-8') as csvfile, \
             open(RESPUESTAS_JSON, 'w', encoding='utf-8') as json_output:
            
            reader = csv.reader(csvfile)
            
            # Omitir el encabezado si existe 
            try:
                next(reader) 
                print("Se omitió la primera fila (encabezados) del CSV.")
            except StopIteration:
                print("El archivo CSV está vacío. Finalizando.")
                return

            # Escribir el corchete de apertura para iniciar el array JSON
            json_output.write("[\n") 
            
            print("\nComenzando análisis. Procesando fila por fila...")
            
            # BUCLE DE LECTURA Y PROCESAMIENTO FILA POR FILA
            for i, row in enumerate(reader):
                usuario_id = str(uuid.uuid4())
                fila_csv_idx = i + 2 # Índice de la fila en el CSV (contando el encabezado en 1)

                try:
                    # 1. LEER LA FILA Y CONVERTIR A RESPUESTAS ENTERAS
                    respuestas_usuario = [int(r.strip()) for r in row if r.strip()]
                    
                    if not respuestas_usuario:
                        print(f"Fila {fila_csv_idx} omitida: Respuestas vacías o no válidas.")
                        continue # Pasar a la siguiente fila
                        
                    
                    # 2. REALIZAR EL ANÁLISIS
                    result = analyzer.analyze(respuestas_usuario)
                    start_time_global = time.time()
                    
                    
                    # 3. AÑADIR METADATOS
                    result['id_usuario'] = usuario_id
                
                    
                    # 4. ESCRITURA PASO A PASO AL ARCHIVO JSON
                    if not primer_elemento:
                        json_output.write(",\n")
                    
                    json.dump(result, json_output, ensure_ascii=False, indent=4)
                    
                    primer_elemento = False
                    elementos_procesados += 1
                    
                    # Reporte de progreso
                    if elementos_procesados % 100 == 0:
                         print(f" Progreso: {elementos_procesados} usuarios procesados. Última fila: {fila_csv_idx}")
                    
                except ValueError:
                    print(f"Error de formato en la Fila {fila_csv_idx}: Las respuestas deben ser números enteros. Fila omitida.")
                except Exception as e:
                    print(f"Error al analizar el usuario (Fila {fila_csv_idx}, ID {usuario_id[:8]}...): {e}")

            # 5. ESCRIBIR EL CORCHETE DE CIERRE ']'
            json_output.write("\n]") # Cierra el array JSON

    except FileNotFoundError:
        print(f" Error: Archivo de entrada '{INPUT_CSV_FILE}' no encontrado. Finalizando.")
        elementos_procesados = 0 # No se procesó nada si el archivo no existe.
    except Exception as e:
        print(f" Error crítico: {e}")
        
    finally:
        end_time_global = time.time()
        total_duration = end_time_global - start_time_global if 'start_time_global' in locals() else 0


        # Imprimir resumen final
        print("\n" + "="*60)
        print(" PROCESAMIENTO FINALIZADO ".center(60, "="))
        print("="*60)
        print(f" Usuarios analizados y escritos: {elementos_procesados}")
        print(f" Tiempo total de procesamiento: {total_duration:.2f} segundos")
        print(f" Archivo JSON completado: {RESPUESTAS_JSON}")
        print("-" * 60)
        
        

if __name__ == "__main__":
    main()
"""
#************INPUT DINÁMICO PARA CONSOLA******************
def main():
    proc = psutil.Process(os.getpid())
    archivo_log = f"log_proceso_{proc.pid}.csv"
    
    evento_fin = Event()
    resumen_final = []

    monitor_thread = Thread(target=monitorear_proceso.monitorear_proceso, args=(proc, archivo_log, evento_fin, resumen_final))
    monitor_thread.start()

    result = {}
    try:
        start_time = time.time()
        
        analyzer = PsychologicalAnalyzer()

        # --- MODIFICACIÓN: Se establece un input fijo ---
        # La siguiente línea se comenta para desactivar la entrada dinámica
        # respuestas_usuario = obtener_respuestas_dinamicamente()
        
        # Se define una lista fija para pruebas rápidas
        respuestas_usuario = [5, 5, 4, 3, 1, 3, 1, 1, 5, 4]
        print(f"--- Usando input fijo para el análisis: {respuestas_usuario} ---")
        # --- FIN DE LA MODIFICACIÓN ---

        print("\nAnalizando sus respuestas...")
        result = analyzer.analyze(respuestas_usuario)
        
        end_time = time.time()
        duration = end_time - start_time
        
        result['processing_time_seconds'] = round(duration, 2)
        
        # Guardar únicamente la lista de palabras en el archivo JSON
        if 'descriptive_words' in result:
            guardar_analisis.guardar_palabras(result['descriptive_words'], RESPUESTAS_JSON)

    except Exception as e:
        print(f"\nOcurrió un error durante la ejecución: {e}")
    finally:
        evento_fin.set()
        monitor_thread.join()

    print("\n" + "="*40)
    print(" ANÁLISIS COMPLETADO ".center(40, "="))
    print("="*40)

    if result:
        print("\n--- Resultados del Análisis Psicológico ---")
        print(f"  Puntajes Numéricos Predichos: {result.get('predicted_scores', 'N/A')}")
        print(f"  Descripción del Perfil Generada: {result.get('unique_profile_description', 'N/A')}")
        print(f"  Tiempo de procesamiento: {result.get('processing_time_seconds', 'N/A')}s")
        print("-----------------------------------------")
    
    if resumen_final:
        print("\n--- Resumen del Monitoreo de Rendimiento ---")
        for t, cpu, ram in resumen_final:
            print(f"  [{t}] CPU: {cpu:.1f}%, RAM: {ram:.2f} MB")
        print("--------------------------------------------")
    print("\nFin del programa.")

if __name__ == "__main__":
    main()

"""