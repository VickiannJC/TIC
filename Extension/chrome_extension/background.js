// ========================================================
// CONFIG
// ========================================================

const SERVER_BASE_URL = 'https://knit-newport-cdt-pan.trycloudflare.com';
const EXT_CLIENT_KEY = "9afe2270278c6647dc54094103a7e7605d61f9b4c0642baf59559453d41c4c94";

const KM_URL = "http://127.0.0.1:8200";

// Poll each interval to check server state (QR + login)
const POLLING_INTERVAL = 10000; //10 segundos



// QR regenerates every 60 seconds
const QR_REFRESH_INTERVAL = 60000;

// Login timeouts
const LOGIN_MAX_TIMEOUT = 180000;

// ========================================================
// MEMORIA DEL TAB (Buzón por email)
// ========================================================
const sessionStore = new Map();

const loginPollingIntervals = new Map();


// Map<string(email), {
//   status: "none" | "login_pending" | "authenticated" | "denied" | "error",
//   email: string,
//   platform: string,
//   tabId: number,
//   startTime: number,
//   error?: string
// }>

// ========================================================
// ESPERAR A QUE UN TAB TERMINE DE CARGAR (ULTRA SEGURO)
// ========================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;

    //  RESET AUTOMÁTICO DE SESIONES HUÉRFANAS
    const session = sessionStore.get(tabId);

    if (session && session.status === "login_pending") {
        console.warn("[BG] Se detectó login_pending huérfano tras refresh. Limpiando sesión…");
        sessionStore.delete(tabId);

        // notificar al content.js para limpiar UI
        chrome.tabs.sendMessage(tabId, {
            action: "authStatusUpdated",
            status: "none"
        }, () => {
            /* ignorar error si no existe content.js en esta página */
        });
    }


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

    if (request.action === "ping") {
        sendResponse({ ok: true });
        return; // importar: indicar que ya respondimos
    }
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
    // LOGIN (BOTÓN “Psy-Auth” )
    // --------------------------------------------
    if (request.action === "requestAuthLogin") {
        const email = request.email;
        const platform = request.platform;
        const tabId = inferredTabId;
        console.log("[BG] Login solicitado para email", email, "desde Tab", tabId);
        if (!email) {
            console.warn("[BG] requestAuthLogin sin email, abortando.");
            return;
        }

        sessionStore.set(tabId, {
            status: "login_pending",
            email,
            platform,
            tabId,
            timestamp: Date.now()
        });

        initiateLogin(email, platform, tabId);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // GENERAR CONTRASEÑA (BOTÓN “Psy-Auth” )
    // --------------------------------------------
    if (request.action === "requestPasswordGeneration") {
        const mainTabId = request.tabId || inferredTabId;

        sessionStore.set(mainTabId, {
            status: "generation_pending",
            email: request.email,
            platform: request.platform,
            origin,
            timestamp: Date.now()
        });

        initiateGeneration(mainTabId, request.email, request.platform);
        sendResponse({ received: true });
        return false;
    }

    // --------------------------------------------
    // CONTENT SCRIPT PREGUNTA POR ESTADO
    // --------------------------------------------
    if (request.action === "checkAuthStatus") {
        const tabId = inferredTabId;

        if (!tabId) {
            console.warn("[BG] checkAuthStatus sin tabId");
            sendResponse({ status: "none" });
            return;
        }

        const session = sessionStore.get(tabId);
        sendResponse(session || { status: "none" });

        return true;
    }
});

// ===================================================================
// NOTIFICAR AL USUARIO DE GENERACION DE CONTRASEÑA Y PASOS A SEGUIR
// ===================================================================
function notifyGeneratedPassword(platform) {
    const title = "Contraseña generada ✅";
    const message =
        `Ya se generó tu contraseña para ${platform}.\n` +
        `Ahora: en Facebook haz clic en “¿Olvidaste tu contraseña?”.\n` +
        `Sigue el proceso y cuando veas “Nueva contraseña”, Psy-Password la llenará automáticamente.`;

    try {
        chrome.notifications.create({
            type: "basic",
            iconUrl: "llave.png", // ajusta al nombre real de tu icono
            title,
            message,
            priority: 2
        });
    } catch (e) {
        console.warn("[BG] No se pudo mostrar notificación:", e);
    }
}


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
        const resp = await fetch(`${SERVER_BASE_URL}/generar-qr-session`, {

            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Key": EXT_CLIENT_KEY
            },
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
        if (session.tabId === tabId) return true;
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

async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fetch(url, options); }
        catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 700));
        }
    }
}


