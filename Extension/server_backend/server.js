const express = require('express');
const bodyParser = require('body-parser');
const webpush = require('web-push');
const cors = require('cors');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const path = require('path');

// Modelos de MongoDB
const Subscripcion = require('./modelosDB/Subscripciones');
const Temporal = require('./modelosDB/temporales');
const QRSession = require('./modelosDB/QRSession');

// Configuracion y claves VAPID
const config = require('./config');
const { platform } = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

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


// Genera un TOKEN DE DESBLOQUEO Temporal (para login)
function generateToken() {
    return Math.random().toString(36).slice(-8);
}

// Enviar notificación push al usuario
async function sendPushNotification(subscription, payload, temporalID) {
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

app.post('/generar-qr-sesion', async (req, res) => {
    const { email, platform } = req.body;

    try {
        // Revisar si el email ya tiene un dispositivo vinculado
        const existing = await Subscripcion.findOne({ email });

        if (existing) {
            console.log("❌ Registro bloqueado: email ya existe →", email);

            return res.status(409).json({
                error: "email_exists",
                message: "Este correo ya está registrado y vinculado a un dispositivo."
            });
        }

        //Eliminar sesiones previas del email
        await QRSession.deleteMany({ email });

        //Crear el nuevo session ID
        const sessionId = 'SESS_' + Math.random().toString(36).substring(2, 9);

        // Detectar dinámicamente host real (ngrok, dominio, ip, local)
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.headers.host;

        const baseUrl = `${proto}://${host}`;

        // URL REAL accesible desde el celular
        const registerUrl = `${baseUrl}/mobile_client/register-mobile.html?sessionId=${sessionId}`;

        const qrDataUrl = await qrcode.toDataURL(registerUrl);

        // Guardar nueva sesión
        await QRSession.create({
            sessionId,
            email,
            platform,
            estado: "pending"
        });

        
        console.log("🟢 Sesión nueva creada:", sessionId);
        console.log("🔐 Sesiones activas ahora:", [...qrSessions.keys()]);

        res.status(200).json({
             qr: qrDataUrl,
            sessionId,
            registerUrl

        });

    } catch (err) {
        console.error("❌ Error en /generar-qr-sesion:", err);
        return res.status(500).json({ error: "Error interno del servidor." });
    }
});


// Registro de subscripción del movil (cuando escanean el QR)
app.post('/register-mobile', async (req, res) => {
    const { sessionId, subscription } = req.body;

    console.log("📨 /register-mobile llamado");
    console.log("📨 BODY:", req.body);

    const sessionData = await QRSession.findOne({ sessionId });

    if (!sessionData) {
         return res.status(404).json({
            error: "session_not_found",
            message: "Este QR ya expiró o no existe."
        });
    }

    console.log("📨 EMAIL ASOCIADO:", sessionData.email);

    // -------------- VALIDACIÓN DE EMAIL DUPLICADO --------------
    const existing = await Subscripcion.findOne({ email: sessionData.email });

    if (existing) {
        console.log("❌ BLOQUEADO: email YA existe:", sessionData.email);

        return res.status(409).json({
            error: "email_exists",
            message: "Este correo ya está registrado en otro dispositivo."
        });
    }

    // -------------- GUARDAR REGISTRO NUEVO ---------------------
    try {
        await Subscripcion.findOneAndUpdate(
            { email: sessionData.email },
            {
                $set: {
                    subscription,
                    linkedAt: new Date()
                }
            },
            { upsert: true }
        );


        console.log("✔ REGISTRO GUARDADO:", saved);
        await QRSession.deleteMany({ email: sessionData.email });

        // enviar push inicial
        const payload = {
            title: 'Dispositivo Vinculado',
            body: 'Haga clic para finalizar el registro.',
            actionType: 'register',
            sessionId: sessionId
        };

        await sendPushNotification(subscription, payload, sessionId);

        res.status(200).json({ message: "registro_ok" });

    } catch (e) {
        console.error("❌ ERROR AL GUARDAR:", e);
        res.status(500).json({ error: "db_error" });
    }
});


// ===============================
// ENDPOINTS AUTENTICACIÓN (LOGIN)
// ===============================

app.post('/request-auth-login', async (req, res) => {
    const { email } = req.body;

    const subDoc = await Subscripcion.findOne({ email: email });
    if (!subDoc) {
        return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
    }

    const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
    const newChallenge = new Temporal({ email, challengeId: challengeId });
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
        return res.send(`<h1>Acción Previa</h1><p>Este desafío ya fue procesado: ${challenge.status}.</p>`);
    }

    if (status === 'confirmed') {
        const tokenDesbloqueo = generateToken();

        challenge.token = tokenDesbloqueo;
        challenge.status = 'confirmed';
        await challenge.save();

        res.send(`<h1>Autenticación Exitosa</h1><p>Ahora puede cerrar esta ventana. La extensión de Chrome rellenará la contraseña.</p>`);
    } else {
        challenge.status = 'denied';
        await challenge.save();
        res.send('<h1>Autenticación Rechazada</h1><p>El inicio de sesión fue denegado por el usuario.</p>');
    }
});

