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

// Configuracion y claves VAPID
const config = require('./config');

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

// Almacenar datos temporales en memoria para el QR
const qrSessions = new Map();

// Lógica
// Genera un TOKEN DE DESBLOQUEO Temporal.
function generateToken() {
    return Math.random().toString(36).slice(-8); 
}

// Enviar notificación push al usuario
async function sendPushNotification(subscription, payload, temporalID) {
    try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        console.log('Notificación enviada con éxito');
        return {success: true};
    } catch (error) {
        console.error('Error al enviar la notificación:', error.statusCode);

        if (error.statusCode === 404 || error.statusCode === 410) {
            await Subscripcion.deleteOne({ 'subscription.endpoint': subscription.endpoint });
            console.log('Subscripción eliminada de la base de datos debido a error 404/410');
        }
        return {success: false, error};
    }
}

// --- Endpoints registro y vinculacion ---

// Generar sesion temporal y QR
app.post('/generar-qr-sesion', async (req, res) => {
    const {email, platform} = req.body;
    const temporalID = 'SESS_' + Math.random().toString(36).substring(2, 9);
    
    const registerUrl = `http://localhost:${PORT}/mobile_client/register-mobile.html?sessionId=${temporalID}`; 
    
    const qrDataUrl = await qrcode.toDataURL(registerUrl);

    // Guardar en memoria el temporal
    qrSessions.set(temporalID, {email, platform, estado: 'pendiente'});

    res.status(200).json({ 
        qr: qrDataUrl, 
        sessionId: temporalID, 
        registerUrl: registerUrl,
        vapidPublicKey: config.VAPID_PUBLIC_KEY,
        platform: platform
    });
});

// Registro de subscripcion del movil
app.post('/register-mobile', async (req, res) => {
    const { sessionId, subscription } = req.body;
    
    const sessionData = qrSessions.get(sessionId); 
    if (!sessionData) {
        return res.status(404).json({ error: 'Sesión temporal expirada o no encontrada.' });
    }

    try {
        // Almacenar la suscripción permanentemente en MongoDB
        await Subscripcion.findOneAndUpdate(
            { email: sessionData.email },
            { $set: { subscription: subscription } },
            { upsert: true, new: true } 
        );
        
        qrSessions.delete(sessionId); // Limpiar sesión temporal

        // Primer Push: "Registrar"
        const payload = {
            title: 'Dispositivo Vinculado',
            body: 'Haga clic para finalizar el registro de su cuenta.',
            actionType: 'register',
            sessionId: sessionId
        };

        sendPushNotification(subscription, payload, sessionId); 

        res.status(200).json({ message: 'Dispositivo registrado y vinculado.' });
        
    } catch (e) {
        console.error('Error al guardar suscripción en BD:', e);
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// --- Endpoints Autenticacion ---

app.post('/request-auth-login', async (req, res) => {
    const { email } = req.body;
    
    const subDoc = await Subscripcion.findOne({ email: email });
    if (!subDoc) {
        return res.status(404).json({ error: 'No se encontró un dispositivo vinculado para este email.' });
    }

    // Crear un nuevo DESAFÍO/TOKEN de autenticación temporal (Temporal)
    const challengeId = 'CHLG_' + Math.random().toString(36).substring(2, 9);
    const newChallenge = new Temporal({ email, challengeId: challengeId }); 
    await newChallenge.save();

    // ENVIAR NOTIFICACIÓN 'AUTENTICAR'
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

// Recibe la confirmación del móvil (Llamado por /mobile/auth-confirm)
app.get('/mobile/auth-confirm', async (req, res) => {
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
        
        // Almacenar el TOKEN DE DESBLOQUEO en el campo 'token' del desafío
        challenge.token = tokenDesbloqueo;
        challenge.status = 'confirmed';
        await challenge.save();

        res.send(`<h1> Autenticación Exitosa</h1><p>Ahora puede cerrar esta ventana. La extensión de Chrome rellenará la contraseña.</p>`);
    } else {
        challenge.status = 'denied';
        await challenge.save();
        res.send('<h1>Autenticación Rechazada</h1><p>El inicio de sesión fue denegado por el usuario.</p>');
    }
});


// Consulta el estado del token (Llamado por la extensión - Polling)
app.get('/check-password-status', async (req, res) => {
    const { email } = req.query;
    
    const confirmedChallenge = await Temporal.findOne({ 
        email: email, 
        status: 'confirmed' 
    }).sort({ createdAt: -1 }); 

    if (confirmedChallenge) {
        // Eliminar el desafío (token) después de la primera consulta
        await Temporal.deleteOne({ _id: confirmedChallenge._id });

        // Devolvemos el TOKEN DE DESBLOQUEO, NO la contraseña real.
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
        // Eliminar desafío denegado para limpiar y permitir un nuevo intento
        await Temporal.deleteOne({ _id: activeChallenge._id });
        return res.status(200).json({ status: 'denied' });
    }

    // Si no hay confirmados ni denegados, está pendiente.
    return res.status(200).json({ status: 'pending' });
});


// SERVIDOR WEB ESTÁTICO (para archivos del cliente móvil)
app.use('/mobile_client', express.static(path.join(__dirname, '..', 'mobile_client')));


// INICIAR SERVIDOR ---
app.listen(PORT, () => {
    console.log(`Servidor Node.js iniciado en http://localhost:${PORT}`);
});