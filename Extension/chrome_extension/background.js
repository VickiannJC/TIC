// ==========================
// CONFIG SERVERS
// ==========================
const SERVER_BASE_URL = "https://undeviously-largest-rashida.ngrok-free.dev";
const POLLING_INTERVAL = 3000;
const MAX_TIMEOUT = 60000;

let activeFrames = {};


async function saveFrames(tabId, framesSet) {
    const obj = {};
    for (const id of framesSet) obj[id] = true;
    await chrome.storage.session.set({ ["frames_" + tabId]: obj });
}

async function loadFrames(tabId) {
    const data = await chrome.storage.session.get("frames_" + tabId);
    const obj = data["frames_" + tabId] || {};
    return new Set(Object.keys(obj).map(id => Number(id)));
}



console.log("[SW] Instalado.");

//Listeners para que Chrome no apaguw SW inmediatamente después de recibir un mensaje
chrome.runtime.onMessageExternal.addListener(() => { });
chrome.runtime.onMessage.addListener(() => { });


//Para que SW controle todas las páginas inmediatamente
self.addEventListener("activate", () => {
    self.clients.claim();
});

// ==========================
// CONTROL DE TABS ACTIVOS
// ==========================
const activeTabs = new Set();
let lastTabId = null; // último tab conocido

async function waitForLeader(tabId, retries = 10) {
    return new Promise(resolve => {
        let attempts = 0;

        const interval = setInterval(() => {
            attempts++;

            if (activeFrames[tabId] !== undefined) {
                clearInterval(interval);
                resolve(true);
            }

            if (attempts >= retries) {
                clearInterval(interval);
                resolve(false);
            }
        }, 200); // cada 200ms
    });
}

async function waitForContentScripts(tabId, retries = 20) {
    for (let i = 0; i < retries; i++) {
        const frames = activeFrames[tabId];
        if (frames && frames.size > 0) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}


async function sendToLeader(tabId, payload) {

    chrome.webNavigation.getAllFrames({ tabId }, async (frames) => {

        // Si Chrome aún no tiene frames, cargar la copia persistente
        if (!frames || frames.length === 0) {
            const savedFrames = await loadFrames(tabId);
            frames = savedFrames.map(id => ({ frameId: id }));
        }

        let delivered = false;

        for (const f of frames) {
            chrome.tabs.sendMessage(
                tabId,
                payload,
                { frameId: f.frameId },
                () => {
                    if (!chrome.runtime.lastError) {
                        console.log("[SW] Frame", f.frameId, "aceptó el mensaje.");
                        delivered = true;
                    }
                }
            );
        }

        setTimeout(() => {
            if (!delivered)
                console.warn("[SW] Ningún frame aceptó el mensaje.");
        }, 250);
    });
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
        sendToLeader(tabId, {
            action: "authTimeout",
            message: err.message
        });
        sendToLeader(tabId, {
            action: "resetAuthButtons"
        });

    }
}

// ==========================
// REGISTRO – GENERAR QR
// ==========================
async function startRegistrationFlow(email, platform, tabId) {
    (async () => {
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
                    sendToLeader(tabId, {
                        action: "emailAlreadyRegistered",
                        message: errData.message
                    });
                    return;
                }
                throw new Error(errData.error || "Error al generar QR");
            }

            const data = await resp.json();
            const qrData = data.qr;

            console.log(`[SW] QR recibido desde backend para: ${email} en tab ${tabId}`);
            await waitForContentScripts(tabId);
            sendToLeader(tabId, {
                action: "showRegistrationQR",
                qrData,
                email,
                platform,
            });


        } catch (err) {
            console.error("[SW] Error en flujo de registro:", err);

            sendToLeader(tabId, {
                action: "authTimeout",
                message: err.message
            });
            sendToLeader(tabId, {
                action: "resetAuthButtons"
            });

        }
    })();
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
        sendToLeader(tabId, {
            action: "authTimeout",
            message: "Tiempo de espera agotado (60s)."
        });
        sendToLeader(tabId, {
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
                    sendToLeader(tabId, {
                        action: "fillKeyMaterial",
                        keyMaterial
                    });
                } else {
                    sendToLeader(tabId, {
                        action: "authTimeout",
                        message: "Fallo al obtener material de clave."
                    });
                    sendToLeader(tabId, {
                        action: "resetAuthButtons"
                    });

                }
            } else if (data.status === "denied") {
                clearTimeout(timeoutId);
                clearInterval(intervalId);

                sendToLeader(tabId, {
                    action: "authTimeout",
                    message: "Autenticación rechazada por el usuario."
                });
                sendToLeader(tabId, {
                    action: "resetAuthButtons"
                });

            }

        } catch (err) {
            console.error("[SW] Error en polling:", err);
            clearTimeout(timeoutId);
            clearInterval(intervalId);

            sendToLeader(tabId, {
                action: "authTimeout",
                message: "Error de red durante autenticación."
            });
            sendToLeader(tabId, {
                action: "resetAuthButtons"
            });

        }

    }, POLLING_INTERVAL);
}

