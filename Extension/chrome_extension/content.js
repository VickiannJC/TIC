// =====|===============================================
// Limpiar variables de la extension
// ================================================
lastEmailUsed = null;
lastPlatformUsed = null;
window.psyLastEmail = null;
window.psyLastPlatform = null;

// Identificar este frame
const PSY_FRAME_ID = Math.random().toString(36).substring(2, 10);

function contentScriptBootstrap() {
    //================================================
    // AVISAR AL BACKGROUND QUE ESTE CONTENT ESTÁ ACTIVO
    // ================================================
    try {
        console.log("[CS] contentReady en frame:", window.location.href, "frameId:", document.location);
        chrome.runtime.sendMessage({
            action: "contentReady",
            href: window.location.href,
            frameId: PSY_FRAME_ID
        });

    } catch (e) {
        console.warn("[CS] No se pudo enviar contentReady:", e);
    }

    // ==============================================
    // Detener intervalos si la página cambia o recarga
    // ==============================================
    window.addEventListener("beforeunload", () => {
        if (window.psyQRInterval) {
            clearInterval(window.psyQRInterval);
            window.psyQRInterval = null;
        }
    });

    // ==============================================
    // Detener intervalos cuando Facebook cambia de vista (SPA navigation)
    // ==============================================
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (window.psyQRInterval) {
                clearInterval(window.psyQRInterval);
                window.psyQRInterval = null;
            }
        }
    });



    // ==============================================
    // Protecciones globales contra invalidación del context
    // ==============================================


    window.addEventListener("pagehide", () => {
        if (window.psyQRInterval) {
            clearInterval(window.psyQRInterval);
            window.psyQRInterval = null;
        }
    });

    window.addEventListener("visibilitychange", () => {
        if (document.hidden && window.psyQRInterval) {
            clearInterval(window.psyQRInterval);
            window.psyQRInterval = null;
        }
    });





    // ================================================
    // 2) SELECTORES
    // ================================================
    let targetPasswordField = null;
    let lastTabIdUsed = null;


    const targetSelector = 'input[type="password"]';
    const emailSelector = 'input[type="email"], input#email, input[name="email"]';

    //===============================================
    // RESET ESTADO -> Evitar usar email/plataforma viejos
    // ================================================
    function resetPsyState() {
        lastEmailUsed = null;
        lastPlatformUsed = null;
        window.psyLastEmail = null;
        window.psyLastPlatform = null;
    }

    function getCleanPlatformName() {
        try {
            let host = window.location.hostname.toLowerCase();

            // Quitar caracteres raros
            host = host.replace(/[^a-z0-9.]/g, "");

            // Dominio base sin subdominios
            const parts = host.split(".");
            const domain = parts[parts.length - 2] || "";

            // Mapeo manual para nombres bonitos
            if (host.includes("facebook")) return "Facebook";
            if (host.includes("google")) return "Google";
            if (host.includes("instagram")) return "Instagram";
            if (host.includes("twitter")) return "Twitter";
            if (host.includes("x.com")) return "Twitter";
            if (host.includes("amazon")) return "Amazon";
            if (host.includes("microsoft")) return "Microsoft";
            if (host.includes("live.com")) return "Microsoft";
            if (host.includes("github")) return "GitHub";
            if (host.includes("linkedin")) return "LinkedIn";

            // Si no está en la lista, devolver dominio capitalizado:
            return domain.charAt(0).toUpperCase() + domain.slice(1);

        } catch (err) {
            console.warn("Error detectando plataforma:", err);
            return "Unknown";
        }
    }


    // ================================================
    // MODAL ELEGANTE UNIVERSAL
    // ================================================
    function showPsyModal(message, isError = true) {
        let overlay = document.getElementById("psy-alert-overlay");

        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "psy-alert-overlay";
            overlay.style.cssText = `
            position:fixed; top:0; left:0;
            width:100vw; height:100vh;
            display:flex; justify-content:center; align-items:center;
            backdrop-filter:blur(3px);
            background:rgba(0,0,0,0.55);
            z-index:999999;
        `;

            //  bloquear clics que atraviesan
            ["click", "touchstart", "pointerdown"].forEach(ev => {
                overlay.addEventListener(ev, e => {
                    e.stopPropagation();
                    e.preventDefault();
                });
            });

            const box = document.createElement("div");
            box.id = "psy-alert-box";
            box.style.cssText = `
            background:white;
            padding:20px;
            border-radius:14px;
            width:90%; max-width:360px;
            text-align:center;
        `;

            const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
            box.style.background = dark ? "#1f1f1f" : "#ffffff";
            box.style.color = dark ? "#fff" : "#111";

            box.innerHTML = `
            <h3>${isError ? "⚠️ Aviso" : "ℹ️ Información"}</h3>
            <p id="psy-alert-text" style="margin:10px 0 15px 0;"></p>
            <button id="psy-alert-close"
                style="padding:10px 18px; background:#0066ff; color:white; border:none; border-radius:8px;">
                Cerrar
            </button>
        `;

            // bloquear clics dentro de la caja
            ["click", "touchstart", "pointerdown"].forEach(ev => {
                box.addEventListener(ev, e => {
                    e.stopPropagation();
                });
            });

            overlay.append(box);
            document.body.append(overlay);

            document.getElementById("psy-alert-close").addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                overlay.remove();
                resetAuthButtons();
            });
        }

        document.getElementById("psy-alert-text").innerText = message;
    }

    // Listener único para resetear estado cuando el usuario escribe email
    document.addEventListener("input", (e) => {
        if (e.target.matches('input[type="email"], input#email, input[name="email"]')) {
            resetPsyState();
        }
    });


    // ================================================
    // INYECTAR BOTÓN
    // ================================================
    function injectButton(passwordField) {
        if (document.getElementById("psy-main-button")) return;

        targetPasswordField = passwordField;

        const container = document.createElement("div");
        container.id = "psy-container";
        container.style.marginTop = "8px";

        container.innerHTML = `
        <button id="psy-main-button"
                type="button"
                style="margin-left: 120px;
                padding: 5px 10px;
                background-color: #007bff;
                color:white;
                border:none;
                border-radius:4px;
                cursor:pointer;">
            🗝️ Autenticar
        </button>

        <div id="psy-options" style="display:none; margin-left:120px; margin-top:5px;">
            <button id="psy-register-button"
                    style="background:#28a745; padding:4px 8px; border:none; border-radius:4px; color:white; cursor:pointer; margin-right:6px;">
                Generar Contraseña
            </button>

            <button id="psy-login-button"
                    style="background:#17a2b8; padding:4px 8px; border:none; border-radius:4px; color:white; cursor:pointer;">
                Inicio de sesión
            </button>
        </div>
    `;



        //====================================================
        // BOTONES AL LADO DE TEXTBOX PASSWORD

        passwordField.parentNode.insertBefore(container, passwordField.nextSibling);


        const mainButton = document.getElementById("psy-main-button");
        const options = document.getElementById("psy-options");
        const btnRegister = document.getElementById("psy-register-button");
        const btnLogin = document.getElementById("psy-login-button");

        mainButton.onclick = () =>
            options.style.display = options.style.display === "none" ? "block" : "none";

        function gatherInfo() {

            const emailField = document.querySelector(emailSelector);
            // Reiniciar estado si el usuario cambia el email


            if (!emailField) {
                showPsyModal("No se encontró un campo de correo electrónico.");
                return null;
            }

            const email = emailField.value.trim();
            if (!email) {
                showPsyModal("Por favor ingresa tu correo electrónico.");
                return null;
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                showPsyModal("El formato del correo no es válido.");
                return null;
            }

            return {
                email,
                platform: getCleanPlatformName() || "Unknown"
            };
        }

        btnRegister.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();

            // Nueva función: Generar contraseña (a definir)
            showPsyModal("Función 'Generar contraseña' disponible para implementación.", false);
        });


        btnLogin.addEventListener("click", (e) => {

            // Bloquear clics fantasma
            e.stopPropagation();
            e.preventDefault();

            const info = gatherInfo();
            if (!info) return;

            btnLogin.disabled = true;
            btnLogin.textContent = "⏳ Iniciando...";

            chrome.runtime.sendMessage({
                action: "requestAuthLogin",
                email: info.email,
                platform: getCleanPlatformName() || "Unknown"
            });
        });
    }

    //======================================================================
    // Función para resetear botones y que el usuario no quede atrapado
    //======================================================================
    function resetAuthButtons() {
        const btnRegister = document.getElementById("psy-register-button");
        const btnLogin = document.getElementById("psy-login-button");

        if (btnRegister) {
            btnRegister.disabled = false;
            btnRegister.textContent = "Registro";
        }

        if (btnLogin) {
            btnLogin.disabled = false;
            btnLogin.textContent = "Inicio de sesión";
        }
    }

    //============================================
    //  FUNCIÓN PARA LIMPAR NOMBRE DE PLATAFORMA
    //============================================

    function getCleanPlatformName() {
        try {
            const host = window.location.hostname;

            // Quitar subdominios tipo: www.facebook.com → facebook
            const parts = host.split(".");

            // Manejo especial para dominios como:
            //   accounts.google.com → google
            //   m.facebook.com → facebook
            //   login.live.com → live
            //   id.apple.com → apple
            let domain = parts[parts.length - 2];

            // Quitar cualquier caracter raro
            domain = domain.replace(/[^a-zA-Z0-9]/g, "");

            // Convertir a PascalCase para que se vea bonito: Facebook, Google, Amazon
            return domain.charAt(0).toUpperCase() + domain.slice(1);

        } catch (e) {
            console.warn("Error leyendo plataforma:", e);
            return "SitioDesconocido";
        }
    }



    // Inject al detectar campo password
    const obs = new MutationObserver(() => {
        const field = document.querySelector(targetSelector);
        if (field) {
            injectButton(field);
            obs.disconnect();
        }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    if (document.querySelector(targetSelector))
        injectButton(document.querySelector(targetSelector));

    // ======================================================
    // 4) DESCIFRADO SIMULADO
    // ======================================================
    function decryptPasswordLocally(keyMaterial) {
        if (!keyMaterial?.derived_key) return null;
        return `PWD_${keyMaterial.derived_key.slice(0, 4)}_${keyMaterial.encrypted_data.slice(-4)}`;
    }

    // ======================================================
    // 5) LISTENER – QR / LOGIN
    // ======================================================
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

        // Guardar tabId para refrescos
        if (sender?.tab?.id) {
            lastTabIdUsed = sender.tab.id;
            console.log("[CS] Actualizado lastTabIdUsed a", lastTabIdUsed);
        }

        //Refrescar botones para que no se bloqueen
        if (request.action === "resetAuthButtons") {
            resetAuthButtons();
            return;
        }



        // REGISTRO → POPUP QR
        if (request.action === "showRegistrationQR" && request.qrData) {

            window.psyLastEmail = request.email;
            window.psyLastPlatform = request.platform;
            // Guardar email y plataforma
            if (request.email) lastEmailUsed = request.email;
            if (request.platform) lastPlatformUsed = request.platform;
            console.log("[CS] showRegistrationQR para", lastEmailUsed, lastPlatformUsed);

            let overlay = document.getElementById("psy-qr-popup");

            if (!overlay) {
                overlay = document.createElement("div");
                overlay.id = "psy-qr-popup";
                overlay.style.cssText = `
                position:fixed; top:0; left:0; width:100vw; height:100vh;
                display:flex; justify-content:center; align-items:center;
                backdrop-filter:blur(4px); background:rgba(0,0,0,0.55);
                z-index:999999;
            `;

                const box = document.createElement("div");
                box.style.cssText = `
                padding:20px; border-radius:14px; width:360px; max-width:90%;
                text-align:center;
            `;

                const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                box.style.background = dark ? "#1e1e1e" : "#fff";
                box.style.color = dark ? "#eee" : "#111";

                box.innerHTML = `
                <h2>Escanea este QR</h2>
                <p>Escanéalo con tu celular para continuar el registro.</p>
                <div id="psy-qr-countdown"></div>
                <img id="psy-qr-img" style="width:100%; max-width:260px; border-radius:8px;">
                <br><br>
                <button id="psy-close-qr" style="padding:10px 18px; background:#0066ff; color:#fff; border:none; border-radius:8px;">Cerrar</button>
            `;

                overlay.append(box);
                document.body.append(overlay);

                document.getElementById("psy-close-qr").addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    clearInterval(window.psyQRInterval);
                    overlay.remove();
                    resetAuthButtons();
                });

            }

            document.getElementById("psy-qr-img").src = request.qrData;
            console.log("[CS] Mostrando QR para:", lastEmailUsed, lastPlatformUsed);

            let t = 60;
            const countdown = document.getElementById("psy-qr-countdown");

            clearInterval(window.psyQRInterval);

            window.psyQRInterval = setInterval(() => {

                // Si el overlay ya no existe → matar intervalo inmediatamente
                const overlay = document.getElementById("psy-qr-popup");
                if (!overlay) {
                    clearInterval(window.psyQRInterval);
                    return;
                }

                countdown.textContent = `Actualizando QR en ${t}s…`;
                t--;

                if (t <= 0) {

                    // ⚠ PROTECCIÓN ANTI-CONTEXT INVALIDADO
                    if (!chrome.runtime?.id) {
                        clearInterval(window.psyQRInterval);
                        return;
                    }
                    showPsyModal("⚠️ Este QR ha expirado. Generando uno nuevo…", false);
                    t = 60;

                    chrome.runtime.sendMessage({
                        action: "requestRegistration",
                        email: window.psyLastEmail,
                        platform: window.psyLastPlatform ?? "Browser",
                        tabId: lastTabIdUsed
                    });
                }

            }, 1000);


            return;
        }

        // ========================================
        // LOGIN
        // ========================================
        if (request.action === "fillKeyMaterial") {

            const pwd = decryptPasswordLocally(request.keyMaterial);
            if (pwd && targetPasswordField) {
                targetPasswordField.value = pwd;
                targetPasswordField.dispatchEvent(new Event("input", { bubbles: true }));
                targetPasswordField.dispatchEvent(new Event("change", { bubbles: true }));

                const form = targetPasswordField.closest("form");
                if (form) form.submit();
            }
            return;
        }

        // ========================================
        // ERRORES
        // ========================================
        if (request.action === "authTimeout") {
            alert("Error: " + request.message);
            resetAuthButtons();
            return;
        }

        if (request.action === "emailAlreadyRegistered") {
            showPsyModal(request.message || "Este correo ya está registrado.");
            resetAuthButtons();
            return;
        }
        if (request.action === "updateEmailContext") {
            if (request.email) {
                window.psyLastEmail = request.email;
                lastEmailUsed = request.email;
            }
            if (request.platform) {
                window.psyLastPlatform = request.platform;
                lastPlatformUsed = request.platform;
            }
            return;
        }

        if (request.action === "emailAlreadyRegistered") {
            // 🔥 asegurarnos que el email está sincronizado
            if (!lastEmailUsed && request.email) {
                lastEmailUsed = request.email;
                window.psyLastEmail = request.email;
            }

            showPsyModal(request.message || "Este correo ya está registrado.");
            resetAuthButtons();
            return;
        }

        if (request.action === "updateContext") {
            console.log("🔥 Contexto recibido desde background:", request.email, request.platform);

            window.psyLastEmail = request.email;
            window.psyLastPlatform = request.platform;

            // actualizar último tab
            lastTabIdUsed = sender?.tab?.id || lastTabIdUsed;

            sendResponse({ ok: true });
            return true;
        }

        if (request.action === "getEmailField") {

            const emailSelector = `
            input[type="email"],
            input[id*="email"],
            input[name*="email"],
            input[autocomplete="email"],
            input[type="text"][id*="user"],
            input[type="text"][name*="user"],
            input[type="text"][placeholder*="mail"],
            input[type="text"][placeholder*="correo"],
            input[type="text"][placeholder*="email"]
        `;

            const emailField = document.querySelector(emailSelector);

            sendResponse({
                email: emailField ? emailField.value.trim() : null
            });
        }





    });

}

