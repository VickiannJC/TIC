// Recibe mensajes desde background.js

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "updateQR") {
        const qrImage = document.getElementById("qrImage");
        qrImage.src = msg.qr;

        const status = document.getElementById("status");
        status.textContent = "Escanea este código con tu dispositivo móvil";
        status.className = "";
    }

    if (msg.action === "qrExpired") {
        const status = document.getElementById("status");
        status.textContent = "QR expirado… generando uno nuevo";
        status.className = "expired";
    }

    if (msg.action === "qrConfirmed") {
        const status = document.getElementById("status");
        status.textContent = "¡QR confirmado!";
        status.className = "success";

        setTimeout(() => {
            window.close();
        }, 1200);
    }
});
