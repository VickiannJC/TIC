require("dotenv").config();

const express = require('express');
const bodyParser = require('body-parser');
const webpush = require('web-push');
const cors = require('cors');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const path = require('path');
const jwt = require("jsonwebtoken");
const fs = require("fs");
// const fetch = require("node-fetch");

// Modelos de MongoDB
const Subscripcion = require('./modelosDB/Subscripciones');
const Temporal = require('./modelosDB/temporales');
const QRSession = require('./modelosDB/QRSession');

// Configuracion y claves VAPID
const config = require('./config');


const app = express();
const PORT = process.env.PORT;

const BIOMETRIA_BASE_URL = process.env.BIOMETRIA_BASE_URL || 'https://unsignatured-isabella-hasty.ngrok-free.dev';
const BIOMETRIA_API_KEY = process.env.BIOMETRIA_API_KEY;
const BIOMETRIA_JWT_PUBLIC_KEY = process.env.BIOMETRIA_JWT_PUBLIC_KEY;

const ANALYSIS_BASE_URL = process.env.ANALYSIS_BASE_URL;


// Timeout máximo esperando callback de biometría en registro (ms)
const BIOMETRIA_REG_TIMEOUT = 60000; // 60s
// Mapa en memoria: email → timer
const biometricRegTimers = new Map();


// Configuraciones VAPID
webpush.setVapidDetails(
    config.VAPID_EMAIL,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
);

// Conexion a MongoDB
mongoose.connect(config.MONGODB_URI)
    .then(() => console.log('Conectado a MongoDB'))
    .catch(err => console.error('Error al conectar a MongoDB:', err));

// Middlewares
app.use(cors());
app.use(bodyParser.json());

//CARGAR TEMPLATES
function loadTemplate(name) {
    const filePath = path.join(__dirname, "templates", name);
    return fs.readFileSync(filePath, "utf8");
}

// Genera un TOKEN DE DESBLOQUEO Temporal (para login)
function generateToken() {
    return Math.random().toString(36).slice(-8);
}

// Enviar notificación push al usuario
async function sendPushNotification(subscription, payload) {
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log('Notificación enviada con éxito');
        return { success: true };
    } catch (error) {
        console.error('Error al enviar la notificación:', error.statusCode);

        if (error.statusCode === 404 || error.statusCode === 410) {
            await Subscripcion.deleteOne({ 'subscription.endpoint': subscription.endpoint });
            console.log('Subscripción eliminada de la base de datos debido a error 404/410');
        }
        return { success: false, error };
    }
}

// ===============================
// ENDPOINTS REGISTRO / VINCULACIÓN
// ===============================

app.post("/generar-qr-sesion", async (req, res) => {
    try {
        const { email, platform } = req.body;

        if (!email || !platform) {
            return res.status(400).json({ error: "Email y plataforma requeridos" });
        }

        console.log(`🧹 Limpieza previa completada para: ${email}`);
        await QRSession.deleteMany({ email }); // SOLO limpiar sesiones QR previas

        // Crear nuevo ID de sesión
        const sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;

        await QRSession.create({
            sessionId,
            email,
            platform,
            estado: "pending"
        });

        // Construir URL base dinámica (ngrok, producción, localhost)
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const baseUrl = `${proto}://${host}`;

        // URL de registro móvil
        const registerUrl = `${baseUrl}/mobile_client/register-mobile.html?sessionId=${sessionId}`;

        // Construir QR
        const qrDataUrl = await qrcode.toDataURL(registerUrl);

        return res.json({
            qr: qrDataUrl,
            sessionId
        });

    } catch (err) {
        console.error("❌ Error en /generar-qr-sesion:", err);
        return res.status(500).json({
            error: "Error interno",
            detail: err.message
        });
    }
});


