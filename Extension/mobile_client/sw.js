const SERVER_BASE_URL = 'https://undeviously-largest-rashida.ngrok-free.dev'; 
const email = data.email;


self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {}; 
    
    const title = data.title || 'Solicitud de Acción';
    const actionType = data.actionType || 'auth';
    const challengeId = data.sessionId;

    const options = {
        body: data.body || 'Se requiere su confirmación para continuar.',
        icon: 'icon.png',
        vibrate: [100, 50, 100],
        data: {
            actionType,
            challengeId
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
    
    const { actionType, challengeId } = event.notification.data;
    let targetUrl = '';

    if (event.action === 'confirm') {
        targetUrl = actionType === 'register'
            ? `${SERVER_BASE_URL}/mobile_client/register-confirm?sessionId=${challengeId}&email=${encodeURIComponent(email)}&status=confirmed`
            : `${SERVER_BASE_URL}/mobile_client/auth-confirm?sessionId=${challengeId}&status=confirmed`;

        if (targetUrl) {
            event.waitUntil(clients.openWindow(targetUrl));
        }

    } else if (event.action === 'deny') {
        const denyUrl = `${SERVER_BASE_URL}/mobile_client/auth-confirm?sessionId=${challengeId}&status=denied`;
        event.waitUntil(fetch(denyUrl));
    }
});
 