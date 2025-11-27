// COnfiguracion VAPID
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

//Email del cliente
const VAPID_EMAIL = 'mailto:example@example.com';

//Configuracion MongoDB
const MONGODB_URI = process.env.MONGODB_URI;

module.exports = {
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
    VAPID_EMAIL,
    MONGODB_URI,
    VAPID_MOBILE_KEY: VAPID_PUBLIC_KEY
};