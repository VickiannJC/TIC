const mongoose = require('mongoose');

const TemporalSchema = new mongoose.Schema({
    challengeId: {
        type: String,
        required: true,
        unique: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true
    },
    platform: {
        type: String,
        lowercase: true,
        required: true
    },
    action: {
        type: String,
        enum: ['autenticacion', 'registro', 'generacion'],
        required: true
    },
    // pending: recién creado
    // confirmed: usuario aceptó en móvil
    // denied: usuario rechazó
    // biometria_ok: biometría validada (login o registro)
    // biometria_failed: fallo biométrico
    // used: token ya entregado a la extensión
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'denied', 'biometria_ok', 'biometria_failed', 'used', 'km_pending'],
        default: 'pending'
    },
    
    // - para LOGIN: es el session_token enviado a Biometría y el token que ve la extensión
    // - para REGISTRO: es el session_token enviado a Biometría
    session_token: {
        type: String,
        default: null
    },
    // Datos que vienen de Biometría
    userBiometriaId: { type: String, default: null },
    biometriaJwt: { type: String, default: null },
    cadenaValores: { type: String, default: null }, // raw_responses para registro
    meta: { type: Object, default: {} },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 3600 // 1 hora //600- 10 minutos
        
    }
});

TemporalSchema.index(
    { email: 1, action: 1, status: 1 },
    { background: true }
);

module.exports = mongoose.model('Temporal', TemporalSchema);