// URL base de tu servidor Node.js (necesario para las acciones de confirmación)
const SERVER_BASE_URL = 'http://localhost:3000'; 

self.addEventListener('push', (event) => {
    // Intenta parsear los datos de la notificación
    const data = event.data ? event.data.json() : {}; 
    
    const title = data.title || 'Solicitud de Acción';
    const actionType = data.actionType || 'auth'; // 'register' o 'auth'
    const challengeId = data.sessionId; // El ID del desafío/sesión enviado por el servidor

    const options = {
        body: data.body || 'Se requiere su confirmación para continuar.',
        icon: 'icon.png', // Reemplazar con una ruta válida
        vibrate: [100, 50, 100],
        data: {
            actionType: actionType,
            challengeId: challengeId
        },
        actions: [
            { action: 'confirm', title: actionType === 'register' ? 'Registrar' : 'Autenticar', icon: 'check.png' },
            { action: 'deny', title: 'Rechazar', icon: 'cancel.png' }
        ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    const action = event.action;
    const { actionType, challengeId } = event.notification.data;
    
    let targetUrl = '';
    
    if (action === 'confirm') {
        if (actionType === 'register') {
            // Flujo de Registro (Notificación inmediata después de la vinculación)
            targetUrl = `${SERVER_BASE_URL}/mobile/register-confirm?sessionId=${challengeId}&status=confirmed`; 
        } else if (actionType === 'auth') {
            // Flujo de Inicio de Sesión (Confirmación de Token/Acceso)
            targetUrl = `${SERVER_BASE_URL}/mobile/auth-confirm?sessionId=${challengeId}&status=confirmed`; 
        }
        
        // Abrir la página web correspondiente que notifica al servidor
        if (targetUrl) {
            event.waitUntil(clients.openWindow(targetUrl));
        }
    } else if (action === 'deny') {
        // Flujo de Rechazo: Notificar al servidor que el desafío fue denegado (opcional)
        const denyUrl = `${SERVER_BASE_URL}/mobile/auth-confirm?sessionId=${challengeId}&status=denied`;
        event.waitUntil(fetch(denyUrl)); // Llama al endpoint de confirmación con estado 'denied'
    }
});