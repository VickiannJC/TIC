const mongoose = require("mongoose");

const qrSessionSchema = new mongoose.Schema({
    sessionId: { type: String, unique: true, index: true },
    email: { type: String, required: true, index: true },
    platform: { type: String },
    subscription: { type: Object, default: null },

    estado: {
        type: String,
        enum: ["pending", "confirmed", "cancelled", "expired"],
        index: true
    },

    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date }
});

// Índice compuesto para búsquedas frecuentes
qrSessionSchema.index({ email: 1, estado: 1, expiresAt: 1 });

// TTL para sesiones expiradas
qrSessionSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, partialFilterExpression: { estado: "expired" } }
);

module.exports = mongoose.model("QRSession", qrSessionSchema);
