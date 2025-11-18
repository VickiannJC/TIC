const mongoose = require('mongoose');

const SubscripcionSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true
    },
    subscription: {
        type: Object,
        required: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    }
});

module.exports = mongoose.model('Subscripcion', SubscripcionSchema);