// Registro de subscripción del movil (cuando escanean el QR)
app.post('/register-mobile', async (req, res) => {
    const { sessionId, subscription } = req.body;

    console.log("📨 /register-mobile llamado");
    console.log("📨 BODY:", req.body);

    try {

        const sessionData = await QRSession.findOne({ sessionId });


        if (!sessionData) {
            return res.status(404).json({
                error: "session_not_found",
                message: "Este QR ya expiró o no existe."
            });
        }

        // SOLO GUARDAMOS TEMPORALMENTE la suscripción en QRSession (NO registrar aún)
        sessionData.subscription = subscription;
        await sessionData.save();
        console.log("Subscripción guardada temporalmente para:", sessionData.email);


        // -------------- VALIDACIÓN DE EMAIL DUPLICADO --------------
        const existing = await Subscripcion.findOne({ email: sessionData.email });

        if (existing) {
            console.log("❌ BLOQUEADO: email YA existe:", sessionData.email);

            return res.status(409).json({
                error: "email_exists",
                message: "Este correo ya está registrado en otro dispositivo."
            });
        }

        // Enviar push para confirmar registro
        const payload = {
            title: 'Confirmar Registro',
            body: 'Toca para confirmar la vinculación del dispositivo.',
            actionType: 'register',
            sessionId,
            email: sessionData.email
        };

        await sendPushNotification(subscription, payload);

        return res.status(200).json({ message: "pending_confirmation" });

    } catch (err) {
        console.error(" Error en /register-mobile:", err);
        return res.status(500).json({ error: "server_error" });
    }
});


// ===============================
// ENDPOINTS AUTENTICACIÓN (LOGIN)
// ===============================

app.post('/request-auth-login', async (req, res) => {
    const { email, platform } = req.body;

    const subDoc = await Subscripcion.findOne({ email: email });
    if (!subDoc) {
        return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
    }

    const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
    const newChallenge = new Temporal({ email, challengeId: challengeId, platform: platform || "Unknown" });
    await newChallenge.save();

    const payload = {
        title: 'Solicitud de Inicio de Sesión',
        body: `Se ha solicitado acceso a ${email}. Toque "Autenticar" para continuar.`,
        actionType: 'auth',
        sessionId: challengeId
    };

    const pushResult = await sendPushNotification(subDoc.subscription, payload, challengeId);

    if (!pushResult.success) {
        return res.status(500).json({ error: 'Fallo al enviar notificación Push.' });
    }

    res.status(200).json({
        message: 'Solicitud enviada al móvil.',
        challengeId: challengeId
    });
});

// Móvil confirma o rechaza autenticación
app.get('/mobile_client/auth-confirm', async (req, res) => {
    const { sessionId: challengeId, status } = req.query;

    const challenge = await Temporal.findOne({ challengeId: challengeId });

    if (!challenge) {
        return res.status(404).send('Desafío de autenticación no válido o expirado.');
    }

    if (challenge.status !== 'pending') {
        return res.send(`<h1>Acción Previa</h1><p>Este desafío ya fue procesado.</p>`);
    }

    //Usuario confirmó en el móvil

    if (status === 'confirmed') {
        const sessionToken = generateToken();

        challenge.token = sessionToken;
        challenge.status = 'confirmed';
        await challenge.save();

        // Ahora llamar a BIOMETRÍA para la autenticación
        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), 30000); // 30s login timeout

            const respBio = await fetch(`${BIOMETRIA_BASE_URL}/api/auth-login`, {
                method: "POST",
                signal: ctrl.signal,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${BIOMETRIA_API_KEY}`
                },
                body: JSON.stringify({
                    action: "login",
                    authenticated: true,
                    email: challenge.email,
                    plataforma: challenge.platform,
                    sessionToken
                })
            });

            clearTimeout(timeout);

            if (!respBio.ok) {
                console.error("❌ Error HTTP biometría login:", respBio.status);
                challenge.status = 'biometria_failed';
                await challenge.save();

                return res.send(`
                    <h1>Autenticación incompleta</h1>
                    <p>El módulo biométrico no aceptó la autenticación.</p>
                `);
            }

            const dataBio = await respBio.json();
            console.log("🔐 Biometría (login) respuesta:", dataBio);

            if (!dataBio.success) {
                challenge.status = 'biometria_failed';
                await challenge.save();
                return res.send('<h1>Autenticación Rechazada</h1><p>El módulo biométrico rechazó el inicio de sesión.</p>');
            }

            // Verificar JWT de biometría antes de dejar pasar al Key Manager
            const jwtCheck = verifyBiometriaJwt(dataBio.jwt);
            if (!jwtCheck.ok) {
                challenge.status = 'biometria_failed';
                await challenge.save();
                return res.send(`
                    <h1>Error de validación</h1>
                    <p>La firma del módulo biométrico no es válida.</p>
                `);
            }

            // Marcamos que todo está OK con biometría
            challenge.status = 'biometria_ok';
            challenge.userBiometriaId = dataBio.idUsuario;
            challenge.biometriaJwt = dataBio.jwt;
            await challenge.save();

            return res.send(`
                <h1>Autenticación Exitosa</h1>
                <p>Ahora puede cerrar esta ventana. El plugin completará el inicio de sesión.</p>
            `);

        } catch (err) {
            console.error("❌ Error llamando a biometría (login):", err);
            challenge.status = 'biometria_failed';
            await challenge.save();

            return res.send(`
                <h1>Error de comunicación</h1>
                <p>No se pudo completar la autenticación con el módulo biométrico.</p>
            `);
        }

    } else {
        // Usuario tocó "Rechazar"
        challenge.status = 'denied';
        await challenge.save();

        // Opcional: avisar a biometría que se denegó
        try {
            await fetch(`${BIOMETRIA_BASE_URL}/api/auth-login`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${BIOMETRIA_API_KEY}`
                },
                body: JSON.stringify({
                    action: "login",
                    authenticated: false,
                    email: challenge.email,
                    plataforma: challenge.platform
                })
            });
        } catch (err) {
            console.error("Error notificando denegación a biometría:", err);
        }

        return res.send('<h1>Autenticación Rechazada</h1><p>El inicio de sesión fue denegado por el usuario.</p>');
    }
});

