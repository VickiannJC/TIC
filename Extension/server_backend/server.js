//version2

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
const crypto = require("crypto");
// Si tu versión de Node no tiene fetch global, descomenta esta línea:
// const fetch = require("node-fetch");

// Modelos de MongoDB
const Subscripcion = require('./modelosDB/Subscripciones');
const Temporal = require('./modelosDB/temporales');
const QRSession = require('./modelosDB/QRSession');

// Configuración y claves VAPID
const config = require('./config');



const app = express();
app.use((req, res, next) => {
    console.log(`🔔 LLEGÓ UNA PETICIÓN: ${req.method} ${req.url}`);
    next();
});
const PORT = process.env.PORT || 3000;

// URLs de otros módulos
const BIOMETRIA_BASE_URL = process.env.BIOMETRIA_BASE_URL;
const BIOMETRIA_API_KEY = process.env.BIOMETRIA_API_KEY;
const BIOMETRIA_JWT_SECRET = process.env.BIOMETRIA_JWT_SECRET;
const SERVER_BASE_URL = 'https://paper-inspector-woods-camera.trycloudflare.com';

const ANALYSIS_BASE_URL = process.env.ANALYSIS_BASE_URL;

// Timeout máximo esperando callback de biometría en REGISTRO (ms) -> 1 hora
const REGISTRATION_TIMEOUT_MS = 60 * 60 * 1000;

// Mapa en memoria: email -> timer de registro biométrico
const biometricRegTimers = new Map();

// Configuraciones VAPID
webpush.setVapidDetails(
    config.VAPID_EMAIL,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
);

// Conexión a MongoDB
mongoose.connect(config.MONGODB_URI)
    .then(() => console.log('✅ Conectado a MongoDB'))
    .catch(err => console.error('❌ Error al conectar a MongoDB:', err));

// Middlewares
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));


//===========================================================
//  UTILIDADES
//===========================================================

// Cargar HTML templates (para móvil)
function loadTemplate(name) {
    const filePath = path.join(__dirname, "templates", name);
    return fs.readFileSync(filePath, "utf8");
}

// Genera un TOKEN DE DESBLOQUEO temporal (para login/registro)
function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}



// Enviar notificación push al usuario
async function sendPushNotification(subscription, payload) {
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log('📨 Notificación enviada con éxito');
        return { success: true };
    } catch (error) {
        console.error('❌ Error al enviar la notificación:', error.statusCode);

        if (error.statusCode === 404 || error.statusCode === 410) {
            // Subscripción inválida ->  eliminar
            await Subscripcion.deleteOne({ 'subscription.endpoint': subscription.endpoint });
            console.log('🧹 Subscripción eliminada de la base de datos (404/410)');
        }
        return { success: false, error };
    }
}

// Verificar JWT de biometría
function verifyBiometriaJwt(jwtToken) {
    console.log("🔐 [BIO-JWT] Verificando JWT:", jwtToken.substring(0, 25) + "...");

    try {
        const payload = jwt.verify(jwtToken, BIOMETRIA_JWT_SECRET, {
            algorithms: ["HS256"]
        });
        return { ok: true, payload };
    } catch (err) {
        console.error("❌ JWT biometría inválido:", err);
        return { ok: false, error: err };
    }
}

//===========================================================
//  ENDPOINTS REGISTRO / VINCULACIÓN (EXTENSIÓN + MÓVIL)
//===========================================================

/**
 * 1) La extensión pide un QR para registro.
 *    - Se limpia cualquier sesión QR previa para ese email.
 *    - Se crea QRSession (pending) con TTL (definido en el modelo).
 *    - Se genera un DataURL con QR apuntando a /mobile_client/register-mobile.html?sessionId=...
 *    - La extensión mostrará este QR y lo podrá regenerar cada 60s.
 */