async function sendToActiveFrames(tabId, payload) {
    let framesSet = activeFrames[tabId];

    // Si el SW despertó y activeFrames está vacío → recuperar del storage
    if (!framesSet || framesSet.size === 0) {
        console.warn("[SW] No hay frames activos.");
        return;
    }


    let delivered = false;

    for (const frameId of framesSet) {
        try {
            chrome.tabs.sendMessage(
                tabId,
                payload,
                { frameId },
                () => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[SW] Error enviando a tab ${tabId} frame ${frameId}:`, chrome.runtime.lastError.message);
                        return;
                    }

                    console.log(`[SW] Mensaje '${payload.action}' entregado correctamente a tab ${tabId} frame ${frameId}`);
                    delivered = true;
                }
            );
        } catch (e) {
            console.warn(`[SW] Excepción enviando a frame ${frameId}:`, e);
        }
    }

    if (!delivered) {
        console.warn(`[SW] Ningún frame aceptó el mensaje para tab ${tabId} action: ${payload.action}`);
    }
}


// ==========================
// LISTENER PRINCIPAL MV3
// ==========================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("📨 BG: Mensaje recibido:", request.action);

    // ======== contentReady: registrar frame líder ========
    if (request.action === "contentReady" && sender.tab) {
        const tabId = sender.tab.id;
        const frameId = sender.frameId ?? 0;

        (async () => {
            if (!activeFrames[tabId]) activeFrames[tabId] = new Set();
            activeFrames[tabId].add(frameId);

            await saveFrames(tabId, activeFrames[tabId]);

            lastTabId = tabId;
            console.log(`[SW] contentReady → tab ${tabId} frame ${frameId}`);

            sendResponse?.({ ok: true });
        })();

        return true; // keeps the channel alive
    }

    // ======== Resolver tabId ========
    let tabId = null;
    if (request.tabId) tabId = request.tabId;
    else if (sender.tab?.id) tabId = sender.tab.id;
    else if (lastTabId) tabId = lastTabId;

    if (!tabId) {
        console.warn("[SW] No hay tabId disponible para procesar la acción:", request.action);
        return;
    }

    // ======== Login ========
    if (request.action === "requestAuthLogin") {
        const platformSafe = request.platform?.trim() || "Unknown";
        startAuthFlow(request.email, platformSafe, tabId);
        return true;
    }

    // ======== Registro ========
    if (request.action === "requestRegistration") {
        console.log("[SW] Procesando requestRegistration en tab:", tabId);

        if (!tabId) {
            console.warn("[SW] requestRegistration sin tabId");
            sendResponse?.({ ok: false, error: "No tabId" });
            return true;
        }

        const email = request.email;
        const platform = request.platform ?? "Browser";

        console.log("[SW] Procesando requestRegistration en tab:", tabId);

        // 1) Actualizar contexto en los frames activos
        sendToActiveFrames(tabId, {
            action: "updateContext",
            email,
            platform,
        });

        // 2) Lanzar flujo de registro (tu fetch hacia el server)
        sendResponse({ ok: true });
        Promise.resolve().then(() => startRegistrationFlow(email, platform, tabId));
        return true;

    }
});

// ==============================================
// Cuando el Service Worker será suspendido
// ==============================================
chrome.runtime.onSuspend.addListener(() => {
    console.log("[SW] Suspendido → limpiando estados antes de dormir…");

    // Limpieza opcional de variables globales del SW
    activeSession = null;
    currentEmail = null;
    currentPlatform = null;

    // Cancelar timers si usas alguno (por seguridad)
    if (globalThis._psyTimeout) {
        clearTimeout(globalThis._psyTimeout);
        globalThis._psyTimeout = null;
    }

    // Si dejaste algún intervalo dentro del SW (solo en ese caso)
    if (globalThis._psyInterval) {
        clearInterval(globalThis._psyInterval);
        globalThis._psyInterval = null;
    }

    // Puedes agregar logs o limpiar cachés aquí si lo deseas
    console.log("[SW] Estado limpio. El Service Worker puede dormirse.");
});

chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) {
        chrome.scripting.executeScript({
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            files: ["content.js"]
        }, () => {
            console.log("[SW] content.js forzado en frame", details.frameId);
        });
    }
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
    if (details.frameId !== 0) {
        chrome.scripting.executeScript({
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            files: ["content.js"]
        }, () => {
            console.log("[SW] content.js reinjectado en frame", details.frameId);
        });
    }
});

chrome.runtime.onMessage.addListener((req, sender) => {
    if (req.action === "injectIntoIframe" && sender.tab) {
        chrome.scripting.executeScript({
            target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
            files: ["content.js"]
        });
    }
});


