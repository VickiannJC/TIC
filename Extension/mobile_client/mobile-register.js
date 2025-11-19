/**
 * Script para registrar el Service Worker y la Suscripción Push del móvil
 * y enviarla al servidor Node.js.
 */
// URL base de tu servidor Node.js
const SERVER_BASE_URL = 'http://localhost:3000'; 

document.addEventListener('DOMContentLoaded', async () => { 
    // Elementos del DOM
    const statusEl = document.getElementById('status');
    const statusMessage = document.getElementById('statusMessage');
    const resultEl = document.getElementById('result');
    const resultTitle = document.getElementById('resultTitle');
    const resultMessage = document.getElementById('resultMessage');
    const resultIcon = document.getElementById('resultIcon');
    const closeBtn = document.getElementById('closeBtn');
    
    // Obtener sessionId de la URL
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('sessionId');
    
    if (!sessionId) {
        showError('Error: No se encontró código de sesión en la URL');
        return;
    }
    
    // Iniciar proceso de vinculación
    statusMessage.textContent = 'Iniciando proceso de vinculación...';
    
    try {
        // 1. Verificar compatibilidad
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            throw new Error('Tu navegador no soporta Service Workers o Notificaciones Push');
        }
        
        // 2. Registrar Service Worker -> archivo sw.js
        statusMessage.textContent = 'Registrando Service Worker...';
        // NOTA: El path debe ser relativo a la raíz del cliente móvil
        const registration = await navigator.serviceWorker.register(`${location.origin}/mobile_client/sw.js`);

        
        // 3. Solicitar permisos para recibir las notificaciones push 
        statusMessage.textContent = 'Solicitando permisos...';
        const permission = await Notification.requestPermission();
        
        if (permission !== 'granted') {
            throw new Error('Permisos para notificaciones no concedidos');
        }
        
        //Obtener clave VAPID pública:
        const VAPID_KEY = 'BHp2vU13C4v9lkA3TiCeDjdrTKx-pjOJKU9danM81efQiPD_6udB7w42xt6DZnz2bAjgf8mdjz-d_Qv7ePkVDOM'; 

        //Suscribir a notificaciones push
        statusMessage.textContent = 'Generando suscripción push...';
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_KEY)
        });
        
        // 6. Enviar suscripción al servidor (Endpoint crucial)
        statusMessage.textContent = 'Vinculando dispositivo...';
        const response = await fetch(`${SERVER_BASE_URL}/register-mobile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, subscription })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Error en el servidor durante la vinculación');
        }
        
        // 7. Mostrar éxito
        showSuccess('¡Dispositivo vinculado correctamente! El servidor enviará una notificación de prueba.');
        
        // Cerrar automáticamente después de 5 segundos (o redirigir)
        setTimeout(() => {
            // window.close();
        }, 5000);
        
    } catch (error) {
        console.error('Error en el proceso de vinculación:', error);
        showError(`Error: ${error.message}`);
    }
    
    // Configurar botón de cierre
    closeBtn.addEventListener('click', () => {
        window.close();
    });
    
    // Función para mostrar éxito
    function showSuccess(message) {
        statusEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
        resultEl.classList.add('success');
        resultTitle.textContent = '¡Vinculación Exitosa!';
        resultMessage.textContent = message;
        resultIcon.innerHTML = '<span>✓</span>';
    }
    
    // Función para mostrar error
    function showError(message) {
        statusEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
        resultEl.classList.add('error');
        resultTitle.textContent = 'Error en Vinculación';
        resultMessage.textContent = message;
        resultIcon.innerHTML = '<span>✗</span>';
    }
    
    // Función para convertir clave VAPID
    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
});