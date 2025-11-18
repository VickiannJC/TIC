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
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'denied'],
        default: 'pending'
    },
    // Este campo almacena el TOKEN DE DESBLOQUEO de única vez
    token: { 
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 120 // Expira automáticamente en 120 segundos (2 minutos)
    }
});

module.exports = mongoose.model('Temporal', TemporalSchema);