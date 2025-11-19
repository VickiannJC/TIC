// ==========================
// CONFIG SERVERS
// ==========================
const SERVER_BASE_URL = "https://undeviously-largest-rashida.ngrok-free.dev";
const KEY_MANAGER_URL = "http://localhost:8080";

const POLLING_INTERVAL = 3000;
const MAX_TIMEOUT = 60000;

// ==========================
// CONTROL DE TABS ACTIVOS
// ==========================
const activeTabs = new Set();
let lastTabId = null; // ← esencial para QR refresh

function safeSendMessage(tabId, payload) {
    try {
        if (activeTabs.has(tabId)) {
            chrome.tabs.sendMessage(tabId, payload);
        } else {
            console.warn("[SW] No se envió mensaje: tabId inválido o sin content script activo.", tabId);
        }
    } catch (err) {
        console.warn("[SW] Error enviando mensaje:", err);
    }
}

// ==========================
// EVENTOS SERVICE WORKER MV3
// ==========================
chrome.runtime.onInstalled.addListener(() => {
    console.log("[SW] Instalado.");
});

chrome.runtime.onStartup.addListener(() => {
    console.log("[SW] Reiniciado.");
});

// ==========================
// GET KEY MATERIAL (LOGIN)
// ==========================
async function getKeyMaterialWithToken(token, email, platform) {
    try {
        const response = await fetch(`${KEY_MANAGER_URL}/get_key_material`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                auth_token: token,
                user_email: email,
                platform_name: platform
            })
        });

        if (!response.ok) {
            throw new Error("Error al solicitar material de clave al Key Manager");
        }

        return await response.json();
    } catch (err) {
        console.error("[SW] Error Key Manager:", err);
        return null;
    }
}

// ==========================
// LOGIN FLOW
// ==========================
async function startAuthFlow(email, platform, tabId) {
    try {
        const resp = await fetch(`${SERVER_BASE_URL}/request-auth-login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, platform })
        });

        if (!resp.ok) {
            if (resp.status === 404) throw new Error("Dispositivo no vinculado");
            throw new Error("Error al iniciar Push Auth");
        }

        await resp.json();
        console.log("[SW] Push de login enviado, iniciando polling…");

        startTokenPolling(email, platform, tabId);

    } catch (err) {
        safeSendMessage(tabId, {
            action: "authTimeout",
            message: err.message
        });
    }
}

// ==========================
// REGISTRO – GENERAR QR
// ==========================
async function startRegistrationFlow(email, platform, tabId) {

    try {
        const resp = await fetch(`${SERVER_BASE_URL}/generar-qr-sesion`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, platform })
        });

        if (!resp.ok) throw new Error("Error al generar QR");

        const data = await resp.json();
        const qrData = data.qr;

        console.log("[SW] QR recibido desde backend para:", email);

        safeSendMessage(tabId, {
            action: "showRegistrationQR",
            qrData,
            email,
            platform
        });

    } catch (err) {
        console.error("[SW] Error en registro:", err);

        safeSendMessage(tabId, {
            action: "authTimeout",
            message: err.message
        });
    }
}

// ==========================
// LOGIN – POLLING
// ==========================
function startTokenPolling(email, platform, tabId) {
    let intervalId = null;
    let timedOut = false;

    const timeoutId = setTimeout(() => {
        timedOut = true;
        clearInterval(intervalId);
        safeSendMessage(tabId, {
            action: "authTimeout",
            message: "Tiempo de espera agotado (60s)."
        });
    }, MAX_TIMEOUT);

    intervalId = setInterval(async () => {
        if (timedOut) return;

        try {
            const resp = await fetch(
                `${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`
            );

            const data = await resp.json();

            if (data.status === "authenticated" && data.token) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);

                const keyMaterial = await getKeyMaterialWithToken(
                    data.token, email, platform
                );

                safeSendMessage(tabId, {
                    action: "fillKeyMaterial",
                    keyMaterial
                });
            }

            if (data.status === "denied") {
                clearTimeout(timeoutId);
                clearInterval(intervalId);

                safeSendMessage(tabId, {
                    action: "authTimeout",
                    message: "Autenticación rechazada por el usuario."
                });
            }

        } catch (err) {
            clearTimeout(timeoutId);
            clearInterval(intervalId);

            safeSendMessage(tabId, {
                action: "authTimeout",
                message: "Error de red durante autenticación."
            });
        }

    }, POLLING_INTERVAL);
}

// ==========================
// LISTENER PRINCIPAL MV3
// ==========================
chrome.runtime.onMessage.addListener((request, sender) => {

    // Registrar pestaña activa
    if (request.action === "contentReady" && sender.tab) {
        activeTabs.add(sender.tab.id);
        lastTabId = sender.tab.id;     // ← RECORDAR TABID PARA REFRESCOS
        return;
    }

    // Si el mensaje viene sin sender.tab (ej. timer 60s)
    const tabId = sender.tab ? sender.tab.id : lastTabId;

    if (!tabId) {
        console.warn("[SW] No hay tabId disponible para procesar la acción.");
        return;
    }

    const { email, platform } = request;

    if (request.action === "requestAuthLogin") {
        startAuthFlow(email, platform, tabId);
    }

    if (request.action === "requestRegistration") {
        startRegistrationFlow(email, platform, tabId);
    }
});
