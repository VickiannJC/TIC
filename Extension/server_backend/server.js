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
const axios = require("axios");
// Si tu versión de Node no tiene fetch global, descomenta esta línea:
// const fetch = require("node-fetch");

// Modelos de MongoDB
const Subscripcion = require('./modelosDB/Subscripciones');
const Temporal = require('./modelosDB/temporales');
const QRSession = require('./modelosDB/QRSession');
const SecurityEvent = require('./modelosDB/SecurityEvent');

// Configuración y claves VAPID
const config = require('./config');



const app = express();
/**app.use("/mobile_client", express.static(
  path.join(__dirname, "mobile_client"),
  {
    index: false,
    fallthrough: true
  }
));**/


app.get("/mobile_client/:file", (req, res) => {
    const file = req.params.file;

    const allowed = [
        "register-mobile.html",
        "mobile-register.v3.js",
        "sw3.js",
        "check.png",
        "cancel.png",
        "README"
    ];

    if (!allowed.includes(file)) {
        return res.status(404).send("File not allowed");
    }

    const absPath = path.join(__dirname, "mobile_client", file);

    res.sendFile(absPath, err => {
        if (err) {
            console.error("❌ Error sirviendo archivo móvil:", {
                file,
                absPath,
                err
            });
            res.status(404).send("File not found");
        }
    });
});

app.use((req, res, next) => {
    console.log(`🔔 LLEGÓ UNA PETICIÓN: ${req.method} ${req.url}`);
    next();
});
const PORT = process.env.PORT || 3000;

const EXT_CLIENT_KEY = process.env.EXT_CLIENT_KEY; // clave compartida con la extensión
const KM_PLUGIN_REG_SECRET = process.env.KM_PLUGIN_REG_SECRET; // secreto  server↔KM


// URLs de otros módulos
const BIOMETRIA_BASE_URL = process.env.BIOMETRIA_BASE_URL;
const BIOMETRIA_API_KEY = process.env.BIOMETRIA_API_KEY;
const BIOMETRIA_JWT_SECRET = process.env.BIOMETRIA_JWT_SECRET;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;

const ANALYSIS_BASE_URL = process.env.ANALYSIS_BASE_URL;

// Timeout máximo esperando callback de biometría en REGISTRO (ms) -> 1 hora
const REGISTRATION_TIMEOUT_MS = 10 * 60 * 1000;

// Mapa en memoria: email -> timer de registro biométrico
const biometricRegTimers = new Map();

// Configuraciones VAPID
webpush.setVapidDetails(
    config.VAPID_EMAIL,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
);

const IS_DEBUG = process.env.NODE_ENV !== 'production';

function dlog(...args) {
    if (IS_DEBUG) {
        console.log(...args);
    }
}
function dwarn(...args) {
    if (IS_DEBUG) {
        console.warn(...args);
    }
}

function requireTemporal(temp, { action, statuses, tabId }) {
    if (!temp) {
        const err = new Error("temporal_not_found");
        err.statusCode = 404;
        throw err;
    }
    if (action && temp.action !== action) {
        const err = new Error("invalid_action");
        err.statusCode = 409;
        throw err;
    }
    if (statuses && !statuses.includes(temp.status)) {
        const err = new Error("invalid_state");
        err.statusCode = 409;
        throw err;
    }
    if (tabId !== undefined && temp.meta?.tabId !== undefined) {
        if (Number(tabId) !== Number(temp.meta.tabId)) {
            const err = new Error("tab_mismatch");
            err.statusCode = 403;
            throw err;
        }
    }
}


// Conexión a MongoDB
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

mongoose.connection.on("connected", () => {
    console.log("✅ Mongo conectado");
});

mongoose.connection.on("error", err => {
    console.error("❌ Mongo error:", err);
});



// Middlewares
app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Client-Key"]
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ===========================================================
//  MIDDLEWARE: AUTENTICACIÓN DEL CLIENTE (EXTENSIÓN)
// ===========================================================
function clientAuth(req, res, next) {
    dlog("🔎 HEADER CLIENT-KEY RECIBIDO:", req.headers["x-client-key"]);

    if (!EXT_CLIENT_KEY) {
        dwarn("⚠ EXT_CLIENT_KEY no está configurado en el servidor.");
        return res.status(500).json({ error: "server_misconfigured" });
    }

    const clientKey = req.headers["x-client-key"];
    if (!clientKey || clientKey !== EXT_CLIENT_KEY) {
        dwarn("⛔ Cliente no autorizado en", req.path, "desde IP:", req.ip);
        logSecurityEvent("invalid_client_key", {
            ip: req.ip,
            path: req.path,
            userAgent: req.headers["user-agent"],
            meta: { clientKeyPresent: !!clientKey }
        });
        return res.status(401).json({ error: "invalid_client" });
    }
    next();
}

// ===========================================================
//  MIDDLEWARE: RATE LIMITING BÁSICO
// ===========================================================
function createRateLimiter({ windowMs, maxRequests, keyFn }) {
    const hits = new Map(); // key -> { count, first }

    return async function rateLimiter(req, res, next) {
        const key = keyFn(req);
        const now = Date.now();
        const entry = hits.get(key) || { count: 0, first: now };

        if (now - entry.first > windowMs) {
            // Ventana nueva
            entry.count = 0;
            entry.first = now;
        }

        entry.count += 1;
        hits.set(key, entry);

        if (entry.count > maxRequests) {
            dwarn("⛔ Rate limit excedido para", key, "en ruta", req.path);
            // Log de evento de seguridad (lo definimos en el punto 3)
            if (typeof logSecurityEvent === "function") {
                logSecurityEvent("rate_limit_exceeded", {
                    email: req.body?.email || req.query?.email,
                    ip: req.ip,
                    path: req.path,
                    meta: { count: entry.count, windowMs }
                });
            }
            return res.status(429).json({ error: "too_many_requests" });
        }

        next();
    };
}

// Limitador específico para login por email/IP
const loginRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,    // 1 minuto
    maxRequests: 10,         // máx 10 req/min por clave
    keyFn: (req) => req.body?.email || req.ip
});

// Limitador para polling de estado (algo más laxo)
const statusRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 20,
    keyFn: (req) => req.query?.email || req.ip
});




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

//firmar -> comunicacion SERVER <-> KEY MANAGER
// Canonical JSON: estable para HMAC (sort keys, sin espacios)
function canonicalJson(obj) {
    const sortObject = (o) => {
        if (Array.isArray(o)) return o.map(sortObject);
        if (o && typeof o === "object") {
            return Object.keys(o).sort().reduce((acc, k) => {
                acc[k] = sortObject(o[k]);
                return acc;
            }, {});
        }
        return o;
    };
    return JSON.stringify(sortObject(obj));
}

function signPluginRegistration(payload) {
    if (!KM_PLUGIN_REG_SECRET) {
        throw new Error("KM_PLUGIN_REG_SECRET no configurado en el servidor Node");
    }
    const msg = canonicalJson(payload);
    return crypto.createHmac("sha256", KM_PLUGIN_REG_SECRET).update(msg).digest("hex");
}



