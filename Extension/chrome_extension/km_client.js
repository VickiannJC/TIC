if (!location.protocol.startsWith('chrome-extension')) return;

(function () {
    // ==============================
    // 1) UTILIDADES BASE64 / BYTES
    // ==============================
    const te = new TextEncoder();
    const td = new TextDecoder();

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToArrayBuffer(b64) {
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function storageGet(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.get(keys, (res) => resolve(res || {}));
        });
    }

    function storageSet(obj) {
        return new Promise((resolve) => {
            chrome.storage.local.set(obj, () => resolve());
        });
    }

    // ==============================
    // 2) ESTADO INTERNO DEL CLIENTE
    // ==============================
    let _config = {
        kmBaseUrl: null,
        userId: null,
        pluginId: null,
        nodeBaseUrl: null,
        sessionToken: null,
        tabId: null,
        extClientKey: null
    };

    let _pluginKeyPair = {
        privateKey: null,   // CryptoKey (ECDH)
        publicKey: null,    // CryptoKey (ECDH)
        publicRaw: null     // Uint8Array
    };

    let _channelKey = null;        // CryptoKey AES-GCM
    let _serverPublicKeyRaw = null; // ArrayBuffer

    // ==============================
    // 3) CLAVES ECC DEL PLUG-IN
    // ==============================
    async function loadOrCreatePluginKeyPair() {
        if (_pluginKeyPair.privateKey && _pluginKeyPair.publicKey && _pluginKeyPair.publicRaw) {
            return _pluginKeyPair;
        }

        const stored = await storageGet(["km_plugin_priv_b64", "km_plugin_pub_b64"]);
        const privB64 = stored.km_plugin_priv_b64;
        const pubB64 = stored.km_plugin_pub_b64;

        if (privB64 && pubB64) {
            // Importar claves existentes
            const privBuf = base64ToArrayBuffer(privB64);
            const pubBuf = base64ToArrayBuffer(pubB64);

            const privateKey = await crypto.subtle.importKey(
                "pkcs8",
                privBuf,
                { name: "ECDH", namedCurve: "P-256" },
                true,
                ["deriveBits"]
            );

            const publicKey = await crypto.subtle.importKey(
                "raw",
                pubBuf,
                { name: "ECDH", namedCurve: "P-256" },
                true,
                []
            );

            _pluginKeyPair = {
                privateKey,
                publicKey,
                publicRaw: new Uint8Array(pubBuf)
            };
            return _pluginKeyPair;
        }

        // No hay claves previas → generar nuevas
        const keyPair = await crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            true,
            ["deriveBits"]
        );

        const privPkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
        const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);

        const privB64New = arrayBufferToBase64(privPkcs8);
        const pubB64New = arrayBufferToBase64(pubRaw);

        await storageSet({
            km_plugin_priv_b64: privB64New,
            km_plugin_pub_b64: pubB64New
        });

        _pluginKeyPair = {
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            publicRaw: new Uint8Array(pubRaw)
        };

        return _pluginKeyPair;
    }

    // ==============================
    // 4) HANDSHAKE CON EL KM
    // ==============================
    async function fetchServerPublicKey() {
        if (_serverPublicKeyRaw) return _serverPublicKeyRaw;

        const url = `${_config.kmBaseUrl}/init_handshake`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`init_handshake failed: ${resp.status}`);
        }
        const data = await resp.json();
        const b64 = data.server_public_key_b64;
        if (!b64) {
            throw new Error("server_public_key_b64 missing in response");
        }

        _serverPublicKeyRaw = base64ToArrayBuffer(b64);
        return _serverPublicKeyRaw;
    }

    async function registerPluginPublicKey() {
        const pubB64 = arrayBufferToBase64(_pluginKeyPair.publicRaw.buffer);
        // 1) Pedir token firmado al backend (Node) — NO al KM
        if (!_config.nodeBaseUrl) throw new Error("nodeBaseUrl no configurado en KMClient.init()");
        if (!_config.sessionToken) throw new Error("sessionToken no configurado (login no validado)");

        const tokenResp = await fetch(`${_config.nodeBaseUrl}/km-plugin-reg-token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Key": _config.extClientKey
            },
            body: JSON.stringify({
                email: _config.userId,
                session_token: _config.sessionToken,
                tabId: _config.tabId,
                plugin_id: _config.pluginId,
                public_key_b64: pubB64
            })
        });

        const tokenData = await tokenResp.json().catch(() => ({}));
        if (!tokenResp.ok || tokenData.ok !== true || !tokenData.reg_token) {
            throw new Error(`km-plugin-reg-token failed: ${tokenResp.status} - ${tokenData.error || "unknown"}`);
        }

        // 2) Registrar public key en el KM, adjuntando reg_token
        const url = `${_config.kmBaseUrl}/auth_plugin_key`;
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: _config.userId,
                plugin_id: _config.pluginId,
                public_key_b64: pubB64,
                reg_token: tokenData.reg_token
            })
        });
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`auth_plugin_key failed: ${resp.status} - ${txt}`);
        }
    }

    async function deriveChannelKey() {
        if (_channelKey) return _channelKey;

        const pluginKeys = await loadOrCreatePluginKeyPair();
        const serverPubRaw = await fetchServerPublicKey();

        // 1) Importar clave pública del servidor (P-256 RAW)
        const serverPubKey = await crypto.subtle.importKey(
            "raw",
            serverPubRaw,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
        );

        // 2) ECDH → shared secret
        const sharedBits = await crypto.subtle.deriveBits(
            { name: "ECDH", public: serverPubKey },
            pluginKeys.privateKey,
            256 // 32 bytes
        );

        // 3) HKDF(SHA-256) con:
        //    - salt = plugin_public_raw
        //    - info = "plugin-km-channel"
        const hkdfBaseKey = await crypto.subtle.importKey(
            "raw",
            sharedBits,
            "HKDF",
            false,
            ["deriveKey"]
        );

        const channelKey = await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: pluginKeys.publicRaw,                // mismo salt que usa el KM
                info: te.encode("plugin-km-channel")       // mismo info que en el KM
            },
            hkdfBaseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );

        _channelKey = channelKey;
        return _channelKey;
    }

    // Hace el handshake completo (idempotente)
    async function ensureHandshake() {

        if (!_config.kmBaseUrl || !_config.userId || !_config.pluginId) {
            throw new Error("KMClient.init() debe llamarse antes del handshake");
        }
        if (_channelKey) return _channelKey;

        //Claves ECC del plug-in (generar/importar)
        await loadOrCreatePluginKeyPair();
        //Registrar public key del plug-in en KM (auth_plugin_key)
        await registerPluginPublicKey();
        //Derivar clave de canal compartida ECDH + HKDF
        const key = await deriveChannelKey();
        return key;
    }

    // ==============================
    // 5) ENVELOPE AES-256-GCM
    // ==============================
    async function envelopeEncrypt(plaintextBytes) {
        const key = await ensureHandshake();
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const ct = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            key,
            plaintextBytes
        );

        const ctBytes = new Uint8Array(ct);
        const out = new Uint8Array(iv.length + ctBytes.length);
        out.set(iv, 0);
        out.set(ctBytes, iv.length);

        return arrayBufferToBase64(out.buffer);
    }

    async function envelopeDecrypt(tokenB64) {
        const key = await ensureHandshake();
        const buf = base64ToArrayBuffer(tokenB64);
        const bytes = new Uint8Array(buf);
        const iv = bytes.slice(0, 12);
        const ct = bytes.slice(12);

        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            ct
        );
        return new Uint8Array(plaintext);
    }

    // ==============================
    // 6) ENDPOINTS KM: /send_keys_enveloped + /get_keys_enveloped
    // ==============================

    // Enviar una clave arbitraria al KM protegida por envelope
    async function sendKeysEnveloped({ keyBytes, email, module_type, purpose, platform, key_algo, metadata }) {
        const payload = {
            key_b64: arrayBufferToBase64(keyBytes.buffer ?? keyBytes),
            email: email || "",
            module_type,
            purpose,
            platform: platform || null,
            key_algo: key_algo || "RAW"
        };

        const plaintext = te.encode(JSON.stringify(payload));
        const encrypted_payload = await envelopeEncrypt(plaintext);

        const resp = await fetch(`${_config.kmBaseUrl}/send_keys_enveloped`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: _config.userId,
                plugin_id: _config.pluginId,
                encrypted_payload,
                metadata: metadata || {}
            })
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`send_keys_enveloped failed: ${resp.status} - ${txt}`);
        }
        return resp.json();
    }

    // Recuperar una clave arbitraria desde el KM protegida por envelope
    async function getKeysEnveloped({ module_type, purpose, platform }) {
        const resp = await fetch(`${_config.kmBaseUrl}/get_keys_enveloped`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: _config.userId,
                plugin_id: _config.pluginId,
                module_type,
                purpose,
                platform: platform || null
            })
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`get_keys_enveloped failed: ${resp.status} - ${txt}`);
        }

        const data = await resp.json();
        if (!data.encrypted_payload) {
            throw new Error("encrypted_payload missing in get_keys_enveloped response");
        }

        const plaintextBytes = await envelopeDecrypt(data.encrypted_payload);
        const payloadJson = td.decode(plaintextBytes);
        const payload = JSON.parse(payloadJson);

        // payload: { key_id, key_b64 }
        return payload;
    }

    // ==============================
    // 7) API PÚBLICA
    // ==============================
    const KMClient = {
        /**
         * Inicializa el cliente KM con la info mínima necesaria.
         *
         * Debes llamarlo una vez por tab / sesión en background.js:
         * KMClient.init({ kmBaseUrl, userId, pluginId })
         */
        async init({ kmBaseUrl, userId, pluginId, nodeBaseUrl, sessionToken, tabId, extClientKey }) {
            if (!kmBaseUrl) throw new Error("kmBaseUrl es obligatorio");
            if (!userId) throw new Error("userId es obligatorio");
            if (!pluginId) throw new Error("pluginId es obligatorio");
            if (!nodeBaseUrl) throw new Error("nodeBaseUrl es obligatorio");
            if (!extClientKey) throw new Error("extClientKey es obligatorio");
            if (!nodeBaseUrl) throw new Error("nodeBaseUrl es obligatorio");
            if (!extClientKey) throw new Error("extClientKey es obligatorio");

            _config.kmBaseUrl = kmBaseUrl.replace(/\/+$/, ""); // sin barra final
            _config.userId = userId;
            _config.pluginId = pluginId;
            _config.nodeBaseUrl = nodeBaseUrl.replace(/\/+$/, "");
            _config.sessionToken = sessionToken || null;
            _config.tabId = tabId ?? null;
            _config.extClientKey = extClientKey;
            _config.nodeBaseUrl = nodeBaseUrl.replace(/\/+$/, "");
            _config.sessionToken = sessionToken;
            _config.tabId = tabId ?? null;
            _config.extClientKey = extClientKey;

            //Para forzar el handshake inmediato
            // await ensureHandshake();
        },

        /**
         * Fuerza el handshake y deja listo el canal seguro.
         * Útil para hacer warm-up después de login + biometría.
         */
        async ensureHandshake() {
            await ensureHandshake();
        },

        /**
         * Envía material de clave arbitrario al KM usando /send_keys_enveloped.
         */
        async sendKeysEnveloped(params) {
            return await sendKeysEnveloped(params);
        },

        /**
         * Recupera una clave del KM usando /get_keys_enveloped
         * y la devuelve como:
         *   { key_id, key_b64 }
         */
        async getKeysEnveloped(params) {
            return await getKeysEnveloped(params);
        },

        /**
     * Descifra un payload envelope (AES-GCM canal KM)
     * Devuelve Uint8Array
     */
        async envelopeDecrypt(tokenB64) {
            return await envelopeDecrypt(tokenB64);
        },
        /**
         * Helper opcional: descodifica key_b64 a Uint8Array.
         */
        decodeKeyB64(key_b64) {
            return new Uint8Array(base64ToArrayBuffer(key_b64));
        }
    };

    // Exponer en el contexto de extensión
    if (typeof self !== "undefined") {
        self.KMClient = KMClient;
    }
    if (typeof window !== "undefined") {
        window.KMClient = KMClient;
    }
})();