async function initiateLogin(email, platform, tabId) {
    try {
        const resp = await fetchWithRetry(`${SERVER_BASE_URL}/request-auth-login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Key": EXT_CLIENT_KEY
            },
            body: JSON.stringify({ email, platform, tabId })
        });

        const data = await resp.json();


        if (!resp.ok) {
            try {
                chrome.tabs.sendMessage(tabId, {
                    action: "authPushFailed",
                    error: data.error || "Error enviando push"
                });
            } catch (e) { }
            return;
        }

        // Notificación enviada correctamente
        try {
            chrome.tabs.sendMessage(tabId, { action: "authPushSent" });
        } catch (e) { }

        startLoginPolling(email, platform, tabId);

    } catch (err) {
        console.error("[BG] Error inicio login:", err);
        const s = sessionStore.get(tabId);
        if (s?.tabId) {
            updateSessionState(s.tabId, { status: "error", error: err.message });
        }
        try {
            chrome.tabs.sendMessage(tabId, { action: "authPushFailed", error: err.message });
        } catch (e) { }
    }
}

async function initiateGeneration(mainTabId, email, platform) {
    try {
        const resp = await fetch(`${SERVER_BASE_URL}/request-gen-login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Key": EXT_CLIENT_KEY
            },
            body: JSON.stringify({ email, platform, tabId: mainTabId })
        });

        if (!resp.ok) {
            const text = await resp.text();
            console.error("[BG] Error generación de contraseña:", text);
            updateSessionState(mainTabId, { status: "error", error: text });
            return;
        }

        startGenerationPolling(mainTabId, email, platform);

    } catch (err) {
        updateSessionState(mainTabId, { status: "error", error: err.message });
    }
}


function startLoginPolling(email, platform, tabId) {
    const startTime = Date.now();

    const interval = setInterval(async () => {
        const s = sessionStore.get(tabId);
        if (!s || s.status !== "login_pending") {
            clearInterval(interval);
            loginPollingIntervals.delete(tabId);
            return;
        }

        if (!tabId) {
            console.warn("[BG] No tabId for email", email);
            return;
        }

        // Timeout global
        if (Date.now() - startTime > LOGIN_MAX_TIMEOUT) {
            clearInterval(interval);
            updateSessionState(tabId, {
                status: "error",
                error: "Tiempo de espera agotado."
            });
            clearInterval(interval);
            loginPollingIntervals.delete(tabId);
            return;
        }

        try {
            const url =
                `${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}` +
                `&action=${encodeURIComponent("autenticacion")}` +
                `&tabId=${encodeURIComponent(String(tabId))}`;
            console.log("🔍 [BG] Polling URL:", url);

            let raw;
            let res;
            try {
                res = await fetch(url, { headers: { "X-Client-Key": EXT_CLIENT_KEY } });
                raw = await res.text();
            } catch (err) {
                console.error("❌ [BG] Error en fetch:", err);
                return;
            }

            let data;
            try {
                data = JSON.parse(raw);
            } catch (err) {
                console.error("❌ Error parseando JSON en polling:", err, raw);
                return;
            }

            if (data.status === "expired") {
                clearInterval(interval);
                loginPollingIntervals.delete(tabId);

                updateSessionState(tabId, {
                    status: "error",
                    error: "La sesión de autenticación expiró."
                });
                return;
            }

            if (data.status === "authenticated") {
                clearInterval(interval);
                loginPollingIntervals.delete(tabId);

                console.log("🔐 Usuario autenticado. Preparando canal seguro con el KM...");

                try {
                    // ✅ Validación explícita del session_token con backend
                    if (!data.session_token) throw new Error("Missing session_token from backend");

                    const v = await fetch(`${SERVER_BASE_URL}/validate-km-token`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Client-Key": EXT_CLIENT_KEY
                        },
                        body: JSON.stringify({ email, session_token: data.session_token, tabId })
                    });
                    const vData = await v.json().catch(() => ({}));
                    if (!v.ok || vData.valid !== true) {
                        throw new Error("Invalid session_token (backend validation failed)");
                    }
                    // Inicializar KMClient (usuario + plugin)
                    await KMClient.init({
                        kmBaseUrl: KM_URL,
                        userId: email,
                        pluginId: "BROWSER_PLUGIN_1",
                        nodeBaseUrl: SERVER_BASE_URL,
                        sessionToken: data.session_token,
                        tabId: tabId,
                        extClientKey: EXT_CLIENT_KEY
                    });

                    // Asegurar handshake (si ya existe no repite)
                    await KMClient.ensureHandshake();
                    console.log("🤝 Handshake completado. Solicitando contraseña al KM...");

                    // Solicitar contraseña protegida con envelope
                    const resp = await fetch(`${KM_URL}/get_password_enveloped`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            user_id: email,
                            plugin_id: "BROWSER_PLUGIN_1",
                            platform: platform
                        })
                    });

                    if (!resp.ok) {
                        const txt = await resp.text();
                        throw new Error(`KM error: ${txt}`);
                    }

                    const dataKm = await resp.json();
                    const encrypted_password = dataKm.encrypted_password;

                    console.log("📩 Recibido encrypted_password desde KM:", encrypted_password);

                    //  Descifrar con enclave local (AES-GCM con channelKey)
                    const pwBytes = await KMClient.envelopeDecrypt(encrypted_password);
                    const password = new TextDecoder().decode(pwBytes);

                    console.log("🔓 Contraseña real descifrada:", password);

                    //  Enviar contraseña real al content script
                    updateSessionState(tabId, {
                        status: "completed",
                        keyMaterial: { password }
                    });

                    const fin = await fetch(`${SERVER_BASE_URL}/finalize-km-session`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Client-Key": EXT_CLIENT_KEY
                        },
                        body: JSON.stringify({ email, session_token: data.session_token, tabId })
                    });
                    const finData = await fin.json().catch(() => ({}));
                    if (!fin.ok || finData.ok !== true) {
                        console.warn("[BG] finalize-km-session falló (no bloquea autofill):", finData);
                    }



                } catch (err) {
                    console.error("❌ Error obteniendo contraseña desde KM:", err);
                    updateSessionState(tabId, {
                        status: "error",
                        message: "No se pudo obtener la contraseña desde el KM"
                    });
                }

                return;
            }



            if (data.status === "denied") {
                clearInterval(interval);
                loginPollingIntervals.delete(tabId);
                updateSessionState(tabId, {
                    status: "error",
                    error: "Acceso denegado por el usuario."
                });


                return;
            }

        } catch (err) {
            console.error("Polling error:", err);
            // No detenemos el polling pTor fallos esporádicos
            console.warn("[BG] Polling transient error:", err?.message || err);


        }
    }, POLLING_INTERVAL);
    // Guardar para posible limpieza futura
        loginPollingIntervals.set(tabId, interval);
}