function startBootstrapInThisFrame() {
    if (!document.body) {
        setTimeout(startBootstrapInThisFrame, 50);
        return;
    }
    contentScriptBootstrap();
    console.log("[CS] Bootstrap arrancado en frame principal.");
}

startBootstrapInThisFrame();


/************************************************************
 * 3) DETECTAR IFRAMES DINÁMICOS Y BOOTSTRAPEARLOS
 ************************************************************/
function tryInjectIntoIframe(iframe) {
    try {
        chrome.runtime.sendMessage({
            action: "injectIntoIframe",
            iframeSrc: iframe.src || "inline"
        });


        chrome.scripting.executeScript({
            target: { tabId: tabId, frameIds: [iframeFrameId] },
            func: contentScriptBootstrap
        });

        console.log("[CS] Bootstrap inyectado en iframe dinámico.");
    } catch (e) {
        console.warn("[CS] No se pudo inyectar en iframe:", e);
    }
}

function startIframeObserver() {
    if (!document.body) {
        setTimeout(startIframeObserver, 50);
        return;
    }

    new MutationObserver((mut) => {
        for (const m of mut) {
            for (const node of m.addedNodes) {
                if (node.tagName === "IFRAME") {
                    tryInjectIntoIframe(node);
                }
            }
        }
    }).observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log("[CS] MutationObserver de iframes iniciado en este frame.");
}

startIframeObserver();

