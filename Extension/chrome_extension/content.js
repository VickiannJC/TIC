// ================================================
// 1) AVISAR AL BACKGROUND QUE ESTE CONTENT ESTÁ ACTIVO
// ================================================
try {
    chrome.runtime.sendMessage({ action: "contentReady" });
} catch (e) {
    console.warn("[CS] No se pudo enviar contentReady:", e);
}

// ================================================
// 2) SELECTORES
// ================================================
let targetPasswordField = null;
let lastTabIdUsed = null;
let lastEmailUsed = null;
let lastPlatformUsed = null;

const targetSelector = 'input[type="password"]';
const emailSelector = 'input[type="email"], input#email, input[name="email"]';

// ================================================
// 3) INYECTAR BOTÓN
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
                Registro
            </button>

            <button id="psy-login-button"
                    style="background:#17a2b8; padding:4px 8px; border:none; border-radius:4px; color:white; cursor:pointer;">
                Inicio de sesión
            </button>
        </div>
    `;

    passwordField.parentNode.insertBefore(container, passwordField.nextSibling);

    const mainButton = document.getElementById("psy-main-button");
    const options = document.getElementById("psy-options");
    const btnRegister = document.getElementById("psy-register-button");
    const btnLogin = document.getElementById("psy-login-button");

    mainButton.onclick = () =>
        options.style.display = options.style.display === "none" ? "block" : "none";

    function gatherInfo() {
        const emailField = document.querySelector(emailSelector);
        if (!emailField || !emailField.value.trim()) {
            alert("Por favor ingrese su email.");
            return null;
        }
        return {
            email: emailField.value.trim(),
            platform: document.title || window.location.hostname
        };
    }

    btnRegister.onclick = () => {
        const info = gatherInfo();
        if (!info) return;

        lastEmailUsed = info.email;
        lastPlatformUsed = info.platform;

        btnRegister.disabled = true;
        btnRegister.textContent = "⏳ Registro...";

        chrome.runtime.sendMessage({
            action: "requestRegistration",
            email: lastEmailUsed,
            platform: lastPlatformUsed
        });
    };

    btnLogin.onclick = () => {
        const info = gatherInfo();
        if (!info) return;

        btnLogin.disabled = true;
        btnLogin.textContent = "⏳ Iniciando...";

        chrome.runtime.sendMessage({
            action: "requestAuthLogin",
            email: info.email,
            platform: info.platform
        });
    };
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
chrome.runtime.onMessage.addListener((request, sender) => {

    // Guardar tabId para refrescos
    if (sender?.tab?.id) {
        lastTabIdUsed = sender.tab.id;
        console.log("[CS] Actualizado lastTabIdUsed a", lastTabIdUsed);
    }

    // ========================================
    // REGISTRO → POPUP QR
    // ========================================
    if (request.action === "showRegistrationQR") {

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

            document.getElementById("psy-close-qr").onclick = () => {
                clearInterval(window.psyQRInterval);
                overlay.remove();
            };
        }

        document.getElementById("psy-qr-img").src = request.qrData;
        console.log("[CS] Mostrando QR para:", lastEmailUsed, lastPlatformUsed);

        let t = 60;
        const countdown = document.getElementById("psy-qr-countdown");

        clearInterval(window.psyQRInterval);
        window.psyQRInterval = setInterval(() => {
            if (!document.body.contains(overlay)) {
                clearInterval(window.psyQRInterval);
                return;
            }

            countdown.textContent = `Actualizando QR en ${t}s…`;
            t--;

            if (t <= 0) {
                t = 60;

                chrome.runtime.sendMessage({
                    action: "requestRegistration",
                    email: lastEmailUsed,
                    platform: lastPlatformUsed,
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
        return;
    }
});
