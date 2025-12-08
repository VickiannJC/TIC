const mongoose = require('mongoose');

const SecurityEventSchema = new mongoose.Schema(
    {
        type: { type: String, required: true },          // "rate_limit_exceeded", "invalid_biometric_jwt"
        email: { type: String },
        ip: { type: String },
        path: { type: String },
        userAgent: { type: String },
        meta: { type: Object }                           // datos adicionales
    },
    { timestamps: true }
);

module.exports = mongoose.model('SecurityEvent', SecurityEventSchema);