app.post("/generar-qr-sesion", async (req, res) => {

    console.log("📥 /generar-qr-sesion BODY recibido:", req.body);
    console.log("Headers:", req.headers);
    try {


        const { email, platform } = req.body;

        if (!email || !platform) {
            return res.status(400).json({ error: "Email y plataforma requeridos" });
        }

        // Limpiar sesiones QR previas de este email
        await QRSession.deleteMany({ email, estado: "pending" });
        console.log(`🧹 Limpieza previa de QRSession para: ${email}`);

        // Crear nuevo ID de sesión
        const sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;

        await QRSession.create({
            sessionId,
            email,
            platform,
            estado: "pending"
        });

        // Construir URL base dinámica (ngrok/producción/localhost)
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const baseUrl = `${proto}://${host}`;

        // URL de registro móvil (cliente web móvil)
        const registerUrl = `${baseUrl}/mobile_client/register-mobile.html?sessionId=${sessionId}`;
        console.log("URL generada para el QR:", registerUrl);
        // Construir QR como DataURL
        const qrDataUrl = await qrcode.toDataURL(registerUrl);
        console.log("QR generado correctamente");




        return res.json({
            qr: qrDataUrl,
            sessionId
        });

    } catch (err) {
        console.error("❌ ERROR detallado en /generar-qr-sesion:", err.stack || err, {
            body: req.body,
            headers: req.headers
        });

        return res.status(500).json({
            error: "server_error",
            detail: err.message
        });
    }
});

app.post("/cancel-qr-session", async (req, res) => {
    const { email } = req.body;
    console.log("Cancelar QR")
    if (!email) return res.status(400).json({ error: "email_required" });

    try {
        await QRSession.deleteMany({ email });
        return res.json({ ok: true, message: "QR sessions cleaned" });

    } catch (err) {
        console.error("❌ Error al limpiar QRSession:", err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});


/**
 * Enviar un push de prueba después de registrar el dispositivo.
 */
app.post("/send-test-push", async (req, res) => {
    const { email, continueUrl, sessionId } = req.body;

    console.log("🔥 /send-test-push BODY recibido:", req.body);
    console.log("🔥 email en push:", email);
    console.log("🔥 continueUrl en push:", continueUrl);


    if (!email) {
        return res.status(400).json({ error: "email_required" });
    }

    try {
        const subDoc = await Subscripcion.findOne({ email });

        if (!subDoc) {
            console.log("❌ No existe subscripcion para:", email);
            return res.status(404).json({ error: "subscription_not_found" });
        }

        console.log("📨 Enviando push de prueba a:", email);

        const payload = {
            title: "Vinculación Exitosa",
            body: "Revisa tus notificaciones y presiona AUTENTICAR para seguir con el registro.",
            actionType: "register_continue",
            email,
            sessionId,
            continueUrl
        };

        console.log("📨 Payload enviado al móvil:", payload);


        await webpush.sendNotification(subDoc.subscription, JSON.stringify(payload));

        return res.json({ ok: true, message: "Test push sent" });

    } catch (err) {
        console.error("❌ ERROR enviando push de prueba:", err);
        return res.status(500).json({ error: "push_error", detail: err.message });
    }
});



/**
 * 2) La extensión consulta el estado de una sesión QR concreta.
 *    - Devuelve estado: "pending" | "confirmed" | "expired"
 *    - Se usa para detener la regeneración de QR en el background.
 */
app.get("/qr-session-status", async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId) {
        return res.status(400).json({ estado: "expired", error: "sessionId_required" });
    }

    try {
        console.log("🔍 CONSULTANDO QRSession:", sessionId);

        const session = await QRSession.findOne({ sessionId })
            .catch(err => {
                console.error("❌ Mongo ERROR buscando QRSession:", err);
                throw err;
            });

        console.log("🔍 RESULTADO QRSession:", session);

        // Caso: no existe la sesión → QR expirado
        if (!session) {
            return res.json({ estado: "expired" });
        }

        // Caso: aún pendiente
        if (session.estado === "pending") {
            return res.json({ estado: "pending" });
        }

        // Caso: confirmado por el móvil
        if (session.estado === "confirmed") {
            return res.json({ estado: "confirmed" });
        }

        // Cualquier otro estado lo tratamos como expirado
        return res.json({ estado: "expired" });

    } catch (err) {
        console.error("🔥 ERROR REAL en /qr-session-status:", err);
        return res.status(200).json({ estado: "expired", error: "exception" });
    }

});

