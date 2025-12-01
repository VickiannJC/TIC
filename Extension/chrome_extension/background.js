// ========================================================
// CONFIG
// ========================================================

const SERVER_BASE_URL = "https://closure-kirk-pumps-indicate.trycloudflare.com";

// Poll each interval to check server state (QR + login)
const POLLING_INTERVAL = 3000;

// QR regenerates every 60 seconds
const QR_REFRESH_INTERVAL = 60000;

// Login timeouts
const LOGIN_MAX_TIMEOUT = 60000; // 60s

// ========================================================
// MEMORIA DEL TAB (Buzón por TabID)
// ========================================================
const sessionStore = new Map();

// ========================================================
// ESPERAR A QUE UN TAB TERMINE DE CARGAR (ULTRA SEGURO)
// ========================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;

    // Buscar sesiones cuyo qrTabId coincida con este tab
    for (const [mainTabId, session] of sessionStore.entries()) {
        if (session.qrTabId === tabId && session.qrData) {
            console.log("[BG] qr_page.html totalmente cargado, enviando primer QR…");
            safeSendMessage(tabId, {
                action: "updateQR",
                qr: session.qrData
            });
        }
    }
});

// ========================================================
// LISTENER PRINCIPAL DE MENSAJES (popup.js + content.js)
// ========================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const inferredTabId = sender.tab ? sender.tab.id : request.tabId;
    if (!inferredTabId) {
        console.warn("[BG] Mensaje ignorado: Falta tabId");
        return;
    }

    const origin = sender.tab ? new URL(sender.tab.url).origin : null;

    // --------------------------------------------
    // REGISTRO (BOTÓN “Registrar Móvil” DEL POPUP)
    // --------------------------------------------
    if (request.action === "requestRegistration") {
        const mainTabId = request.tabId || inferredTabId;
        console.log(`[BG] Registro solicitado para Tab ${mainTabId}`);

        // Inicializar estado
        sessionStore.set(mainTabId, {
            status: "registering",
            email: request.email,
            platform: request.platform,
            origin,
            sessionId: null,
            qrData: null,
            qrTimerId: null,
            pollTimerId: null,
            qrTabId: null
        });

        startRegistrationFlow(mainTabId);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // LOGIN (BOTÓN “Psy-Auth” EN content.js)
    // --------------------------------------------
    if (request.action === "requestAuthLogin") {
        const mainTabId = request.tabId || inferredTabId;
        console.log(`[BG] Login solicitado para Tab ${mainTabId}`);

        sessionStore.set(mainTabId, {
            status: "login_pending",
            email: request.email,
            platform: request.platform,
            origin,
            timestamp: Date.now()
        });

        initiateLogin(mainTabId, request.email, request.platform);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // CONTENT SCRIPT PREGUNTA POR ESTADO
    // --------------------------------------------
    if (request.action === "checkAuthStatus") {
        const session = sessionStore.get(inferredTabId);

        if (session) {
            sendResponse({
                status: session.status,
                qrData: session.qrData,
                keyMaterial: session.keyMaterial,
                error: session.error
            });

            // Limpieza cuando ya se completó login
            if (session.status === "completed") {
                setTimeout(() => sessionStore.delete(inferredTabId), 5000);
            }
        } else {
            sendResponse({ status: "none" });
        }

        return true;
    }
});

// ========================================================
//  REGISTRO – ciclo completo
// ========================================================

