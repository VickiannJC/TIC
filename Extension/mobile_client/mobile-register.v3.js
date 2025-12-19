/**
 * Script para registrar el Service Worker y la Suscripción Push del móvil
 * y enviarla al servidor Node.js.
 */
// URL base de tu servidor Node.js
const SERVER_BASE_URL = 'https://genia-api-extension-avbke7bhgea4bngk.eastus2-01.azurewebsites.net';
const API_BASE = window.location.origin;

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

    try{

    if (!sessionId) {
        showError('Error: No se encontró código de sesión en la URL');
        return;
    }

       // Iniciar proceso de vinculación
    statusMessage.textContent = 'Iniciando proceso de vinculación...';
    const PERMISSION_GUARD_KEY = `psy_permission_requested_${sessionId}`;

    if (sessionStorage.getItem(PERMISSION_GUARD_KEY)) {
        console.log("[MOBILE] Permiso ya solicitado para esta sessionId");
    } else {
        sessionStorage.setItem(PERMISSION_GUARD_KEY, "1");
    }

    // Solicitar permisos para recibir las notificaciones push 
        statusMessage.textContent = 'Solicitando permisos...';
        const permission = await Notification.requestPermission();

        if (permission !== 'granted') {
            showError("Debes permitir notificaciones para continuar.");
            throw new Error('Permisos para notificaciones no concedidos');
        }

 
        // Verificar compatibilidad
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            throw new Error('Tu navegador no soporta Service Workers o Notificaciones Push');
        }

        // Registrar Service Worker -> archivo sw.js
        console.log("[MOBILE] Registrando Service Worker...");
        statusMessage.textContent = 'Registrando Service Worker...';
        const registration = await navigator.serviceWorker.register(`${location.origin}/mobile_client/sw3.js`);
        console.log("[MOBILE] Service Worker registrado:", registration);

        //Obtener clave VAPID pública:
        const VAPID_KEY = 'BHp2vU13C4v9lkA3TiCeDjdrTKx-pjOJKU9danM81efQiPD_6udB7w42xt6DZnz2bAjgf8mdjz-d_Qv7ePkVDOM';

        //Suscribir a notificaciones push
        console.log("[MOBILE] Suscribiéndose a Push...");
        statusMessage.textContent = 'Generando suscripción push...';
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_KEY)
        });
        console.log("[MOBILE] Suscripción obtenida:", subscription);

        // Enviar suscripción al servidor 
        statusMessage.textContent = 'Vinculando dispositivo...';
        const response = await fetch(`${API_BASE}/register-mobile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, subscription })
        });
        const raw = await response.text();
        console.log("🔴 URL:", response.url);
        console.log("🔴 STATUS:", response.status);
        console.log("🔴 CONTENT-TYPE:", response.headers.get("content-type"));
        console.log("🔴 RAW (primeros 300 chars):", raw.slice(0, 300));
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error("[MOBILE] Respuesta NO JSON del servidor:", raw);
            throw new Error("Respuesta inválida del servidor");
        }
        console.log("[MOBILE] /register-mobile respuesta:", data);
        if (data.status === "already_registered") {
            const userMessage = "Este dispositivo ya está registrado. No es necesario continuar.";

            console.error("[MOBILE] Registro bloqueado. Reason:", data.reason);


            alert(userMessage);

            // Opcional: mostrar pantalla de error elegante
            showError(userMessage);

            // 🔥 Cerrar la pantalla después de 1.2s y refrescar página
            setTimeout(() => {
                try {
                    window.location.reload();  // refrescar
                } catch (e) {
                    console.error("No se pudo refrescar la página:", e);
                }

                // Si es un web app standalone, puede cerrar la pestaña
                window.close();
            }, 1200);

            return;
        }


        console.log("[MOBILE] continueUrl recibido:", data.continueUrl);
        console.log("[MOBILE] email recibido:", data.email);


        showSuccess(
            '¡Dispositivo vinculado correctamente! Pulsa continuar para seguir con el registro biométrico.',
            data.continueUrl
        );

        try {
            console.log("[MOBILE] ENVIANDO PUSH TEST con email:", data.email);
            console.log("[MOBILE] Enviando push test con:", {
                email: data.email,
                continueUrl: data.continueUrl
            });

            console.log("[MOBILE] Enviando TEST PUSH con datos:");
            console.log("email:", data.email);
            console.log("continueUrl:", data.continueUrl);
            console.log("sessionId:", data.sessionId);

            await fetch(`${SERVER_BASE_URL}/send-test-push`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: data.email,
                    continueUrl: data.continueUrl,
                    sessionId: data.sessionId,
                    challengeId: data.challengeId,
                    session_token: data.session_token
                })
            });

            console.log("[MOBILE] Push de prueba enviado.");
        } catch (err) {
            console.error("[MOBILE] Error enviando push de prueba:", err);
        }

        console.log("[MOBILE] sessionId:", sessionId);
        console.log("[MOBILE] SW registrado");




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
    function showSuccess(message, continueUrl) {
        statusEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
        resultEl.classList.add('success');

        resultTitle.textContent = '¡Vinculación Exitosa!';
        resultMessage.textContent = "Revisa tus notificaciones y presiona *Continuar* desde la notificación para seguir con el registro.";
        resultIcon.innerHTML = '<span>✓</span>';

    }


    // Función para mostrar error
    function showError(message) {
        statusEl.classList.add('hidden');
        resultEl.classList.remove('hidden');
        resultEl.classList.add('error');
        resultTitle.textContent = 'Usuario ya registrado';
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