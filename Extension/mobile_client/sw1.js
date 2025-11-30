// sw_v12.js — Service Worker para el cliente móvil de Psy-Password
// Cambia el nombre del archivo o añade este comentario para forzar actualización

const SERVER_BASE_URL = 'https://undeviously-largest-rashida.ngrok-free.dev';

// ========================================================
// PUSH EVENT — recibir notificación desde el servidor
// ========================================================
self.addEventListener('push', (event) => {
    let data = {};
    console.log("[SW] Push recibido RAW:", event.data ? event.data.text() : "SIN DATA");


    try {
        data = event.data ? event.data.json() : {};
        console.log("[SW] Push parseado:", data);
        console.log("[SW] continueUrl recibido:", data.continueUrl);

    } catch (e) {
        console.error('[SW] Error parseando datos del push:', e);
    }

    const title = data.title || 'Psy-Password';
    const body = data.body || 'Se requiere tu acción para continuar.';
    const actionType = data.actionType || 'auth';  // 'auth' | 'register' | 'register_continue' | etc.
    const sessionId = data.sessionId || null;
    const email = data.email || null;
    const continueUrl = data.continueUrl || null;

    console.log('[SW] Push recibido:', { actionType, sessionId, email, continueUrl });

    const options = {
        body,
        //icon: 'icon.png',
        vibrate: [100, 50, 100],
        data: {
            actionType,
            sessionId,
            email,
            continueUrl
        },
        actions: [
            {
                action: 'confirm',
                // Nombres de botones según tipo
                title:
                    actionType === 'auth'
                        ? 'Autenticar'
                        : actionType === 'register_continue'
                            ? 'Continuar'
                            : actionType === 'register'
                                ? 'Registrar'
                                : 'Aceptar',
                icon: 'check.png'
            },
            {
                action: 'deny',
                title:
                    actionType === 'auth'
                        ? 'Rechazar'
                        : 'Cancelar',
                icon: 'cancel.png'
            }
        ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// ========================================================
// NOTIFICATION CLICK — usuario pulsa en la notificación
// ========================================================
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const { actionType, sessionId, email, continueUrl } = event.notification.data || {};

    console.log("[SW] CLICK DATA:", {
        actionType,
        sessionId,
        email,
        continueUrl,
        action: event.action
    });

    if (!continueUrl) {
        console.warn("[SW] No se puede abrir continueUrl porque es undefined");
    } else {
        console.log("[SW] Abriendo URL:", continueUrl);
    }


    // Función helper para abrir URL segura
    const open = (url) => {
        if (!url) {
            console.warn('[SW] URL vacía, no se puede abrir');
            return;
        }
        event.waitUntil(clients.openWindow(url));
    };

    // Si el usuario toca el cuerpo de la notificación (sin botón),
    // event.action === '' → lo tratamos como "confirm".
    const isConfirm =
        event.action === 'confirm' || event.action === '' || event.action === undefined;

    // ------------------------------
    // CASOS POR TIPO DE ACCIÓN
   if (actionType === 'auth') {
    if (isConfirm) {
        // Abrir flujo correcto del registro estético
        const url = `${SERVER_BASE_URL}/mobile_client/register-confirm?email=${encodeURIComponent(email)}&sessionId=${encodeURIComponent(sessionId)}`;
        console.log("[SW] Abriendo register-confirm desde push:", url);
        open(url);
    } else if (event.action === 'deny') {
        console.log("[SW] Usuario rechazó AUTENTICAR.");
    }
    return;
}


    if (actionType === 'register') {
        // (Si en algún momento usas push para confirmar registro directamente)
        if (isConfirm) {
            const url = `${SERVER_BASE_URL}/mobile_client/register-confirm?sessionId=${encodeURIComponent(
                sessionId || ''
            )}&email=${encodeURIComponent(email || '')}`;
            open(url);
        } else if (event.action === 'deny') {
            console.log('[SW] Registro rechazado por el usuario.');
        }
        return;
    }

    if (actionType === 'register_continue') {
        // PUSH DE PRUEBA DESPUÉS DE VINCULACIÓN
        if (isConfirm) {
            open(continueUrl);
        } else if (event.action === 'deny') {
            console.log('[SW] Usuario canceló continuar con registro biométrico.');
        }
        return;
    }

    // Fallback genérico: si no sabemos el tipo, pero hay continueUrl,
    // lo tratamos como "confirmar".
    if (isConfirm && continueUrl) {
        open(continueUrl);
    }
});

self.addEventListener('notificationclose', (event) => {
    const { actionType, sessionId, email } = event.notification.data || {};
    console.log('[SW] Notificación cerrada.', { actionType, sessionId, email });
});
