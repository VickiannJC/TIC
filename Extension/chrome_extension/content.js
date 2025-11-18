// Variable global para almacenar el campo de contraseña
let targetPasswordField = null;
const targetSelector = 'input[type="password"]';
const emailSelector = 'input[type="email"], input#email, input[name="email"]'; // Selector robusto para email

// --- Funciones del DOM y Extracción ---

// Crea e inyecta el botón
function injectButton(passwordField) {
    if (document.getElementById('extensionButton')) {
        return; 
    }

    targetPasswordField = passwordField; // Guardamos la referencia global

    const buttonContainer = document.createElement('div');
    buttonContainer.innerHTML = `
        <button id="extensionButton" 
                type="button"
                style="margin-left: 120px; 
                       padding: 5px 10px; 
                       background-color: #007bff; 
                       color: white; 
                       border: none; 
                       border-radius: 4px; 
                       cursor: pointer;">
            🗝️ Autenticar
        </button>
    `;

    passwordField.parentNode.insertBefore(buttonContainer, passwordField.nextSibling);

    const button = document.getElementById('extensionButton');
    
    if (button) {
        button.addEventListener('click', (event) => {
            event.preventDefault(); 

            const emailField = document.querySelector(emailSelector);
            let email = "";
            let platformName = document.title || window.location.hostname;
            
            if (emailField) {
                email = emailField.value.trim();
                if(email === ""){
                    alert("Por favor, ingrese su email.");
                    return;
                }
            } else {
                alert("Error: No se encontró el campo de email. Intente rellenarlo manualmente.");
                return;
            }

            // Deshabilita y cambia el texto del botón mientras espera
            button.textContent = '⏳ Esperando...';
            button.disabled = true;

            // 1. Enviar solicitud de autenticación al Service Worker
            chrome.runtime.sendMessage({
                action: "requestAuthLogin", 
                email: email,
                platform: platformName
            });
        });
    }
}

// OBSERVADOR para inyectar el botón
const observer = new MutationObserver((mutationsList, observer) => {
    const passwordField = document.querySelector(targetSelector);

    if (passwordField) {
        injectButton(passwordField);
        observer.disconnect(); 
    }
});

const observerConfig = { childList: true, subtree: true };
observer.observe(document.body, observerConfig);

const initialPasswordField = document.querySelector(targetSelector);
if (initialPasswordField) {
    injectButton(initialPasswordField);
}

// --- Módulo de Desencriptación Local (SIMULADO) ---

/**
 * Simula el módulo de cálculo local para desencriptar la contraseña.
 * @param {object} keyMaterial - Material de clave y datos cifrados del Servidor Go.
 * @returns {string|null} La contraseña real descifrada.
 */
function decryptPasswordLocally(keyMaterial) {
    // **NOTA:** Aquí se debe integrar tu módulo criptográfico (JS/WebAssembly).
    
    if (keyMaterial && keyMaterial.derived_key && keyMaterial.encrypted_data) {
        console.log("Módulo local: Usando material de clave para descifrar.");
        
        // --- Lógica Simulación ---
        const partialKey = keyMaterial.derived_key.slice(0, 4);
        const partialData = keyMaterial.encrypted_data.slice(-4);
        
        // Retorna la contraseña REAL (simulada)
        return `Contrasena_Real_${partialKey}_${partialData}`;
        // --- Fin Simulación ---
    }
    return null;
}

// --- Listener para el Flujo Final ---

// Recibe el material de clave del Service Worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Escucha la acción 'fillKeyMaterial' que trae el material de clave
    if (request.action === "fillKeyMaterial" && request.keyMaterial) {
        
        const button = document.getElementById('extensionButton');
        const keyMaterial = request.keyMaterial;
        
        if (targetPasswordField) {
            
            // 1. Llamar al módulo local para desencriptar
            const realPassword = decryptPasswordLocally(keyMaterial);
            
            if (!realPassword) {
                 alert("Error: Fallo en la desencriptación local.");
                 // Reestablecer el botón
                 button.textContent = '🗝️ Reintentar';
                 button.disabled = false;
                 return;
            }

            // 2. Rellenar la casilla de contraseña con la clave REAL
            targetPasswordField.value = realPassword;
            
            // 3. Despachar eventos de entrada (necesario)
            targetPasswordField.dispatchEvent(new Event('input', { bubbles: true }));
            targetPasswordField.dispatchEvent(new Event('change', { bubbles: true }));

            // 4. Simular el clic en el botón de envío
            const form = targetPasswordField.closest('form');
            if (form) {
                const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
                if (submitButton) {
                    submitButton.click();
                } else {
                    form.submit();
                }
            }
            
            // 5. Limpieza
            document.getElementById('extensionButton')?.parentNode.remove();
        }
        
        return true; 
    } else if (request.action === "authTimeout") {
        // Manejar el tiempo de espera agotado o error
        const button = document.getElementById('extensionButton');
        if (button) {
             button.textContent = '🗝️ Reintentar';
             button.disabled = false;
        }
        alert(`Fallo en la autenticación: ${request.message || 'Tiempo agotado.'}`);
    }
});