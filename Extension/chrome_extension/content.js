// ========================================================
//  Content Script para interacción con páginas web
// ========================================================
(() => {
    // Verificación de contexto de extensión
    if (typeof chrome === "undefined" || !chrome.runtime?.id) {
        console.warn("[EXT] content.js fuera de extensión. Abortando.");
        return; 
    }

    console.log("[EXT] content.js ejecutándose en contexto correcto");
    // Estado interno local del content script
    let myPasswordField = null;

    let lastInjectedPassword = null;

    // PING AL BACKGROUND PARA VERIFICAR CONEXIÓN
    let pingIntervalId = null;
    let pingFailures = 0;
    let hasWarnedPing = false;
    const MAX_PING_FAILURES = 5;



    function pingBackground() {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(
                    { action: "ping" },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            return reject(chrome.runtime.lastError);
                        }
                        resolve(response);
                    }
                );
            } catch (e) {
                reject(e);
            }
        });
    }


    function startBackgroundPing() {
        // Si ya hay un intervalo activo, no crear otro
        if (pingIntervalId !== null) return;

        pingIntervalId = setInterval(async () => {
            try {
                // Si el background está vivo, esto no debería lanzar error.
                await pingBackground();
                // Si llega aquí, resetear contador de fallos
                pingFailures = 0;
            } catch (e) {
                pingFailures += 1;

                // Mostrar el warning SOLO la primera vez
                if (!hasWarnedPing) {
                    console.warn("[CS] No se pudo comunicar con background. Reintentando...");
                    hasWarnedPing = true;
                }

                // Si lleva demasiados fallos, dejar de intentarlo
                if (pingFailures >= MAX_PING_FAILURES) {
                    clearInterval(pingIntervalId);
                    pingIntervalId = null;
                    console.warn("[CS] Ping a background desactivado tras múltiples fallos.");
                }
            }
        }, 3000);
    }



    // ========================================================
    // DETECCIÓN DE CAMPOS DE EMAIL / CONTRASEÑA
    // ========================================================

    // Encuentra un campo de contraseña visible 
    function findPasswordField() {
        const selectors = [
            'input[type="password"]',
            'input[name*="pass"]',
            'input[id*="pass"]',
            'input[data-password]',
            'input[autocomplete="current-password"]'
        ];

        // Primero intentar campos visibles
        for (let sel of selectors) {
            const inputs = document.querySelectorAll(sel);
            for (let input of inputs) {
                if (input.offsetParent !== null) return input;
            }
        }

        // Si no hay visibles, devolver cualquiera
        return document.querySelector('input[type="password"]');
    }

    function getAllVisiblePasswordInputs() {
        const candidates = new Set();

        // Clásicos
        document.querySelectorAll('input[type="password"]').forEach(i => candidates.add(i));

        // Accesibilidad (Facebook real)
        document.querySelectorAll(
            'input[aria-label], input[aria-describedby], input[role="textbox"]'
        ).forEach(i => {
            const label =
                (i.getAttribute("aria-label") || "").toLowerCase() +
                (i.getAttribute("aria-describedby") || "").toLowerCase();

            if (label.includes("contraseña") || label.includes("password")) {
                candidates.add(i);
            }
        });

        return [...candidates].filter(i =>
            i &&
            i.offsetParent !== null &&
            !i.disabled &&
            !i.readOnly
        );
    }


    // Heurística para Facebook: cuando reseteas, suelen aparecer 1 o 2 password inputs
    // (nueva contraseña + confirmar). Tomamos ambos si existen.
    function findFacebookNewPasswordFields() {
        const pw = getAllVisiblePasswordInputs();
        if (pw.length === 0) return { primary: null, confirm: null };

        // Si hay dos, normalmente es (new, confirm). Si hay uno, es el único.
        return {
            primary: pw[0] || null,
            confirm: pw[1] || null
        };
    }
    // Encuentra un campo de email/usuario visible

    function findEmailField() {
        return document.querySelector(
            'input[type="email"], input[name*="email"], input[name*="user"], input[id*="email"], input[id*="user"]'
        );
    }

    // Detectar plataforma a partir del domo
    function getPlatformName() {
        const host = window.location.hostname;
        const parts = host.split('.');
        const domain = parts.length > 1 ? parts[parts.length - 2] : host;
        return domain.charAt(0).toUpperCase() + domain.slice(1);
    }
    // ========================================================
    // DETECCIÓN DE CONTRASEÑA NUEVA (autocompletar)
    // ========================================================

    function isFacebookHost() {
        const h = location.hostname;
        return h === "www.facebook.com" || h.endsWith(".facebook.com") || h === "m.facebook.com";
    }

    // “Recovery/reset” suele pasar por rutas tipo identify/recover/checkpoint
    function isFacebookRecoveryContext() {
        if (!isFacebookHost()) return false;

        const p = location.pathname.toLowerCase();
        const q = location.search.toLowerCase();

        return (
            p.includes("/login/identify") ||
            p.includes("/recover") ||
            p.includes("/checkpoint") ||
            q.includes("recover") ||
            q.includes("reset")
        );
    }

    function debugFacebookContext() {
        console.log("[PSY][FB][CTX]", {
            host: location.hostname,
            path: location.pathname,
            search: location.search,
            isRecovery: isFacebookRecoveryContext()
        });
    }



    // ========================================================
    // BUZÓN (ASK BACKGROUND FOR SESSION STATE)
    // ========================================================

    function checkBuzon() {
        const emailField = findEmailField();
        const email = emailField ? emailField.value : null;

        if (!email && !isFacebookRecoveryContext()) {
            return;
        }
        if (isFacebookHost()) {
            debugFacebookContext();
        }

        try {
            chrome.runtime.sendMessage({ action: "checkAuthStatus", email: email || "" }, (response) => {
                if (chrome.runtime.lastError) {
                    return; // Tab cerrándose o contexto inválido
                }
                if (!response) {
                    console.warn("[CS] checkAuthStatus sin respuesta (extensión recargada o pestaña sin background).");
                    return;
                }
                //console.log("[CS] Estado de autenticación para", email, "=>", response.status);

                if (response.status === "authenticated") {
                    showNotificationBanner(" Autenticación completada, iniciando sesión...");

                }

                handleServerResponse(response);
                if (
                    isFacebookRecoveryContext() &&
                    response.status === "completed" &&
                    response.keyMaterial?.password
                ) {
                    console.log("[PSY][FB] Contraseña lista, iniciando autofill reactivo");
                    waitForFacebookResetAndFill(response.keyMaterial.password);
                }

            });
        } catch (e) {
            // Es normal si el frame fue recargado
        }
    }

    // ========================================================
    //  RESPUESTAS DEL BACKGROUND
    // ========================================================

    function handleServerResponse(data) {
        // REGISTRO — Mostrar QR
        if (data.status === "show_qr" && data.qrData) {
            showQRModal(data.qrData);
        }

        // REGISTRO — Confirmado
        if (data.status === "registration_completed") {
            removeQRModal();
            alert("Psy-Password: Dispositivo móvil vinculado correctamente.");
            resetButtons();
        }

        // LOGIN — Autocompletar contraseña
        if (data.status === "completed" && data.keyMaterial) {
            const pwd = data.keyMaterial.password;

            fillPassword(pwd);
            removeQRModal();
            resetButtons();
        }

        // ERROR GENERAL
        if (data.status === "error") {
            alert("GenPIA: " + data.error || "Ocurrió un error inesperado durante la autenticación.");
            removeQRModal();
            resetButtons();
        }

        console.log("[PSY][STATE]", {
            status: data.status,
            hasPassword: !!data.keyMaterial?.password,
            url: location.href
        });

    }

    // Autocompletado del campo contraseña
    function fillPassword(pwd) {
        if (!myPasswordField) myPasswordField = findPasswordField();
        if (!myPasswordField) return;

        console.log("[CS] Llenando contraseña automáticamente...");
        myPasswordField.value = pwd;

        // Simular eventos para frameworks (React/Vue/Angular)
        myPasswordField.dispatchEvent(new Event('input', { bubbles: true }));
        myPasswordField.dispatchEvent(new Event('change', { bubbles: true }));
        myPasswordField.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function fillInput(el, value) {
        if (!el) return;
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    /** 
    function autofillFacebookResetPassword(pwd) {
        const { primary, confirm } = findFacebookNewPasswordFields();
    
        if (!primary) return; // todavía no está la pantalla de nueva contraseña
    
        console.log("[CS][FB] Detectado reset password. Autocompletando nueva contraseña...");
    
        fillInput(primary, pwd);
    
        // Si hay confirmación, también la llenamos
        if (confirm) fillInput(confirm, pwd);
    
        // NO hacemos clic en “Continuar” por seguridad / anti-bot / UX.
        showNotificationBanner(" Contraseña nueva autocompletada. Pulsa “Continuar” en Facebook.");
    }
    */


    // ===============================
    // AUTOFILL REACTIVO - NUEVA CONTRASEÑA
    // ===============================
    function waitForFacebookResetAndFill(pwd) {
        const START_TS = Date.now();
        const MAX_WAIT_MS = 20000; // 20s
        const INTERVAL_MS = 300;

        console.log("[PSY][FB] Esperando campos de nueva contraseña...");

        const timer = setInterval(() => {
            const elapsed = Date.now() - START_TS;

            // Seguridad: timeout duro
            if (elapsed > MAX_WAIT_MS) {
                console.warn("[PSY][FB] Timeout esperando campos password");
                clearInterval(timer);
                return;
            }

            const { primary, confirm } = findFacebookNewPasswordFields();

            // DEBUG visible
            console.log("[PSY][FB][SCAN]", {
                elapsed,
                primary: !!primary,
                confirm: !!confirm,
                url: location.href
            });

            if (!primary) {
                console.log("[PSY][FB][WAIT] Sin campos aún...");
                return;
            }

            console.log("[PSY][FB] Campo detectado → autocompletando");

            fillInput(primary, pwd);
            if (confirm) fillInput(confirm, pwd);

            showNotificationBanner(
                "Contraseña nueva autocompletada.\nPulsa “Continuar” en Facebook."
            );

            clearInterval(timer);
        }, INTERVAL_MS);
    }

    // ========================================================
    // LISTENERS — Broadcast desde background
    // ========================================================

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        // background → “hay actualización de estado”
        if (msg.action === "authStatusUpdated") {
            console.log("[CS] Notificación recibida — revisando buzón...");
            checkBuzon();
        }
        if (msg.action === "authPushSent") {
            console.log("[CS] Push enviado correctamente al móvil");
            showNotificationBanner("✔ Notificación enviada a tu dispositivo móvil");
        }
        if (msg.action === "authPushFailed") {
            console.error("[CS] Error enviando push:", msg.error);
            showNotificationBanner("❌ No se pudo enviar la notificación a tu móvil");
        }

        if(msg.action === "resetButtons") {
            resetButtons();
        }
        if (msg.action === "authLoginSuccess") {
            showNotificationBanner("✅ Contraseña autocompletada. Iniciando sesión...");
        }


        // popup.js pide email
        if (msg.action === "getEmailField") {
            const emailEl = findEmailField();
            sendResponse({ email: emailEl ? emailEl.value : null });
        }

        if (msg.action === "showPostGenerateInstructions") {
            showNotificationBanner(
                `✅ Contraseña generada para ${msg.platform}.\n` +
                `Ahora haz clic en “¿Olvidaste tu contraseña?” y sigue el proceso.\n` +
                `Cuando Facebook muestre “Nueva contraseña”, la extensión la llenará automáticamente.`
            );
        }


    });

    // Cuando el frame termina de cargar, checkear buzón + inyectar botón
    document.addEventListener("DOMContentLoaded", () => {

        const pass = findPasswordField();
        if (pass) {
            injectButton(pass);
            // Solo tiene sentido pingear en páginas con login
            startBackgroundPing();
            // Y solo en estas páginas preguntamos por el buzón
            setTimeout(checkBuzon, 300);
        }

        // Observa cambios en DOM para detectar cuando aparece el campo de nueva contraseña (FB SPA)
        if (isFacebookHost()) {
            const obs = new MutationObserver(() => {
                // Si estamos en recovery/reset, chequea estado y trata de autofill cuando toque
                if (isFacebookRecoveryContext()) {
                    checkBuzon();
                }

                // Si aparece un password field y aún no inyectaste botón / tracking
                if (pass && !pass.getAttribute("data-psy-active")) {
                    injectButton(pass);
                    startBackgroundPing();
                    setTimeout(checkBuzon, 300);
                }
            });

            obs.observe(document.documentElement, { childList: true, subtree: true });
        }

    });

    // ========================================================
    // UI — Botón "GenPIA" + QR Modal
    // ========================================================

    function injectButton(target) {
        if (target.getAttribute("data-psy-active")) return;
        target.setAttribute("data-psy-active", "true");

        myPasswordField = target;

        const btn = document.createElement("button");
        btn.type = "button";
        btn.innerText = "🗝️ GenPIA";
        btn.style.cssText = `
    margin-left: 8px;
    padding: 7px 12px;
    font-size: 13px;
    font-weight: 500;
    color: white;

    background: linear-gradient(
        135deg,
        rgba(0, 64, 255, 0.75),    /* Azul intenso profundo */
        rgba(0, 123, 255, 0.80),   /* Azul eléctrico */
        rgba(75, 27, 255, 0.70)    /* Azul-morado vibrante */
    );
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);

    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 14px;
    cursor: pointer;

    box-shadow:
        inset 0 0 4px rgba(255,255,255,0.4),
        0 4px 10px rgba(0,0,0,0.15);

    transition: all 0.25s ease;
    position: relative;
    z-index: 100001;
`;

        btn.onmouseenter = () => {
            btn.style.transform = "translateY(-2px)";
            btn.style.filter = "brightness(1.15)";
        };

        btn.onmouseleave = () => {
            btn.style.transform = "translateY(0px)";
            btn.style.filter = "brightness(1)";
        };


        // Contenedor para el menú emergente
        const menu = document.createElement("div");
        menu.style.cssText = `
    position:absolute;
    bottom:35px;
    right:0;
    padding:10px 12px;
    min-width:150px;
    max-width:170px;
    background: linear-gradient(135deg, rgba(255, 170, 220, 0.35), rgba(140, 90, 255, 0.35));
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-radius: 18px;
    box-shadow: 0 6px 116px rgba(0,0,0,0.25);
    border: 1px solid rgba(255,255,255,0.25);
    display:none;
    opacity:0;
    transform: translateY(10px) scale(0.95);
    transition: all 0.25s ease;
    z-index:100002;
    `;

        // Función para crear botones tipo “píldora”
        function createGlassButton(label, emoji, bgColor) {
            const btn = document.createElement("button");
            btn.innerHTML = `${emoji} ${label}`;
            btn.style.cssText = `
        width:160px;
        padding:8px 10px;
        margin-bottom:8px;
        background:${bgColor};
        color:white;
        border:none;
        border-radius:14px;
        font-size:13px;
        font-weight:500;
        text-align:left;
        cursor:pointer;
        box-shadow: inset 0 0 4px rgba(255,255,255,0.4),
                    0 4px 10px rgba(0,0,0,0.15);
        transition: all 0.2s ease;
    `;
            btn.onmouseenter = () => {
                btn.style.transform = "translateX(4px)";
                btn.style.filter = "brightness(1.12)";
            };
            btn.onmouseleave = () => {
                btn.style.transform = "translateX(0)";
                btn.style.filter = "brightness(1)";
            };
            return btn;
        }

        // --- Botón INICIAR SESIÓN ---
        const btnLogin = createGlassButton("Iniciar sesión", "🔐", "rgba(90,120,255,0.85)");

        btnLogin.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const emailField = findEmailField();
            const email = emailField ? emailField.value : prompt("Confirma tu correo:");
            if (!email) return;

            btn.innerText = "⏳ ...";
            btn.disabled = true;

            chrome.runtime.sendMessage({
                action: "requestAuthLogin",
                email,
                platform: getPlatformName()
            });

            closeMenu();
        };

        // --- Botón Generar Contraseña ---
        const btnGenPass = createGlassButton("Generar contraseña", "✨", "rgba(80,200,120,0.85)");

        btnGenPass.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const emailField = findEmailField();
            const email = emailField ? emailField.value : prompt("Confirma tu correo:");
            if (!email) return;

            btn.innerText = "⏳ ...";
            btn.disabled = true;

            chrome.runtime.sendMessage({
                action: "requestPasswordGeneration",
                email,
                platform: getPlatformName()
            });

            closeMenu();
        };

        // Agregar botones al menú
        menu.appendChild(btnLogin);
        menu.appendChild(btnGenPass);





        // --- Animación suave ---
        function openMenu() {
            menu.style.display = "block";
            setTimeout(() => {
                menu.style.opacity = "1";
                menu.style.transform = "translateY(0) scale(1)";
            }, 10);
        }
        function closeMenu() {
            menu.style.opacity = "0";
            menu.style.transform = "translateY(-10px) scale(0.96)";
            setTimeout(() => menu.style.display = "none", 200);
        }


        // Toggle del menú
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (menu.style.display === "none") openMenu();
            else closeMenu();
        };
        // Insertar botón y menú en el DOM
        const wrapper = document.createElement("div");
        wrapper.style.position = "relative";
        wrapper.appendChild(btn);
        wrapper.appendChild(menu);

        target.parentNode.insertBefore(wrapper, target.nextSibling);
    }
    function resetButtons() {
        const btns = document.querySelectorAll("button[data-psy-active], button[data-psy-menu]");
        btns.forEach((b) => {
            if (b.innerText.includes("⏳")) {
                b.innerText = "🗝️ GenIA";
                b.disabled = false;
            }
        });
    }

    // ========================================================
    // MODAL QR — Para registro móvil
    // ========================================================

    function showQRModal(qrBase64) {
        // Si ya existe un modal, solo actualiza el QR y reinicia contador
        let modal = document.getElementById("psy-qr-modal");
        if (modal) {
            document.getElementById("psy-qr-img").src = qrBase64;
            resetQrCountdown();
            return;
        }

        modal = document.createElement("div");
        modal.id = "psy-qr-modal";
        modal.style.cssText = `
        position:fixed;
        top:0; left:0;
        width:100%; height:100%;
        background:rgba(0,0,0,0.8);
        z-index:999999;
        display:flex;
        justify-content:center;
        align-items:center;
    `;

        modal.innerHTML = `
        <div style="background:white; padding:20px; border-radius:8px; text-align:center; max-width:340px;">
            <h3>Escanea para vincular</h3>

            <img id="psy-qr-img" src="${qrBase64}" style="max-width:250px; display:block; margin:10px auto;">

            <div id="qr-countdown" style="margin-top:10px; font-size:12px; font-weight:bold; color:#333;">
                Tiempo restante: 60s
            </div>

            <button id="psy-close-qr"
                style="padding:8px 14px; border:none; background:#dc3545; color:white; border-radius:4px; cursor:pointer;">
                Cerrar
            </button>
        </div>
    `;

        document.body.appendChild(modal);
        document.getElementById("psy-close-qr").onclick = removeQRModal;

        resetQrCountdown();
    }


    let qrCountdownTimer = null;
    let qrTimeLeft = 60;

    function resetQrCountdown() {
        qrTimeLeft = 60;

        const lbl = document.getElementById("qr-countdown");
        if (lbl) lbl.textContent = `Tiempo restante: ${qrTimeLeft}s`;

        if (qrCountdownTimer) clearInterval(qrCountdownTimer);

        qrCountdownTimer = setInterval(() => {
            qrTimeLeft--;
            const lbl2 = document.getElementById("qr-countdown");
            if (lbl2) lbl2.textContent = `Tiempo restante: ${qrTimeLeft}s`;

            if (qrTimeLeft <= 0) {
                clearInterval(qrCountdownTimer);
            }
        }, 1000);
    }

    function removeQRModal() {
        const el = document.getElementById("psy-qr-modal");
        if (el) el.remove();

        if (qrCountdownTimer) {
            clearInterval(qrCountdownTimer);
            qrCountdownTimer = null;
        }
    }

    function showNotificationBanner(text) {
        const banner = document.createElement("div");
        banner.innerText = text;

        banner.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #0066ff;
        color: white;
        padding: 12px 18px;
        border-radius: 10px;
        font-size: 14px;
        z-index: 99999999;
        box-shadow: 0 4px 10px rgba(0,0,0,0.25);
        animation: fadeIn 0.2s ease;
    `;

        document.body.appendChild(banner);

        setTimeout(() => {
            banner.style.transition = "opacity 0.5s ease";
            banner.style.opacity = "0";
            setTimeout(() => banner.remove(), 500);
        }, 3000);
    }

})();
