// tests/registro-flow.test.js
const request = require("supertest");
const mongoose = require("mongoose");
const app = require("../server"); // <= Ajusta la ruta si es necesario

const Subscripcion = require("../modelosDB/Subscripciones");
const Temporal = require("../modelosDB/temporales");
const QRSession = require("../modelosDB/QRSession");

// Mock biometría externa
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ exists: false })
    })
);


// Desactivar timers reales
jest.useFakeTimers();

describe("FLUJO COMPLETO DE REGISTRO", () => {

    const email = "test@example.com";
    let sessionId = null;

    beforeAll(async () => {
        await mongoose.connect(process.env.MONGODB_URI);
        await Subscripcion.deleteMany({});
        await Temporal.deleteMany({});
        await QRSession.deleteMany({});
    });

    afterAll(async () => {
        await mongoose.connection.close();
    });

    // ------------------------------------------------------
    // 1) GENERAR QR
    // ------------------------------------------------------
    test("POST /generar-qr-sesion genera un QR válido", async () => {

        const res = await request(app)
            .post("/generar-qr-sesion")
            .send({ email, platform: "Web" });

        expect(res.status).toBe(200);
        expect(res.body.qr).toContain("data:image/png;base64");
        expect(res.body.sessionId).toBeDefined();

        sessionId = res.body.sessionId;

        const qr = await QRSession.findOne({ sessionId });
        expect(qr).not.toBeNull();
        expect(qr.estado).toBe("pending");
    });

    // ------------------------------------------------------
    // 2) REGISTER MOBILE — Usuario NUEVO
    // ------------------------------------------------------
    test("POST /register-mobile — Usuario nuevo: crea Subscripción + TEMP + Timer", async () => {

        const dummySub = { endpoint: "https://push.example.com/123" };

        const res = await request(app)
            .post("/register-mobile")
            .send({
                sessionId,
                subscription: dummySub
            });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("subscription_saved");

        // --- Verificar subscripción guardada ---
        const sub = await Subscripcion.findOne({ email });
        expect(sub).not.toBeNull();

        // --- Verificar temporal creado ---
        const temp = await Temporal.findOne({ email });
        expect(temp).not.toBeNull();
        expect(temp.challengeId).toMatch(/^REG_/);

        // --- Verificar QRSession confirmada ---
        const s = await QRSession.findOne({ sessionId });
        expect(s.estado).toBe("confirmed");
    });

    // ------------------------------------------------------
    // 3) REGISTER MOBILE — Usuario ya registrado
    // ------------------------------------------------------
    test("POST /register-mobile — Usuario YA registrado NO borra subscripción", async () => {

        // Simulamos que subscripción ya existe
        await Subscripcion.updateOne(
            { email },
            { subscription: { endpoint: "abc" } },
            { upsert: true }
        );

        const res = await request(app)
            .post("/register-mobile")
            .send({
                sessionId,
                subscription: { endpoint: "nuevo" }
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe("already_registered");

        // subscripción debe mantenerse
        const sub = await Subscripcion.findOne({ email });
        expect(sub).not.toBeNull();

        // temporales REG deben limpiarse
        const temps = await Temporal.find({ email });
        expect(temps.length).toBe(0);
    });

    // ------------------------------------------------------
    // 4) register-confirm cuando exists:true
    // ------------------------------------------------------
    test("POST /mobile_client/register-confirm — exists:true: debe retornar error", async () => {

        global.fetch.mockImplementationOnce(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ exists: true })
            })
        );

        const res = await request(app)
            .post(`/mobile_client/register-confirm?email=${email}&sessionId=${sessionId}`)
            .send();

        expect(res.status).toBe(200);
        expect(res.text).toContain("Usuario ya está registrado");

        // Asegurar limpieza
        const qr = await QRSession.findOne({ email });
        expect(qr).toBeNull();

        const temps = await Temporal.find({ email });
        expect(temps.length).toBe(0);

        const sub = await Subscripcion.findOne({ email });
        expect(sub).not.toBeNull(); // subscripción debe quedar
    });

    // ------------------------------------------------------
    // 5) register-confirm cuando exists:false
    // ------------------------------------------------------
    test("POST /mobile_client/register-confirm — exists:false: retorna pantalla estética", async () => {

        global.fetch.mockImplementationOnce(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ exists: false })
            })
        );

        const res = await request(app)
            .post(`/mobile_client/register-confirm?email=${email}&sessionId=${sessionId}`)
            .send();

        expect(res.status).toBe(200);
        expect(res.text).toContain("Continuar"); // del HTML estético
    });

    // ------------------------------------------------------
    // 6) /api/registro-finalizado
    // ------------------------------------------------------
    test("POST /api/registro-finalizado — marca biometria_ok y envía a analizer", async () => {

        // Crear nuevo temporal REG para esta prueba
        const temp = await Temporal.create({
            challengeId: "REG_123",
            email,
            token: "ABC123",
            status: "pending"
        });

        const res = await request(app)
            .post("/api/registro-finalizado")
            .send({
                email,
                idUsuario: "bio_001",
                user_answers: [1, 2, 3],
                sessionToken: "ABC123"
            });

        expect(res.status).toBe(200);

        const updated = await Temporal.findOne({ email, token: "ABC123" });
        expect(updated.status).toBe("biometria_ok");
        expect(updated.userBiometriaId).toBe("bio_001");
    });
});
