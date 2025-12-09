// sw_v44.js — Service Worker para el cliente móvil de Psy-Password
// Cambia el nombre del archivo o añade este comentario para forzar actualización

console.log("[SW] Service Worker CARGADO y EJECUTADO.");


const SERVER_BASE_URL = 'https://frames-newest-divorce-total.trycloudflare.com';

self.addEventListener("install", (event) => {
    console.log("[SW] INSTALL ejecutado");
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    console.log("[SW] ACTIVATE ejecutado");
    self.clients.claim();
});



// Mandatory fetch handler so clients.openWindow() can work in notificationclick
self.addEventListener('fetch', (event) => {

});

// ========================================================
// PUSH EVENT — recibir notificación desde el servidor
// ========================================================
self.addEventListener('push', (event) => {

    console.log("🔥🔥🔥 [SW] PUSH EVENT DISPARADO");
    console.log("🔹 event.data =", event.data);

    let raw;
    try {
        raw = event.data ? event.data.text() : "NO_DATA";
        console.log("📩 PUSH RAW TEXT:", raw);
    } catch(e) {
        console.log("❌ ERROR leyendo event.data:", e);
    }

    console.log("🔥 [SW] RAW TEXT:", event.data ? event.data.text() : "NO DATA");


    let data = {};


    try {
        data = event.data ? event.data.json() : {};
        console.log("[SW] Push parseado:", data);
        console.log("[SW] continueUrl recibido:", data.continueUrl);

    } catch (e) {
        console.error('[SW] Error parseando datos del push:', e);
    }

    console.log("[SW] DATA FINAL PARA LA NOTIFICACIÓN:", data);


    const title = data.title || 'Psy-Password';
    const body = data.body || 'Se requiere tu acción para continuar.';
    const actionType = data.actionType || 'auth';  // 'auth' | 'register' | 'register_continue' | etc.
    const sessionId = data.sessionId || null;
    const email = data.email || null;
    const continueUrl = data.continueUrl || null;
    const session_token = data.session_token || null;
    const challengeId = data.challengeId || null;

    console.log('[SW] Push recibido:', { actionType, sessionId, email, continueUrl });

    const options = {
        body,
        //icon: 'icon.png',
        vibrate: [100, 50, 100],
        data: {
            actionType,
            continueUrl,
            sessionId,
            email,
            session_token,
            challengeId
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
                                : actionType === 'generate'
                                ? 'Generar'
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
    console.log("🖱 [SW] CLICK en notificación");
    console.log("   ➤ event.action:", event.action);
    console.log("🔹 event.notification.data =", event.notification.data);
    event.notification.close();

    const { actionType, email, continueUrl, session_token } = event.notification.data || {};
    const sessionId = event.notification.data?.sessionId;


    console.log("[SW] CLICK DATA:", {
        actionType,
        email,
        continueUrl,
        session_token,
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
    
        console.log("[SW] isConfirm:", isConfirm);

   
    // CASOS POR TIPO DE ACCIÓN
    if (actionType === 'auth') {
        console.log('[SW] Click en notificación de LOGIN:', {
            isConfirm,
            actionType,
            sessionId,
            email,
            continueUrl
        });

        if (isConfirm) {
            // 🔹 Priorizar la URL que mandó el servidor
            if (continueUrl) {
                console.log('[SW] Abriendo continueUrl (login):', continueUrl);
                open(continueUrl);
            } else {
                // Fallback por si alguna vez no viene continueUrl
                const fallbackUrl = `${SERVER_BASE_URL}/mobile_client/auth-confirm?token=${encodeURIComponent(
                    session_token || ''
                )}&status=confirmed`;
                console.log('[SW] continueUrl ausente, usando fallback auth-confirm:', fallbackUrl);
                open(fallbackUrl);
            }
        } else if (event.action === 'deny') {
            console.log('[SW] Usuario rechazó AUTENTICAR desde la notificación.', {
                sessionId,
                email
            });
            
        }

        return;
    }

    if (actionType === 'generate') {
        console.log('[SW] Click en notificación de GENERATE:', {
            isConfirm,
            actionType,
            sessionId,
            email,
            continueUrl
        });

        if (isConfirm) {
            // 🔹 Priorizar la URL que mandó el servidor
            if (continueUrl) {
                console.log('[SW] Abriendo continueUrl (login):', continueUrl);
                open(continueUrl);
            } else {
                // Fallback por si alguna vez no viene continueUrl
                const fallbackUrl = `${SERVER_BASE_URL}/mobile_client/gen-confirm?token=${encodeURIComponent(
                    session_token || ''
                )}&status=confirmed`;
                console.log('[SW] continueUrl ausente, usando fallback gen-confirm:', fallbackUrl);
                open(fallbackUrl);
            }
        } else if (event.action === 'deny') {
            console.log('[SW] Usuario rechazó GENERAR desde la notificación.', {
                sessionId,
                email
            });
            
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
            console.log('[SW] Abriendo continueUrl (login):', continueUrl);
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
