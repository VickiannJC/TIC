import os
import pandas as pd
import numpy as np
import tensorflow as tf
import matplotlib.pyplot as plt
from sklearn.model_selection import train_test_split
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import Dense, Input, BatchNormalization, Dropout
from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint, ReduceLROnPlateau
from tensorflow.keras.optimizers import Adam

# Verificación de seguridad
print(f"Ejecutando en TensorFlow versión: {tf.__version__}")
if not tf.__version__.startswith('2.10'):
    print("ADVERTENCIA: Se recomienda instalar tensorflow==2.10.1 para máxima compatibilidad.")

# ==========================================
# 1. CONFIGURACIÓN Y CARGA DE DATOS
# ==========================================
FILE_PATH = "bfi10_datos_sinteticos_alta_sensibilidad_forzada.csv"
MODELO_H5_PATH = 'best_model_local.h5' 
MODELO_TFLITE_PATH = 'model_tf210_high_fidelity.tflite'

# Opcional: Semillas para repetibilidad (Descomenta si lo deseas)
# np.random.seed(42)
# tf.random.set_seed(42)

# Carga de datos o Generación Sintética
try:
    if not os.path.exists(FILE_PATH):
        raise FileNotFoundError
    df_data = pd.read_csv(FILE_PATH)
    print(f"Datos cargados exitosamente desde {FILE_PATH}")
except FileNotFoundError:
    print("Archivo no encontrado. Generando datos sintéticos para demostración...")
    n_samples = 2000 
    X_sim = np.random.randint(1, 6, size=(n_samples, 10))
    # Relación compleja simulada
    weights1 = np.random.rand(10, 20)
    weights2 = np.random.rand(20, 5)
    hidden = np.tanh(np.dot(X_sim, weights1)) 
    y_sim = np.dot(hidden, weights2) + np.random.normal(0, 0.2, size=(n_samples, 5))
    
    cols_input = [f'Q{i}' for i in range(1, 11)]
    cols_output = ['Extraversion', 'Agreeableness', 'Conscientiousness', 'Neuroticism', 'Openness']
    df_data = pd.DataFrame(np.hstack((X_sim, y_sim)), columns=cols_input + cols_output)

# Preprocesamiento
input_cols = [f'Q{i}' for i in range(1, 11)]
output_cols = ['Extraversion', 'Agreeableness', 'Conscientiousness', 'Neuroticism', 'Openness']

# Float32 es esencial para TFLite
X_data = df_data[input_cols].values.astype('float32') 
y_data = df_data[output_cols].values.astype('float32')
N_FEATURES = X_data.shape[1]
N_TARGETS = y_data.shape[1]

# Split
X_train, X_temp, y_train, y_temp = train_test_split(X_data, y_data, test_size=0.2)
X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5)

# ==========================================
# 2. ARQUITECTURA DE ALTO RENDIMIENTO
# ==========================================
def build_model():
    model = Sequential([
        Input(shape=(N_FEATURES,), name='input_layer'),
        
        # Capa densa grande con regularización
        Dense(128, name='dense_1'),
        BatchNormalization(), 
        tf.keras.layers.Activation('relu'),
        Dropout(0.3), 
        
        # Capa media
        Dense(64, name='dense_2'),
        BatchNormalization(),
        tf.keras.layers.Activation('relu'),
        Dropout(0.2),
        
        # Capa de refinamiento
        Dense(32, activation='relu', name='dense_3'),
        
        # Salida
        Dense(N_TARGETS, name='output_layer') 
    ])
    
    # LR inicial alto para escapar de mínimos locales rápido al inicio
    model.compile(optimizer=Adam(learning_rate=0.005), loss='mse', metrics=['mae'])
    return model

model = build_model()

# ==========================================
# 3. ENTRENAMIENTO DINÁMICO
# ==========================================
print("\n--- INICIANDO ENTRENAMIENTO ---")

# A. EarlyStopping: Espera 40 épocas sin mejora antes de detenerse
early_stopping = EarlyStopping(
    monitor='val_loss', 
    patience=40, 
    restore_best_weights=True,
    verbose=1
)