// ======================================================
// CONFIRMACIÓN DE REGISTRO DESDE EL MÓVIL
// ======================================================
app.get("/mobile_client/register-confirm", (req, res) => {
    const { email, sessionId } = req.query;

    if (!email || !sessionId) {
        
        const errorTemplate = loadTemplate("error_estetico.html");
        return res.send(errorTemplate.replace("{{ERROR_MESSAGE}}", "Faltan datos necesarios."));
    }

    const biometriaURL = `${BIOMETRIA_BASE_URL}/biometric/register?email=${encodeURIComponent(email)}&session=${sessionId}`;
    const html = loadTemplate("registro_estetico.html")
        .replace("{{BIOMETRIA_URL}}", biometriaURL)
        .replace("{{CONTINUE_URL}}", `/mobile_client/register-confirm?email=${encodeURIComponent(email)}&sessionId=${sessionId}`);

    res.send(html);
});

app.post("/mobile_client/register-confirm", async (req, res) => {
    try {
        const { sessionId } = req.query;
        const { subscription, userEmail } = req.body;

        if (!sessionId || !userEmail || !subscription)
            return res.status(400).send("Datos incompletos");

        // Buscar sesión
        const session = await QRSession.findOne({ sessionId });
        if (!session) {
            return res.send("<h1>Sesión expirada</h1><p>Escanea el QR nuevamente.</p>");
        }

        // Guardar suscripción móvil
        await Subscripcion.updateOne(
            { email: userEmail },
            { subscription },
            { upsert: true }
        );

        // URL a la que el usuario debe ser enviado
        const biometriaURL = `${BIOMETRIA_BASE_URL}/biometric/register?email=${encodeURIComponent(userEmail)}&session=${sessionId}`;
        const continueURL = `/mobile_client/register-confirm?email=${encodeURIComponent(userEmail)}&sessionId=${sessionId}`;


        let html = loadTemplate("registro_estetico.html");

html = html
    .replace("{{BIOMETRIA_URL}}", biometriaURL)
    .replace("{{CONTINUE_URL}}", continueURL);

res.send(html);

        // → BIOMETRIA EN SEGUNDO PLANO
        setTimeout(async () => {
            try {
                await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/check-user`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${BIOMETRIA_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: userEmail,
                        session_token: sessionId,
                        action: "registro"
                    })
                });
                session.estado = "confirmed";
                await session.save();
            } catch (err) {
                console.error("Error biometría:", err);
            }
        }, 10);

    } catch (err) {
        console.error("Error en /register-confirm:", err);
        return res.status(500).send("Error interno");
    }
});





// Polling del estado del token (llamado por la extensión)
app.get('/check-password-status', async (req, res) => {
    const { email } = req.query;

    // Buscar challenge con biometría OK
    const okChallenge = await Temporal.findOne({
        email: email,
        status: 'biometria_ok'
    }).sort({ createdAt: -1 });

    if (okChallenge) {
        return res.status(200).json({
            status: 'authenticated',
            token: okChallenge.token   // este es el que usas para el Key Manager
        });
    }

    // Luego ver si hay alguno denegado o fallido
    const badChallenge = await Temporal.findOne({
        email: email,
        status: { $in: ['denied', 'biometria_failed'] }
    }).sort({ createdAt: -1 });

    if (badChallenge) {
        return res.status(200).json({ status: 'denied' });
    }

    // Si no hay nada definitivo aún → pending
    return res.status(200).json({ status: 'pending' });
});

app.post('/api/biometria/registro-resultado', async (req, res) => {
    const auth = req.headers.authorization || "";
    const token = auth.replace("Bearer ", "");

    if (token !== BIOMETRIA_API_KEY) {
        return res.status(401).json({ error: "unauthorized" });
    }

    const {
        email,
        sessionToken,
        success,
        idUsuario,
        jwt: biomJwt,
        cadenaValores,
        apiKey // si ellos te devuelven otra API key asociada a ese usuario
    } = req.body;

    if (!email || !sessionToken) {
        return res.status(400).json({ error: "email_and_sessionToken_required" });
    }

    // Parar temporizador
    if (biometricRegTimers.has(email)) {
        clearTimeout(biometricRegTimers.get(email));
        biometricRegTimers.delete(email);
    }

    // Buscar el Temporal asociado
    const temp = await Temporal.findOne({
        email,
        token: sessionToken,
        challengeId: { $regex: /^REG_/ }
    });

    if (!temp) {
        console.warn("⚠ Resultado biometría para registro sin Temporal activo:", email);
        return res.status(404).json({ error: "registration_session_not_found" });
    }

    if (!success) {
        temp.status = 'biometria_failed';
        await temp.save();
        return res.json({ ok: true });
    }

    // Verificar JWT de biometría
    const jwtCheck = verifyBiometriaJwt(biomJwt);
    if (!jwtCheck.ok) {
        temp.status = 'biometria_failed';
        await temp.save();
        return res.status(400).json({ error: "invalid_biometric_jwt" });
    }

    temp.status = 'biometria_ok';
    temp.userBiometriaId = idUsuario;
    temp.biometriaJwt = biomJwt;
    temp.cadenaValores = cadenaValores;
    await temp.save();

    // Enviar info al módulo de análisis
    try {
        await fetch(`${ANALYSIS_BASE_URL}/api/biometric-registration`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email,
                idUsuario,
                jwt: biomJwt,
                cadenaValores,
                sessionToken
            })
        });
    } catch (err) {
        console.error("❌ Error enviando a módulo de análisis:", err);
    }

    return res.json({ ok: true });
});


// Archivos estáticos del cliente móvil
app.use('/mobile_client', express.static(path.join(__dirname, '..', 'mobile_client')));


//===========================================================
//  VERIFICAR JWT DE BIOMETRÍA
//===========================================================

function verifyBiometriaJwt(jwtToken) {
    try {
        const payload = jwt.verify(jwtToken, BIOMETRIA_JWT_PUBLIC_KEY, {
            algorithms: ["RS256", "HS256"] // según lo que usen biometría
        });
        return { ok: true, payload };
    } catch (err) {
        console.error("JWT biometría inválido:", err);
        return { ok: false, error: err };
    }
}


// ---------------------------------------------
// MANEJO GLOBAL DE ERRORES — NO EXPONER STACKTRACE
// ---------------------------------------------
app.use((err, req, res, next) => {
    console.error("🔥 Error interno:", err);

    // Si el request viene de la extensión → responder JSON
    if (req.headers["content-type"] === "application/json" ||
        req.url.includes("/generar-qr-sesion") ||
        req.url.includes("/request-auth-login") ||
        req.url.includes("/register-mobile")) {

        return res.status(500).json({
            error: "server_error",
            message: "Ocurrió un error inesperado. Intenta nuevamente."
        });
    }

    // Si viene del navegador móvil → responder HTML amigable
    return res.status(500).send(`
        <html>
            <body style="font-family:sans-serif; margin:40px;">
                <h1>Error Interno</h1>
                <p>Ocurrió un problema procesando la solicitud.</p>
                <p>Por favor regresa al sitio y genera un nuevo código QR.</p>
            </body>
        </html>
    `);
});
// Iniciar el servidor

app.listen(PORT, () => {
    console.log(`Servidor Node.js iniciado en http://localhost:${PORT}`);
});
