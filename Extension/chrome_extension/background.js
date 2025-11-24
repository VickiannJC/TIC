// ==========================
// CONFIG SERVERS
// ==========================
const SERVER_BASE_URL = "https://undeviously-largest-rashida.ngrok-free.dev";
const POLLING_INTERVAL = 3000;
const MAX_TIMEOUT = 60000;



// ==========================
// CONTROL DE TABS ACTIVOS
// ==========================
const activeTabs = new Set();
let lastTabId = null; // último tab conocido

function safeSendMessage(tabId, payload) {
    if (tabId == null) {
        console.warn("[SW] safeSendMessage sin tabId, no envío:", payload);
        return;
    }
    try {
        chrome.tabs.sendMessage(tabId, payload, () => {
            // En MV3 es normal que falle si el content ya no está; lo registramos
            if (chrome.runtime.lastError) {
                console.warn("[SW] Error enviando mensaje al tab",
                    tabId, ":", chrome.runtime.lastError.message);
            }
        });
    } catch (err) {
        console.warn("[SW] Excepción enviando mensaje al tab", tabId, ":", err);
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
        const contentType = resp.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("Servidor devolvió HTML/Texto en lugar de JSON");
        }

        await resp.json();
        console.log("[SW] Push de login enviado, iniciando polling…");

        startTokenPolling(email, platform, tabId);

    } catch (err) {
        console.error("[SW] Error en flujo de login:", err);
        safeSendMessage(tabId, {
            action: "authTimeout",
            message: err.message
        });
        safeSendMessage(tabId, {
            action: "resetAuthButtons"
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

        const contentType = resp.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            const txt = await resp.text();
            throw new Error("Respuesta no JSON: " + txt.substring(0, 200));
        }



        if (!resp.ok) {

            const errData = await resp.json();
            if (resp.status === 409 && errData.error === "email_exists") {
                safeSendMessage(tabId, {
                    action: "emailAlreadyRegistered",
                    message: errData.message
                });
                return;
            }
            throw new Error(errData.error || "Error al generar QR");
        }

        const data = await resp.json();
        const qrData = data.qr;

        console.log("[SW] QR recibido desde backend para:", email, "en tab", tabId);

        safeSendMessage(tabId, {
            action: "showRegistrationQR",
            qrData,
            email,
            platform
        });

    } catch (err) {
        console.error("[SW] Error en flujo de registro:", err);

        safeSendMessage(tabId, {
            action: "authTimeout",
            message: err.message
        });
        safeSendMessage(tabId, {
            action: "resetAuthButtons"
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
        if (intervalId !== null) clearInterval(intervalId);
        safeSendMessage(tabId, {
            action: "authTimeout",
            message: "Tiempo de espera agotado (60s)."
        });
        safeSendMessage(tabId, {
            action: "resetAuthButtons"
        });

    }, MAX_TIMEOUT);

    intervalId = setInterval(async () => {
        if (timedOut) return;

        try {
            const resp = await fetch(
                `${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`
            );

            const contentType = resp.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                throw new Error("Servidor devolvió HTML/Texto en lugar de JSON");
            }

            const data = await resp.json();

            if (data.status === "authenticated" && data.token) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);

                const keyMaterial = await getKeyMaterialWithToken(
                    data.token, email, platform
                );

                if (keyMaterial) {
                    safeSendMessage(tabId, {
                        action: "fillKeyMaterial",
                        keyMaterial
                    });
                } else {
                    safeSendMessage(tabId, {
                        action: "authTimeout",
                        message: "Fallo al obtener material de clave."
                    });
                    safeSendMessage(tabId, {
                        action: "resetAuthButtons"
                    });

                }
            } else if (data.status === "denied") {
                clearTimeout(timeoutId);
                clearInterval(intervalId);

                safeSendMessage(tabId, {
                    action: "authTimeout",
                    message: "Autenticación rechazada por el usuario."
                });
                safeSendMessage(tabId, {
                    action: "resetAuthButtons"
                });

            }

        } catch (err) {
            console.error("[SW] Error en polling:", err);
            clearTimeout(timeoutId);
            clearInterval(intervalId);

            safeSendMessage(tabId, {
                action: "authTimeout",
                message: "Error de red durante autenticación."
            });
            safeSendMessage(tabId, {
                action: "resetAuthButtons"
            });

        }

    }, POLLING_INTERVAL);
}

// ==========================
// LISTENER PRINCIPAL MV3
// ==========================
chrome.runtime.onMessage.addListener((request, sender) => {
    // Handshake: content.js avisa que está listo
    if (request.action === "contentReady" && sender.tab) {
        activeTabs.add(sender.tab.id);
        lastTabId = sender.tab.id;
        console.log("[SW] contentReady desde tab", sender.tab.id);
        return;
    }

    // Determinar el tabId real
    const tabId = sender.tab?.id ?? request.tabId ?? lastTabId;

    if (!tabId) {
        console.warn("[SW] No hay tabId disponible para procesar la acción:", request.action);
        return;
    }

    const { email, platform } = request;

    if (request.action === "requestAuthLogin") {
        console.log("[SW] requestAuthLogin para", email, "en tab", tabId);
        startAuthFlow(email, platform, tabId);
    }

    if (request.action === "requestRegistration") {
        console.log("[SW] requestRegistration para", email, "en tab", tabId);
        startRegistrationFlow(email, platform, tabId);
    }
});
