// URLs de los servidores (¡Ajustar si es necesario!)
const SERVER_BASE_URL = 'http://localhost:3000'; // Servidor Node.js (Token)
const KEY_MANAGER_URL = 'http://localhost:8080'; // Servidor Go (Material de Clave)

const POLLING_INTERVAL = 3000; // 3 segundos
const MAX_TIMEOUT = 60000; // 60 segundos de espera máxima

// --- Función de Solicitud de Material de Clave al Servidor Go ---
async function getKeyMaterialWithToken(token, email, platform) {
    try {
        const response = await fetch(`${KEY_MANAGER_URL}/get_key_material`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auth_token: token,
                user_email: email,
                platform_name: platform
            })
        });

        if (!response.ok) {
            throw new Error('Error al solicitar material de clave al Key Manager.');
        }

        const data = await response.json();
        // El servidor Go devuelve el material de clave (ej. clave derivada, datos cifrados)
        return data; 

    } catch (error) {
        console.error("Error en el Key Manager (Servidor Go):", error);
        return null;
    }
}

// --- Flujo de Autenticación Principal (Login) ---

function startAuthFlow(email, platform, tabId) {
    // 1. Iniciar la solicitud de autenticación Push en el servidor Node.js
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
        // 2. Si la solicitud Push se envió con éxito, comenzar el polling para el token
        startTokenPolling(email, platform, tabId); 
    })
    .catch(error => {
        console.error("Error en flujo de autenticación:", error);
        chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: error.message });
    });
}

// Función de Polling para consultar el Token de Desbloqueo (Servidor Node.js)
function startTokenPolling(email, platform, tabId) {
    let intervalId = null;

    const checkToken = async () => { 
        fetch(`${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`)
            .then(res => res.json())
            .then(async data => {
                if (data.status === 'authenticated' && data.token) {
                    // TOKEN DE DESBLOQUEO RECIBIDO
                    clearInterval(intervalId);

                    // 1. Usar el token para pedir el material de clave al Servidor Go
                    const keyMaterial = await getKeyMaterialWithToken(data.token, email, platform);

                    if (keyMaterial) {
                        // 2. Enviar el material de clave al Content Script para desencriptación local
                        chrome.tabs.sendMessage(tabId, {
                            action: "fillKeyMaterial", 
                            keyMaterial: keyMaterial 
                        });
                    } else {
                        chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: "Fallo al obtener el material de clave (Servidor Go)." });
                    }
                } else if (data.status === 'denied') {
                    // Móvil rechazó
                    clearInterval(intervalId);
                    chrome.tabs.sendMessage(tabId, { action: "authTimeout", message: "Autenticación rechazada por el móvil." });
                }
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


// --- Escuchar mensajes del Content Script ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "requestAuthLogin" && sender.tab) {
        // CORRECCIÓN: Llamamos a startAuthFlow con email y platform
        startAuthFlow(request.email, request.platform, sender.tab.id); 
        return true; 
    }
});