// Enviar notificación push al usuario
async function sendPushNotification(subscription, payload) {
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        dlog('📨 Notificación enviada con éxito');
        return { success: true };
    } catch (error) {
        console.error('❌ Error al enviar la notificación:', error.statusCode);

        if (error.statusCode === 404 || error.statusCode === 410) {
            // Subscripción inválida ->  eliminar
            await Subscripcion.deleteOne({ 'subscription.endpoint': subscription.endpoint });
            dlog('🧹 Subscripción eliminada de la base de datos (404/410)');
        }
        return { success: false, error };
    }
}

// Verificar JWT de biometría
function verifyBiometriaJwt(jwtToken) {
    dlog("🔐 [BIO-JWT] Verificando JWT:", jwtToken.substring(0, 25) + "...");

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

// ===========================================================
//  LOG DE EVENTOS DE SEGURIDAD
// ===========================================================
async function logSecurityEvent(type, { email, ip, path, userAgent, meta } = {}) {
    try {
        await SecurityEvent.create({
            type,
            email,
            ip,
            path,
            userAgent,
            meta
        });
    } catch (err) {
        console.error("❌ Error guardando SecurityEvent:", err);
    }
}


// Endpoint de salud para MongoDB
app.get("/mongo-health", async (req, res) => {
    try {
        await mongoose.connection.db.admin().ping();
        res.json({ mongo: "ok" });
    } catch (e) {
        res.status(500).json({ mongo: "error", detail: e.message });
    }
});


//===========================================================
//  ENDPOINTS REGISTRO / VINCULACIÓN (EXTENSIÓN + MÓVIL)
//===========================================================

/**
 * La extensión pide un QR para registro.
 *    - Se limpia cualquier sesión QR previa para ese email.
 *    - Se crea QRSession (pending) con TTL (definido en el modelo).
 *    - Se genera un DataURL con QR apuntando a /mobile_client/register-mobile.html?sessionId=...
 *    - La extensión mostrará este QR y lo podrá regenerar cada 60s.
 */
app.post("/generar-qr-session", clientAuth, async (req, res) => {

    dlog("📥 /generar-qr-session BODY recibido:", req.body);
    dlog("Headers:", req.headers);
    try {


        const { email, platform } = req.body;

        if (!email || !platform) {
            return res.status(400).json({ error: "Email y plataforma requeridos" });
        }

        // Limpiar sesiones QR previas de este email
        await QRSession.deleteMany({ email, estado: "pending" });
        dlog(`🧹 Limpieza previa de QRSession para: ${email}`);

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
        dlog("URL generada para el QR:", registerUrl);
        // Construir QR como DataURL
        const qrDataUrl = await qrcode.toDataURL(registerUrl);
        dlog("QR generado correctamente");




        return res.json({
            qr: qrDataUrl,
            sessionId
        });

    } catch (err) {
        console.error("❌ ERROR detallado en /generar-qr-session:", err.stack || err, {
            body: req.body,
            headers: req.headers
        });

        return res.status(500).json({
            error: "server_error",
            detail: err.message
        });
    }
});

app.post("/cancel-qr-session", clientAuth, async (req, res) => {
    console.log("🔥 cancel-qr-session llamado desde:", {
        headers: req.headers,
        origin: req.headers.origin,
        referer: req.headers.referer,
        userAgent: req.headers["user-agent"]
    });
    next();

    const { email } = req.body;
    dlog("Cancelar QR")
    if (!email) return res.status(400).json({ error: "email_required" });
    if (!req.headers["x-client-key"]) {
        return res.status(403).json({
            error: "forbidden",
            message: "Este endpoint es solo para la extensión"
        });
    }


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
    const { email, continueUrl, sessionId, challengeId, session_token } = req.body;

    dlog("🔥 /send-test-push BODY recibido:", req.body);
    dlog("🔥 email en push:", email);
    dlog("🔥 continueUrl en push:", continueUrl);


    if (!email) {
        return res.status(400).json({ error: "email_required" });
    }

    try {
        const subDoc = await Subscripcion.findOne({ email });

        if (!subDoc) {
            dlog("❌ No existe subscripcion para:", email);
            return res.status(404).json({ error: "subscription_not_found" });
        }

        dlog("📨 Enviando push de prueba a:", email);
        const payload = {
            title: "Vinculación Exitosa",
            body: "Revisa tus notificaciones y presiona AUTENTICAR para seguir con el registro.",
            actionType: "register_continue",
            email,
            sessionId,
            continueUrl,
            challengeId,
            session_token
        };

        dlog("📨 Payload enviado al móvil:", payload);


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
        dlog("🔍 CONSULTANDO QRSession:", sessionId);

        const session = await QRSession.findOne({ sessionId })
            .catch(err => {
                console.error("❌ Mongo ERROR buscando QRSession:", err);
                throw err;
            });

        dlog("🔍 RESULTADO QRSession:", session);

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
 * El móvil (register-mobile) envía la suscripción Push una vez escaneado el QR.
 *    Flujo:
 *      - Verificar que QRSession existe y está pending.
 *      - Verificar que no exista Subscripcion previa (email único).
 *      - Guardar Subscripcion (email → subscription).
 *      - Marcar QRSession.estado = "confirmed".
 *      - Crear Temporal tipo REG_XXXX con token efímero.
 *      - Programar timeout de 1h: biometría no responde, eliminar Subscripcion/Temporal/QRSession.
 *      - Responder con continueUrl (para que el móvil muestre botón "Continuar").
 * 
 * 
 */

app.post('/register-mobile', async (req, res) => {
    const { sessionId, subscription } = req.body;

    dlog("📨 /register-mobile: Vinculando dispositivo móvil...");

    try {
        const sessionData = await QRSession.findOne({ sessionId });
        if (req.path !== '/register-mobile') {
            console.error("🚨 RUTA MAL FORMADA:", {
                path: req.path,
                originalUrl: req.originalUrl
            });
            return res.status(400).json({ error: 'invalid_path' });
        }
        if (!sessionData) {
            return res.status(404).json({
                error: "session_not_found",
                message: "Este QR ya expiró o no existe."
            });
        }

        // Verificar que no exista suscripción previa para el mismo email
        const email = sessionData.email.toLowerCase().trim();
        const existing = await Subscripcion.findOne({ email: email });
        if (existing) {
            dlog("❌ Registro bloqueado: email YA existe:", email);

            // 🔥 LIMPIAR sesión QR y temporales de registro
            await QRSession.deleteMany({ email: email });
            await Temporal.deleteMany({ email: email, challengeId: { $regex: /^REG_/ } });

            // Si había un temporizador, cancelarlo
            if (biometricRegTimers.has(email)) {
                clearTimeout(biometricRegTimers.get(email));
                biometricRegTimers.delete(email);
            }

            return res.status(200).json({
                status: "already_registered",
                reason: "subscription_exists",
                email: email,
                message: "Este correo ya tiene un dispositivo vinculado."
            });
        }


        // Guardar suscripción móvil definitiva
        await Subscripcion.updateOne(
            { email: email },
            { subscription },
            { upsert: true }
        );

        // Marcar la sesión QR como confirmada
        sessionData.subscription = subscription;
        sessionData.estado = "confirmed";
        await sessionData.save();

        // Crear entrada Temporal para REGISTRO (protege el canal con biometría)
        const challengeId = "REG_" + Math.random().toString(36).substring(2, 9);
        const session_token = generateToken();

        await Temporal.create({
            challengeId,
            email: email,
            platform: sessionData.platform || "Unknown",
            session_token: session_token,   // mantener el nombre session_token
            status: "pending",
            action: "registro"
        });



        if (biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        const timer = setTimeout(async () => {
            try {
                console.log(`⏰ Timeout biometría para ${email}, limpiando datos...`);
                await Subscripcion.deleteOne({ email: email });
                await Temporal.deleteMany({ email: email, challengeId: { $regex: /^REG_/ } });
                await QRSession.deleteMany({ email: email });
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
        const continueUrl = `${baseUrl}/mobile_client/register-confirm?email=${encodeURIComponent(email)}&session_token=${session_token}`;

        return res.status(200).json({
            message: "subscription_saved",
            continueUrl,
            email: email,
            sessionId,
            challengeId,
            session_token
        });

    } catch (err) {
        console.error("❌ Error en /register-mobile:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * Página de registro estético para el móvil.
 *    - GET: muestra un HTML con iframe/botón hacia módulo biométrico.
 *    - POST: se usa si quieres que biometría haga callback aquí y recargue la vista.
 */
app.get("/mobile_client/register-confirm", async (req, res) => {
    try {
        const { email, session_token } = req.query;

        if (!email) {
            const html = loadTemplate("error_estetico.html")
                .replace("{{ERROR_MESSAGE}}", "Faltan datos necesarios.");
            return res.send(html);
        }

        // Mostrar registro_estetico.html

        const html = loadTemplate("registro_estetico.html")
            .replace("{{EMAIL}}", email)
            .replace("{{TOKEN}}", session_token || "");

        return res.send(html);

    } catch (err) {
        console.error("❌ Error en GET /mobile_client/register-confirm:", err);

        const html = loadTemplate("error_estetico.html")
            .replace("{{ERROR_MESSAGE}}", "Error interno procesando la solicitud.");
        return res.send(html);
    }
});
app.post("/mobile_client/register-confirm-continue", async (req, res) => {
    try {
        const { email } = req.body;

        // 1. Llamar check-user recién aquí
        let raw = await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/check-user`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${BIOMETRIA_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                email,
                session_token: req.body.session_token,
                action: "registro",
            })
        });

        let text = await raw.text();
        let data;

        try {
            data = JSON.parse(text);
        } catch {
            console.error("❌ Respuesta no JSON:", text);
            return res.send(loadTemplate("error_estetico.html")
                .replace("{{ERROR_MESSAGE}}", "Error comunicando con biometría."));
        }

        // CASO A: Existe → error + limpieza
        if (data.exists === true) {
            console.warn("⚠ Usuario ya existe, limpiando datos…");
            await QRSession.deleteMany({ email });
            await Temporal.deleteMany({ email, challengeId: { $regex: /^REG_/ } });
            if (biometricRegTimers.has(email)) {
                clearTimeout(biometricRegTimers.get(email));
                biometricRegTimers.delete(email);
            }

            return res.send(loadTemplate("error_registered.html"));
        }

        // 3. CASO B: Usuario NO existe → INICIAR TEMPORIZADOR DE ESPERA
        dlog("Usuario no existe, iniciando temporizador de espera para registro…");

        // cancelar timer previo si existiera
        if (biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        // tiempo máximo esperando /api/registro-finalizado → 10 minutos
        const REG_TIMEOUT_MS = 10 * 60 * 1000;

        const timer = setTimeout(async () => {
            try {
                dlog(`⏰ Timeout registro biométrico para ${email}, limpiando datos…`);
                await QRSession.deleteMany({ email });
                await Temporal.deleteMany({ email, challengeId: { $regex: /^REG_/ } });
            } catch (err) {
                console.error("❌ Error limpiando tras timeout biométrico:", err);
            } finally {
                biometricRegTimers.delete(email);
            }
        }, REG_TIMEOUT_MS);

        biometricRegTimers.set(email, timer);

        // MOSTRAR PANTALLA DE ESPERA (sin authenticate-start)
        return res.send(
            loadTemplate("registro_estetico.html")
                .replace("{{EMAIL}}", email)
                .replace("{{SESSIONID}}", req.body.token)
                .replace("{{BIOMETRIA_URL}}", "") // ya no se usa
        );

    } catch (err) {
        console.error("🔥 Error en /register-confirm-continue:", err);
        return res.send(loadTemplate("error_estetico.html")
            .replace("{{ERROR_MESSAGE}}", "Error interno."));
    }
});

app.get("/api/registro-estado", async (req, res) => {
    const { email } = req.query;

    if (!email) return res.json({ estado: "error" });

    const temp = await Temporal.findOne({
        email,
        challengeId: { $regex: /^REG_/ }
    });

    if (!temp) return res.json({ estado: "no_encontrado" });

    if (temp.status === "biometria_ok") {
        return res.json({ estado: "completado" });
    }

    return res.json({ estado: "pendiente" });
});




app.post("/api/registro-finalizado", async (req, res) => {

    dlog("BODY /api/registro-finalizado:", req.body);
    try {
        const { user_id, email, session_token, action } = req.body;

        if (!email || !session_token || !action) {
            console.error("❌ Faltan campos obligatorios en /registro-finalizado");
            return res.status(400).json({ error: "missing_fields" });
        }

        if (action !== "registro") {
            console.error("❌ Acción inválida en /registro-finalizado:", action);
            return res.status(400).json({ error: "invalid_action" });
        }

        // cancelar timer
        if (biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        // buscar temporal
        const temp = await Temporal.findOne({
            email,
            session_token,
        });

        if (!temp) {
            console.warn("⚠ [REGISTRO FINALIZADO] No se encontró sesión temporal.");
            return res.status(404).json({ error: "registration_session_not_found" });
        }
        let raw_responses = req.body.raw_responses;

        // Si viene como array user_answers → convertirlo
        if (!raw_responses && Array.isArray(req.body.user_answers)) {
            raw_responses = req.body.user_answers.join(",");
        }

        // Si viene como array (forma interna) → convertirlo
        if (Array.isArray(raw_responses)) {
            raw_responses = raw_responses.join(",");
        }

        temp.status = "biometria_ok";
        temp.userBiometriaId = user_id;
        temp.cadenaValores = raw_responses;

        await temp.save();

        dlog("✅ Registro biométrico guardado correctamente en MongoDB.");

        // Registro completado para el email
        await QRSession.deleteMany({ email }); //limpiar sesiones QR ya usadas
        dlog("🧹 Sesiones QR limpiadas para:", email);


        // Enviar datos al módulo de análisis psicológico
        dlog("➡️ Enviando payload a psy_analyzer:", {
            email, user_id, raw_responses, session_token
        });
        // 5. Enviar datos al módulo de análisis (Python)
        if (ANALYSIS_BASE_URL) {
            const parsedAnswers = raw_responses
                .split(",")
                .map((x) => parseInt(x.trim(), 10));

            const payload = {
                email,
                idUsuario: user_id,
                user_answers: parsedAnswers,
                session_token
            };

            dlog("📦 Enviando payload al módulo de análisis:", payload);

            try {
                const response = await fetch(`${ANALYSIS_BASE_URL}/api/biometric-registration`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("❌ psy_analyzer devolvió error:", errorText);

                    // ----------------------------
                    // LIMPIEZA COMPLETA DE SESIONES
                    // ----------------------------

                    dwarn("🧹 Limpiando datos debido a fallo del analizador…");

                    await QRSession.deleteMany({ email });
                    await Temporal.deleteMany({ email, challengeId: { $regex: /^REG_/ } });
                    await Subscripcion.deleteOne({ email });

                    // Detener timeout biométrico si existe
                    if (biometricRegTimers.has(email)) {
                        clearTimeout(biometricRegTimers.get(email));
                        biometricRegTimers.delete(email);
                    }

                    return res.status(500).json({
                        error: "analysis_failed",
                        detail: "El analizador psicológico devolvió un error.",
                        analyzer_response: errorText
                    });
                }

                dlog("⬅️ psy_analyzer respondió:", response.status);
            } catch (err) {
                console.error("❌ Error enviando a psy_analyzer:", err);
            }
        }

        // 6. Respuesta final
        return res.json({ ok: true, message: "Registro completado correctamente" });

    } catch (err) {
        console.error("❌ Error en /api/registro-finalizado:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

//===========================================================
//  ENDPOINTS GENERACION 
//===========================================================
app.post('/request-gen-login', clientAuth, loginRateLimiter, async (req, res) => {
    dlog("🔵 [GEN-REQUEST] Recibido request-gen-login desde la extensión");
    dlog("Email:", req.body.email);
    dlog("Platform:", req.body.platform);

    const { email, platform, tabId } = req.body;

    try {
        const subDoc = await Subscripcion.findOne({ email });
        if (!subDoc) {
            return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
        }
        await Temporal.deleteMany({
            email,
            action: "generacion",
            status: { $in: ["pending", "confirmed", "denied", "biometria_failed", "used"] }
        });
        const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
        const session_token = generateToken();

        const newChallenge = new Temporal({
            email,
            challengeId,
            platform,
            session_token,
            status: "pending",
            action: "generacion",
            meta: { tabId: Number.isFinite(Number(tabId)) ? Number(tabId) : undefined }
        });
        await newChallenge.save();

        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const baseUrl = `${proto}://${host}`;

        const continueUrl = `${baseUrl}/mobile_client/gen-confirm?session_token=${encodeURIComponent(session_token)}&status=confirmed`;
        dlog("🔵 [GEN-REQUEST] continueUrl generado:", continueUrl);

        const payload = {
            title: 'Solicitud de Generación de Contraseña',
            body: `Se ha solicitado generar una contraseña para: ${email}. Toque "Generar" para continuar.`,
            actionType: 'generate',
            email,
            session_token,
            continueUrl: encodeURI(continueUrl)
        };

        dlog("📦 [GEN-REQUEST] Payload PUSH que se enviará:", payload);


        const pushResult = await sendPushNotification(subDoc.subscription, payload);
        dlog("📨 Notificación enviada con éxito", pushResult);
        if (!pushResult.success) {
            return res.status(500).json({ error: 'Fallo al enviar notificación Push.' });
        }

        return res.status(200).json({
            message: 'Solicitud enviada al móvil.',
            challengeId
        });

    } catch (err) {
        console.error("❌ Error en /request-gen-login:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

app.get('/mobile_client/gen-confirm', async (req, res) => {
    const { session_token, status } = req.query;

    dlog("🟦 [LOGIN][GEN-CONFIRM] Request recibida:", { status });
    dlog("🟦 [GEN-CONFIRM] Query params:", req.query);

    try {
        const challenge = await Temporal.findOne({ session_token: session_token });

        dlog("🟦 [LOGIN][GEN-CONFIRM] Challenge encontrado:", challenge ? {
            email: challenge.email,
            action: challenge.action,
            status: challenge.status,
            challengeId: challenge.challengeId
        } : "No encontrado");

        if (!challenge) {
            dwarn("⚠️ [LOGIN][GEN-CONFIRM] Challenge no encontrado.");
            return res.status(404).send("Desafío inválido o expirado.");
        }

        if (status === "confirmed") {
            if (challenge.status === "pending") {
                challenge.status = "confirmed";
                await challenge.save();
                dlog("🟦 [LOGIN][GEN-CONFIRM] Challenge marcado confirmed");
            }

            const html = loadTemplate("gen_estetico.html")
                .replace("{{SESSION_TOKEN}}", session_token);

            return res.send(html);
        }

        // Usuario rechazó en la notificación
        challenge.status = "denied";
        await challenge.save();
        dlog("🟡 [LOGIN][GEN-CONFIRM] Usuario rechazó.");

        return res.send("<h1>Autenticación GEN rechazada</h1>");

    } catch (err) {
        console.error("❌ [LOGIN][GEN-CONFIRM] Error:", err);
        return res.status(500).send("Error interno.");
    }
});

app.post('/mobile_client/gen-continue', async (req, res) => {
    const { session_token } = req.body;

    dlog("[GEN][AUTH-CONTINUE] POST recibido:", { session_token });
    dlog("[GEN-CONTINUE] Body recibido:", req.body);


    if (!session_token) {
        dwarn("⚠️ [GEN-CONTINUE] No se recibió token en el POST");
        return res.status(400).send("Falta token");
    }

    try {
        const challenge = await Temporal.findOne({ session_token: session_token });
        dlog("[GEN-CONTINUE] Challenge encontrado:", challenge ? {
            email: challenge.email,
            action: challenge.action,
            status: challenge.status,
            session_token: challenge.session_token
        } : "❌ No encontrado");


        if (!challenge) {
            dwarn("⚠️ [LOGIN][GEN-CONTINUE] Challenge no encontrado para token");
            await logSecurityEvent("gen_continue_invalid_token", {
                ip: req.ip,
                path: req.path,
                meta: { tokenPrefix: token.slice(0, 8) }
            });
            return res.status(404).send("Desafío no encontrado");
        }

        if (challenge.action !== "generacion") {
            dlog("❌ [GEN-CONTINUE] Acción inválida:", challenge.action);
            return res.status(400).send("Invalid action for gen-continue");

        }




        dlog("🟦 [LOGIN][GEN-CONTINUE] Challenge:", {
            email: challenge.email,
            session_token: challenge.session_token,
            status: challenge.status
        });

        // inicia biometría
        const respBio = await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BIOMETRIA_API_KEY}`
            },
            body: JSON.stringify({
                email: challenge.email,
                session_token: challenge.session_token,
                action: "generacion",
                callback_url: `${SERVER_BASE_URL}/api/biometric-gen-callback`
            })
        });

        const dataBio = await respBio.json().catch(() => ({}));

        dlog("[LOGIN][GEN-CONTINUE] Respuesta authenticate-start:", dataBio);

        if (!respBio.ok || !dataBio.success) {
            challenge.status = "biometria_failed";
            await challenge.save();
            console.error("❌ [LOGIN][GEN-CONTINUE] Error authenticate-start:", dataBio);
            return res.send("<h1>Error iniciando autenticación biométrica</h1>");
        }

        dlog("[LOGIN][GEN-CONTINUE] Biometría iniciada, esperando callback…");

        return res.send(`
            <h1>Autenticación iniciada</h1>
            <p>Completa la verificación biométrica en la app.</p>
        `);

    } catch (err) {
        console.error("❌ [LOGIN][GEN-CONTINUE] Error:", err);
        return res.status(500).send("Error interno");
    }
});


//===========================================================
//  ENDPOINTS AUTENTICACIÓN (BIOMETRIC) 
//===========================================================


app.post('/api/biometric-login-callback', async (req, res) => {
    dlog("🟣 [BIO-CALLBACK] Request recibido del módulo biométrico");
    dlog("Headers recibidos (sanitizados):", {
        authorization: req.headers.authorization ? "Bearer ***" : undefined
    });
    dlog("Body recibido:", {
        user_id: req.body.user_id,
        email: req.body.email,
        session_token: req.body.session_token,
        action: req.body.action,
        authenticated: req.body.authenticated
    });

    try {

        // Validar API Key
        const auth = req.headers.authorization || "";
        const apiKey = auth.replace("Bearer ", "");

        if (apiKey !== BIOMETRIA_API_KEY) {
            dwarn("⚠ Intento de acceso con API Key inválida en /api/biometric-login-callback");
            return res.status(401).json({ error: "unauthorized" });
        }

        // Extraer datos
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
        dlog("🔎 [BIO-CALLBACK] Buscando Temporal con:");
        dlog({
            email: req.body.email,
            session_token: req.body.session_token
        });


        // Buscar el challenge de LOGIN correspondiente
        const temp = await Temporal.findOne({
            email,
            session_token,
            action: "autenticacion"
        }).sort({ createdAt: -1 });


        if (!temp) {
            dwarn("⚠ Callback de autenticación sin Temporal activo:", {
                email,
                session_token
            });

            console.error("❌ [BIO-CALLBACK] No existe Temporal para este session_token!");
            return res.status(404).json({ error: "auth_session_not_found" });

        } else {
            dlog("🟢 [BIO-CALLBACK] Temporal encontrado:", {
                id: temp._id,
                challengeId: temp.challengeId,
                status: temp.status
            });
        }

        if (temp.status !== "confirmed") {
            await logSecurityEvent("biometric_without_confirmation", {
                email,
                ip: req.ip,
                path: req.path,
                meta: { currentStatus: temp.status }
            });
            return res.status(409).json({ error: "auth_not_confirmed" });
        }

        dlog("🟦 [LOGIN][BIO-CALLBACK] Callback recibido:", {
            email,
            authenticated,
            session_token: session_token?.slice(0, 8) + "..."
        });

        // 4) Si la autenticación fue rechazada
        if (!authenticated) {
            temp.status = 'denied';
            await temp.save();
            return res.json({ ok: true, authenticated: false });
        }
        dlog("🔐 [BIO-CALLBACK] Validando JWT biométrico…");


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
            await logSecurityEvent("invalid_biometric_jwt", {
                email,
                ip: req.ip,
                path: req.path,
                userAgent: req.headers["user-agent"],
                meta: { reason: jwtCheck.error?.message }
            });
            return res.status(400).json({ error: "invalid_biometric_jwt" });
        }
        dlog("🟢 [BIO-CALLBACK] JWT válido");

        // 6) Marcar como OK y guardar datos
        temp.status = 'biometria_ok';
        temp.userBiometriaId = user_id;
        temp.biometriaJwt = biomJwt;
        await temp.save();

        // A partir de aquí, la extensión podrá ver:
        //   status: 'authenticated' y token: temp.token
        // cuando consulte /check-password-status
        dlog("✅ [BIO-CALLBACK] Autenticación biométrica completada OK");
        return res.json({ ok: true, authenticated: true });

    } catch (err) {
        console.error("❌ Error en /api/biometric-login-callback:", err);
        return res.status(500).json({ error: "server_error" });
    }
});

app.post('/api/biometric-gen-callback', async (req, res) => {
    dlog("🟣 [BIO-CALLBACK] Request recibido del módulo biométrico");
    dlog("Headers recibidos (sanitizados):", {
        authorization: req.headers.authorization ? "Bearer ***" : undefined
    });
    dlog("Body recibido:", {
        user_id: req.body.user_id,
        email: req.body.email,
        session_token: req.body.session_token,
        action: req.body.action,
        authenticated: req.body.authenticated
    });

    try {

        // Validar API Key
        const auth = req.headers.authorization || "";
        const apiKey = auth.replace("Bearer ", "");

        if (apiKey !== BIOMETRIA_API_KEY) {
            console.warn("⚠ Intento de acceso con API Key inválida en /api/biometric-gen-callback");
            return res.status(401).json({ error: "unauthorized" });
        }

        //  Extraer datos
        const {
            user_id,
            email,
            session_token,
            action,
            authenticated,
            jwt: biomJwt
        } = req.body;

        if (action !== "generacion") {
            return res.status(400).json({ error: "invalid_action" });
        }

        if (!email || !session_token) {
            return res.status(400).json({ error: "email_and_session_token_required" });
        }
        dlog("🔎 [BIO-CALLBACK] Buscando Temporal con:");
        dlog({
            email: req.body.email,
            session_token: req.body.session_token
        });


        //  Buscar el challenge de LOGIN correspondiente
        //    Asumimos que guardaste session_token en Temporal.token
        const temp = await Temporal.findOne({
            email,
            session_token,
            action: "generacion"
        }).sort({ createdAt: -1 });


        if (!temp) {
            dwarn("⚠ Callback de autenticación (generacion) sin Temporal activo:", {
                email,
                session_token
            });

            console.error("❌ [BIO-CALLBACK] No existe Temporal para este session_token!");
            return res.status(404).json({ error: "auth_session_not_found" });

        } else {
            dlog("🟢 [BIO-CALLBACK] Temporal encontrado:", {
                id: temp._id,
                challengeId: temp.challengeId,
                status: temp.status
            });
        }

        dlog("🟦 [GEN][BIO-CALLBACK] Callback recibido:", {
            email,
            authenticated,
            session_token: session_token?.slice(0, 8) + "..."
        });

        // 4) Si la autenticación fue rechazada
        if (!authenticated) {
            temp.status = 'denied';
            await temp.save();
            return res.json({ ok: true, authenticated: false });
        }
        dlog("🔐 [BIO-CALLBACK] Validando JWT biométrico…");


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
            await logSecurityEvent("invalid_biometric_jwt", {
                email,
                ip: req.ip,
                path: req.path,
                userAgent: req.headers["user-agent"],
                meta: { reason: jwtCheck.error?.message }
            });
            return res.status(400).json({ error: "invalid_biometric_jwt" });
        }
        dlog("🟢 [BIO-CALLBACK] JWT válido");

        // 6) Marcar como OK y guardar datos
        temp.status = 'biometria_ok';
        temp.userBiometriaId = user_id;
        temp.biometriaJwt = biomJwt;
        await temp.save();

        // A partir de aquí, la extensión podrá ver:
        //   status: 'authenticated' y token: temp.token
        // cuando consulte /check-password-status
        dlog("✅ [BIO-CALLBACK] Autenticación biométrica completada OK");
        // ===============================================
        // 7) LLAMAR A ANALYZER /generator-init
        // ===============================================
        try {
            if (ANALYSIS_BASE_URL) {
                dlog("🚀 Llamando a ANALYZER /generator-init ...");

                const payload = {
                    user_id,
                    session_token,
                    email,
                    authenticated: true,
                    platform: temp.platform || "Unknown"
                };

                const respAnalyzer = await fetch(`${ANALYSIS_BASE_URL}/generator-init`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                const analyzerData = await respAnalyzer.json().catch(() => ({}));

                dlog("📥 Respuesta de /generator-init:", analyzerData);

                if (!respAnalyzer.ok || analyzerData.success !== true) {
                    console.error("❌ Analyzer respondió error en generación:", analyzerData);

                    return res.status(500).json({
                        ok: false,
                        authenticated: true,
                        error: "generator_init_failed",
                        detail: analyzerData.message || "Fallo en servidor de análisis"
                    });
                }

                // =====================================
                // 8) Notificar éxito a la extensión
                // =====================================
                dlog("🟢 Generación iniciada correctamente.");
                return res.json({
                    ok: true,
                    authenticated: true,
                    generator: analyzerData
                });
            }
        } catch (err) {
            console.error("🔥 Error llamando a ANALYSIS /generator-init:", err);
            return res.status(500).json({
                ok: false,
                authenticated: true,
                error: "analysis_exception"
            });
        }

        return res.json({ ok: true, authenticated: true });

    } catch (err) {
        console.error("❌ Error en /api/biometric-gen-callback:", err);
        return res.status(500).json({ error: "server_error" });
    }
});




//===========================================================
//  ENDPOINTS AUTENTICACIÓN (LOGIN) – EXTENSIÓN + MÓVIL
//===========================================================

/**
 * 5) La extensión pide login: se manda push al móvil.
 */
app.post('/request-auth-login', clientAuth, loginRateLimiter, async (req, res) => {
    dlog("🔵 [AUTH-REQUEST] Recibido request-auth-login desde la extensión");
    dlog("Email:", req.body.email);
    dlog("Platform:", req.body.platform);

    const { email, platform, tabId } = req.body;

    try {

        // Limpia-> solo un login activo por email
        await Temporal.deleteMany({
            email,
            action: "autenticacion",
            status: { $in: ["pending", "confirmed", "biometria_ok", "km_pending"] }
        });


        const subDoc = await Subscripcion.findOne({ email });
        if (!subDoc) {
            return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
        }

        // (Opcional) hash del endpoint para rastrear binding dispositivo
        const endpoint = subDoc.subscription?.endpoint || "";
        const subscriptionHash = endpoint
            ? crypto.createHash("sha256").update(endpoint).digest("hex")
            : null;

        const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
        const session_token = generateToken();
        const newChallenge = new Temporal({
            email,
            challengeId,
            platform,
            session_token,
            status: "pending",
            action: "autenticacion",
            meta: {
                tabId: Number.isFinite(Number(tabId)) ? Number(tabId) : undefined,
                subscriptionHash: subscriptionHash || undefined
            }

        });
        await newChallenge.save();

        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;
        const baseUrl = `${proto}://${host}`;

        const continueUrl = `${baseUrl}/mobile_client/auth-confirm?session_token=${encodeURIComponent(session_token)}&status=confirmed`;
        dlog("🔵 [AUTH-REQUEST] continueUrl generado:", continueUrl);

        const payload = {
            title: 'Solicitud de Inicio de Sesión',
            body: `Se ha solicitado acceso a ${email}. Toque "Autenticar" para continuar.`,
            actionType: 'auth',
            email,
            session_token,
            continueUrl: encodeURI(continueUrl)
        };

        dlog("📦 [AUTH-REQUEST] Payload PUSH que se enviará:", payload);


        const pushResult = await sendPushNotification(subDoc.subscription, payload);
        dlog("📨 Notificación enviada con éxito", pushResult);
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
 * El móvil confirma o rechaza autenticación (LOGIN).
 *   - En caso de confirmación, se llama al módulo biométrico.
 *   - Si biometría valida y el JWT es correcto, se marca Temporal como 'biometria_ok'.
 *   - La extensión hará polling a /check-password-status.
 */
app.get('/mobile_client/auth-confirm', async (req, res) => {
    const { session_token, status } = req.query;

    dlog("🟦 [LOGIN][AUTH-CONFIRM] Request recibida:", { status });

    try {
        const challenge = await Temporal.findOne({ session_token: session_token }).sort({ createdAt: -1 });
        requireTemporal(challenge, {
            action: "autenticacion",
            statuses: ["pending"]
        });

        dlog("[LOGIN][AUTH-CONFIRM] Challenge encontrado:", challenge ? {
            email: challenge.email,
            status: challenge.status,
            challengeId: challenge.challengeId
        } : "null");

        if (!challenge) {
            dwarn("⚠️ [LOGIN][AUTH-CONFIRM] Challenge no encontrado.");
            return res.status(404).send("Desafío inválido o expirado.");
        }

        if (status === "confirmed") {
            if (challenge.status !== "pending") {
                return res.status(409).send("Sesión ya utilizada o inválida.");
            }

            challenge.status = "confirmed";
            await challenge.save();
            dlog("[LOGIN][AUTH-CONFIRM] Challenge marcado confirmed");
            const html = loadTemplate("auth_estetico.html")
                .replace("{{SESSION_TOKEN}}", session_token);

            return res.send(html);
        }

        // Usuario rechazó en la notificación
        challenge.status = "denied";
        await challenge.save();
        dlog("🟡 [LOGIN][AUTH-CONFIRM] Usuario rechazó.");

        return res.send("<h1>Autenticación rechazada</h1>");

    } catch (err) {
        console.error("❌ [LOGIN][AUTH-CONFIRM] Error:", err);
        return res.status(500).json({ error: "error interno" });
    }

});

app.post('/mobile_client/auth-continue', async (req, res) => {
    const { session_token } = req.body;

    dlog("[LOGIN][AUTH-CONTINUE] POST recibido:", { session_token });

    if (!session_token) {
        dwarn("⚠️ [LOGIN][AUTH-CONTINUE] Falta token");
        return res.status(400).send("Falta challengeId");
    }

    try {
        const challenge = await Temporal.findOne({ session_token: session_token }).sort({ createdAt: -1 });

        requireTemporal(challenge, {
            action: "autenticacion",
            statuses: ["confirmed"]
        });

        if (!challenge) {
            dwarn("⚠️ [LOGIN][AUTH-CONTINUE] Challenge no encontrado para token");
            await logSecurityEvent("auth_continue_invalid_token", {
                ip: req.ip,
                path: req.path,
                meta: { tokenPrefix: session_token.slice(0, 8) }
            });
            return res.status(404).send("Desafío no encontrado");
        }

        if (challenge.action !== "autenticacion") {
            return res.status(400).send("Invalid action for auth-continue");
        }


        dlog("[LOGIN][AUTH-CONTINUE] Challenge:", {
            email: challenge.email,
            session_token: challenge.session_token,
            status: challenge.status
        });

        // ✨ Inicia biometría
        const respBio = await fetch(`${BIOMETRIA_BASE_URL}/api/v1/biometric/authenticate-start`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BIOMETRIA_API_KEY}`
            },
            body: JSON.stringify({
                email: challenge.email,
                session_token: challenge.session_token,
                action: "autenticacion",
                callback_url: `${SERVER_BASE_URL}/api/biometric-login-callback`
            })
        });

        const dataBio = await respBio.json().catch(() => ({}));

        dlog("[LOGIN][AUTH-CONTINUE] Respuesta authenticate-start:", dataBio);

        if (!respBio.ok || !dataBio.success) {
            challenge.status = "biometria_failed";
            await challenge.save();
            console.error("❌ [LOGIN][AUTH-CONTINUE] Error authenticate-start:", dataBio);
            return res.send("<h1>Error iniciando autenticación biométrica</h1>");
        }

        dlog("[LOGIN][AUTH-CONTINUE] Biometría iniciada, esperando callback…");

        return res.send(`
            <h1>Autenticación iniciada</h1>
            <p>Completa la verificación biométrica en la app.</p>
        `);

    } catch (err) {
        console.error("❌ [LOGIN][AUTH-CONTINUE] Error:", err);
        return res.status(500).json({ error: "error interno" });
    }

});


/**
 * 7) Polling del estado del token (llamado por la extensión).
 *    - Si encuentra Temporal con status 'biometria_ok' → authenticated + token.
 *    - Si encuentra alguno denegado/fallido → denied.
 *    - Caso contrario, pending.
 */
app.get('/check-password-status', clientAuth, statusRateLimiter, async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const { email } = req.query;
    const action = (req.query.action || "").toString().trim();   // "autenticacion" | "generacion" | ""
    const tabIdRaw = req.query.tabId;
    const tabId = (tabIdRaw !== undefined && tabIdRaw !== null && tabIdRaw !== "")
        ? Number(tabIdRaw)
        : null;

    try {

        // Filtro base
        const base = { email };
        if (action) base.action = action;
        // Si se envía tabId, se usa para evitar colisión multi-pestaña -> se rellene multiples pestañas
        if (Number.isFinite(tabId)) base["meta.tabId"] = tabId;

        const exists = await Temporal.findOne(base);

        if (!exists) {
            return res.status(200).json({ status: "expired" });
        }

        // Consumir el challenge biometría OK → used
        const okChallenge = await Temporal.findOneAndUpdate(
            { ...base, status: "biometria_ok" },
            { $set: { status: "km_pending" } },
            { sort: { createdAt: -1 }, new: true }
        );

        if (okChallenge) {
            return res.status(200).json({
                status: "authenticated",
                session_token: okChallenge.session_token
            });
        }

        // Denied / failed (solo del action/tabId si aplica)
        const badChallenge = await Temporal.findOne({
            ...base,
            status: { $in: ["denied", "biometria_failed"] }
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
    dlog("🚀 [NODE] Petición recibida en /api/analizer-register");
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
            dwarn("⛔ [NODE] API Key rechazada");
            return res.status(401).json({ error: "unauthorized" });
        }

        // --- 3. EXTRAER DATOS (Todo unificado a 'sessionToken') ---
        const {
            email,
            idUsuario: user_id,
            raw_responses,
            session_token // <--- Variable definida aquí
        } = req.body;

        const cadenaValores = Array.isArray(raw_responses)
            ? raw_responses.join(",")
            : raw_responses;

        dlog(`🔍 [NODE] Buscando temporal para: ${email} con session_token: ${session_token}`);

        if (!email || !session_token) {
            return res.status(400).json({ error: "email_and_sessionToken_required" });
        }

        // Parar temporizador de timeout (Si existe la variable global biometricRegTimers)
        if (typeof biometricRegTimers !== 'undefined' && biometricRegTimers.has(email)) {
            clearTimeout(biometricRegTimers.get(email));
            biometricRegTimers.delete(email);
        }

        // BUSCAR EN MONGO ---
        const temp = await Temporal.findOne({
            email,
            session_token: session_token,
            challengeId: { $regex: /^REG_/ }
        });

        if (!temp) {
            console.warn("⚠ Resultado biometría sin Temporal activo:", { email, session_token });
            return res.status(404).json({ error: "registration_session_not_found" });
        }

        //  GUARDAR EN MONGO 
        dlog("[NODE] Temporal encontrado. Actualizando estado...");
        temp.status = 'biometria_ok';
        temp.userBiometriaId = user_id;
        temp.cadenaValores = cadenaValores;
        await temp.save();

        // ENVIAR A  ANÁLISIS
        const analysisUrl = process.env.ANALYSIS_BASE_URL;

        if (analysisUrl) {
            try {
                const parsedAnswers = String(cadenaValores)
                    .split(",")
                    .map(v => Number(v.trim()))
                    .filter(n => !isNaN(n));

                const payload = {
                    email,
                    idUsuario: user_id,
                    user_answers: Array.isArray(parsedAnswers) ? parsedAnswers : [],
                    session_token: session_token
                };

                dlog("📦 [NODE] Payload a enviar a Python:", JSON.stringify(payload));

                await fetch(`${analysisUrl}/api/biometric-registration`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                dlog("[NODE] Python respondió con estatus: 200 (✅ Éxito)")

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
//  PÁGINA DE CONFIRMACIÓN DE REGISTRO (FRONTEND)
//===========================================================

app.get("/mobile_client/registro-completado", (req, res) => {
    const { email } = req.query;

    try {
        let html = loadTemplate("registro_completado.html");
        html = html.replace("{{EMAIL}}", email || "tu cuenta");

        return res.send(html);

    } catch (err) {
        console.error("❌ Error cargando registro_completado.html:", err);
        return res.status(500).send("Error interno mostrando la confirmación de registro.");
    }
});

//===========================================================
//  confirmacion SESSION_TOKEN con KM TOKEN
//===========================================================
app.post("/validate-km-token", clientAuth, async (req, res) => {
    try {
        const { session_token, email, tabId } = req.body;
        if (!email || !session_token) return res.status(400).json({ valid: false, error: "missing_fields" });

        // Validación FUERTE: debe ser login, en estado km_pending, y (si viene) ligado al tabId
        const q = {
            email,
            session_token,
            action: "autenticacion",
            status: "km_pending"
        };
        const tid = (tabId !== undefined && tabId !== null && tabId !== "") ? Number(tabId) : null;
        if (Number.isFinite(tid)) q["meta.tabId"] = tid;

        const temp = await Temporal.findOne(q).sort({ createdAt: -1 });
        if (!temp) return res.status(404).json({ valid: false });

        return res.status(200).json({ valid: true });
    } catch (e) {
        console.error("❌ Error en /validate-km-token:", e);
        return res.status(500).json({ valid: false, error: "server_error" });
    }
});

/**
 * TOKEN PARA AUTORIZAR PUBLIC KEY DEL PLUGIN EN KM
 */
/**
 * Emite un token (HMAC) para autorizar el registro de la public key del plugin en el KM.
 * Importante: la extensión NO conoce KM_PLUGIN_REG_SECRET, solo recibe el token ya firmado.
 */
app.post("/km-plugin-reg-token", clientAuth, async (req, res) => {
    try {
        const { email, session_token, tabId, plugin_id, public_key_b64 } = req.body;
        if (!email || !session_token || !plugin_id || !public_key_b64) {
            return res.status(400).json({ ok: false, error: "missing_fields" });
        }

        // Solo durante login ->en km_pending (biometría OK y aún no consumido)
        const q = {
            email,
            session_token,
            action: "autenticacion",
            status: "km_pending"
        };
        const tid = (tabId !== undefined && tabId !== null && tabId !== "") ? Number(tabId) : null;
        if (Number.isFinite(tid)) q["meta.tabId"] = tid;

        const temp = await Temporal.findOne(q).sort({ createdAt: -1 });
        requireTemporal(temp, {
            action: "autenticacion",
            statuses: ["km_pending"],
            tabId
        });
        if (!temp) {
            return res.status(403).json({ ok: false, error: "invalid_session_state" });
        }

        const payload = {
            user_id: email,
            plugin_id: plugin_id,
            public_key_b64: public_key_b64
        };

        const reg_token = signPluginRegistration(payload);
        return res.json({ ok: true, reg_token });
    } catch (e) {
        console.error("❌ Error en /km-plugin-reg-token:", e);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});

/**
 *  Finaliza el login y consume el token (ONE-TIME) SOLO cuando el KM ya fue exitoso.
 */
app.post("/finalize-km-session", clientAuth, async (req, res) => {
    try {
        const { email, session_token, tabId } = req.body;
        if (!email || !session_token) return res.status(400).json({ ok: false, error: "missing_fields" });

        const q = {
            email,
            session_token,
            action: "autenticacion",
            status: "km_pending"
        };
        const tid = (tabId !== undefined && tabId !== null && tabId !== "") ? Number(tabId) : null;
        if (Number.isFinite(tid)) q["meta.tabId"] = tid;

        // Atómico: km_pending -> used
        const updated = await Temporal.findOneAndUpdate(
            q,
            { $set: { status: "used" } },
            { new: true }
        );

        if (!updated) return res.status(404).json({ ok: false, error: "not_found_or_already_used" });
        return res.json({ ok: true });
    } catch (e) {
        console.error("❌ Error en /finalize-km-session:", e);
        return res.status(500).json({ ok: false, error: "server_error" });
    }
});


//===========================================================
//  MANEJO GLOBAL DE ERRORES
//===========================================================

app.use((err, req, res, next) => {
    // 🔥 NO tocar archivos estáticos
    if (req.path.startsWith("/mobile_client/")) {
        return next(err);
    }

    console.error("🔥 ERROR REAL:", {
        message: err.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        body: req.body
    });

    // APIs → JSON
    if (
        req.is("application/json") ||
        req.path.startsWith("/generar-qr-session") ||
        req.path.startsWith("/request-auth-login") ||
        req.path.startsWith("/register-mobile") ||
        req.path.startsWith("/qr-session-status") ||
        req.path.startsWith("/check-password-status")
    ) {
        return res.status(500).json({
            error: "server_error",
            message: "Ocurrió un error inesperado. Intenta nuevamente."
        });
    }

    // Fallback genérico
    return res.status(err.statusCode || 500).json({
        error: "internal_server_error",
        message: err.message || "Error interno del servidor",
        path: req.originalUrl
    });
});


app.use((req, res, next) => {
    // 🔥 NO tocar estáticos
    if (req.path.startsWith("/mobile_client/")) {
        return next();
    }

    const oldSend = res.send;
    res.send = function (body) {
        if (typeof body === "string" && body.includes("<!DOCTYPE")) {
            console.warn("⚠️ HTML DEVUELTO EN:", req.method, req.originalUrl);
            console.warn(body.slice(0, 300));
        }
        return oldSend.call(this, body);
    };
    next();
});



app.use((req, res, next) => {
    //  NO tocar estáticos
    if (req.path.startsWith("/mobile_client/")) {
        return next();
    }

    res.on("finish", () => {
        const ct = res.getHeader("content-type");
        if (ct && ct.includes("text/html")) {
            console.warn("⚠️ RESPUESTA HTML enviada a:", req.method, req.originalUrl);
        }
    });
    next();
});

//  CATCH-ALL PARA APIs: nunca devolver HTML
app.use((req, res, next) => {
    // 🔥 Nunca interceptar estáticos
    if (req.path.startsWith("/mobile_client/")) {
        return next();
    }

    if (
        req.path === "/register-mobile" ||
        req.path.startsWith("/qr-session") ||
        req.path === "/send-test-push"
    ) {
        return res.status(404).json({
            error: "api_not_found",
            path: req.originalUrl
        });
    }

    next();
});


app.post("*", (req, res, next) => {
    if (req.path.startsWith("/mobile_client/")) {
        return next();
    }

    if (req.path.includes("register-mobile")) {
        console.log("🔥 FETCH REAL ORIGEN:", {
            path: req.path,
            referer: req.headers.referer,
            origin: req.headers.origin,
            userAgent: req.headers["user-agent"]
        });
    }
    next();
});




//===========================================================
//  INICIAR SERVIDOR
//===========================================================

app.listen(PORT, () => {
    dlog(`🚀 Servidor Node.js iniciado en http://localhost:${PORT}`);
});
