import psutil
import csv
import datetime

def monitorear_proceso(proc, archivo_log, evento_fin, resumen_final):
    """Monitorea el uso de CPU y RAM del proceso y lo guarda en un CSV."""
    with open(archivo_log, mode='w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['Timestamp', 'CPU (%)', 'RAM usada (MB)'])
        print(f"Monitoreando este proceso (PID {proc.pid}). Log en: {archivo_log}")

        while not evento_fin.is_set():
            try:
                cpu = proc.cpu_percent(interval=1)
                ram = proc.memory_info().rss / (1024 ** 2)
                timestamp = datetime.datetime.now().strftime("%H:%M:%S")
                
                writer.writerow([timestamp, cpu, f"{ram:.2f}"])
                resumen_final.append((timestamp, cpu, ram))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                print("El proceso finalizó o el acceso fue denegado.")
                break