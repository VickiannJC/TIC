// COnfiguracion VAPID
const VAPID_PUBLIC_KEY = 'BHp2vU13C4v9lkA3TiCeDjdrTKx-pjOJKU9danM81efQiPD_6udB7w42xt6DZnz2bAjgf8mdjz-d_Qv7ePkVDOM';
const VAPID_PRIVATE_KEY = 'QenLmZT4xGH9VYVb5N-W446DrVH9OOjcbxDvFr6TC_I';

//Email del cliente
const VAPID_EMAIL = 'mailto:example@example.com';

//Configuracion MongoDB
const MONGODB_URI = 'mongodb://localhost:27017/webpush_db';

module.exports = {
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
    VAPID_EMAIL,
    MONGODB_URI,
    VAPID_MOBILE_KEY: VAPID_PUBLIC_KEY
};