// URL base de tu servidor (¡Reemplazar con la URL real!)
const SERVER_BASE_URL = 'http://localhost:3000'; 
const POLLING_INTERVAL = 3000; // 3 segundos
const MAX_TIMEOUT = 60000; // 60 segundos de espera máxima

// Lógica del Flujo de Registro

function startRegistrationFlow(email) {
    // 1. Iniciar la solicitud de QR al servidor
    fetch(`${SERVER_BASE_URL}/generar-qr-sesion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
    })
    .then(response => response.json())
    .then(data => {
        // QR en popup o notificación
        console.log("QR generado. URL de registro:", data.registerUrl);
        alert(`Escanea el QR para vincular. Clave Pública VAPID: ${data.vapidPublicKey}`);
    })
    .catch(error => {
        console.error("Error al generar QR:", error);
        alert("Fallo al generar el código QR.");
    });
}


// Lógica del Flujo Inicio de sesion 

function startAuthFlow(email, tabId) {
    // Iniciar la solicitud de autenticación Push en el servidor
    fetch(`${SERVER_BASE_URL}/request-auth-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
    })
    .then(response => {
        if (!response.ok) {
            if (response.status === 404) throw new Error('Dispositivo no vinculado');
            throw new Error('Error al iniciar Push Auth');
        }
        return response.json();
    })
    .then(data => {
        // Si la solicitud Push se envió con éxito comenzar el polling (consulta periódica) para el token
        startTokenPolling(email, tabId);
    })
    .catch(error => {
        console.error("Error en flujo de autenticación:", error);
        // Notificar al Content Script sobre el fallo
        chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: error.message });
    });
}

// Función de Polling para consultar el Token de Desbloqueo
function startTokenPolling(email, tabId) {
    let intervalId = null;

    const checkToken = () => {
        fetch(`${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`)
            .then(res => res.json())
            .then(data => {
                if (data.status === 'authenticated' && data.token) {
                    // TOKEN RECIBIDO -> Enviarlo al Content Script
                    clearInterval(intervalId);
                    
                    chrome.tabs.sendMessage(tabId, {
                        action: "fillToken", // NUEVO NOMBRE DE ACCIÓN
                        token: data.token  // ENVIAMOS EL TOKEN DE DESBLOQUEO
                    });
                } else if (data.status === 'denied') {
                    // Móvil rechazó
                    clearInterval(intervalId);
                    chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: "Autenticación rechazada por el móvil." });
                }
                // Si 'pending'-> continúa el polling
            })
            .catch(error => {
                console.error('Error en polling:', error);
                clearInterval(intervalId);
                chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: "Error de red durante la espera." });
            });
    };

    intervalId = setInterval(checkToken, POLLING_INTERVAL);
    
    // Configurar un timeout máximo
    setTimeout(() => {
        clearInterval(intervalId);
        chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: "Tiempo de espera agotado (60s)." });
    }, MAX_TIMEOUT); 
}


// Escuchar mensajes del Content Script o Popup

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "requestAuthLogin" && sender.tab) {
        // El Content Script solicita iniciar la autenticación Push-to-Fill
        startAuthFlow(request.email, sender.tab.id);
        return true; 
    }
    if (request.action === "requestRegister" && request.email) {
        startRegistrationFlow(request.email);
    }
});