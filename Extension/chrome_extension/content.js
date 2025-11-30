// ========================================================
// content.js — Script inyectado en todas las páginas
// ========================================================

// Estado interno local del content script
let myPasswordField = null;

// ========================================================
// 1) DETECCIÓN DE CAMPOS DEL SITIO
// ========================================================

// Encuentra un campo de contraseña visible (mejorado)
function findPasswordField() {
    const selectors = [
        'input[type="password"]',
        'input[name*="pass"]',
        'input[id*="pass"]'
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

function findEmailField() {
    return document.querySelector(
        'input[type="email"], input[name*="email"], input[name*="user"], input[id*="email"], input[id*="user"]'
    );
}

// Detectar plataforma a partir del dominio
function getPlatformName() {
    const host = window.location.hostname;
    const parts = host.split('.');
    const domain = parts.length > 1 ? parts[parts.length - 2] : host;
    return domain.charAt(0).toUpperCase() + domain.slice(1);
}

// ========================================================
// 2) BUZÓN (ASK BACKGROUND FOR SESSION STATE)
// ========================================================

function checkBuzon() {
    try {
        chrome.runtime.sendMessage({ action: "checkAuthStatus" }, (response) => {
            if (chrome.runtime.lastError) {
                return; // Tab cerrándose o contexto inválido
            }
            if (!response) return;

            handleServerResponse(response);
        });
    } catch (e) {
        // Es normal si el frame fue recargado
    }
}

// ========================================================
// 3) RESPUESTAS DEL BACKGROUND
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
        alert("Psy-Password: " + data.error);
        removeQRModal();
        resetButtons();
    }
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

// ========================================================
// 4) LISTENERS — Broadcast desde background
// ========================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // background → “hay actualización de estado”
    if (msg.action === "authStatusUpdated") {
        console.log("[CS] Notificación recibida — revisando buzón...");
        checkBuzon();
    }

    // popup.js pide email
    if (msg.action === "getEmailField") {
        const emailEl = findEmailField();
        sendResponse({ email: emailEl ? emailEl.value : null });
    }
});

// Cuando el frame termina de cargar, checkear buzón + inyectar botón
document.addEventListener("DOMContentLoaded", () => {
    setTimeout(checkBuzon, 300);

    const pass = findPasswordField();
    if (pass) injectButton(pass);
});

// ========================================================
// 5) UI — Botón "🗝️ Psy-Auth" + QR Modal
// ========================================================

function injectButton(target) {
    if (target.getAttribute("data-psy-active")) return;
    target.setAttribute("data-psy-active", "true");

    myPasswordField = target;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerText = "🗝️ Psy-Auth";
    btn.style.cssText = `
        margin-left:5px;
        background:#007bff;
        color:white;
        border:none;
        padding:5px 8px;
        border-radius:4px;
        cursor:pointer;
        z-index:100000;
        position:relative;
        font-size:14px;
    `;

    target.parentNode.insertBefore(btn, target.nextSibling);

    btn.onclick = (e) => {
        e.preventDefault();

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
    };
}

function resetButtons() {
    const btns = document.querySelectorAll("button");
    btns.forEach((b) => {
        if (b.innerText.includes("⏳")) {
            b.innerText = "🗝️ Psy-Auth";
            b.disabled = false;
        }
    });
}

// ========================================================
// 6) MODAL QR — Para registro móvil
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