/**
 * 3) El móvil (register-mobile) envía la suscripción Push una vez escaneado el QR.
 *    Flujo:
 *      - Verificar que QRSession existe y está pending.
 *      - Verificar que no exista Subscripcion previa (email único).
 *      - Guardar Subscripcion (email → subscription).
 *      - Marcar QRSession.estado = "confirmed".
 *      - Crear Temporal tipo REG_XXXX con token efímero.
 *      - Programar timeout de 1h: biometría no responde, eliminar Subscripcion/Temporal/QRSession.
 *      - Responder con continueUrl (para que el móvil muestre botón "Continuar").
 */
app.post('/register-mobile', async (req, res) => {
    const { sessionId, subscription } = req.body;

    console.log("📨 /register-mobile: Vinculando dispositivo móvil...");

    try {
        const sessionData = await QRSession.findOne({ sessionId });

        if (!sessionData) {
            return res.status(404).json({
                error: "session_not_found",
                message: "Este QR ya expiró o no existe."
            });
        }

        // Verificar que no exista suscripción previa para el mismo email
        const existing = await Subscripcion.findOne({ email: sessionData.email });
        if (existing) {
            console.log("❌ Registro bloqueado: email YA existe:", sessionData.email);

            // 🔥 LIMPIAR sesión QR y temporales de registro
            await QRSession.deleteMany({ email: sessionData.email });
            await Temporal.deleteMany({ email: sessionData.email, challengeId: { $regex: /^REG_/ } });

            // Si había un temporizador, cancelarlo
            if (biometricRegTimers.has(sessionData.email)) {
                clearTimeout(biometricRegTimers.get(sessionData.email));
                biometricRegTimers.delete(sessionData.email);
            }

            return res.status(200).json({
                status: "already_registered",
                email: sessionData.email,
                message: "Este dispositivo ya está registrado. No es necesario continuar."
            });
        }


        // Guardar suscripción móvil definitiva
        await Subscripcion.updateOne(
            { email: sessionData.email },
            { subscription },
            { upsert: true }
        );

        // Marcar la sesión QR como confirmada
        sessionData.subscription = subscription;
        sessionData.estado = "confirmed";
        await sessionData.save();

        // Crear entrada Temporal para REGISTRO (protege el canal con biometría)
        const challengeId = "REG_" + Math.random().toString(36).substring(2, 9);
        const token = generateToken();

        await Temporal.create({
            challengeId,
            email: sessionData.email,
            platform: sessionData.platform || "Unknown",
            status: "pending",
            token
        });

        // Programar TIMEOUT DE 1 HORA
        const email = sessionData.email;

        if (biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        const timer = setTimeout(async () => {
            try {
                console.log(`⏰ Timeout biometría para ${email}, limpiando datos...`);
                await Subscripcion.deleteOne({ email });
                await Temporal.deleteMany({ email, challengeId: { $regex: /^REG_/ } });
                await QRSession.deleteMany({ email });
            } catch (err) {
                console.error("❌ Error limpiando tras timeout biometría:", err);
            } finally {
                biometricRegTimers.delete(email);
            }
        }, REGISTRATION_TIMEOUT_MS);

        biometricRegTimers.set(email, timer);

        // Construir URL base
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const baseUrl = `${proto}://${host}`;

        // URL para el siguiente paso de registro biométrico
        const continueUrl = `${baseUrl}/mobile_client/register-confirm?email=${encodeURIComponent(email)}&sessionId=${sessionId}`;

        return res.status(200).json({
            message: "subscription_saved",
            continueUrl,
            email: sessionData.email,
            sessionId,
            challengeId,
            token
        });

    } catch (err) {
        console.error("❌ Error en /register-mobile:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * 4) Página de registro estético para el móvil.
 *    - GET: muestra un HTML con iframe/botón hacia módulo biométrico.
 *    - POST: se usa si quieres que biometría haga callback aquí y recargue la vista.
 */
app.get("/mobile_client/register-confirm", (req, res) => {
    const { email, sessionId } = req.query;

    if (!email || !sessionId) {
        const errorTemplate = loadTemplate("error_estetico.html");
        return res.send(errorTemplate.replace("{{ERROR_MESSAGE}}", "Faltan datos necesarios."));
    }

    const biometriaURL = `${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`;
    ;
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

        // Guardar/actualizar suscripción móvil (idempotente)
        await Subscripcion.updateOne(
            { email: userEmail },
            { subscription },
            { upsert: true }
        );

        const biometriaURL = `${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`;

        const continueURL = `/mobile_client/register-confirm?email=${encodeURIComponent(userEmail)}&sessionId=${sessionId}`;

        let html = loadTemplate("registro_estetico.html");
        html = html
            .replace("{{BIOMETRIA_URL}}", biometriaURL)
            .replace("{{CONTINUE_URL}}", continueURL);

        res.send(html);

        // Consulta en segundo plano a biometría para verificar usuario.
        setTimeout(async () => {
            try {
                console.log("🔵 [CHECK-USER] Enviando petición a /check-user (registro)");
                const resp = await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/check-user`, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${BIOMETRIA_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        email: userEmail,
                        session_token: `REG_${sessionId}`, // token dummy, aquí no importa
                        action: "registro"
                    })
                });
                const data = await resp.json();
                console.log("🟢 [CHECK-USER] Respuesta:", data);
            } catch (err) {
                console.error("❌ Error biometría (check-user):", err);
            }
        }, 10);

    } catch (err) {
        console.error("❌ Error en /mobile_client/register-confirm (POST):", err);
        return res.status(500).send("Error interno");
    }
});

/*app.get("/mobile_client/start-biometric", async (req, res) => {
    const { email, sessionId } = req.query;

    console.log("🚀 [AUTH-START] Enviando authenticate-start al módulo biométrico");
    console.log("URL:", `${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`);
    console.log("Headers:", {
        Authorization: `Bearer ${BIOMETRIA_API_KEY}`,
        "Content-Type": "application/json"
    });
    console.log("Body:", {
        email: email,
        session_token: sessionId,
        action: "autenticacion",
        callback_url: `${SERVER_BASE_URL}/api/biometric-callback`
    });


    await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${BIOMETRIA_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            email,
            session_token: sessionId,
            action: "registro"
        })
    });
    console.log("🟢 [AUTH-START] Envío completado. Ahora esperando callback...");


    res.redirect(`/mobile_client/register-confirm?email=${email}&sessionId=${sessionId}`);
});
*/

//===========================================================
//  ENDPOINTS AUTENTICACIÓN (BIOMETRIC) 
//===========================================================


app.post('/api/biometric-callback', async (req, res) => {
    console.log("🟣 [BIO-CALLBACK] Request recibido del módulo biométrico");
    console.log("Headers recibidos (sanitizados):", {
        authorization: req.headers.authorization ? "Bearer ***" : undefined
    });
    console.log("Body recibido:", {
        user_id: req.body.user_id,
        email: req.body.email,
        session_token: req.body.session_token,
        action: req.body.action,
        authenticated: req.body.authenticated
    });

    try {

        // 1) Validar API Key
        const auth = req.headers.authorization || "";
        const apiKey = auth.replace("Bearer ", "");

        if (apiKey !== BIOMETRIA_API_KEY) {
            console.warn("⚠ Intento de acceso con API Key inválida en /api/biometric-callback");
            return res.status(401).json({ error: "unauthorized" });
        }

        // 2) Extraer datos
        const {
            user_id,
            email,
            session_token,
            action,
            authenticated,
            jwt: biomJwt
        } = req.body;

        if (action !== "autenticacion") {
            return res.status(400).json({ error: "invalid_action" });
        }

        if (!email || !session_token) {
            return res.status(400).json({ error: "email_and_session_token_required" });
        }
        console.log("🔎 [BIO-CALLBACK] Buscando Temporal con:");
        console.log({
            email: req.body.email,
            session_token: req.body.session_token
        });


        // 3) Buscar el challenge de LOGIN correspondiente
        //    Asumimos que guardaste session_token en Temporal.token
        const temp = await Temporal.findOne({
            email,
            token: session_token
        }).sort({ createdAt: -1 });

        if (!temp) {
            console.warn("⚠ Callback de autenticación sin Temporal activo:", {
                email,
                session_token
            });

            console.error("❌ [BIO-CALLBACK] No existe Temporal para este session_token!");
            return res.status(404).json({ error: "auth_session_not_found" });

        } else {
            console.log("🟢 [BIO-CALLBACK] Temporal encontrado:", {
                id: temp._id,
                challengeId: temp.challengeId,
                status: temp.status
            });
        }

        // 4) Si la autenticación fue rechazada
        if (!authenticated) {
            temp.status = 'denied';
            await temp.save();
            return res.json({ ok: true, authenticated: false });
        }
        console.log("🔐 [BIO-CALLBACK] Validando JWT biométrico…");


        // 5) Autenticación aceptada → verificar JWT
        if (!biomJwt) {
            temp.status = 'biometria_failed';
            await temp.save();
            return res.status(400).json({ error: "jwt_required" });
        }

        const jwtCheck = verifyBiometriaJwt(biomJwt);
        if (!jwtCheck.ok) {
            temp.status = 'biometria_failed';
            await temp.save();
            return res.status(400).json({ error: "invalid_biometric_jwt" });
        }
        console.log("🟢 [BIO-CALLBACK] JWT válido");

        // 6) Marcar como OK y guardar datos
        temp.status = 'biometria_ok';
        temp.userBiometriaId = user_id;
        temp.biometriaJwt = biomJwt;
        await temp.save();

        // A partir de aquí, la extensión podrá ver:
        //   status: 'authenticated' y token: temp.token
        // cuando consulte /check-password-status
        console.log("✅ [BIO-CALLBACK] Autenticación biométrica completada OK");
        return res.json({ ok: true, authenticated: true });

    } catch (err) {
        console.error("❌ Error en /api/biometric-callback:", err);
        return res.status(500).json({ error: "server_error" });
    }
});



//===========================================================
//  ENDPOINTS AUTENTICACIÓN (LOGIN) – EXTENSIÓN + MÓVIL
//===========================================================

/**
 * 5) La extensión pide login: se manda push al móvil.
 */
app.post('/request-auth-login', async (req, res) => {
    console.log("🔵 [AUTH-REQUEST] Recibido request-auth-login desde la extensión");
    console.log("Email:", req.body.email);
    console.log("Platform:", req.body.platform);

    const { email, platform } = req.body;

    try {
        const subDoc = await Subscripcion.findOne({ email });
        if (!subDoc) {
            return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
        }

        const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
        const session_token = generateToken();
        const newChallenge = new Temporal({
            email,
            challengeId,
            platform: platform || "Unknown",
            token: session_token,
            status: "pending"
        });
        await newChallenge.save();

        const continueUrl = `${SERVER_BASE_URL}/mobile_client/auth-confirm?sessionId=${challengeId}&status=confirmed`;


        const payload = {
            title: 'Solicitud de Inicio de Sesión',
            body: `Se ha solicitado acceso a ${email}. Toque "Autenticar" para continuar.`,
            actionType: 'auth',
            email,
            sessionId: challengeId,
            continueUrl
        };

        const pushResult = await sendPushNotification(subDoc.subscription, payload);

        if (!pushResult.success) {
            return res.status(500).json({ error: 'Fallo al enviar notificación Push.' });
        }

        return res.status(200).json({
            message: 'Solicitud enviada al móvil.',
            challengeId
        });

    } catch (err) {
        console.error("❌ Error en /request-auth-login:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * 6) El móvil confirma o rechaza autenticación (LOGIN).
 *    - En caso de confirmación, se llama al módulo biométrico.
 *    - Si biometría valida y el JWT es correcto, se marca Temporal como 'biometria_ok'.
 *    - La extensión hará polling a /check-password-status.
 */
app.get('/mobile_client/auth-confirm', async (req, res) => {
    const { sessionId: challengeId, status } = req.query;

    try {
        const challenge = await Temporal.findOne({ challengeId });

        if (!challenge) {
            return res.status(404).send('Desafío de autenticación no válido o expirado.');
        }

        if (challenge.status !== 'pending') {
            return res.send(`<h1>Acción Previa</h1><p>Este desafío ya fue procesado.</p>`);
        }

        // Usuario confirmó en el móvil
        if (status === 'confirmed') {
            const sessionToken = challenge.token;
            challenge.status = 'confirmed';
            await challenge.save();

            // Llamar a módulo biométrico
            try {

                const respBio = await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${BIOMETRIA_API_KEY}`
                    },
                    body: JSON.stringify({
                        email: challenge.email,
                        session_token: sessionToken,
                        action: "autenticacion",
                        callback_url: `${SERVER_BASE_URL}/api/biometric-callback`
                    })
                });


                const dataBio = await respBio.json();
                console.log("🔐 [AUTH-START] respuesta inicial biometría (sin JWT):", {
                    success: dataBio.success,
                    message: dataBio.message,
                    user_id: dataBio.user_id,
                    request_id: dataBio.request_id
                });

                if (!respBio.ok) {
                    console.error("❌ Error HTTP biometría login:", respBio.status);
                    challenge.status = 'biometria_failed';
                    await challenge.save();

                    return res.send(`
                        <h1>Autenticación incompleta</h1>
                        <p>El módulo biométrico no aceptó la autenticación.</p>
                    `);
                }



                if (!dataBio.success) {
                    challenge.status = 'biometria_failed';
                    await challenge.save();
                    return res.send('<h1>Autenticación Rechazada</h1><p>El módulo biométrico rechazó el inicio de sesión.</p>');
                }


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
                console.error("❌ Error notificando denegación a biometría:", err);
            }

            return res.send('<h1>Autenticación Rechazada</h1><p>El inicio de sesión fue denegado por el usuario.</p>');
        }

    } catch (err) {
        console.error("❌ Error en /mobile_client/auth-confirm:", err);
        return res.status(500).send("Error interno");
    }
});

/**
 * 7) Polling del estado del token (llamado por la extensión).
 *    - Si encuentra Temporal con status 'biometria_ok' → authenticated + token.
 *    - Si encuentra alguno denegado/fallido → denied.
 *    - Caso contrario, pending.
 */
app.get('/check-password-status', async (req, res) => {
    const { email } = req.query;

    try {
        // Buscar challenge con biometría OK
        const okChallenge = await Temporal.findOne({
            email,
            status: 'biometria_ok'
        }).sort({ createdAt: -1 });

        if (okChallenge) {
            const token = okChallenge.token;

            okChallenge.status = 'used'; //Token de un solo uso
            await okChallenge.save();
            return res.status(200).json({
                status: 'authenticated',
                token   // token de desbloqueo que usará la extensión
            });
        }

        // Ver si hay alguno denegado o fallido
        const badChallenge = await Temporal.findOne({
            email,
            status: { $in: ['denied', 'biometria_failed'] }
        }).sort({ createdAt: -1 });

        if (badChallenge) {
            return res.status(200).json({ status: 'denied' });
        }

        // Si no hay nada definitivo aún → pending
        return res.status(200).json({ status: 'pending' });

    } catch (err) {
        console.error("❌ Error en /check-password-status:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

//===========================================================
//  CALLBACK DESDE MÓDULO BIOMÉTRICO (REGISTRO)
//===========================================================

/**
 * 8) Biometría envía el resultado del REGISTRO.
 *    - Se valida API key (Bearer).
 *    - Se busca Temporal con challengeId REG_*, email y token(sessionToken).
 *    - Si success=false → se marca 'biometria_failed'.
 *    - Si success=true:
 *        * Se verifica el JWT.
 *        * Se marca Temporal como 'biometria_ok'.
 *        * Se envía info al módulo de análisis (psy_analyzer).
 */
app.post('/api/analizer-register', async (req, res) => {
    console.log("🚀 [NODE] Petición recibida en /api/analizer-register");
    try {
        // --- 1. VALIDACIÓN PREVIA (Evita crash si body es null) ---
        if (!req.body) {
             console.error("❌ ERROR: req.body es undefined (falta express.json)");
             return res.status(500).json({ error: "internal_server_error_no_body_parser" });
        }

        // --- 2. VALIDAR API KEY ---
        const auth = req.headers.authorization || "";
        const tokenApi = auth.replace("Bearer ", "");

        // Asegúrate de que BIOMETRIA_API_KEY venga de process.env
        if (tokenApi !== process.env.BIOMETRIA_API_KEY) {
            console.warn("⛔ [NODE] API Key rechazada");
            return res.status(401).json({ error: "unauthorized" });
        }

        // --- 3. EXTRAER DATOS (Todo unificado a 'sessionToken') ---
        const {
            email,
            idUsuario: user_id,
            user_answers: cadenaValores,
            sessionToken // <--- Variable definida aquí
        } = req.body;

        console.log(`🔍 [NODE] Buscando temporal para: ${email} con token: ${sessionToken}`);

        if (!email || !sessionToken) {
            return res.status(400).json({ error: "email_and_sessionToken_required" });
        }

        // Parar temporizador de timeout (Si existe la variable global biometricRegTimers)
        if (typeof biometricRegTimers !== 'undefined' && biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        // --- 4. BUSCAR EN MONGO ---
        const temp = await Temporal.findOne({
            email,
            token: sessionToken, // <--- CORREGIDO: Usamos la variable sessionToken
            challengeId: { $regex: /^REG_/ }
        });

        if (!temp) {
            console.warn("⚠ Resultado biometría sin Temporal activo:", { email, sessionToken });
            return res.status(404).json({ error: "registration_session_not_found" });
        }

        // --- 5. GUARDAR EN MONGO ---
        console.log("✅ [NODE] Temporal encontrado. Actualizando estado...");
        temp.status = 'biometria_ok';
        temp.userBiometriaId = user_id;
        temp.cadenaValores = Array.isArray(cadenaValores) ? cadenaValores.join(",") : cadenaValores;
        await temp.save();

        // --- 6. ENVIAR A PYTHON ---
        const analysisUrl = process.env.ANALYSIS_BASE_URL;
        
        if (analysisUrl) {
            try {
                const parsedAnswers = typeof cadenaValores === "string"
                    ? cadenaValores.split(",").map(x => parseInt(x.trim(), 10))
                    : cadenaValores;

                // CORRECCIÓN: Definimos el objeto antes para poder imprimirlo y enviarlo
                const payload = {
                    email,
                    idUsuario: user_id,
                    user_answers: Array.isArray(parsedAnswers) ? parsedAnswers : [],
                    sessionToken: sessionToken // <--- CORREGIDO: Usamos sessionToken
                };

                console.log("📦 [NODE] Payload a enviar a Python:", JSON.stringify(payload));

                await fetch(`${analysisUrl}/api/biometric-registration`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                console.log("[NODE] Python respondió con estatus: 200 (✅ Éxito)")

            } catch (err) {
                console.error("❌ Error enviando a módulo de análisis:", err);
            }
        }
        
        return res.json({ ok: true });

    } catch (err) {
        console.error("❌ Error CRÍTICO en /api/analizer-register:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

//===========================================================
//  ARCHIVOS ESTÁTICOS DEL CLIENTE MÓVIL
//===========================================================

app.use('/mobile_client', express.static(path.join(__dirname, '..', 'mobile_client')));

//===========================================================
//  MANEJO GLOBAL DE ERRORES
//===========================================================

app.use((err, req, res, next) => {
    console.error("🔥 Error interno:", err);

    // Si el request viene de la extensión → responder JSON
    if (req.headers["content-type"] === "application/json" ||
        req.url.includes("/generar-qr-sesion") ||
        req.url.includes("/request-auth-login") ||
        req.url.includes("/register-mobile") ||
        req.url.includes("/qr-session-status") ||
        req.url.includes("/check-password-status")) {

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

//===========================================================
//  INICIAR SERVIDOR
//===========================================================

app.listen(PORT, () => {
    console.log(`🚀 Servidor Node.js iniciado en http://localhost:${PORT}`);
});
