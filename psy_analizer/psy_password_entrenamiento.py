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

# Verificación de version
print(f"Ejecutando en TensorFlow versión: {tf.__version__}")
if not tf.__version__.startswith('2.10'):
    print("ADVERTENCIA: Se recomienda instalar tensorflow==2.10.1 para máxima compatibilidad.")

# ==========================================
# CONFIGURACIÓN Y CARGA DE DATOS
# ==========================================
FILE_PATH = "bfi10_datos_sinteticos_alta_sensibilidad_forzada.csv"
MODELO_H5_PATH = 'best_model_local.h5' 
MODELO_TFLITE_PATH = 'model_tf210_high_fidelity.tflite'


# Carga de datos
try:
    if not os.path.exists(FILE_PATH):
        raise FileNotFoundError
    df_data = pd.read_csv(FILE_PATH)
    print(f"Datos cargados exitosamente desde {FILE_PATH}")
except FileNotFoundError:
    print("Archivo no encontrado. ...")

    
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
# ARQUITECTURA 
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
# ENTRENAMIENTO DINÁMICO
# ==========================================
print("\n--- INICIANDO ENTRENAMIENTO ---")

#  Espera 40 épocas sin mejora antes de detenerse
early_stopping = EarlyStopping(
    monitor='val_loss', 
    patience=40, 
    restore_best_weights=True,
    verbose=1
)

# Guarda el mejor modelo en formato H5
model_checkpoint = ModelCheckpoint(
    MODELO_H5_PATH, 
    monitor='val_loss', 
    save_best_only=True, 
    mode='min', 
    verbose=0
)

# Reduce el LR si se estanca para afinar la precisión
lr_scheduler = ReduceLROnPlateau(
    monitor='val_loss', factor=0.5, patience=10, min_lr=1e-6, verbose=1
)

# Entrenamiento
history = model.fit(
    X_train, y_train,
    epochs=1000, # Máximo 1000 épocas
    batch_size=32,
    validation_data=(X_val, y_val),
    callbacks=[early_stopping, model_checkpoint, lr_scheduler],
    verbose=1 # 1 para ver el progreso en consola local
)

# ==========================================
#  EVALUACIÓN
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
# CONVERSIÓN A TFLITE 
# ==========================================
print("\n--- CONVIRTIENDO A TFLITE ---")

try:
    # Cargar el mejor modelo guardado (.h5)
    best_model = load_model(MODELO_H5_PATH)
    
    # onfigurar el convertidor
    converter = tf.lite.TFLiteConverter.from_keras_model(best_model)
    
    # Compatibilidad
    # Usar ops estándar asegura que funcione en cualquier intérprete TF 2.x
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    
    # optimización
    converter.optimizations = [tf.lite.Optimize.DEFAULT] 
    
    tflite_model = converter.convert()

    # Guardar
    with open(MODELO_TFLITE_PATH, 'wb') as f:
        f.write(tflite_model)
        
    file_size = os.path.getsize(MODELO_TFLITE_PATH) / 1024
    print(f"Modelo guardado exitosamente: {MODELO_TFLITE_PATH}")
    print(f"Tamaño del archivo: {file_size:.2f} KB")
    print("NOTA: Modelo en precisión Float32 (Alta Fidelidad).")

except Exception as e:
    print(f"ERROR en la conversión: {e}")

# ==========================================
#  PRUEBA RÁPIDA PARA VISUALIZAR RESULTADOS
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