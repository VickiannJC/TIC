// ===============================
// Obtener email desde la página
// ===============================
async function getEmail() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    return new Promise(resolve => {
        chrome.tabs.sendMessage(tab.id, { action: "getEmailField" }, (res) => {
            resolve(res?.email || null);
        });
    });
}

// ===============================
// BOTONES POPUP
// ===============================

// Más información
document.getElementById("btn-info").onclick = () => {
    alert("Psy-Password protege tus cuentas mediante biometría y dispositivos vinculados.");
};

// Recuperar secuencias
document.getElementById("btn-seq").onclick = () => {
    alert("Función disponible próximamente.");
};

// Recuperar contraseña
document.getElementById("btn-pass").onclick = () => {
    alert("Usa tu app móvil vinculada para gestionar recuperación de contraseñas.");
};

// ===============================
// Registrar dispositivo (CORREGIDO)
// ===============================
document.getElementById("btn-reg").onclick = async () => {

    const email = await getEmail();

    if (!email) {
        alert("No se detectó un correo en esta página.");
        return;
    }

    console.log("📤 POPUP → BG: Enviando requestRegistration");

    // Obtener tabId REAL donde se debe mostrar el QR
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {

        const realTabId = tabs[0]?.id;

        chrome.runtime.sendMessage(
            {
                action: "requestRegistration",
                email,
                platform: "Browser",
                tabId: realTabId   // 🔥 envío explícito de tabId
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.warn("Mensaje no entregado:", chrome.runtime.lastError.message);
                    return;
                }
                console.log("Respuesta BG:", response);
            }
        );
    });

    window.close();
};