// ======================================================
// CONFIRMACIÓN DE REGISTRO DESDE EL MÓVIL
// ======================================================
app.get('/mobile_client/register-confirm', async (req, res) => {
    console.log("📡 /mobile_client/register-confirm llamado");

    const { sessionId, status } = req.query;

    console.log("📡 sessionId:", sessionId);
    console.log("📡 status:", status);
    console.log("📡 qrSessions actuales:", Array.from(qrSessions.keys()));

    const sessionData = await QRSession.findOne({ sessionId });

    if (!sessionData) {
        console.log("❌ No existe la sesión (Probablemente QR viejo)")
        return res.send(`
            <h1>QR Expirado</h1>
            <p>El QR que escaneaste ya no es válido.</p>
        `);
    }


    if (status !== "confirmed") {
        await QRSession.deleteOne({ sessionId });
        return res.send(`
            <h1>Vinculación cancelada</h1>
            <p>Has cancelado el proceso.</p>
        `);
    }

    // Guardar el dispositivo en BD
    try {
        console.log("💾 Guardando suscripción en Mongo para:", sessionData.email);

        await Subscripcion.findOneAndUpdate(
            { email: sessionData.email },
            {
                $set: {
                    subscription: sessionData.subscription,
                    linkedAt: new Date()
                }
            },
            { upsert: true}
        );

        console.log("✔ Suscripción guardada:", saved);

        await QRSession.deleteMany({email:sessionData.email});


        console.log("🗑 Sesiones eliminadas para el email:", sessionData.email);

        return res.send(`
            <h1>Vinculación Exitosa</h1>
            <p>Tu dispositivo ha sido registrado correctamente.</p>
        `);

    } catch (err) {
        console.log("❌ Error al guardar:", err);
        return res.send(`
            <h1>Error Interno</h1>
            <p>No se pudo completar la vinculación.</p>
        `);
    }
});


// Polling del estado del token (llamado por la extensión)
app.get('/check-password-status', async (req, res) => {
    const { email } = req.query;

    const confirmedChallenge = await Temporal.findOne({
        email: email,
        status: 'confirmed'
    }).sort({ createdAt: -1 });

    if (confirmedChallenge) {
        //await Temporal.deleteOne({ _id: confirmedChallenge._id });

        return res.status(200).json({
            status: 'authenticated',
            token: confirmedChallenge.token
        });
    }

    const activeChallenge = await Temporal.findOne({
        email: email,
        status: { $in: ['pending', 'denied'] }
    });

    if (activeChallenge && activeChallenge.status === 'denied') {
        //await Temporal.deleteOne({ _id: activeChallenge._id });
        return res.status(200).json({ status: 'denied' });
    }

    return res.status(200).json({ status: 'pending' });
});

// Archivos estáticos del cliente móvil
app.use('/mobile_client', express.static(path.join(__dirname, '..', 'mobile_client')));

app.listen(PORT, () => {
    console.log(`Servidor Node.js iniciado en http://localhost:${PORT}`);
});