function startGenerationPolling(mainTabId, email, platform) {
    const startTime = Date.now();

    const interval = setInterval(async () => {
        const s = sessionStore.get(mainTabId);
        if (!s || s.status !== "generation_pending") {
            clearInterval(interval);
            return;
        }

        if (Date.now() - startTime > LOGIN_MAX_TIMEOUT) {
            updateSessionState(mainTabId, {
                status: "error",
                error: "Tiempo de espera agotado."
            });
            clearInterval(interval);
            loginPollingIntervals.delete(mainTabId);
            return;
        }
        try {

            const resp = await fetch(
                `${SERVER_BASE_URL}/check-password-status?email=${encodeURIComponent(email)}` +
                `&action=${encodeURIComponent("generacion")}` +
                `&tabId=${encodeURIComponent(String(mainTabId))}`,
                {
                    headers: {
                        "X-Client-Key": EXT_CLIENT_KEY
                    }
                });
            const data = await resp.json();

            if (data.status === "authenticated") {
                clearInterval(interval);

                // MARCAMOS SOLO EL EVENTO, PERO NO HACEMOS NADA MÁS
                updateSessionState(mainTabId, {
                    status: "completed",
                    keyMaterial: { token: data.session_token }
                });
                chrome.tabs.sendMessage(mainTabId, {
                    action: "showPostGenerateInstructions",
                    platform
                });

                notifyGeneratedPassword(platform);

                return;
            }

            if (data.status === "denied") {
                clearInterval(interval);
                updateSessionState(mainTabId, {
                    status: "error",
                    error: "Usuario rechazó en biometría."
                });
                return;
            }
        } catch (err) {
            console.error("Polling error:", err);
            // No detenemos el polling por fallos esporádicos
            updateSessionState(mainTabId, {
                status: "error",
                error: "Error comunicando con el servidor."
            });

            // 🔥 Limpieza consistente
            setTimeout(() => sessionStore.delete(mainTabId), 2000);
        }

    }, POLLING_INTERVAL);
}


// ========================================================
// UPDATE SESSION STATE (BROADCAST AL TAB)
// ========================================================

function updateSessionState(tabId, newState) {
    const previous = sessionStore.get(tabId) || {};
    const merged = { ...previous, ...newState };
    sessionStore.set(tabId, merged);

    const targetTab = merged.tabId || tabId;

    if (targetTab) {
        try {
            chrome.tabs.sendMessage(targetTab, {
                action: "authStatusUpdated",
                status: merged.status,
                error: merged.error || null
            }, () => {
                if (chrome.runtime.lastError) {
                    console.warn("[BG] No se pudo notificar al tab:", chrome.runtime.lastError.message);
                }
            });
        } catch (e) {
            console.warn("[BG] Error enviando mensaje al tab:", e);
        }
    } else {
        console.warn("[BG] updateSessionState sin tabId:", tabId);
    }
}


// ========================================================
// DETECTAR CUANDO SE CIERRA LA PESTAÑA DE QR
// ========================================================
chrome.tabs.onRemoved.addListener(async (closedTabId) => {

    // Si era un polling de login, limpiarlo
    const poll = loginPollingIntervals.get(closedTabId);
    if (poll) {
        clearInterval(poll);
        loginPollingIntervals.delete(closedTabId);
    }

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
