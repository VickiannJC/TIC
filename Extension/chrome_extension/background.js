// ========================================================
// CONFIG
// ========================================================

const SERVER_BASE_URL = "https://undeviously-largest-rashida.ngrok-free.dev";

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
// LISTENER PRINCIPAL DE MENSAJES (popup.js + content.js)
// ========================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    if (!tabId) {
        console.warn("[BG] Mensaje ignorado: Falta tabId");
        return;
    }

    const origin = sender.tab ? new URL(sender.tab.url).origin : null;

    // --------------------------------------------
    // REGISTRO (BOTÓN “Registrar Móvil” DEL POPUP)
    // --------------------------------------------
    if (request.action === "requestRegistration") {
        console.log(`[BG] Registro solicitado para Tab ${tabId}`);

        // Inicializar estado
        sessionStore.set(tabId, {
            status: "registering",
            email: request.email,
            platform: request.platform,
            origin,
            sessionId: null,
            qrData: null,
            qrTimerId: null,
            pollTimerId: null
        });

        startRegistrationFlow(tabId);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // LOGIN (BOTÓN “Psy-Auth” EN content.js)
    // --------------------------------------------
    if (request.action === "requestAuthLogin") {
        console.log(`[BG] Login solicitado para Tab ${tabId}`);

        sessionStore.set(tabId, {
            status: "login_pending",
            email: request.email,
            platform: request.platform,
            origin,
            timestamp: Date.now()
        });

        initiateLogin(tabId, request.email, request.platform);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // CONTENT SCRIPT PREGUNTA POR ESTADO
    // --------------------------------------------
    if (request.action === "checkAuthStatus") {
        const session = sessionStore.get(tabId);

        if (session) {
            sendResponse({
                status: session.status,
                qrData: session.qrData,
                keyMaterial: session.keyMaterial,
                error: session.error
            });

            // Limpieza cuando ya se completó login
            if (session.status === "completed") {
                setTimeout(() => sessionStore.delete(tabId), 5000);
            }
        } else {
            sendResponse({ status: "none" });
        }

        return true;
    }
});

// ========================================================
// 1) REGISTRO – ciclo completo
// ========================================================

async function startRegistrationFlow(tabId) {
    try {
        await generateAndShowQr(tabId);

        // Timer para regenerar QR cada 60s
        const qrTimerId = setInterval(() => {
            const s = sessionStore.get(tabId);
            if (!s || s.status !== "registering") {
                clearInterval(pollTimerId);
                return;
            }
            console.log("[BG] Polling con sessionId =", s.sessionId);
            // Si sessionId aún no llega, esperar sin cancelar el polling
            if (!s.sessionId) {
                return;
            }
            generateAndShowQr(tabId);
        }, QR_REFRESH_INTERVAL);

        // Polling al servidor para saber si QR fue confirmado
        const pollTimerId = setInterval(async () => {
            const s = sessionStore.get(tabId);
            if (!s || s.status !== "registering" || !s.sessionId) {
                clearInterval(pollTimerId);
                return;
            }

            try {
                const resp = await fetch(`${SERVER_BASE_URL}/qr-session-status?sessionId=${encodeURIComponent(s.sessionId)}`);
                const data = await resp.json();

                if (data.estado === "confirmed") {
                    console.log(`[BG] QR confirmado para ${s.email}`);

                    clearInterval(pollTimerId);
                    clearInterval(s.qrTimerId);

                    updateSessionState(tabId, { status: "registration_completed" });
                }

                if (data.estado === "expired") {
                    console.log(`[BG] QR expirado para ${s.email}`);

                    clearInterval(pollTimerId);
                    clearInterval(s.qrTimerId);

                    updateSessionState(tabId, {
                        status: "error",
                        error: "El código QR expiró. Intenta nuevamente."
                    });
                }

            } catch (err) {
                console.error("[BG] Error consultando estado QR:", err);
            }

        }, POLLING_INTERVAL);

        // Guardar timers
        const s = sessionStore.get(tabId);
        if (s) {
            s.qrTimerId = qrTimerId;
            s.pollTimerId = pollTimerId;
            sessionStore.set(tabId, s);
        }

    } catch (err) {
        console.error("❌ Error en startRegistrationFlow:", err);
        updateSessionState(tabId, { status: "error", error: err.message });
    }
}

async function generateAndShowQr(tabId) {
    const s = sessionStore.get(tabId);
    if (!s) return;

    console.log("[BG] Enviando POST /generar-qr-sesion", {
        email: s.email,
        platform: s.platform
    });


    const resp = await fetch(`${SERVER_BASE_URL}/generar-qr-sesion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: s.email, platform: s.platform })
    });

    console.log("[BG] Respuesta QR:", resp.status, await resp.clone().text());

    if (!resp.ok) throw new Error("Error generando QR");

    const data = await resp.json();




    updateSessionState(tabId, {
        status: "registering",
        qrData: data.qr,
        sessionId: data.sessionId
    });
}

// ========================================================
// 2) LOGIN – ciclo completo
// ========================================================

async function initiateLogin(tabId, email, platform) {
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

        startLoginPolling(tabId, email);

    } catch (err) {
        console.error("[BG] Error inicio login:", err);
        updateSessionState(tabId, {
            status: "error",
            error: err.message
        });
    }
}

function startLoginPolling(tabId, email) {
    const startTime = Date.now();

    const interval = setInterval(async () => {
        const s = sessionStore.get(tabId);
        if (!s || s.status !== "login_pending") {
            clearInterval(interval);
            return;
        }

        // Timeout global
        if (Date.now() - startTime > LOGIN_MAX_TIMEOUT) {
            clearInterval(interval);
            updateSessionState(tabId, {
                status: "error",
                error: "Tiempo de espera agotado."
            });
            return;
        }

        try {
            const resp = await fetch(`${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}`);
            const data = await resp.json();

            if (data.status === "authenticated") {
                clearInterval(interval);

                updateSessionState(tabId, {
                    status: "completed",
                    keyMaterial: { password: data.token } // token = password temporal
                });
            }

            if (data.status === "denied") {
                clearInterval(interval);
                updateSessionState(tabId, {
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

function updateSessionState(tabId, newData) {
    const session = sessionStore.get(tabId);
    if (!session) return;

    const updated = { ...session, ...newData };
    sessionStore.set(tabId, updated);

    // Notificar a todos los frames del tab
    chrome.tabs.sendMessage(tabId, {
        action: "authStatusUpdated",
        status: updated.status
    }).catch(() => {
        // Puede fallar si el tab/iframe fue cerrado
        console.error("El tab fue cerrado");
    });
}