async function startRegistrationFlow(mainTabId) {
    const s = sessionStore.get(mainTabId);
    if (!s) return;

    console.log("[BG] Registro iniciado para Tab", mainTabId);

    // Cerrar QR previo si existiera
    if (s.qrTabId) {
        try { chrome.tabs.remove(s.qrTabId); } catch (e) { }
    }

    // 1) Abrir una pestaña dedicada al QR
    chrome.tabs.create({ url: chrome.runtime.getURL("qr_page.html") }, async (qrTab) => {
        s.qrTabId = qrTab.id;
        sessionStore.set(mainTabId, s);

        // 2) Generar PRIMER QR
        await generateQrAndSend(mainTabId, qrTab.id);

        // Evitar múltiples timers
        if (s.qrTimerId) {
            clearInterval(s.qrTimerId);
            s.qrTimerId = null;
        }

        // 3) Timer de regeneración cada 60s
        s.qrTimerId = setInterval(() => {
            const session = sessionStore.get(mainTabId);
            if (!session || session.status !== "registering" || !session.qrTabId) {
                return;
            }


            safeSendMessage(session.qrTabId, {
                action: "qrExpired"
            });

            generateQrAndSend(mainTabId, session.qrTabId);
        }, QR_REFRESH_INTERVAL);

        // Cancelar poll previo si existe
        if (s.pollTimerId) {
            clearInterval(s.pollTimerId);
            s.pollTimerId = null;
        }

        // 4) Polling al estado del QR
        s.pollTimerId = setInterval(async () => {
            const session = sessionStore.get(mainTabId);
            console.log("[BG] Polling tab:", mainTabId, "→ sesión encontrada:", session);
            if (!session || session.status !== "registering" || !session.qrTabId) {
                return;
            }


            try {
                const resp = await fetch(
                    `${SERVER_BASE_URL}/qr-session-status?sessionId=${encodeURIComponent(session.sessionId)}`
                );
                const data = await resp.json();

                if (data.estado === "confirmed") {
                    console.log("[BG] ¡QR CONFIRMADO!");

                    // notificar a la pestaña del QR
                    safeSendMessage(session.qrTabId, {
                        action: "qrConfirmed"
                    });

                    // Detener timers
                    if (session.qrTimerId) clearInterval(session.qrTimerId);
                    if (session.pollTimerId) clearInterval(session.pollTimerId);
                    session.qrTimerId = null;
                    session.pollTimerId = null;

                    // Cerrar pestaña de QR
                    if (session.qrTimerId) clearInterval(session.qrTimerId);
                    if (session.pollTimerId) clearInterval(session.pollTimerId);
                    session.qrTabId = null;
                    sessionStore.set(mainTabId, session);

                    updateSessionState(mainTabId, { status: "registration_completed" });

                }
            } catch (err) {
                console.error("[BG] Error consultando QR:", err);
            }

        }, POLLING_INTERVAL);

        sessionStore.set(mainTabId, s);
    });
}

// =============================
// FUNCION: generar QR y enviarlo
// =============================

async function generateQrAndSend(mainTabId, qrTabId) {
    const s = sessionStore.get(mainTabId);
    if (!s) return;

    // Evitar QR duplicados si el estado ya cambió
    if (s.status !== "registering") return;

    console.log("[BG] Generando QR...");

    try {
        const resp = await fetch(`${SERVER_BASE_URL}/generar-qr-sesion`, {

            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: s.email, platform: s.platform })
        });
        console.log("🌐 [BG→SERVER] Enviando QR request al servidor:", {
            email: s.email,
            platform: s.platform
        });


        const raw = await resp.text();
        if (!resp.ok) {
            console.error("❌ Error HTTP generando QR:", resp.status, raw);
            return;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            console.error("❌ Respuesta QR no es JSON válido:", err, "RAW:", raw);
            return;
        }

        // Guardar nuevo QR y sessionId
        s.qrData = data.qr;
        s.sessionId = data.sessionId;
        sessionStore.set(mainTabId, s);

        // Enviar QR a la pestaña
        setTimeout(() => {
            safeSendMessage(qrTabId, {
                action: "updateQR",
                qr: data.qr
            });
        }, 400);

    } catch (err) {
        console.error("[BG] Error en generateQrAndSend:", err);
    }
}

function sessionStoreHasTab(tabId) {
    for (const session of sessionStore.values()) {
        if (session.qrTabId === tabId) return true;
    }
    return false;
}

