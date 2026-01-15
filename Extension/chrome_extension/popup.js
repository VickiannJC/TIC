// ========================================================
// popup.js — Interfaz del Popup de la Extensión
// ========================================================

// Obtener email desde la pestaña activa (content.js lo devuelve)
async function getEmailFromTab() {
    try {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        if (!tab) return null;

        return new Promise((resolve) => {
            chrome.tabs.sendMessage(
                tab.id,
                { action: "getEmailField" },
                (response) => {
                    if (chrome.runtime.lastError) {
                        resolve(null);
                        return;
                    }
                    resolve(response?.email || null);
                }
            );
        });

    } catch (err) {
        console.error("Error obteniendo email desde content script:", err);
        return null;
    }
}

// ========================================================
// BOTONES DEL POPUP
// ========================================================

// Información
document.getElementById("btn-info").onclick = () => {
    alert("Psy-Password protege tus cuentas mediante biometría y dispositivos vinculados.");
};
/** 
// Secuencias (placeholder)
document.getElementById("btn-seq").onclick = () => {
    alert("Función disponible próximamente.");
};

// Recuperación de contraseña (placeholder)
document.getElementById("btn-pass").onclick = () => {
    alert("Usa tu app móvil vinculada para gestionar recuperación de contraseñas.");
};
*/

// ========================================================
// REGISTRO — Botón "Registrar Móvil"
// ========================================================

document.getElementById("btn-reg").onclick = async () => {
    try {
        // Obtener pestaña activa
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            alert("No se encontró una pestaña activa.");
            return;
        }

        // Intentar obtener email desde el content script
        const email = await getEmailFromTab();

        if (!email) {
            alert("No se detectó un correo. Escríbelo en el formulario primero.");
            return;
        }

        // Enviar mensaje al background, siempre con tabId explícito
        chrome.runtime.sendMessage(
            {
                action: "requestRegistration",
                email,
                platform: "Web", // Puedes mejorar esto si quieres detectar plataforma real
                tabId: tab.id
            },
            (res) => {
                // Opcional: validar que recibió la orden
                if (chrome.runtime.lastError) {
                    console.error("Error enviando mensaje al background:", chrome.runtime.lastError);
                }
            }
        );

        // Cerrar popup
        window.close();

    } catch (err) {
        console.error("Error al activar registro móvil:", err);
        alert("Ocurrió un error al iniciar la vinculación.");
    }
};