# B. Checkpoint: Guarda solo el mejor modelo en formato H5
# Nota: En TF 2.10 local, no usamos save_format='h5' explícito en el constructor
# si el archivo ya termina en .h5, Keras lo detecta solo.
model_checkpoint = ModelCheckpoint(
    MODELO_H5_PATH, 
    monitor='val_loss', 
    save_best_only=True, 
    mode='min', 
    verbose=0
)

# C. Scheduler: Reduce el LR si se estanca para afinar la precisión
lr_scheduler = ReduceLROnPlateau(
    monitor='val_loss', factor=0.5, patience=10, min_lr=1e-6, verbose=1
)

# Entrenamiento
history = model.fit(
    X_train, y_train,
    epochs=1000, # Techo alto, mandan los callbacks
    batch_size=32,
    validation_data=(X_val, y_val),
    callbacks=[early_stopping, model_checkpoint, lr_scheduler],
    verbose=1 # Ponemos 1 para ver el progreso en consola local
)

# ==========================================
# 4. EVALUACIÓN
# ==========================================
loss, mae = model.evaluate(X_test, y_test, verbose=0)
print(f"\n>>> RESULTADOS FINALES <<<")
print(f"MAE en Test: {mae:.5f}")

# Guardar gráfica
plt.figure(figsize=(10, 6))
plt.plot(history.history['loss'], label='Loss Train')
plt.plot(history.history['val_loss'], label='Loss Val')
plt.title(f'Entrenamiento Local (MAE: {mae:.4f})')
plt.legend()
plt.grid(True)
plt.savefig('training_plot.png')
print("Gráfica guardada como 'training_plot.png'")

# ==========================================
# 5. CONVERSIÓN A TFLITE (ALTA FIDELIDAD)
# ==========================================
print("\n--- CONVIRTIENDO A TFLITE ---")

try:
    # 1. Cargar el mejor modelo guardado (.h5)
    best_model = load_model(MODELO_H5_PATH)
    
    # 2. Configurar el convertidor
    converter = tf.lite.TFLiteConverter.from_keras_model(best_model)
    
    # 3. Compatibilidad
    # Usar ops estándar asegura que funcione en cualquier intérprete TF 2.x
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    
    # 4. ¿OPTIMIZACIÓN?
    # Para MÁXIMO RENDIMIENTO (Precisión), dejamos esto COMENTADO.
    # Esto mantiene los pesos en Float32 (más pesado, pero matemáticamente exacto).
    # Si necesitas reducir tamaño, descomenta la siguiente línea:
    converter.optimizations = [tf.lite.Optimize.DEFAULT] 
    
    tflite_model = converter.convert()

    # 5. Guardar
    with open(MODELO_TFLITE_PATH, 'wb') as f:
        f.write(tflite_model)
        
    file_size = os.path.getsize(MODELO_TFLITE_PATH) / 1024
    print(f"Modelo guardado exitosamente: {MODELO_TFLITE_PATH}")
    print(f"Tamaño del archivo: {file_size:.2f} KB")
    print("NOTA: Modelo en precisión Float32 (Alta Fidelidad).")

except Exception as e:
    print(f"ERROR en la conversión: {e}")

# ==========================================
# 6. PRUEBA RÁPIDA DE INFERENCIA
# ==========================================
try:
    interpreter = tf.lite.Interpreter(model_path=MODELO_TFLITE_PATH)
    interpreter.allocate_tensors()
    
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    
    # Prueba con un dato real del test set
    sample_input = X_test[0:1]
    interpreter.set_tensor(input_details[0]['index'], sample_input)
    interpreter.invoke()
    tflite_out = interpreter.get_tensor(output_details[0]['index'])
    
    print(f"\n--- PRUEBA TÉCNICA ---")
    print(f"Input shape: {sample_input.shape}")
    print(f"Output TFLite: {tflite_out[0]}")
    print("El modelo funciona correctamente.")
except Exception as e:
    print(f"Error en la prueba de inferencia: {e}")