// Envío robusto de mensajes a tabs
function safeSendMessage(tabId, message, attempt = 0) {

    if (!tabId) return;
    // SI LA TAB YA FUE CERRADA → CANCELAR
    if (!sessionStoreHasTab(tabId)) {
        console.warn("[BG] Tab ya no existe, se cancela envío:", message);
        return;
    }

    if (attempt > 20) {
        console.warn("[BG] Mensaje no enviado: límite de intentos alcanzado", message);
        return;
    }

    try {
        chrome.tabs.sendMessage(tabId, message, () => {
            if (!chrome.runtime.lastError) return;

            const error = chrome.runtime.lastError.message || "";
            if (error.includes("Receiving end does not exist") || error.includes("The message port closed")) {
                return;
            }

            console.warn("[BG] Error inesperado en sendMessage:", error);
            // Otros errores → reintentar
            setTimeout(() => {
                safeSendMessage(tabId, message, attempt + 1);
            }, 150);
        });
    } catch (e) {
        console.error("[BG] Excepción en safeSendMessage:", e);
    }
}

// ========================================================
// 2) LOGIN – ciclo completo
// ========================================================

async function initiateLogin(mainTabId, email, platform) {
    try {
        const resp = await fetch(`${SERVER_BASE_URL}/request-auth-login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, platform })
        });

        if (!resp.ok) {
            const errMsg = await resp.text();
            throw new Error("Error desde servidor de login: " + errMsg);
        }

        startLoginPolling(mainTabId, email);

    } catch (err) {
        console.error("[BG] Error inicio login:", err);
        updateSessionState(mainTabId, {
            status: "error",
            error: err.message
        });
    }
}

function startLoginPolling(mainTabId, email) {
    const startTime = Date.now();

    const interval = setInterval(async () => {
        const s = sessionStore.get(mainTabId);
        if (!s || s.status !== "login_pending") {
            clearInterval(interval);
            return;
        }

        // Timeout global
        if (Date.now() - startTime > LOGIN_MAX_TIMEOUT) {
            clearInterval(interval);
            updateSessionState(mainTabId, {
                status: "error",
                error: "Tiempo de espera agotado."
            });
            return;
        }

        try {
            const resp = await fetch(
                `${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`
            );
            const data = await resp.json();

            if (data.status === "authenticated") {
                clearInterval(interval);

                updateSessionState(mainTabId, {
                    status: "completed",
                    keyMaterial: { password: data.token } // token = password temporal
                });
            }

            if (data.status === "denied") {
                clearInterval(interval);
                updateSessionState(mainTabId, {
                    status: "error",
                    error: "Acceso denegado por el usuario."
                });
            }

        } catch (err) {
            console.error("Polling error:", err);
            // No detenemos el polling por fallos esporádicos
        }
    }, POLLING_INTERVAL);
}

// ========================================================
// UPDATE SESSION STATE (BROADCAST AL TAB)
// ========================================================

function updateSessionState(mainTabId, newData) {
    const session = sessionStore.get(mainTabId);
    if (!session) return;

    const updated = { ...session, ...newData };
    sessionStore.set(mainTabId, updated);

    try {
        chrome.tabs.sendMessage(mainTabId, {
            action: "authStatusUpdated",
            status: updated.status
        }, () => {
            if (chrome.runtime.lastError) {
                console.warn("[BG] No se pudo notificar al tab:", chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.error("El tab fue cerrado o no está disponible:", e);
    }
}

// ========================================================
// DETECTAR CUANDO SE CIERRA LA PESTAÑA DE QR
// ========================================================
chrome.tabs.onRemoved.addListener(async (closedTabId) => {

    for (const [mainTabId, session] of sessionStore.entries()) {
        if (session.qrTabId === closedTabId) {

            console.log("🚫 Pestaña de QR cerrada. Cancelando flujo…", closedTabId);

            // 1) Detener timers de QR y polling
            if (session.qrTimerId) {
                clearInterval(session.qrTimerId);
            }
            if (session.pollTimerId) {
                clearInterval(session.pollTimerId);
            }

            // 2) Eliminar sesión local de la extensión
            sessionStore.delete(mainTabId);
            session.qrTabId = null;


            // 3) Limpiar sesiones del servidor
            try {
                await fetch(`${SERVER_BASE_URL}/cancel-qr-session`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email: session.email })
                });
                console.log("🧹 Sesión QR limpiada del servidor:", session.email);
            } catch (err) {
                console.error("❌ Error limpiando sesión del servidor:", err);
            }
        }
    }
});
