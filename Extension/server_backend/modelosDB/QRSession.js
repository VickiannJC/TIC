const mongoose = require("mongoose");

const qrSessionSchema = new mongoose.Schema({
    sessionId: { type: String, unique: true },
    email: { type: String, required: true },
    platform: { type: String },
    subscription: { type: Object, default: null },
    estado: { type: String, default: "pending" },  // pending | confirmed | expired
    createdAt: { type: Date, default: Date.now, expires: 120 } // expira en 120s (2 minutos)
});

module.exports = mongoose.model("QRSession", qrSessionSchema);
