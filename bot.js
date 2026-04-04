// bot.js - Vicky Bot - Asistente WhatsApp con Gemini AI
// Gardens Wood - Leña, Cercos, Pérgolas, Sector Fogonero

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrTerminal = require('qrcode-terminal');
const qrImage = require('qr-image');
const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Cargar `.env` local si existe (no commitear; ver `.env.example`)
(function loadEnvLocal() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 1) {
                const solo = t.trim();
                if (solo === 'VICKY_LOG_LABELS' && process.env.VICKY_LOG_LABELS === undefined) {
                    process.env.VICKY_LOG_LABELS = '1';
                }
                continue;
            }
            const key = t.slice(0, eq).trim();
            let val = t.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = val;
        }
    } catch (_) { /* ignore */ }
})();

// --- MÓDULO FIRESTORE (Dashboard) ---
const firestoreModule = require('./firestore-module');
const { ejecutarCronGeocodificacionClientes } = require('./cron-geocode-clientes');
const { ejecutarTurnoVickyGeminiCore } = require('./vicky-gemini-turn');
const instagramDmMod = require('./instagram-dm');

// --- SERVIDOR HTTP (salud + cron interno) ---
const PORT = process.env.PORT || 8080;

/** Quita BOM, espacios extremos y caracteres invisibles (Scheduler / portapapeles). */
function normalizeCronCredential(raw) {
    return String(raw || '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        .trim();
}

/** Secreto esperado para cron (misma forma que tokens de cabecera). */
function vickyCronSecretTrimmed() {
    return normalizeCronCredential(process.env.VICKY_CRON_SECRET);
}

function cronSecretsEqual(rawToken, rawSecret) {
    const token = normalizeCronCredential(rawToken);
    const secret = normalizeCronCredential(rawSecret);
    if (!token || !secret || token.length !== secret.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(secret, 'utf8'));
    } catch {
        return false;
    }
}

/**
 * Valida cron HTTP:
 * - `Authorization: Bearer <secreto>` (con o sin espacio tras Bearer; varias cabeceras Authorization en rawHeaders)
 * - Comas en Authorization (p. ej. otro Bearer delante): prueba cada fragmento
 * - `Authorization: <secreto>` sin palabra Bearer (algunos formularios)
 * - `X-Vicky-Cron-Secret: <secreto>` si OIDC de Scheduler pisa o mezcla Authorization
 */
function isCronRequestAuthorized(req) {
    const secret = vickyCronSecretTrimmed();
    if (!secret) return false;

    const alt = normalizeCronCredential(req.headers['x-vicky-cron-secret']);
    if (cronSecretsEqual(alt, secret)) return true;

    const authChunks = [];
    const rh = req.rawHeaders;
    if (Array.isArray(rh)) {
        for (let i = 0; i < rh.length; i += 2) {
            const hn = String(rh[i]).toLowerCase();
            if (hn === 'authorization' || hn === 'authorisation') {
                authChunks.push(String(rh[i + 1] || '').trim());
            }
        }
    }
    const merged = String(
        req.headers.authorization || req.headers.authorisation || ''
    ).trim();
    if (merged) authChunks.push(merged);

    for (const chunk of authChunks) {
        const parts = chunk
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
        for (const part of parts) {
            if (cronSecretsEqual(part, secret)) return true;
            const m = /^Bearer\s*(.+)$/i.exec(part);
            if (m && cronSecretsEqual(String(m[1] || '').trim(), secret)) return true;
        }
    }

    return false;
}

/** Log seguro (sin imprimir secretos). Siempre en 401; más detalle con VICKY_LOG_CRON_AUTH=1 */
function logCronAuth401(req, pathLabel, extra = {}) {
    const s = vickyCronSecretTrimmed();
    const auth = String(req.headers.authorization || req.headers.authorisation || '');
    const keys = Object.keys(req.headers || {})
        .filter((k) => /auth|secret|cron|forward/i.test(k))
        .join(',');
    console.warn(
        '⚠️ Cron 401',
        pathLabel || '',
        'secretLen=',
        s.length,
        'authHdrLen=',
        auth.length,
        'xVicky=',
        !!normalizeCronCredential(req.headers['x-vicky-cron-secret']),
        'hdrKeys=',
        keys || '(ninguna coincidencia)',
        extra?.bodySecretTried ? 'bodySecret=si' : ''
    );
    if (process.env.VICKY_LOG_CRON_AUTH === '1') {
        console.warn('⚠️ Cron 401 debug: method=', req.method, 'url=', req.url?.slice(0, 80));
    }
}

/**
 * Si VICKY_CRON_ALLOW_BODY_SECRET=1, acepta el mismo secreto en JSON: {"cronSecret":"..."}.
 * Útil si algo entre Scheduler y Cloud Run altera cabeceras (probar solo si hace falta).
 */
function cronJsonBodyMatchesSecret(rawBody) {
    if (process.env.VICKY_CRON_ALLOW_BODY_SECRET !== '1') return false;
    const t = String(rawBody || '').trim();
    if (!t || t[0] !== '{') return false;
    let j;
    try {
        j = JSON.parse(t);
    } catch {
        return false;
    }
    const sent = normalizeCronCredential(j.cronSecret ?? j.vickyCronSecret);
    return sent && cronSecretsEqual(sent, vickyCronSecretTrimmed());
}

/** Referencias asignadas tras definir funciones de cron (evita circularidad). */
const vickyCronHandlers = {
    ejecutarProgramados: null,
    ejecutarClima: null,
    ejecutarGeocodeClientes: null,
};

/** Cuerpo JSON del POST Instagram (procesado async); se asigna tras definir `procesarWebhookInstagramPayload`. */
const vickyInstagramWebhook = { handlePayload: null };

const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
        res.writeHead(code, { 'Content-Type': type });
        res.end(body);
    };

    const urlPathOnly = (() => {
        const p = (req.url || '/').split('?')[0];
        if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
        return p || '/';
    })();

    if (req.method === 'GET' && (urlPathOnly === '/' || urlPathOnly === '/health')) {
        return send(200, '¡Vicky Bot está en línea! 🪵💨');
    }

    /** Política de privacidad pública (Meta App Review, transparencia). */
    if (req.method === 'GET' && urlPathOnly === '/legal/politica-privacidad') {
        const legalPath = path.join(__dirname, 'legal', 'politica-privacidad.html');
        try {
            const html = fs.readFileSync(legalPath, 'utf8');
            return send(200, html, 'text/html; charset=utf-8');
        } catch (e) {
            console.error('❌ legal/politica-privacidad:', e?.message || e);
            return send(500, 'No disponible');
        }
    }

    if (req.method === 'POST' && urlPathOnly === '/internal/cron/programados') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        return req.on('end', async () => {
            const secretConfigured = vickyCronSecretTrimmed();
            const authed =
                isCronRequestAuthorized(req) || cronJsonBodyMatchesSecret(raw);
            if (!secretConfigured || !authed) {
                logCronAuth401(req, urlPathOnly, {
                    bodySecretTried: process.env.VICKY_CRON_ALLOW_BODY_SECRET === '1',
                });
                return send(401, 'unauthorized');
            }
            try {
                const fn = vickyCronHandlers.ejecutarProgramados;
                const n = fn ? await fn() : 0;
                send(200, JSON.stringify({ ok: true, enviados: n }), 'application/json; charset=utf-8');
            } catch (e) {
                send(500, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
            }
        });
    }

    if (req.method === 'POST' && urlPathOnly === '/internal/cron/weather') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        return req.on('end', async () => {
            const secretConfigured = vickyCronSecretTrimmed();
            const authed =
                isCronRequestAuthorized(req) || cronJsonBodyMatchesSecret(raw);
            if (!secretConfigured || !authed) {
                logCronAuth401(req, urlPathOnly, {
                    bodySecretTried: process.env.VICKY_CRON_ALLOW_BODY_SECRET === '1',
                });
                return send(401, 'unauthorized');
            }
            try {
                const fn = vickyCronHandlers.ejecutarClima;
                const r = fn ? await fn() : { skipped: true };
                send(200, JSON.stringify({ ok: true, ...r }), 'application/json; charset=utf-8');
            } catch (e) {
                send(500, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
            }
        });
    }

    if (req.method === 'POST' && urlPathOnly === '/internal/cron/geocode-clientes') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        return req.on('end', async () => {
            const secretConfigured = vickyCronSecretTrimmed();
            const authed =
                isCronRequestAuthorized(req) || cronJsonBodyMatchesSecret(raw);
            if (!secretConfigured || !authed) {
                logCronAuth401(req, urlPathOnly, {
                    bodySecretTried: process.env.VICKY_CRON_ALLOW_BODY_SECRET === '1',
                });
                return send(401, 'unauthorized');
            }
            try {
                const host = req.headers.host || 'localhost';
                const u = new URL(req.url || '/', `http://${host}`);
                let max = u.searchParams.get('max');
                let dryRun =
                    u.searchParams.get('dryRun') === '1' ||
                    u.searchParams.get('dry_run') === '1';
                let forceRegeocode =
                    u.searchParams.get('forceRegeocode') === '1' ||
                    u.searchParams.get('force_regeocode') === '1';
                const body = String(raw || '').trim();
                if (body) {
                    try {
                        const j = JSON.parse(body);
                        if (j.max != null) max = j.max;
                        if (j.dryRun != null) dryRun = !!j.dryRun;
                        if (j.forceRegeocode != null) forceRegeocode = !!j.forceRegeocode;
                    } catch {
                        /* cuerpo no JSON: ignorar */
                    }
                }
                const opts = {};
                if (max != null && max !== '') {
                    const n = Number(max);
                    if (Number.isFinite(n)) opts.max = n;
                }
                if (dryRun) opts.dryRun = true;
                if (forceRegeocode) opts.forceRegeocode = true;
                const fn = vickyCronHandlers.ejecutarGeocodeClientes;
                const r = fn ? await fn(opts) : { skipped: true, reason: 'no_handler' };
                send(200, JSON.stringify({ ok: true, ...r }), 'application/json; charset=utf-8');
            } catch (e) {
                send(500, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
            }
        });
    }

    if (
        req.method === 'GET' &&
        (urlPathOnly === '/internal/cron/programados' ||
            urlPathOnly === '/internal/cron/weather' ||
            urlPathOnly === '/internal/cron/geocode-clientes')
    ) {
        return send(
            405,
            JSON.stringify({
                error: 'method_not_allowed',
                hint: 'Usar POST. Cloud Scheduler: metodo POST en el trabajo HTTP.',
            }),
            'application/json; charset=utf-8'
        );
    }

    const rawUrl = req.url || '/';
    if (rawUrl.startsWith('/webhooks/instagram')) {
        if (req.method === 'GET') {
            const host = req.headers.host || 'localhost';
            const u = new URL(rawUrl, `http://${host}`);
            const q = Object.fromEntries(u.searchParams.entries());
            const v = instagramDmMod.verifyWebhookGet(q);
            if (v.ok) {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end(v.challenge);
            }
            return send(403, 'forbidden');
        }
        if (req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            return req.on('end', () => {
                const raw = Buffer.concat(chunks);
                const sig = req.headers['x-hub-signature-256'];
                if (!instagramDmMod.verifySignature(raw, sig)) {
                    return send(401, 'invalid signature');
                }
                let body;
                try {
                    body = JSON.parse(raw.toString('utf8'));
                } catch {
                    return send(400, 'invalid json');
                }
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('OK');
                const fn = vickyInstagramWebhook.handlePayload;
                if (typeof fn === 'function') {
                    Promise.resolve(fn(body)).catch((e) => console.error('❌ Instagram webhook:', e?.message || e));
                }
            });
        }
        return send(405, 'method not allowed');
    }

    return send(404, 'not found');
});
server.listen(PORT, () => {
    console.log(
        `📡 HTTP puerto ${PORT} (GET /health, GET /legal/politica-privacidad, POST /internal/cron/* Bearer, GET|POST /webhooks/instagram)`
    );
    const cs = vickyCronSecretTrimmed();
    if (cs.length) {
        console.log(`🔐 Cron HTTP: VICKY_CRON_SECRET cargado (${cs.length} caracteres).`);
    } else {
        console.warn(
            '⚠️ Cron HTTP: VICKY_CRON_SECRET vacío — POST /internal/cron/* responderá 401 hasta definir la variable en Cloud Run.'
        );
    }
    firestoreModule.initFirestore().catch((e) =>
        console.warn('⚠️ Firestore init temprana (cron HTTP):', e?.message || e)
    );
});

// --- CONFIGURACIÓN DE NUBE ---
const BUCKET_NAME = 'webgardens-8655d_whatsapp_session';
const storage = new Storage();
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const HISTORIAL_PATH = path.join(__dirname, 'usuarios_vistos.json');
const HISTORIAL_CONSULTAS_DIR = path.join(__dirname, 'historial_consultas');
const MAX_ENTRADAS_CONSULTAS = 100; // pares cliente/vicky recientes por archivo

// --- AUDIO DE BIENVENIDA (se envía solo la primera vez por cliente) ---
const AUDIO_INTRO_PATH = path.join(__dirname, 'ElevenLabs_2026-03-21T11_41_40_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');
const AUDIO_INTRO_EXISTS = fs.existsSync(AUDIO_INTRO_PATH);
console.log(`🎵 Audio intro: ${AUDIO_INTRO_EXISTS ? '✅ encontrado' : '❌ NO encontrado en ' + AUDIO_INTRO_PATH}`);

const AUDIO_CONFIRMADO_PATH = path.join(__dirname, 'ElevenLabs_2026-03-21T12_03_41_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');
const AUDIO_CONFIRMADO_EXISTS = fs.existsSync(AUDIO_CONFIRMADO_PATH);
console.log(`🎵 Audio confirmado: ${AUDIO_CONFIRMADO_EXISTS ? '✅ encontrado' : '❌ NO encontrado en ' + AUDIO_CONFIRMADO_PATH}`);

// --- IMÁGENES POR SERVICIO ---
const IMAGENES = {
    lena:     path.join(__dirname, 'assets', 'madera_premium.png'),
    cerco:    path.join(__dirname, 'images', 'Cercos', 'cerco1.jpeg'),
    pergola:  path.join(__dirname, 'images', 'Pergolas', '1.png'),
    fogonero: path.join(__dirname, 'images', 'Sector Fogonero', 'WhatsApp Image 2026-03-18 at 16.11.59 (1).jpeg'),
    bancos:   path.join(__dirname, 'images', 'Bancos', 'bancos1.mp4')  // video
};

// --- GEMINI AI ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error(
        '❌ GEMINI_API_KEY no configurada. El bot no podrá responder. '
        + 'En .env debe existir una línea sin # al inicio: GEMINI_API_KEY=tu_clave'
    );
}

const SYSTEM_PROMPT = `Sos Vicky, la asistente virtual de Gardens Wood, una empresa cordobesa de Argentina que trabaja con madera y espacios exteriores.

Tus servicios disponibles:

═══════════════════════════════
🪵 LEÑA
═══════════════════════════════
Tenemos leña de Quebracho Blanco y Colorado: una mezcla que va re bien para todo (hogar, salamandra y parrilla).
PRECIOS por tonelada (1000 kg):
  • Hogar / Grande: $290.000
  • Salamandra / Mediana: $300.000
  • Parrilla / Fino (Quebracho Blanco): $320.000

INFO DE ENVÍO (solo leña):
  • Si está en Villa Allende, el envío es SIN CARGO en pedidos de más de 500 kg. 🎁
  • Para zonas cercanas como Mendiolaza, Valle del Sol, Saldán, La Calera, Argüello, Valle Escondido y Unquillo, el envío tiene un costo extra de $45.000.
  • Si es para otras zonas, lo cotizamos según la ubicación exacta.

Datos a pedir al cliente para agendar entrega de leña:
  1. Nombre y Apellido
  2. Dirección de entrega
  3. Nro de contacto de quien recibe
  4. Día de la semana disponible (ej: Lunes y Martes)
  5. Rango horario para recibir el pedido (ej: 9 a 13hs)
  6. Método de pago (Efectivo / Transferencia)

═══════════════════════════════
🪵 CERCOS DE MADERA
═══════════════════════════════
Material: Eucalipto Impregnado CCA (más de 15 años sin mantenimiento).
Sistema de instalación: cimentación de hormigón cada 2m, tutores traseros anti-inclinación, acabado a elección (irregular o lineal).
PRECIOS por metro lineal (material + mano de obra):
  • 1.80m de alto: $140.000/m
  • 2.00m a 2.50m de alto: $170.000/m
  • Hasta 3.00m de alto (medida especial): $185.000/m
  • Revestimiento con palo fino: $150.000/m
Alturas estándar: 1.80m, 2.00m y 2.50m. Si el cliente necesita una altura diferente (menor o mayor), también podemos realizarlo. El máximo que trabajamos es 3.00m.
Seña: $200.000 a $300.000 por transferencia para reservar fecha.
Saldo: en efectivo al finalizar la obra.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de cerco:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Días disponibles para la obra
  5. Método de pago para la seña (Transferencia)

═══════════════════════════════
🌿 PÉRGOLAS
═══════════════════════════════
PRECIOS por metro cuadrado (m²) (material + mano de obra):
  • Caña Tacuara: $110.000/m² — reduce temperatura hasta 5°, 100% ecológica
  • Caña Tacuara + Chapa de Policarbonato: $130.000/m²
  • Palos Pergoleros (eucalipto impregnado CCA): $130.000/m² — ideal para enredaderas, sombra natural
  • Palos Pergoleros (eucalipto impregnado CCA) + Chapa de Policarbonato: $150.000/m² — protege 99% rayos UV, resiste granizo y lluvia
Flete: zonas cercanas a Villa Allende sin cargo. Otras zonas se cotiza.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de pérgola:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Días disponibles para la obra
  5. Método de pago para la seña (Transferencia)

═══════════════════════════════
🔥 SECTOR FOGONERO
═══════════════════════════════
PRECIO base por metro cuadrado:
  • $57.000/m² — incluye Geotextil + Piedra blanca
Opciones adicionales (a cotizar separado):
  • Bancos de quebracho blanco con respaldo (ver servicio BANCOS)
  • Tratamiento de resina para fijar las piedras
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de sector fogonero:
  (mismos que pérgola: nombre, dirección, contacto, días disponibles, método de pago seña)

═══════════════════════════════
🪵 PRODUCTOS DE MADERA (venta por unidad / metro)
═══════════════════════════════
Todos los precios son + IVA. El cliente puede retirar en el local (Av. Río de Janeiro 1281, Villa Allende) o recibir a domicilio.
ENVÍO: pedidos de 1 unidad en Villa Allende → $20.000. Otros casos se cotiza según volumen y zona.

NOTA INTERNA (no usar esta terminología con el cliente): Los clientes no conocen los nombres técnicos de estos productos. Cuando preguntan, usan términos genéricos como "palos", "postes", "estacas". Vicky debe hacer preguntas para identificar qué necesitan (para qué lo van a usar, qué largo necesitan, si es para jardín/cerco/enredadera/construcción) y luego cotizar el producto correcto sin usar términos técnicos internos como "tijera", "tutor", "pergolero" o "boyero". Simplemente describir el producto: "palo de eucalipto impregnado de X metros".

TABLAS DE QUEBRACHO COLORADO (QC):
  • 2,54cm × 12,7cm × 2m → $10.574,85
  • 2,54cm × 12,7cm × 2,7m → $14.273,84
  • 2,54cm × 12,7cm × 3m → $15.859,52
  • 2,54cm × 15,24cm × 2m → $12.690,93
  • 2,54cm × 15,24cm × 2,7m → $17.133,03
  • 2,54cm × 15,24cm × 3m → $19.036,39
  • 2,54cm × 20,32cm × 2m → $16.920,32
  • 2,54cm × 20,32cm × 2,7m → $22.840,35
  • 2,54cm × 20,32cm × 3m → $25.381,85

TIRANTES DE QUEBRACHO COLORADO (QC):
  • 5,08cm × 10,16cm × 2,7m → $22.840,35
  • 5,08cm × 10,16cm × 3m → $25.381,85
  • 5,08cm × 15,24cm × 2,7m → $34.260,53

TABLONES:
  • Tablón QC 3,81cm × 22,86cm × 1m → $14.273,84
  • Tablón QC 3,81cm × 22,86cm × 0,5m → $7.138,30
  • Tablón QC 2,7m → $154.700,00
  • Tablón QB 2,7m → $91.162,50
  • Tablón QB 1,5m → $52.487,50
  • Tablón para barras QC → $247.000,00/metro lineal

DURMIENTES:
  • Durmiente QC 12,7cm × 25,4cm × 2,7m → $104.975,00
  • Durmiente QC 12,7cm × 25,4cm × 2m → $69.062,50
  • Durmiente QC 2da 12,7cm × 25,4cm × 2,7m → $91.000,00
  • Durmiente QB 10,16cm × 20,32cm × 2,7m → $110.500,00
  • Durmiente QB 10,16cm × 20,32cm × 2m → $81.900,00
  • Durmiente QB 10,16cm × 20,32cm × 1,5m → $57.980,00
  • Durmiente recuperado → $84.500,00/unidad

POSTES DE QUEBRACHO COLORADO (QC):
  • 7,62cm × 7,62cm × 3m → $28.550,44
  • 7,62cm × 7,62cm × 2,7m → $25.696,78
  • 7,62cm × 7,62cm × 2,2m → $20.936,99
  • 7,62cm × 7,62cm × 2m → $18.895,50
  • 10,16cm × 10,16cm × 3m → $50.752,65
  • 10,16cm × 10,16cm × 2,7m → $45.677,94
  • 10,16cm × 10,16cm × 2,4m → $40.603,23
  • 10,16cm × 10,16cm × 2,2m → $37.219,17
  • 10,16cm × 10,16cm × 2m → $33.835,10
  • Poste QC 3m → $28.161,90

POSTES Y POSTECITOS DE EUCALIPTO IMPREGNADO CCA:
  • Poste eucalipto 7,5m → $101.790,00
  • Poste eucalipto 9m → $113.100,00
  • Postecito eucalipto 2,5m → $12.874,55

VARILLAS:
  • Varilla QB 3,81cm × 5,08cm × 1,2m → $1.519,38
  • Varilla QC 3,81cm × 5,08cm × 1,2m → $2.624,38

VIGAS Y ESTRUCTURAS:
  • Viga 12,7cm × 40,64cm × 3,5m → $226.525,00

TIJERAS DE EUCALIPTO IMPREGNADO CCA:
  • Tijera eucalipto 4m → $42.836,63
  • Tijera eucalipto 5m → $50.541,57
  • Tijera eucalipto 6m → $64.938,25
  • Tijera eucalipto 7m → $77.426,38

TUTORES Y BOYEROS DE EUCALIPTO IMPREGNADO CCA:
  • Tutor eucalipto 3/5 — 2,5m → $5.655,00
  • Tutor eucalipto 5/7 — 2,5m → $6.833,13
  • Boyero 1,8m → $9.896,25

LEÑA Y CARBÓN (precio por carga):
  • Leña campana → $262.437,50
  • Leña despunte → $165.750,00
  • Leña tacos → $8.287,50
  • Carbón → $483.437,50
  • Costaneros → $13.812,50

OTROS PRODUCTOS:
  • Tranquera 2m → $303.875,00
  • Tranquera 3m → $497.250,00
  • Mesa de jardín 2m → $511.062,50
  • Hamaca → $635.375,00
  • Muelitas → $52.000,00
  • Cañizo criollo → $14.300,00/m²
  • Cañizo tacuara → $11.700,00/m²

Datos a pedir para ventas de productos:
  1. Nombre y Apellido
  2. Producto/s y cantidad
  3. Si retira en local o necesita envío (y dirección si es envío)
  4. Nro de contacto
  5. Método de pago (Efectivo / Transferencia)

═══════════════════════════════
🪑 BANCOS DE QUEBRACHO BLANCO CON RESPALDO
═══════════════════════════════
Material: Quebracho Blanco macizo con respaldo incluido.
Medidas: 60cm de profundidad × el largo que necesite el cliente (máximo 2.70m por banco).
PRECIO: $355.000 por metro lineal (material + mano de obra).
Se pueden vender solos, sin necesitar el Sector Fogonero. También se complementan con el Sector Fogonero.
Seña: por transferencia para reservar fecha.
Saldo: en efectivo al finalizar.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar bancos:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Largo total de banco/s que necesita (en metros)
  5. Días disponibles para la obra
  6. Método de pago para la seña (Transferencia)

═══════════════════════════════
REGLAS DE COMPORTAMIENTO
═══════════════════════════════
1. Hablás en español rioplatense: usá "vos" en lugar de "tú", "dale", "bárbaro". NUNCA uses la palabra "che".
2. Sos amigable, entusiasta y cálida, pero profesional y concisa.
3. Usás emojis moderadamente (no en cada frase).
4. NUNCA inventés precios ni información que no esté en este sistema.
4b. Precios y datos técnicos: usá SOLO montos, medidas y tablas que figuren explícitamente en este mensaje de sistema o en datos de servicios que el sistema te inyecte en la conversación. Si no tenés un valor exacto en ese material, decí con naturalidad que lo confirma un asesor — no estimés, no redondeés de cabeza ni completes huecos inventados.
5. NUNCA digas que sos un asistente virtual, una IA, un bot, o que sos automatizada. Si alguien te pregunta si sos una persona o un bot, respondé con naturalidad que sos Vicky de Gardens Wood y cambiá el tema hacia cómo podés ayudar.
6. Vicky atiende las 24 horas, los 7 días de la semana. Respondé siempre sin mencionar horarios. Los horarios de atención presencial/telefónica del negocio son lunes a viernes 8hs a 17hs y sábados 9hs a 13hs — solo mencioná esto si el cliente pregunta específicamente por horarios de atención o visitas.
   Ubicación del local: Av. Río de Janeiro 1281, Villa Allende, Córdoba. Solo mencioná la dirección si el cliente pregunta dónde están o cómo ir.
6b. Instagram y WhatsApp: si el cliente escribe por Instagram (mensajes directos de @gardens.wood o consultas que llegan por ahí), usá el mismo criterio que por WhatsApp: mismos precios (incluida leña y envíos), mismo tono, mismas reglas de embudo y handoff. No digas que no atendés por Instagram ni que el catálogo es distinto. Si el cliente prefiere continuar por WhatsApp, podés ofrecerlo como comodidad, pero no lo exijas.
7. Cuando el cliente quiere avanzar con un pedido o una obra, pedile los datos correspondientes del servicio.
8. Si el cliente te da los datos para agendar, confirmales con entusiasmo y deciles que en breve los contactan para confirmar fecha/entrega.
9. Si el cliente pregunta por algo que no manejamos (otro producto, otro servicio), deciles amablemente que no trabajamos con eso.
10. Si el cliente te saluda, respondé el saludo brevemente y ofrecé ayuda. Si el cliente tiene una cotización pendiente y te saluda con un mensaje AMBIGUO (solo "hola", "buenas", "cómo andás"), preguntale si escribe por la cotización o por otro tema. PERO si el cliente hace una consulta CONCRETA (pregunta por leña, cerco, pérgola, precio, etc.), respondé directamente a ESA consulta — NO preguntes por la cotización pendiente en ese caso.
    CONTINUIDAD CON CLIENTES CONOCIDOS: Si el [CONTEXTO_SISTEMA] dice que el cliente ya compró o tuvo un trabajo anterior, tratalo con familiaridad total. No te presentes, no expliques quién es Vicky, no ofrezcas el catálogo completo. Si pregunta por algo nuevo, respondé sobre eso directamente. Podés hacer referencia al trabajo anterior de forma natural y breve si suma ("como el cerco que te hicimos", "igual que la leña que te mandamos"). El tono debe ser el de alguien que ya te conoce, no el de un vendedor hablando con un desconocido.
    REGLA ABSOLUTA — UN SOLO SALUDO: Nunca saludes dos veces en el mismo turno. Si tu respuesta incluye [AUDIO_CORTO:], [AUDIO_FIDELIZAR:] o cualquier marcador de audio, el texto escrito NO debe contener "Hola", "Buenas", "Bárbaro", "Claro", ni ninguna frase de saludo o introducción. El texto empieza directo con la info. Si el contexto dice que la charla es fluida, tampoco saludes en el audio.
11. Si no entendés la consulta, pedí que te expliquen mejor con un ejemplo.
11b. SIEMPRE terminá cada respuesta con una pregunta relevante para mantener la conversación activa.
11b-EXCEPCIÓN HANDOFF: Si en tu respuesta incluís el marcador [HANDOFF_EXPERTO:...] (traspaso a asesor), NO es obligatorio cerrar con pregunta. En ese caso, cerrá con una frase breve de traspaso (ej: "En breve te sigue un asesor para ajustar el presupuesto.") y nada más.
11b-EXCEPCIÓN CONFIRMADO: Si en tu respuesta incluís [CONFIRMADO] (regla 17, cierre sin datos bancarios), NO es obligatorio cerrar con pregunta.

MARCADORES INTERNOS (no visibles para el cliente; van al final del pensamiento de respuesta o en línea aparte):
• [DIRECCION:…] [ZONA:…] [BARRIO:…] [LOCALIDAD:…] [REFERENCIA:…] [NOTAS_UBICACION:…] — guardan ficha en CRM/mapas (reglas 19–20b).
• [CRM:potencial|statusCrm|urgencia|zona|intereses] — potencial: frío|tibio|caliente · statusCrm: pendiente_cotizacion|seguimiento|concreto|en_obra · urgencia: alta|media|baja · zona: barrio/zona libre · intereses: lista separada por comas (pergolas,decks,cercos,lena,mantenimiento). Ej: [CRM:tibio|seguimiento|media|Villa Allende|cercos,lena]
• [NOTIFICAR_VENTA:resumen breve del pedido o intención de compra] — cuando el cliente pide datos bancarios/CBU, confirma pedido fuerte o muestra intención de cierre. NO le pases CBU, alias ni datos de transferencia vos: decile que en breve un asesor se comunica con los datos. Incluí despedida tipo "en breve un asesor te contacta".
• [AGENDAR:YYYY-MM-DD|texto del recordatorio] — si el cliente pide que lo contacten otro día (ej. "escribime el lunes"). Una línea; fecha ISO y texto corto para el mensaje programado.
• [ENTREGA:YYYY-MM-DD|HH:mm o --|título breve] — cuando coordinás fecha (y si aplica hora) de entrega u obra: queda en el **calendario del panel** (Agenda de entregas). Usá \`--\` (dos guiones) en hora si es solo el día. Ej: [ENTREGA:2026-04-07|09:00|1 tn leña Iván] o [ENTREGA:2026-04-07|--|Entrega leña coordinada].
11c. AUDIO DE FIDELIZACIÓN: Cuando el contexto indique [CONTEXTO_AUDIO:], incluí al inicio de tu respuesta el marcador [AUDIO_FIDELIZAR:frase] con una frase corta y cálida (máx 12 palabras) que suene humana y genere confianza. La frase va SOLO en el marcador, no la repitas en el texto escrito. Variá siempre la frase según la conversación. Ejemplos: "¡Me alegra que estés mirando esto! Es una excelente opción.", "Cualquier duda que tengas me avisás, estoy acá.", "Trabajamos con mucha gente de la zona, van a quedar re conformes." La pregunta debe estar relacionada con lo que se estuvo hablando. Ejemplos según contexto:
    - Después de dar precio de leña: "¿Te la enviamos? ¿Cuántos kilos necesitás?"
    - Después de dar info de cercos: "¿Ya tenés las medidas del espacio? ¿Es para el frente o el fondo de tu casa?"
    - Después de dar info de pérgolas: "¿Tenés alguna medida en mente o querés que te ayudemos a calcular el espacio?"
    - Después de dar un presupuesto: "¿Esto era lo que estabas buscando? ¿Querés que avancemos?"
    - En general: "¿Conocés nuestro showroom en Villa Allende?" (solo si no fue mencionado antes) o "¿Tenés alguna otra consulta?"
    NUNCA termines una respuesta sin pregunta. La pregunta cierra siempre el mensaje de Vicky.
11d. Pregunta de cierre: NO enumeres en cada mensaje la lista de servicios (leña, cercos, pérgolas, fogonero, etc.) salvo que el cliente pregunte explícitamente qué venden o sea una consulta totalmente genérica sin tema. Preferí una sola pregunta corta atada al tema actual, por ejemplo "¿En qué más te puedo ayudar?" o algo concreto sobre medidas, zona o cantidad.
11e. Si el sistema envía [CONTEXTO_PUBLICIDAD], el cliente llegó desde un anuncio de leña o de cercos. NO preguntes qué producto le interesa ni ofrezcas el menú completo de servicios; respondé directo sobre ese producto con la información del sistema.

TÉCNICAS DE VENTA (aplicar naturalmente, sin sonar forzado):

T1. PRUEBA SOCIAL + INSTAGRAM: Cuando el cliente muestra interés, pide precio, o está dudando, mencioná naturalmente que pueden ver trabajos realizados en Instagram. Los mensajes directos de @gardens.wood se responden con el mismo flujo y precios que WhatsApp (regla 6b). Combiná con prueba social de zona. Variá siempre, no uses siempre la misma frase. Ejemplos:
    - "Si querés ver cómo quedan los cercos terminados, tenemos fotos en Instagram: @gardens.wood. Quedaron buenísimos los últimos que hicimos."
    - "La semana pasada terminamos un cerco en Villa Allende, lo subimos al Instagram @gardens.wood si querés verlo."
    - "Mirá, en @gardens.wood subimos todos los trabajos. Los clientes de la zona siempre nos piden algo parecido a lo que ven ahí."
    - "Tenemos varios trabajos de pérgolas subidos en @gardens.wood, para que te des una idea del terminado."
    CUÁNDO MENCIONARLO (elegí uno, no todos a la vez):
    • Cuando el cliente pregunta "¿cómo quedan?", "¿tienen fotos?", "¿puedo ver ejemplos?"
    • Cuando el cliente dice "voy a pensar" o muestra dudas antes de confirmar
    • Justo después de enviar una cotización, para reforzar la confianza
    • Una vez por conversación máximo — no lo repitas en cada mensaje.

T2. MANEJO DE OBJECIONES DE PRECIO: Si el cliente dice "es caro", "voy a pensar", "lo consulto", no te quedes callada. Respondé con empatía y ofrecé alternativas o aclará el valor:
    - "¿Te parece caro por el total o por metro? Podemos arrancar con una parte y continuarlo después."
    - "Entiendo, es una inversión. ¿Querés que te muestre alguna opción más accesible?"
    - "El quebracho dura décadas, es caro una vez y barato para siempre."
    - "¿Qué presupuesto tenías pensado? Veo qué te puedo armar."

T3. ANCLAJE DE PRECIO: Cuando hay varias opciones, mencioná primero la premium y luego la más económica. Así la económica parece más accesible. Ejemplo: "La altura máxima a 3 metros sale $185.000/m, si necesitás algo más estándar, los de 1.8m salen bastante menos."

T4. URGENCIA REAL (solo cuando sea verdad): En temporada de invierno: "Estamos entrando en temporada, el stock de leña se mueve rápido." Sobre precios: "Los precios se actualizan mensualmente, el de ahora es el que te puedo asegurar hoy."

T5. CIERRE ASUNTIVO: En vez de preguntar "¿te interesa?", asumí que sí y preguntá el siguiente paso concreto:
    - "¿Cuándo necesitarías la entrega?" en vez de "¿Querés avanzar?"
    - "¿Te lo mandamos a Villa Allende o en qué zona estás?"
    - "¿Arrancamos con la medida que me dijiste o querés ajustarla?"

T6. SHOWROOM: Una sola vez por conversación, cuando hay interés concreto: "Si querés ver las muestras en persona, estamos en Av. Río de Janeiro 1281, Villa Allende, de lunes a viernes de 8 a 17hs."

T7. VISITA SIN CARGO (para proyectos grandes): Cuando el cliente consulta por un proyecto grande — pérgola, cerco de más de 20 metros, sector fogonero completo, o cualquier obra que requiera medición — ofrecé una visita técnica gratuita. Hacelo de forma natural, como un beneficio, no como un trámite.
    CUÁNDO OFRECERLA:
    • Pérgolas: siempre, porque dependen del espacio y estructura
    • Cercos de más de 20 metros o con desniveles / esquinas / puertas
    • Sector fogonero completo (banco + pérgola + fogón)
    • Cuando el cliente dice "no sé exactamente cuántos metros son"
    • Cuando menciona que el terreno tiene pendiente, desnivel o es irregular
    CÓMO DECIRLO (variá siempre):
    - "Para un proyecto de ese tamaño te conviene que pasemos a ver el espacio. La visita es sin cargo y te damos el presupuesto exacto en el momento. ¿Cuándo te vendría bien?"
    - "Para la pérgola lo ideal es que vayamos a medir. No te cuesta nada y así el presupuesto es preciso. ¿Estás en Villa Allende o zona?"
    - "Con ese metraje conviene que uno de nuestros técnicos pase a ver. Es sin cargo. ¿Cuándo podría ser?"
    UNA sola vez por conversación. Si el cliente ya confirmó la visita, no la ofrezcas de nuevo.

12. Cuando mostrés precios de un servicio, incluí al final del mensaje exactamente uno de estos marcadores según corresponda (sin modificarlo):
    - Para leña: [IMG:lena]
    - Para cercos: [IMG:cerco]
    - Para pérgolas: [IMG:pergola]
    - Para sector fogonero: [IMG:fogonero]
    - Para bancos de quebracho: [IMG:bancos]
    Solo incluí el marcador cuando mostrés una lista de precios, NO en cada mensaje.
    REGLA CLAVE — SIN SALUDO DOBLE: Si en esta misma respuesta hay un [AUDIO_CORTO:] o [AUDIO_FIDELIZAR:], el texto escrito empieza DIRECTO con los datos. Prohibido: "Hola", "Buenas", "Bárbaro", "Claro, te cuento", "Te paso la info", "Acá te detallo". Solo los datos.
13. No incluyas el marcador de imagen si ya lo enviaste antes en la misma conversación.
14. Formateá los precios con puntos separadores de miles (ej: $290.000, no $290000).
15. Cuando hagás un presupuesto con metros o cantidad, mostrá el cálculo detallado (cantidad × precio = total).
16. Cuando enviés una cotización con total (presupuesto completo), agregá al FINAL del mensaje el marcador: [COTIZACION:servicio] donde servicio es lena, cerco, pergola, fogonero o bancos. Ejemplo: [COTIZACION:cerco]
    ESPECIAL CERCOS — PDF: Cuando hagas un presupuesto de CERCOS con datos completos (metros, precio, altura), además de [COTIZACION:cerco] agregá al FINAL el marcador:
    [PDF_CERCO:metros|precioUnit|alturaM|descuentoPct]
    Ejemplos:
      • 28 metros, $140.000/ml, altura 1.8m, sin descuento → [PDF_CERCO:28|140000|1.8|0]
      • 15 metros, $155.000/ml, altura 2m, 5% descuento   → [PDF_CERCO:15|155000|2.0|5]
    Solo incluir cuando tenés metros y precio definidos. precioUnit es el valor por metro lineal SIN signo $.
    descuentoPct es 0 si no hay descuento. alturaM es la altura en metros (1.8, 2.0, 2.5, 3.0).
    FLUJO OBLIGATORIO AL ENVIAR PRESUPUESTO DE CERCO:
    1° Enviás el desglose del presupuesto (metros × precio = total).
    2° Terminás el mensaje con UNA sola pregunta de cierre: "¿Te parece bien el presupuesto? ¿Avanzamos?"
    3° NUNCA pedís datos para agendar (dirección, nombre, fecha) en el mismo mensaje del presupuesto.
    4° Solo DESPUÉS de que el cliente diga que sí quiere avanzar, pedís los datos necesarios para coordinar la obra.
17. Cuando el cliente confirme que va a hacer la seña o que quiere avanzar con el pedido, NO le compartas datos bancarios por este chat: ni alias, ni CBU, ni titular, ni CUIT. Eso lo envía un asesor por otro medio. Respondé con naturalidad (podés variar la redacción) que ya tenés los datos que necesitás y que en breve un asesor se va a comunicar con el cliente para ultimar los detalles (incluido el pago si corresponde). Ejemplos de sentido: "Listo, ya tengo lo que necesitaba. En breve un asesor se comunica con vos para cerrar los detalles." / "Perfecto, quedó registrado. En breve te escribe un asesor para ultimar todo." Al FINAL del mensaje agregá: [CONFIRMADO]
    Si el cliente pide explícitamente CBU o datos para transferir antes de haber cerrado intención, aplicá la misma lógica: sin datos bancarios; asesor en breve.
17b. COMPROBANTE DE TRANSFERENCIA — NO PEDIR (salvo excepción): En el flujo habitual **no pidas** foto, PDF ni captura del comprobante de transferencia, ni digas “mandame el comprobante”, “pasame la transferencia”, etc. El pago y la acreditación los cierra el asesor por otro canal (regla 17). **Solo podés pedir explícitamente el comprobante** si en el contexto tenés **las dos** cosas claras: (1) el contacto ya es **cliente** con nosotros (no solo consulta: p. ej. en CRM/estado figura como cliente o equivalente, o historial de compra cerrada; **no** alcanza un solo presupuesto enviado), **y** (2) **ya transfirió al menos una vez** antes (consta en el hilo, en pedidos anteriores, o lo dijo explícitamente). Si falta cualquiera de las dos, **no lo solicites**. Si el cliente **manda** un comprobante por su cuenta, respondé con normalidad (regla 24 — fotos); eso **no** habilita a exigir comprobantes en mensajes posteriores salvo que se cumpla de nuevo esta excepción.
18. Cuando conozcas el nombre del cliente (porque te lo dijo o porque está en el contexto), agregá al FINAL del primer mensaje donde lo uses: [NOMBRE:PrimerNombre] — solo el primer nombre, sin apellido.
18b. Si el sistema te pasa un bloque [CONTEXTO_HISTORIAL_CONSULTAS] con intercambios anteriores, tenelo en cuenta antes de responder (continuidad, no repetir lo ya aclarado). Si ahí figura un nombre conocido, usalo de forma natural en el saludo (solo primer nombre).
18c. Si aparece [HILO_WHATSAPP_RECIENTE], es el registro del chat en el panel: usalo para saber de qué venían hablando antes de contestar (además de [LECTURA_CHAT_PREVIO] y el mensaje actual).
19. Cuando el cliente te diga su dirección de entrega u obra, agregá al FINAL: [DIRECCION:la dirección completa]
20. Cuando el cliente te diga su zona o barrio (aunque no sea la dirección exacta), agregá al FINAL: [ZONA:nombre de la zona]
20b. DATOS PARA MAPA Y LOGÍSTICA (Firestore + geocodificación automática): todo lo que el cliente diga que ayude a ubicarlo debe quedar en marcadores separados al FINAL del turno (el cliente no los ve). Usá texto fiel a lo que dijo, sin inventar:
    • [BARRIO:nombre del barrio] — si nombra barrio/pueblo dentro de la ciudad distinto de la "zona" general.
    • [LOCALIDAD:ciudad o localidad] — ej. Villa Allende, Río Ceballos, Córdoba capital, si lo dice o es claro por contexto.
    • [REFERENCIA:punto de referencia] — entre calles, color de portón, edificio, lote, "frente a…", etc.
    • [NOTAS_UBICACION:texto breve] — cualquier otro dato útil para encontrar el lugar (horario de entrega en la dirección, acceso, perro, etc.). Mantené el texto conciso.
    Si en un mismo mensaje da varios datos, podés emitir varios marcadores. Si ya usás [ZONA:…] para el mismo concepto, no dupliques; priorizá el más específico.
21. Cuando el cliente te diga su método de pago preferido (efectivo o transferencia), agregá al FINAL: [METODO_PAGO:efectivo] o [METODO_PAGO:transferencia]
21b. Cuando en UN SOLO mensaje el cliente te envíe los datos que pediste para coordinar entrega u obra (como mínimo: un TELÉFONO DE CONTACTO real —puede ser distinto al de WhatsApp—, más DIRECCIÓN o ZONA clara, más FRANJA HORARIA / horario preferido de entrega u otro dato de coordinación equivalente), al FINAL de tu respuesta agregá EXACTAMENTE esta marca sola: [NOTIFICAR_DATOS_ENTREGA]. No la uses si faltan datos, si el mensaje es solo una pregunta o si el cliente aún no cerró los datos. Seguí usando en el mismo turno [DIRECCION:…], [ZONA:…], [BARRIO:…], [LOCALIDAD:…], [REFERENCIA:…], [NOTAS_UBICACION:…], [NOMBRE:…], etc. cuando correspondan.
21c. Si en ese mismo intercambio el cliente ya dio o confirmó una FECHA concreta de entrega (día del mes, “el viernes” resuelto a fecha, etc.), agregá también [ENTREGA:YYYY-MM-DD|HH:mm o --|título breve con nombre o producto]. Si todavía no hay día cerrado, no inventes la fecha. El sistema guarda el evento en el cronograma del panel y los datos en CRM.
22. Cuando el cliente confirme un pedido o una obra y ya tenés todos los datos, registrá el pedido al FINAL con: [PEDIDO:servicio|descripcion_breve] — por ejemplo: [PEDIDO:lena|500kg quebracho] o [PEDIDO:cerco|12m a 2m de alto]
25. AUDIOS QUE MANDA EL CLIENTE: Cuando el cliente manda un audio o nota de voz, procesá su contenido normalmente. Además, al principio de tu respuesta incluí esta línea especial (y solo esta línea al inicio): [AUDIO_CORTO:frase]
    REGLAS DE ORO para el AUDIO_CORTO — para que suene LO MÁS HUMANA POSIBLE:
    • Frases cortas y naturales. Como si le hablarás a un amigo, no a un cliente formal.
    • Sin listas, sin puntos, sin asteriscos, sin guiones. Solo texto corrido.
    • Sin tecnicismos ni abreviaciones (decí "metros" no "mt", "kilogramos" no "kg").
    • Usá comas para pausas naturales, no saltos de línea.
    • Variá siempre las frases — nunca dos audios iguales.
    • Máximo 2-3 oraciones. Breve y cálido.
    La frase del AUDIO_CORTO depende del tipo de respuesta:
    a) Si el cliente pregunta de forma VAGA sobre un producto o servicio: respondé con una pregunta cálida y conversacional para entender qué necesita. Sin datos del catálogo todavía.
       Ejemplo pérgola: "Hola [nombre], qué bueno que consultes. Contame un poco, ¿es para tener sombra en el jardín, para guardar el auto, o para armar una zona de asado? Así te oriento mejor."
       Ejemplo cerco: "Hola [nombre], perfecto. ¿Es para delimitar el frente, el fondo, o un lateral? Y más o menos, ¿cuántos metros serían?"
    b) Si la respuesta NO es un presupuesto pero SÍ tiene info concreta: frase corta, cálida y variada. Máximo 15 palabras.
       Ejemplos: "Sí, [nombre], ya te mando todo." / "Dale, anotá esto." / "Bueno, te cuento."
    c) Si la respuesta ES un presupuesto o cotización: resumí solo el pedido y el total, en forma conversacional.
       SOLO: qué producto, cuánto, y el total. Terminá con una pregunta de cierre natural.
       Ejemplo: "Mirá, para los quince metros de cerco a un ochenta de alto, el total te quedaría en dos millones cien mil pesos. ¿Te parece bien?"
       NUNCA leas campos de datos a completar (nombre, dirección, etc.) — eso va solo en texto.
    Variá siempre el tono, las palabras y el ritmo para que no suene siempre igual.
24. FOTOS QUE MANDA EL CLIENTE: Si el cliente manda una foto, analizala en el contexto de nuestros servicios y productos:
    - Si es un espacio exterior (patio, jardín, terreno): estimá visualmente si aplica pérgola, cerco, sector fogonero o bancos. Comentá lo que ves y preguntale qué tiene en mente.
    - Si es una foto de madera o producto: identificá de qué se trata y ofrecé el producto similar de nuestro catálogo.
    - Si es un comprobante de transferencia: agradecé, confirmá que quedó a disposición del equipo y que en breve lo contactan si hace falta coordinar. **No** uses este mensaje para pedir otro comprobante ni para instar a mandar comprobantes en el futuro (regla 17b).
    - Si es una foto de un trabajo que le gusta (de otra empresa): identificá el estilo y cotizá nuestro equivalente.
    - Si la foto no es clara o no tiene relación con nuestros servicios: pedile que te cuente qué necesita.
    - Si manda una foto sin texto: respondé describiendo brevemente lo que ves y preguntando en qué lo podés ayudar.
23. COLA DE ENTREGA DE LEÑA: El vehículo de entrega tiene capacidad de 1 tonelada (1000kg). Para pedidos de hasta 200kg, los sumamos a una entrega grupal con otros clientes de la zona para que el flete salga conveniente para todos.
    - Si el cliente pide 200kg o menos: informale amablemente que para pedidos pequeños armamos una ruta grupal con otros clientes de la zona para que el flete sea más conveniente. Decile que cuando tengamos la ruta lista lo contactamos para coordinar. Pedile su dirección y cantidad si aún no las tenés. Si ya sabés el tipo de leña (hogar/grande, salamandra/mediana o parrilla/fino), agregá al FINAL: [PEDIDO_LENA:cantidadKg|direccion_completa|tipo] con tipo exactamente uno de: hogar, salamandra, parrilla (minúsculas). Si el tipo no está claro, preguntale antes de poner el marcador. El formato de dos campos sigue siendo válido: [PEDIDO_LENA:cantidadKg|direccion_completa]
    - Si el cliente pide más de 200kg: podemos hacer la entrega individual. Cotizá normalmente con la info de envío estándar. NO uses el marcador [PEDIDO_LENA].
    - Si el cliente pregunta cuánto tarda: decile que normalmente en 2 a 5 días hábiles lo contactamos para coordinar.

25. INTERPRETACIÓN DE PEDIDOS DE LEÑA — REGLAS EXTENDIDAS:
    El cliente puede pedir leña de muchas formas distintas. Siempre intentá interpretar correctamente antes de pedir aclaración.
    CONECTORES VÁLIDOS entre cantidad y tipo:
    - "X kg DE salamandra" → X kg de Salamandra/Mediana
    - "X kg PARA salamandra" → X kg de Salamandra/Mediana (PARA = DE en este contexto)
    - "X PARA hogar" → X kg de Hogar/Grande (sin unidad = kg por defecto)
    - "X de leña PARA parrilla" → X kg de Parrilla/Fino
    - "X tonelada para salamandra y Y kg para parrilla" → pedido mixto: X ton Salamandra + Y kg Parrilla
    TOLERANCIA DE TYPOS en nombres de productos (tratá estos como el tipo correcto):
    - "salamndra", "salmandra", "salamadra", "salamanda" → Salamandra/Mediana
    - "parilla", "parrila", "parrilla", "parila" → Parrilla/Fino
    - "ogar", "hoagr", "hogra" → Hogar/Grande
    CANTIDAD SIN TIPO ESPECIFICADO: Si el cliente menciona cantidad (con o sin unidad) pero NO dice qué tipo de leña quiere (ej: "1000kg", "2 toneladas", "quiero leña"), preguntale cuál necesita:
    "Perfecto! Tenemos tres tipos de leña:
    • Hogar/Grande: $290.000/tn
    • Salamandra/Mediana: $300.000/tn
    • Parrilla/Fino (Quebracho Blanco): $320.000/tn
    ¿Cuál te va mejor? 🪵"
    PEDIDOS MIXTOS: Si pide dos tipos en el mismo mensaje (ej: "1tn salamandra y 200kg parrilla"), cotizá ambos por separado y sumá el total.

26. RESPUESTA ANTE MENSAJES CASUALES O EXCLAMACIONES:
    Si durante una conversación activa el cliente manda un mensaje muy informal, exclamación o saludo sin consulta clara (ej: "Aaaaaa vickyyy eeee", "jajaja", "dale igual"), NO te quedés en silencio. Respondé brevemente y reenganché la conversación:
    - Si ya estabas hablando de leña: "¡Acá estoy! 😊 ¿Seguís con la consulta de leña o necesitás otra cosa?"
    - Si no hay contexto: "¡Hola! ¿En qué te puedo ayudar? 😊"
    Nunca ignorés un mensaje, aunque no tenga contenido claro.

27. NUNCA RESPONDAS CON SILENCIO:
    Si no entendés la consulta o el mensaje es ambiguo, SIEMPRE respondé algo. Opciones:
    - Pedí que te expliquen de otra manera: "Disculpá, no entendí bien. ¿Podés contarme qué necesitás? 😊"
    - Re-ofrecé el menú de servicios si no hay contexto previo
    Esta regla tiene prioridad sobre todo lo demás — jamás dejes un mensaje sin respuesta.

28. RESPUESTAS NEGATIVAS A COLA DE LEÑA:
    Cuando un cliente que fue anotado en la cola grupal de leña responde negativamente (ej: "no", "mejor no", "dejá", "después", "cancelar"), reconocé su respuesta y confirmá amablemente:
    "¡Sin problema! Si después necesitás la leña, avisame y lo agendamos sin drama 😊🪵"
    Y continuá la conversación normalmente.`;

// --- SESIONES Y TRACKING ---
const SESSIONS = new Map();
const BOT_MSG_IDS = new Set();
/** Evita llamar requestPairingCode varias veces en el mismo proceso Node */
let pairingCodeRequestSent = false;
/** Con WHATSAPP_PAIRING_SKIP_GCS_AUTH, el rmSync de auth solo una vez por proceso (si no, cada reconexión borra creds.json y rompe QR/subida GCS). */
let vickyPairingAuthDirWipedThisProcess = false;
/** Un solo timer de reconexión para no apilar varios connectToWhatsApp(). */
let waReconnectTimer = null;

/** Socket Baileys activo (cada reconexión asigna el nuevo; evita enviar con socket cerrado). */
const vickySocketRef = { current: null };
/** Sondeo de `entregas_agenda` pendientes de aviso al grupo WA (altas desde panel). */
let agendaGrupoNotifyInterval = null;
/** Firestore + Gemini + delays: solo la primera vez; reconexiones solo recrean el socket. */
let vickyBootstrapHecho = false;
let vickyGeminiModel = null;
/** Cliente Gemini reutilizado para recargar `systemInstruction` tras #g + OK sin reiniciar el proceso. */
let vickyGoogleGenAI = null;
const vickyRuntimeCfg = {
    mensajeBienvenidaActivo: '¿En qué te puedo ayudar? Escribime porfa que me es más fácil responder 😊',
    DELAY_MIN: 26 * 1000,
    DELAY_MAX: 34 * 1000,
    FIDELIZAR_CADA: 0,
    BOT_ACTIVO: true,
    SILENCIO_HUMANO_MS: 24 * 60 * 60 * 1000,
    /** ID interno de etiqueta WhatsApp Business (panel `config/general` o env). Al handoff a asesor se llama `addChatLabel`. */
    WHATSAPP_LABEL_ID_CONTACTAR_ASESOR: '',
    /** Dígitos del admin: env desde el arranque; Firestore lo pisa al bootstrap. */
    ADMIN_PHONE_DIGITS: String(process.env.ADMIN_PHONE || '').replace(/\D/g, ''),
    /** WhatsApp operación: reenvío del mensaje del cliente cuando da teléfono + dirección + horario (marcador Gemini). */
    DATOS_ENTREGA_NOTIFY_DIGITS: '',
    CAMPANA_DELAY_MIN_MS: 15000,
    CAMPANA_DELAY_MAX_MS: 20000,
    CAMPANA_MAX: 40,
    CAMPANA_DESC_PCT: 10,
    /** Modelo Gemini (se setea en bootstrap). */
    MODEL_GEMINI: 'gemini-2.5-flash',
    /** JID grupo WhatsApp para avisos de nuevas filas en agenda de entregas (…@g.us). */
    GRUPO_JID_AGENDA_ENTREGAS: '',
    /** Panel `config/general` o default true. */
    NOTIFICAR_AGENDA_GRUPO_ACTIVO: true,
};
let vickySeguimientoIniciado = false;

function normalizarDigitosNotifOperacion(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('54')) return d;
    if (d.length === 10) return `549${d}`;
    if (d.length === 11 && d.startsWith('9')) return `54${d}`;
    return d;
}

(() => {
    const def = process.env.VICKY_DATOS_ENTREGA_NOTIFY_PHONE || '5493512956376';
    vickyRuntimeCfg.DATOS_ENTREGA_NOTIFY_DIGITS = normalizarDigitosNotifOperacion(def);
})();

/** Marca envío saliente al JID antes de await sendMessage: si Baileys emite el eco `fromMe` muy rápido, no lo confundimos con humano. */
const lastBotOutTsByJid = new Map();
const BOT_OUT_GRACE_MS = 8000;

/** Aplica en WhatsApp Business la etiqueta configurada (ej. “Contactar asesor”) al chat del cliente. */
async function aplicarEtiquetaContactarAsesor(remoteJid) {
    const labelId = vickyRuntimeCfg.WHATSAPP_LABEL_ID_CONTACTAR_ASESOR;
    if (!labelId || !remoteJid) return;
    const sock = vickySocketRef.current;
    if (!sock || typeof sock.addChatLabel !== 'function') return;
    try {
        await sock.addChatLabel(remoteJid, labelId);
        console.log(`🏷️ Etiqueta contactar asesor aplicada → ${remoteJid}`);
    } catch (e) {
        console.warn(`⚠️ addChatLabel (${labelId}):`, e.message);
    }
}

async function sendBotMessage(jid, content) {
    const s = vickySocketRef.current;
    if (!s) {
        console.warn('⚠️ sendBotMessage: sin socket activo');
        return null;
    }
    try {
        lastBotOutTsByJid.set(jid, Date.now());
        const sent = await s.sendMessage(jid, content);
        if (sent?.key?.id) BOT_MSG_IDS.add(sent.key.id);
        return sent;
    } catch (e) {
        console.warn('⚠️ sendBotMessage:', e.message);
        return null;
    }
}

function normalizarJidGrupoAgendaEntregas(raw) {
    const s = String(raw || '').trim().replace(/\s/g, '');
    if (!s) return '';
    if (s.endsWith('@g.us')) return s;
    return '';
}

function textoNotificacionEntregaAgendaEnGrupo(docId, d) {
    if (!d || typeof d !== 'object') return `📅 *Agenda de entregas* — id \`${docId}\``;
    const lines = ['📅 *Nueva entrada en agenda de entregas*', ''];
    if (d.fechaDia) lines.push(`📆 Día: *${String(d.fechaDia)}*`);
    if (d.horaTexto) lines.push(`🕐 Hora: ${String(d.horaTexto)}`);
    lines.push(`📝 ${String(d.titulo || '—').slice(0, 400)}`);
    if (d.origen) lines.push(`📎 Origen: _${String(d.origen)}_`);
    if (d.telefonoContacto) lines.push(`📞 Contacto: \`${String(d.telefonoContacto)}\``);
    if (d.direccion) lines.push(`📍 ${String(d.direccion).slice(0, 220)}`);
    if (d.producto) lines.push(`📦 ${String(d.producto).slice(0, 220)}`);
    if (d.notas) lines.push(`ℹ️ ${String(d.notas).slice(0, 280)}`);
    if (d.jid) lines.push(`💬 Chat: \`${String(d.jid)}\``);
    lines.push('', `\`id:${docId}\``);
    return lines.join('\n').slice(0, 3800);
}

async function leerConfigNotificacionGrupoAgendaEntregas() {
    if (!firestoreModule.isAvailable()) {
        const jid = normalizarJidGrupoAgendaEntregas(process.env.WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS);
        return { activo: true, grupoJid: jid };
    }
    const cfg = await firestoreModule.getConfigGeneral();
    const jid = normalizarJidGrupoAgendaEntregas(
        cfg.whatsappGrupoJidAgendaEntregas || process.env.WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS
    );
    const activo = cfg.notificarAgendaEntregasGrupoActivo !== false;
    return { activo, grupoJid: jid };
}

async function intentarNotificarNuevaEntregaAgendaGrupo(docId) {
    if (!docId || !firestoreModule.isAvailable()) return;
    if (!vickySocketRef.current) return;
    const { activo, grupoJid } = await leerConfigNotificacionGrupoAgendaEntregas();
    vickyRuntimeCfg.GRUPO_JID_AGENDA_ENTREGAS = grupoJid;
    vickyRuntimeCfg.NOTIFICAR_AGENDA_GRUPO_ACTIVO = activo;
    if (!activo || !grupoJid) return;
    const claimed = await firestoreModule.claimEntregaAgendaNotificacionGrupo(docId);
    if (!claimed) return;
    const d = await firestoreModule.getEntregaAgendaDocData(docId);
    if (!d) {
        await firestoreModule.revertEntregaAgendaNotificacionGrupo(docId);
        return;
    }
    const text = textoNotificacionEntregaAgendaEnGrupo(docId, d);
    const sent = await sendBotMessage(grupoJid, { text });
    if (!sent) {
        await firestoreModule.revertEntregaAgendaNotificacionGrupo(docId);
        console.warn(
            `⚠️ No se pudo enviar notificación de agenda al grupo (${String(grupoJid).slice(0, 32)}…); doc ${docId} queda pendiente.`
        );
    } else {
        console.log(`📣 Agenda entregas → grupo WA (${docId})`);
    }
}

async function procesarPendientesNotificacionAgendaGrupo() {
    if (!firestoreModule.isAvailable() || !vickySocketRef.current) return;
    const { activo, grupoJid } = await leerConfigNotificacionGrupoAgendaEntregas();
    if (!activo || !grupoJid) return;
    const ids = await firestoreModule.listEntregaAgendaIdsPendientesNotificarGrupo(12);
    for (const id of ids) {
        await intentarNotificarNuevaEntregaAgendaGrupo(id);
    }
}

/** Catálogo por servicio (imagen/video) — WhatsApp; Instagram usa texto alternativo en vicky-gemini-turn. */
async function enviarImagenCatalogo(jid, servicioKey) {
    const mediaPath = IMAGENES[servicioKey];
    if (mediaPath && fs.existsSync(mediaPath)) {
        try {
            const ext = path.extname(mediaPath).toLowerCase();
            const esVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
            if (esVideo) {
                await sendBotMessage(jid, { video: fs.readFileSync(mediaPath), mimetype: 'video/mp4', caption: '' });
            } else {
                await sendBotMessage(jid, { image: fs.readFileSync(mediaPath), caption: '' });
            }
        } catch (e) {
            console.warn(`⚠️ No se pudo enviar media de ${servicioKey}:`, e.message);
        }
    }
}

async function simularEscrituraVicky(remoteJid) {
    const s = vickySocketRef.current;
    if (!s) return;
    const { DELAY_MIN, DELAY_MAX } = vickyRuntimeCfg;
    try {
        await s.presenceSubscribe(remoteJid);
        await delay(500);
        await s.sendPresenceUpdate('composing', remoteJid);
        const span = DELAY_MAX - DELAY_MIN;
        const waitMs = span <= 0 ? DELAY_MIN : DELAY_MIN + Math.floor(Math.random() * (span + 1));
        await delay(waitMs);
        await s.sendPresenceUpdate('paused', remoteJid);
    } catch (e) {
        console.warn('⚠️ Error presencia:', e.message);
    }
}

// Dedupe de mensajes entrantes (evita doble procesamiento por reintentos/reconexiones)
const PROCESSED_IN_MSG_IDS = new Map(); // msgId -> timestampMs
const PROCESSED_IN_MSG_TTL_MS = 30 * 60 * 1000; // 30 min

function markIncomingProcessed(msgId) {
    if (!msgId) return;
    const now = Date.now();
    PROCESSED_IN_MSG_IDS.set(msgId, now);
    // limpieza opportunista
    if (PROCESSED_IN_MSG_IDS.size > 2000) {
        for (const [k, t] of PROCESSED_IN_MSG_IDS.entries()) {
            if (now - t > PROCESSED_IN_MSG_TTL_MS) PROCESSED_IN_MSG_IDS.delete(k);
        }
    }
}

function wasIncomingProcessed(msgId) {
    if (!msgId) return false;
    const now = Date.now();
    const t = PROCESSED_IN_MSG_IDS.get(msgId);
    if (!t) return false;
    if (now - t > PROCESSED_IN_MSG_TTL_MS) {
        PROCESSED_IN_MSG_IDS.delete(msgId);
        return false;
    }
    return true;
}

// ============================================================
// PERSISTENCIA GCS
// ============================================================
async function downloadFromGCS(opts = {}) {
    const quiet = !!opts.quiet;
    if (!quiet) console.log('📦 Sincronizando sesión desde GCS...');
    try {
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

        /** Vinculación por código con sesión “a medias” en GCS suele fallar en el teléfono; esto fuerza auth limpio solo si aún no hay sesión registrada. */
        const pairingSkipGcsAuth = /^(1|true|yes)$/i.test(String(process.env.WHATSAPP_PAIRING_SKIP_GCS_AUTH || '').trim());
        let skipAuthDownload = false;
        if (pairingSkipGcsAuth) {
            const credPath = path.join(AUTH_DIR, 'creds.json');
            let shouldResetAuth = true;
            if (fs.existsSync(credPath)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                    if (creds.registered) shouldResetAuth = false;
                } catch (_) { /* creds rotos → reiniciar */ }
            }
            if (shouldResetAuth) {
                skipAuthDownload = true;
                if (!vickyPairingAuthDirWipedThisProcess) {
                    vickyPairingAuthDirWipedThisProcess = true;
                    if (!quiet) console.log('⚠️ WHATSAPP_PAIRING_SKIP_GCS_AUTH: limpieza inicial en este arranque → se borró auth local y no se descarga auth/ desde GCS.');
                    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
                    fs.mkdirSync(AUTH_DIR, { recursive: true });
                } else {
                    if (!quiet) console.log('💡 WHATSAPP_PAIRING_SKIP_GCS_AUTH: reconexión → no se borra auth otra vez (conservá el QR en curso); solo se omite descarga auth desde GCS.');
                }
            } else {
                if (!quiet) console.log('💡 WHATSAPP_PAIRING_SKIP_GCS_AUTH activo pero la sesión ya está registrada; se sincroniza auth desde GCS con normalidad.');
            }
        }

        if (!skipAuthDownload) {
            const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: 'auth/' });
        for (const file of files) {
            const destPath = path.join(AUTH_DIR, file.name.replace('auth/', ''));
            await file.download({ destination: destPath });
            }
        }
        const histFile = storage.bucket(BUCKET_NAME).file('usuarios_vistos.json');
        const [exists] = await histFile.exists();
        if (exists) {
            await histFile.download({ destination: HISTORIAL_PATH });
            if (!quiet) console.log('✅ Historial descargado.');
        }
        if (!quiet) console.log('✅ Sincronización completa.');
    } catch (e) {
        console.error('❌ Error en downloadFromGCS:', e.stack);
        if (String(e.message || e).includes('credentials')) {
            console.warn('💡 Local: ejecutá `gcloud auth application-default login` o definí GOOGLE_APPLICATION_CREDENTIALS=ruta\\al\\service-account.json');
        }
    }
}

// Debounce para uploads de sesión: evita GCS 429 por subidas masivas de archivos auth
const _gcsUploadTimers = new Map();
async function uploadToGCS(fileName, fullPath) {
    // Los archivos de auth de sesión se debouncean 15s — los datos de negocio van inmediato
    const esArchivoAuth = fileName !== 'usuarios_vistos.json' && fileName !== 'cola_lena.json';
    if (esArchivoAuth) {
        if (_gcsUploadTimers.has(fileName)) clearTimeout(_gcsUploadTimers.get(fileName));
        _gcsUploadTimers.set(fileName, setTimeout(async () => {
            _gcsUploadTimers.delete(fileName);
            try {
                await storage.bucket(BUCKET_NAME).upload(fullPath, { destination: `auth/${fileName}` });
            } catch (e) {
                if (!e.message.includes('429')) console.error(`❌ Error subiendo ${fileName}:`, e.message);
            }
        }, 15000));
        return;
    }
    try {
        const destination = fileName === 'usuarios_vistos.json' ? fileName : `auth/${fileName}`;
        await storage.bucket(BUCKET_NAME).upload(fullPath, { destination });
    } catch (e) {
        console.error(`❌ Error subiendo ${fileName}:`, e.message);
    }
}

// ============================================================
// HISTORIAL DE CLIENTES (persistencia GCS)
// ============================================================
let clientesHistorial = {};

function loadHistorialLocal() {
    if (fs.existsSync(HISTORIAL_PATH)) {
        try {
            const data = fs.readFileSync(HISTORIAL_PATH, 'utf-8');
            const parsed = JSON.parse(data);
            clientesHistorial = Array.isArray(parsed) ? {} : (parsed || {});
        } catch (e) { console.error(e); clientesHistorial = {}; }
    }
}

function saveHistorialLocal() {
    try {
        fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(clientesHistorial, null, 2), 'utf-8');
    } catch (e) { console.error('❌ Error guardando historial:', e.message); }
}

async function saveHistorialGCS() {
    saveHistorialLocal();
    await uploadToGCS('usuarios_vistos.json', HISTORIAL_PATH);
}

// --- Historial de consultas por cliente (carpeta local + GCS historial_consultas/{tel}.json) ---
/** Clave de archivo segura (Windows no admite ":" en nombre). Thread `ig:123` → `ig_123.json`. */
function historialConsultaFileKey(threadId) {
    const t = String(threadId || '');
    return t.startsWith('ig:') ? t.replace(/^ig:/, 'ig_') : t;
}

function pathConsultaLocal(tel) {
    return path.join(HISTORIAL_CONSULTAS_DIR, `${historialConsultaFileKey(tel)}.json`);
}

async function downloadHistorialConsultaIfNeeded(tel) {
    if (!tel) return;
    try {
        if (!fs.existsSync(HISTORIAL_CONSULTAS_DIR)) fs.mkdirSync(HISTORIAL_CONSULTAS_DIR, { recursive: true });
        const localPath = pathConsultaLocal(tel);
        if (fs.existsSync(localPath)) return;
        const gcsKey = `historial_consultas/${historialConsultaFileKey(tel)}.json`;
        const gcsFile = storage.bucket(BUCKET_NAME).file(gcsKey);
        const [exists] = await gcsFile.exists();
        if (exists) {
            await gcsFile.download({ destination: localPath });
            console.log(`📂 Historial de consultas descargado: ${tel}`);
        }
    } catch (e) {
        if (!e.message?.includes('No such object')) console.warn(`⚠️ downloadHistorialConsulta ${tel}:`, e.message);
    }
}

function leerHistorialConsultasArchivo(tel) {
    try {
        const p = pathConsultaLocal(tel);
        if (!fs.existsSync(p)) return null;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!data || !Array.isArray(data.entradas)) return null;
        return data;
    } catch (e) {
        return null;
    }
}

function construirContextoHistorialConsultas(data) {
    if (!data || !data.entradas || data.entradas.length === 0) return null;
    const cortes = data.entradas.slice(-24);
    const lineas = cortes.map((e) => {
        const quien = e.de === 'cliente' ? 'Cliente' : 'Vicky';
        const t = e.ts ? new Date(e.ts).toLocaleString('es-AR') : '';
        const txt = String(e.texto || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        return `- ${t} ${quien}: ${txt}`;
    });
    const primerNombre = data.nombre ? String(data.nombre).trim().split(/\s+/)[0] : null;
    const lineaNombre = primerNombre
        ? `Nombre conocido (usá solo el primer nombre al saludar si encaja): ${primerNombre}.`
        : '';
    return `[CONTEXTO_HISTORIAL_CONSULTAS] Este contacto ya tuvo consultas previas con Gardens Wood guardadas en historial. ${lineaNombre}\nIntercambios recientes:\n${lineas.join('\n')}\nContinuá la conversación con coherencia. Si el nombre figura arriba, usalo de forma natural (solo primer nombre).`;
}

function limpiarTextoParaHistorialConsulta(s) {
    if (!s) return '';
    return s
        .replace(/\[IMG:[^\]]+\]/gi, '')
        .replace(/\[COTIZACION:[^\]]+\]/gi, '')
        .replace(/\[PDF_CERCO:[^\]]+\]/gi, '')
        .replace(/\[CONFIRMADO\]/gi, '')
        .replace(/\[NOMBRE:[^\]]+\]/gi, '')
        .replace(/\[DIRECCION:[^\]]+\]/gi, '')
        .replace(/\[ZONA:[^\]]+\]/gi, '')
        .replace(/\[BARRIO:[^\]]+\]/gi, '')
        .replace(/\[LOCALIDAD:[^\]]+\]/gi, '')
        .replace(/\[REFERENCIA:[^\]]+\]/gi, '')
        .replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '')
        .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
        .replace(/\[PEDIDO:[^\]]+\]/gi, '')
        .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
        .replace(/\[HANDOFF_EXPERTO:[^\]]+\]/gi, '')
        .replace(/\[AUDIO_CORTO:[^\]]+\]/gi, '')
        .replace(/\[AUDIO_FIDELIZAR:[^\]]+\]/gi, '')
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4500);
}

function appendHistorialConsultaSync(tel, { entradaCliente, salidaVicky, nombre }) {
    if (!tel) return;
    try {
        if (!fs.existsSync(HISTORIAL_CONSULTAS_DIR)) fs.mkdirSync(HISTORIAL_CONSULTAS_DIR, { recursive: true });
        const p = pathConsultaLocal(tel);
        let data = { telefono: tel, nombre: nombre || null, actualizadoEn: new Date().toISOString(), entradas: [] };
        if (fs.existsSync(p)) {
            try {
                const prev = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (prev && Array.isArray(prev.entradas)) data.entradas = prev.entradas;
                if (prev?.nombre && !nombre) data.nombre = prev.nombre;
            } catch (_) { /* vacío */ }
        }
        if (nombre) data.nombre = nombre;
        const ts = Date.now();
        data.actualizadoEn = new Date().toISOString();
        data.entradas.push({ ts, de: 'cliente', texto: (entradaCliente || '').slice(0, 2500) });
        data.entradas.push({ ts, de: 'vicky', texto: (salidaVicky || '').slice(0, 4500) });
        if (data.entradas.length > MAX_ENTRADAS_CONSULTAS) {
            data.entradas = data.entradas.slice(-MAX_ENTRADAS_CONSULTAS);
        }
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
        storage.bucket(BUCKET_NAME).upload(p, { destination: `historial_consultas/${historialConsultaFileKey(tel)}.json` }).catch((e) => {
            if (!e.message?.includes('429')) console.warn('⚠️ Subida historial_consultas:', e.message);
        });
    } catch (e) {
        console.warn('⚠️ appendHistorialConsulta:', e.message);
    }
}

// ============================================================
// COLA LOGÍSTICA DE LEÑA
// ============================================================
const COLA_LENA_PATH = path.join(__dirname, 'cola_lena.json');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ADMIN_PHONE = process.env.ADMIN_PHONE;
// ADMIN_PHONE solo para enviar al dueño (ej. ruta de leña). No activa modo admin por JID: así tu mismo número puede chatear como cliente.
// Modo admin: texto que empieza con ADMIN_SECRET (definilo en .env, ej. vicky1234). Default en código: !vicky
// Salir del modo admin: mensaje exacto ADMIN_EXIT_COMMAND (default adminoff). Configurar con env var ADMIN_EXIT_COMMAND.
// Configurar con env var ADMIN_SECRET o usa el default. Ej: "!vicky "
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '!vicky').toLowerCase().trim();
const ADMIN_EXIT_COMMAND = (process.env.ADMIN_EXIT_COMMAND || 'adminoff').toLowerCase().trim();
// JIDs que se autenticaron como admin recientemente (válido 1 hora)
// Cada entrada: { activadoEn: timestamp, listaClientes: { 1: jid, 2: jid, ... } }
const adminSesionesActivas = new Map();
const ADMIN_SESSION_TTL = 60 * 60 * 1000; // 1 hora

/** Tras la frase secreta sola: menú numerado (persistido en `adminWaSesion`). */
const ADMIN_MENU_PRINCIPAL_MSG =
    '🔑 *Modo admin*\n\n'
    + 'Elegí una opción (mandá solo el número):\n\n'
    + '*1* — Enviar mensaje a un cliente (Vicky redacta con Gemini y lo envía)\n'
    + '*2* — Instructivo para Vicky (como *#g*: se suma al system prompt con *OK*)\n'
    + '*3* — Cargar *Agenda de entregas* (cliente → fecha → hora → título)\n'
    + '*4* — Más comandos (*#reporte*, *#p*, *#c*, *#ruta* …) — también podés escribirlos con *#* al inicio\n\n'
    + '_Volver a este menú:_ *menu*\n'
    + '_Salir:_ *adminoff* o *#SALIR*';

/** Sesión admin en Firestore (multi-réplica). El flujo #g (vista previa) no se replica; OK aplica en `config/prompts` y se recarga Gemini en este proceso. */
async function rehydrateAdminWaSessionFromFirestore(remoteJid) {
    if (!remoteJid || !firestoreModule.isAvailable()) return;
    const fsSes = await firestoreModule.getAdminWaSession(remoteJid);
    if (!fsSes || !Number.isFinite(fsSes.activadoEn)) return;
    if ((Date.now() - fsSes.activadoEn) >= ADMIN_SESSION_TTL) {
        adminSesionesActivas.delete(remoteJid);
        await firestoreModule.clearAdminWaSession(remoteJid);
        return;
    }
    const local = adminSesionesActivas.get(remoteJid);
    const draftLocal = local && (local.borradorGeminiPreview || local.esperandoInstructivoGemini);
    if (draftLocal) {
        adminSesionesActivas.set(remoteJid, {
            ...fsSes,
            borradorGeminiPreview: local.borradorGeminiPreview ?? null,
            esperandoInstructivoGemini: !!local.esperandoInstructivoGemini,
            esperandoMenuPrincipal: !!fsSes.esperandoMenuPrincipal,
            wizard: fsSes.wizard && typeof fsSes.wizard === 'object' ? fsSes.wizard : null,
        });
        return;
    }
    adminSesionesActivas.set(remoteJid, fsSes);
}

async function persistAdminWaSessionFirestore(remoteJid) {
    if (!remoteJid || !firestoreModule.isAvailable()) return;
    const s = adminSesionesActivas.get(remoteJid);
    if (s && (Date.now() - s.activadoEn) < ADMIN_SESSION_TTL) {
        await firestoreModule.saveAdminWaSession(remoteJid, s);
    } else {
        if (s) adminSesionesActivas.delete(remoteJid);
        await firestoreModule.clearAdminWaSession(remoteJid);
    }
}

/** Quita invisibles/BOM, # ancho Unicode y espacios tras # (p. ej. "# reporte" → "#reporte"). */
function normalizarTextoComandosAdmin(s) {
    let t = String(s || '');
    t = t.replace(/^\uFEFF/g, '').replace(/^[\u200B-\u200D\u2060\uFEFF\u00A0]+/g, '');
    t = t.replace(/\uFF03/g, '#');
    t = t.trim();
    // "# p lidmap …" / "#  p …" → "#p …" (el bucle de abajo pegaba # + p → #plidmap y rompía #p lidmap)
    t = t.replace(/^#\s+p(?=\s|lidmap|$)/i, '#p');
    while (/^#\s+/.test(t)) {
        t = t.replace(/^#\s+/, '#');
    }
    return t;
}

/** ¿El texto normalizado es comando admin con #? */
function esMensajeHashComandoAdmin(textoNorm) {
    const t = String(textoNorm || '').trim().replace(/\*/g, '');
    return (
        /^#\s*(reporte\b|pedido(\s|$)|p(\+|\-|\s|lidmap\s)|g(\s|$)|ruta_geo\s|ruta\s|c(\s|$)|entrega\s|enviar\s|silencio\s|silenciar(\s|$)|activar\s|activo\s|vicky\s|estado\s*$)/i.test(t)
        || /^#\s*p\s+lidmap\b/i.test(t)
        || /^#\s*plidmap(?=[\s\d])/i.test(t)
    );
}

/**
 * Alternativas al símbolo # (WhatsApp a veces lo rompe al enviar).
 * !!reporte, !!g, !!g texto…, !!c, !!c juan, !!ruta zona prod, !!salir — o vicky:reporte, vicky:g …
 */
function normalizarAliasesComandoAdminRaw(s) {
    let t = String(s || '').trim();
    if (/^vicky\s*:/i.test(t)) {
        return '#' + t.replace(/^vicky\s*:\s*/i, '').trimStart();
    }
    if (/^!!\s*salir\s*$/i.test(t)) return '#salir';
    if (/^!!\s*reporte\b/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*ruta_geo(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*ruta(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*c(\s|$)/i.test(t)) return t.replace(/^!!\s*c/i, '#c');
    if (/^!!\s*g(\s|$)/i.test(t)) return t.replace(/^!!\s*g/i, '#g');
    if (/^!!\s*entrega(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*enviar(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*silencio(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*silenciar(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*activar(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*activo(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*estado\s*$/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*pedido(\s|$)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*p(\+|\-|\s)/i.test(t)) return t.replace(/^!!\s*/i, '#');
    if (/^!!\s*detalle\b/i.test(t)) return t.replace(/^!!\s*/i, '');
    return t;
}

/** Pipeline único: texto plano extraído del mensaje → comandos admin reconocibles. */
function textoAdminDesdeTextoPlano(plano) {
    return normalizarTextoComandosAdmin(normalizarAliasesComandoAdminRaw(normalizarTextoComandosAdmin(String(plano || ''))));
}

/** Texto que parece comando interno (lista, tel, último, “decile…”). Si no coincide y hay sesión admin sin paso 2, el mensaje sigue como cliente. */
function textoPareceComandoAdmin(t) {
    const s = textoAdminDesdeTextoPlano(t);
    if (!s) return false;
    if (/^(lista|vicky\s*lista|mostr[aá]\s+los|qui[eé]n\s+habl)/i.test(s)) return true;
    if (/^(el\s+)?[uú]ltimo\b/i.test(s)) return true;
    if (/^#\d{1,2}$/i.test(s)) return true;
    if (/^n\s*\d{1,2}$/i.test(s)) return true;
    if (/^(?:nro|nº|num|numero|número)\s*\d{1,2}$/i.test(s)) return true;
    if (/^(termina\s+en|finaliza\s+en)\s+\d{4}$/i.test(s)) return true;
    if (/^\*\d{4}$/.test(s)) return true;
    if (/^\d{10,15}$/.test(s)) return true;
    if (/^(mand[áa]|dec[ií]le|decile|avis[aá]le|avisale|pregunt[aá]le|preguntale|inform[aá]le|informale|envi[aá]le|enviale|cont[aá]le|contale|escrib[ií]le|escribile)\b/i.test(s)) return true;
    if (/^#\s*(c|g|ruta_geo|ruta|reporte|pedido|p(\+|\-|\s|lidmap\b)|entrega|salir|enviar|silencio|silenciar|activar|activo|vicky)\b/i.test(s)) return true;
    if (/^#\s*estado\s*$/i.test(s)) return true;
    if (/^(#d|#detalle|detalle)\s/i.test(s)) return true;
    if (/^(ok|dale|s[íi]|listo|guardar|confirmo)\s*$/i.test(s)) return true;
    if (/^(no|cancelar|cancel)\s*$/i.test(s)) return true;
    if (/^menu$/i.test(s)) return true;
    if (/^[1-4]\s*$/i.test(s)) return true;
    return false;
}

/**
 * Desanida tipos comunes de Baileys 7 (ephemeral, viewOnce, edited, deviceSent) y extrae texto/caption.
 */
function extraerTextoParaAdmin(msg) {
    if (!msg?.message) return '';
    let m = msg.message;
    const unwrap = (x) => {
        if (!x) return null;
        if (x.ephemeralMessage?.message) return x.ephemeralMessage.message;
        if (x.viewOnceMessage?.message) return x.viewOnceMessage.message;
        if (x.viewOnceMessageV2?.message) return x.viewOnceMessageV2.message;
        if (x.deviceSentMessage?.message) return x.deviceSentMessage.message;
        if (x.documentWithCaptionMessage?.message) return x.documentWithCaptionMessage.message;
        if (x.editedMessage?.message) return x.editedMessage.message;
        return null;
    };
    for (let i = 0; i < 6 && unwrap(m); i++) {
        m = unwrap(m);
    }
    const t = (
        m.conversation
        || m.extendedTextMessage?.text
        || m.imageMessage?.caption
        || m.videoMessage?.caption
        || m.documentMessage?.caption
        || m.buttonsResponseMessage?.selectedDisplayText
        || m.listResponseMessage?.title
        || m.listResponseMessage?.singleSelectReply?.selectedRowId
        || (m.templateButtonReplyMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedId)
        || ''
    );
    return String(t || '');
}

/**
 * Mensajes entrantes (!fromMe) siempre pueden ser admin.
 * Mensajes salientes (fromMe): solo si NO son eco del bot y (hay sesión admin vigente en ESTE chat
 * o el texto activa admin: frase secreta, #…, adminoff). Así podés usar la app Business del mismo número
 * que el bot (chat con tu otro celular o “Mensajes guardados”) sin que los # se ignoren.
 */
function debeEntrarModoAdmin(msg, remoteJid, textoRaw, tieneAudioMsg) {
    if (!msg?.key) return false;
    if (!msg.key.fromMe) return true;
    if (BOT_MSG_IDS.has(msg.key.id)) return false;
    const t = String(textoRaw || '').trim().toLowerCase();
    const sesData = adminSesionesActivas.get(remoteJid);
    const sesVig = sesData && (Date.now() - sesData.activadoEn) < ADMIN_SESSION_TTL;
    if (sesVig) return true;
    if (t.startsWith(ADMIN_SECRET)) return true;
    if (t === ADMIN_EXIT_COMMAND || t === '#salir') return true;
    if (
        /^#\s*(g|ruta_geo|ruta|c|reporte|pedido|p(\+|\-|\s)|entrega|salir|enviar|silencio|silenciar|activar|activo|vicky)\b/.test(t)
        || /^#\s*p\s+lidmap\b/i.test(t)
        || /^#\s*plidmap(?=[\s\d])/i.test(t)
    ) {
        return true;
    }
    if (/^#\s*estado\s*$/.test(t)) return true;
    if (tieneAudioMsg) return false;
    return false;
}

/** Tras `adminoff`: reactivar Vicky en memoria y en Firestore (silencio humano / panel). Varias rutas JID (@lid vs número) por si el panel guardó silencio en otro id. */
/** Tras #activo global: quita silencio humano en todas las sesiones Baileys en memoria. */
function limpiarHumanosLocalesSesiones() {
    for (const s of SESSIONS.values()) {
        s.humanAtendiendo = false;
        s.humanTimestamp = null;
    }
}

function reactivarVickyTrasSalirAdmin(remoteJid) {
    const s = SESSIONS.get(remoteJid);
    if (s) {
        s.humanAtendiendo = false;
        s.humanTimestamp = null;
    }
    if (!firestoreModule.isAvailable()) return;

    const jids = new Set([remoteJid]);
    if (remoteJid.endsWith('@lid')) {
        const lidNum = remoteJid.replace(/@lid$/, '');
        const phone = lidToPhone.get(lidNum);
        if (phone && /^\d{10,15}$/.test(String(phone).replace(/\D/g, ''))) {
            jids.add(`${String(phone).replace(/\D/g, '')}@s.whatsapp.net`);
        }
    }
    const hist = getCliente(remoteJid);
    if (hist?.telefono) {
        const digits = String(hist.telefono).replace(/\D/g, '');
        if (digits.length >= 10) jids.add(`${digits}@s.whatsapp.net`);
    }
    for (const jid of jids) {
        firestoreModule.reactivarBotEnChat(jid).catch(() => {});
    }
}

// Mapeo @lid → teléfono real, construido desde contactos sincronizados por Baileys
// Claves: lid numérico (sin @lid). Valores: teléfono (sin @s.whatsapp.net)
const lidToPhone = new Map();
const UMBRAL_COLA_KG = 500; // Total acumulado en cola para disparar notificación al admin
const LIMITE_INDIVIDUAL_KG = 200; // Pedidos > 200kg se entregan individual, ≤ 200kg van a cola grupal

// --- ELEVENLABS TTS ---
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || 'agent_6101kmm5scd6evw8xqbyespx4dfe';
const ELEVENLABS_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID || 'phnum_9501kmmbjr2cfyj8r9cbwnr9b7g3';
console.log(`🎙️ ElevenLabs: ${ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? '✅ configurado' : '❌ no configurado'}`);
const BASE_LOCATION = 'Villa Allende, Córdoba, Argentina';

let colaLena = [];

function idColaLenaDoc(remoteJid) {
    const tel = getTel(remoteJid);
    const d = String(tel || '').replace(/\D/g, '');
    if (d.length < 8) return null;
    return `cola_${d}`;
}

function normalizarColaItemMeta() {
    for (const p of colaLena) {
        if (!p || !p.remoteJid) continue;
        const id = idColaLenaDoc(p.remoteJid);
        if (id) p.id = id;
        p.tel = getTel(p.remoteJid) || (p.id ? String(p.id).replace(/^cola_/, '') : null);
        if (p.estado === 'en_cola') {
            delete p.ordenRuta;
            delete p.rutaGrupoId;
        }
    }
}

async function persistirColaLenaYFirestore() {
    normalizarColaItemMeta();
    saveColaLenaLocal();
    await uploadToGCS('cola_lena.json', COLA_LENA_PATH);
    if (firestoreModule.isAvailable() && colaLena.length > 0) {
        await firestoreModule.syncColaLena(colaLena);
    }
}

function loadColaLenaLocal() {
    if (fs.existsSync(COLA_LENA_PATH)) {
        try {
            colaLena = JSON.parse(fs.readFileSync(COLA_LENA_PATH, 'utf-8')) || [];
            normalizarColaItemMeta();
        } catch (e) { colaLena = []; }
    }
}

function saveColaLenaLocal() {
    try {
        fs.writeFileSync(COLA_LENA_PATH, JSON.stringify(colaLena, null, 2), 'utf-8');
    } catch (e) { console.error('❌ Error guardando cola leña:', e.message); }
}

async function saveColaLenaGCS() {
    await persistirColaLenaYFirestore();
}

async function downloadColaLenaGCS(opts = {}) {
    const quiet = !!opts.quiet;
    try {
        const archivo = storage.bucket(BUCKET_NAME).file('cola_lena.json');
        const [existe] = await archivo.exists();
        if (existe) {
            await archivo.download({ destination: COLA_LENA_PATH });
            loadColaLenaLocal();
            if (!quiet) console.log(`🪵 Cola de leña descargada (${colaLena.length} pedidos en espera).`);
        }
    } catch (e) {
        console.warn('⚠️ No se pudo descargar cola_lena.json:', e.message);
    }
}

function totalKgEnCola() {
    return colaLena.filter(p => p.estado === 'en_cola').reduce((sum, p) => sum + (p.cantidadKg || 0), 0);
}

async function calcularRutaOptima(pedidos) {
    if (!GOOGLE_MAPS_API_KEY || pedidos.length === 0) {
        // Sin API key: ordenar por zona alfabéticamente como fallback
        return [...pedidos].sort((a, b) => (a.zona || a.direccion || '').localeCompare(b.zona || b.direccion || ''));
    }
    try {
        const destinos = pedidos.map(p => encodeURIComponent(p.direccion + ', Córdoba, Argentina')).join('|');
        const origen = encodeURIComponent(BASE_LOCATION);
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origen}&destinations=${destinos}&key=${GOOGLE_MAPS_API_KEY}&language=es`;

        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status !== 'OK') {
            console.warn('⚠️ Google Maps Distance Matrix error:', data.status);
            return pedidos;
        }

        const filas = data.rows[0]?.elements || [];
        const conDistancia = pedidos.map((p, i) => ({
            ...p,
            distanciaMetros: filas[i]?.status === 'OK' ? (filas[i].distance?.value || 999999) : 999999
        }));

        return conDistancia.sort((a, b) => a.distanciaMetros - b.distanciaMetros);
    } catch (e) {
        console.error('❌ Error Google Maps:', e.message);
        return pedidos;
    }
}

async function notificarAdmin(pedidosOrdenados) {
    const sock = vickySocketRef.current;
    if (!sock) {
        console.warn('⚠️ notificarAdmin: sin socket activo');
        return;
    }
    const adminDigits = vickyRuntimeCfg.ADMIN_PHONE_DIGITS || String(ADMIN_PHONE || '').replace(/\D/g, '');
    if (adminDigits.length < 10) {
        console.warn('⚠️ Admin sin teléfono (panel adminPhone o ADMIN_PHONE): no se puede notificar ruta leña.');
        return;
    }
    const adminJid = `${adminDigits}@s.whatsapp.net`;
    const total = pedidosOrdenados.reduce((sum, p) => sum + (p.cantidadKg || 0), 0);
    const ruta = pedidosOrdenados.map((p, idx) => {
        const zonaTexto = p.zona ? ` (${p.zona})` : '';
        const tel = getTel(p.remoteJid);
        const tipoTxt = p.tipoLena ? ` — ${p.tipoLena}` : '';
        const ordenTxt = p.ordenRuta != null ? `${p.ordenRuta}. ` : `${idx + 1}. `;
        return `• ${ordenTxt}${p.nombre || 'Sin nombre'} — ${p.cantidadKg}kg${tipoTxt} — ${p.direccion}${zonaTexto} ☎ ${tel}`;
    }).join('\n');

    const ciudades = [...new Set(pedidosOrdenados.map(p => p.zona || '').filter(Boolean))];
    const rutaTexto = ciudades.length > 0 ? `\nRuta sugerida: Villa Allende → ${ciudades.join(' → ')}` : '';
    const grupoTxt = pedidosOrdenados[0]?.rutaGrupoId ? `\n*Grupo ruta:* \`${pedidosOrdenados[0].rutaGrupoId}\`` : '';

    const mensaje = `🪵 *RUTA DE LEÑA LISTA*\nTotal acumulado: ${total}kg (${pedidosOrdenados.length} clientes)${grupoTxt}\n\n*Clientes en ruta (ordenados por proximidad):*\n${ruta}${rutaTexto}\n\nLos pedidos fueron removidos de la cola. Coordiná las entregas directamente con cada cliente.`;

    try {
        const sent = await sock.sendMessage(adminJid, { text: mensaje });
        if (sent?.key?.id) BOT_MSG_IDS.add(sent.key.id);
        console.log(`📬 Notificación de ruta enviada al admin (${adminDigits.slice(0, 4)}…)`);
    } catch (e) {
        console.error('❌ Error notificando admin:', e.message);
    }
}

async function agregarAColaLena(remoteJid, nombre, direccion, zona, cantidadKg, tipoLena = null) {
    // Evitar duplicados del mismo cliente
    const tel = getTel(remoteJid);
    const existente = colaLena.findIndex(p => getTel(p.remoteJid) === tel && p.estado === 'en_cola');
    if (existente >= 0) {
        // Actualizar pedido existente
        colaLena[existente].cantidadKg = cantidadKg;
        colaLena[existente].direccion = direccion || colaLena[existente].direccion;
        colaLena[existente].zona = zona || colaLena[existente].zona;
        colaLena[existente].nombre = nombre || colaLena[existente].nombre;
        if (tipoLena) colaLena[existente].tipoLena = tipoLena;
        delete colaLena[existente].ordenRuta;
        delete colaLena[existente].rutaGrupoId;
        console.log(`🔄 Pedido cola leña actualizado para ${tel}: ${cantidadKg}kg`);
    } else {
        colaLena.push({
            remoteJid,
            nombre: nombre || null,
            direccion: direccion || 'Sin dirección',
            zona: zona || null,
            cantidadKg,
            tipoLena: tipoLena || null,
            fechaPedido: new Date().toISOString(),
            estado: 'en_cola'
        });
        console.log(`➕ Pedido agregado a cola leña: ${tel} — ${cantidadKg}kg`);
    }
    await saveColaLenaGCS();

    const totalActual = totalKgEnCola();
    console.log(`🪵 Total en cola: ${totalActual}kg / ${UMBRAL_COLA_KG}kg`);

    if (totalActual >= UMBRAL_COLA_KG) {
        console.log(`🚚 Cupo alcanzado (${totalActual}kg). Calculando ruta óptima...`);
        const pedidosPendientes = colaLena.filter(p => p.estado === 'en_cola');
        const pedidosOrdenados = await calcularRutaOptima(pedidosPendientes);
        const rutaGrupoId = `rg_${Date.now()}`;
        pedidosOrdenados.forEach((pSort, i) => {
            const t = getTel(pSort.remoteJid);
            const orig = colaLena.find(x => x.estado === 'en_cola' && getTel(x.remoteJid) === t);
            if (orig) {
                orig.ordenRuta = i + 1;
                orig.rutaGrupoId = rutaGrupoId;
            }
        });

        const paraMensajeAdmin = pedidosOrdenados.map((pSort, i) => {
            const t = getTel(pSort.remoteJid);
            const orig = colaLena.find(x => getTel(x.remoteJid) === t && x.estado === 'en_cola');
            return {
                ...pSort,
                ordenRuta: orig?.ordenRuta ?? i + 1,
                rutaGrupoId: orig?.rutaGrupoId ?? rutaGrupoId,
                tipoLena: orig?.tipoLena ?? pSort.tipoLena ?? null,
            };
        });

        pedidosPendientes.forEach(p => { p.estado = 'notificado'; });
        await saveColaLenaGCS();

        await notificarAdmin(paraMensajeAdmin);
    }
}

/**
 * Se concatena siempre después de `config/prompts.sistemaPrompt` (o fallback `SYSTEM_PROMPT`) y del bloque de precios/servicios.
 * Así las reglas de ubicación/mapas aplican aunque el panel reemplace por completo el instructivo en Firestore.
 */
const SYSTEM_PROMPT_SUFIJO_UBICACION_MARCADORES = `

═══════════════════════════════════════
UBICACIÓN / MAPA / CRM (anexo del sistema — no omitir)
═══════════════════════════════════════
Todo dato que el cliente dé para ubicar entrega u obra debe quedar en marcadores INTERNOS al final del turno (el cliente no los ve). Texto fiel a lo dicho, sin inventar.
• [DIRECCION:calle y número o dirección completa de entrega]
• [ZONA:zona o barrio general]
• [BARRIO:barrio o sector específico]
• [LOCALIDAD:ciudad o localidad (ej. Villa Allende, Río Ceballos)]
• [REFERENCIA:entre calles, color portón, lote, "frente a…"]
• [NOTAS_UBICACION:texto breve — acceso, horario en puerta, perro, etc.]
Si en un mensaje hay varios datos, emití varios marcadores. Si [ZONA:…] ya cubre el mismo concepto que barrio, no dupliques; priorizá el más específico.
Cuando corresponda [NOTIFICAR_DATOS_ENTREGA], usá también estos marcadores si el cliente aportó esos datos.
`;

// ============================================================
// MODO ADMIN — Envío de mensajes puntuales a clientes
// ============================================================
const SYSTEM_PROMPT_ADMIN = `Sos el asistente interno de Vicky, el bot de Gardens Wood.
El dueño del negocio te manda instrucciones por audio o texto para enviarle un mensaje puntual a un cliente, o para pedir información del sistema.
Tu trabajo es interpretar la instrucción y responder SIEMPRE con uno de estos marcadores exactos, sin texto adicional:

── MARCADORES DISPONIBLES ──

1. [LISTAR_CLIENTES]
   Cuando el admin pide ver la lista de clientes, quién habló, mostrar contactos, etc.
   Ejemplos: "Vicky lista", "mostrá los clientes", "quién habló último", "mostrame los contactos"

2. [ENVIAR_A:NombreONumero|mensaje para el cliente]
   Cuando el admin quiere enviar un mensaje a un cliente específico por nombre o número.
   NombreONumero puede ser:
   - Nombre: "Juan", "María García"
   - Número completo: "3512956376"
   - Últimos 4 dígitos: "*6376" (cuando dice "termina en 6376" o "finalizado en 6376")

3. [ENVIAR_A:#N|mensaje]
   Cuando el admin hace referencia a un número de la lista previa ("el 2", "el tercero", "al número 1").
   N es el número de posición en la lista. Ejemplo: "el 2, avisale que pasamos el jueves" → [ENVIAR_A:#2|Hola! Te avisamos que pasamos el jueves. Cualquier cambio avisame.]

4. [ENVIAR_A:ULTIMO|mensaje]
   Cuando el admin dice "el último que habló", "el más reciente", "el último cliente".

5. [ENVIAR_A:ULTIMO_LENA|mensaje], [ENVIAR_A:ULTIMO_CERCO|mensaje], [ENVIAR_A:ULTIMO_PERGOLA|mensaje], [ENVIAR_A:ULTIMO_FOGONERO|mensaje]
   Cuando el admin dice "el último que preguntó por leña/cerco/pérgola/fogonero".

6. [ENVIAR_A:CAMPANA_TODOS|mensaje] o [ENVIAR_A:CAMPANA_CLIENTES|mensaje]
   Aviso masivo a clientes con chat en Firestore (límite y demora como campaña). Ej: "mandá a todos los clientes que esta semana…"

7. [ENVIAR_A:CAMPANA_LENA|mensaje] o [ENVIAR_A:CAMPANA_LEÑA|mensaje], [ENVIAR_A:CAMPANA_CERCO|…], [ENVIAR_A:CAMPANA_PERGOLA|…], [ENVIAR_A:CAMPANA_FOGONERO|…]
   Igual pero solo quienes tienen servicioPendiente alineado a ese rubro.

── EJEMPLOS ──
- "Vicky lista" → [LISTAR_CLIENTES]
- "Mostrá los clientes" → [LISTAR_CLIENTES]
- "El 2, avisale que pasamos el jueves" → [ENVIAR_A:#2|Hola! Te avisamos que pasamos el jueves. Cualquier cambio avisame.]
- "El tercero, decile que ya tenemos el presupuesto" → [ENVIAR_A:#3|Hola! Ya tenemos tu presupuesto listo. ¿Querés que te lo mande?]
- "Mandá a Juan que su pedido de leña llega el martes" → [ENVIAR_A:Juan|Hola Juan! Te cuento que tu pedido de leña llega el martes. Cualquier consulta avisame.]
- "El último que habló, avisale que lo llamamos" → [ENVIAR_A:ULTIMO|Hola! Te avisamos que te vamos a llamar en breve. Cualquier duda avisame.]
- "El que preguntó por cerco, decile que ya tenemos el presupuesto" → [ENVIAR_A:ULTIMO_CERCO|Hola! Ya tenemos tu presupuesto de cerco listo. ¿Te lo mando?]
- "Mandá al que termina en 6376 que pasamos a medir el jueves" → [ENVIAR_A:*6376|Hola! Confirmamos que pasamos a medir el jueves. Cualquier cambio avisame.]
- "Mandá al 3512956376 que pasamos a medir el jueves a las 10" → [ENVIAR_A:3512956376|Hola! Confirmamos que pasamos a medir el jueves a las 10. Cualquier cambio avisame.]
- "A todos los clientes avisales que esta semana hay promo de leña" → [ENVIAR_A:CAMPANA_TODOS|Buenas tardes! Te queremos avisar que esta semana tenemos novedades en leña. Cualquier consulta escribinos.]
- "Mandá a los de leña que subió el precio del carbón" → [ENVIAR_A:CAMPANA_LENA|Hola! Te avisamos una actualización sobre carbón y leña. Si querés te pasamos detalle.]

── REGLAS ──
- Si el destinatario es un número, extraelo limpio (solo dígitos).
- Si el admin dice "termina en", "finalizado en" → usá formato *XXXX.
- El mensaje debe sonar natural, cálido, de parte de Gardens Wood.
- Si la instrucción no es clara, respondé: [ERROR:no entendí la instrucción, repetila más claro]
- Si hay múltiples destinatarios, generá un [ENVIAR_A:...] por cada uno.
- No agregues nada más fuera del/los marcadores.`;

function generarListaClientes(adminJid) {
    const ahora = Date.now();
    const MS_HORA = 60 * 60 * 1000;
    const MS_DIA = 24 * MS_HORA;

    // Filtrar: excluir el propio admin y entradas sin JID real
    const clientes = Object.entries(clientesHistorial)
        .filter(([, datos]) => datos.remoteJid && datos.remoteJid !== adminJid)
        .sort(([, a], [, b]) => {
            // Ordenar por ultimoMensaje desc; si no tiene, al final
            const ta = a.ultimoMensaje || 0;
            const tb = b.ultimoMensaje || 0;
            return tb - ta;
        });

    if (clientes.length === 0) {
        return { texto: '📋 No hay clientes en el historial todavía.', mapa: {} };
    }

    const mapa = {};
    const lineas = ['📋 *Clientes recientes:*', ''];

    clientes.slice(0, 15).forEach(([, datos], i) => {
        const n = i + 1;
        mapa[n] = datos.remoteJid;

        // Nombre: Gemini > pushName (nombre WhatsApp) > "Sin nombre"
        const nombreTexto = datos.nombre || datos.pushName || null;
        const nombre = nombreTexto ? `*${nombreTexto}*` : '_Sin nombre_';

        // Teléfono: usar el real si está disponible, o intentar resolver por lidToPhone
        const lidId = datos.remoteJid?.replace(/@.+$/, '');
        const telResuelto = datos.telefono || lidToPhone.get(lidId) || null;
        let telMostrar;
        if (telResuelto) {
            telMostrar = telResuelto.length > 8 ? `…${telResuelto.slice(-8)}` : telResuelto;
        } else {
            // @lid sin número resuelto: mostrar aviso
            telMostrar = `_(sin tel. — ID: …${lidId ? lidId.slice(-6) : '?'})_`;
        }

        // Servicio / estado
        const servicio = datos.servicioPendiente || '';
        const estado = datos.estado && datos.estado !== 'nuevo' ? datos.estado : '';
        const servicioTag = servicio ? ` | ${servicio}` : (estado ? ` | ${estado}` : '');

        // Recencia
        let recencia = 'sin actividad';
        if (datos.ultimoMensaje) {
            const diff = ahora - datos.ultimoMensaje;
            if (diff < MS_HORA) {
                recencia = `hace ${Math.round(diff / 60000)}min`;
            } else if (diff < MS_DIA) {
                recencia = `hace ${Math.round(diff / MS_HORA)}h`;
            } else if (diff < 7 * MS_DIA) {
                recencia = `hace ${Math.round(diff / MS_DIA)}d`;
            } else {
                recencia = `hace ${Math.round(diff / (7 * MS_DIA))}sem`;
            }
        }

        lineas.push(`*${n}.* ${nombre}`);
        lineas.push(`    📱 ${telMostrar}${servicioTag}`);
        lineas.push(`    🕐 ${recencia}`);
        lineas.push('');
    });

    lineas.push('_Decí "el 2", "#3", "N12", "nro 5" o "mandá al 3 que..."_');
    return { texto: lineas.join('\n'), mapa };
}

function buscarClientePorNombre(nombre) {
    const nombreLower = nombre.toLowerCase().trim();
    const camposNombre = (datos) => [datos.nombre, datos.pushName].filter(Boolean).map(n => n.toLowerCase().trim());

    // Match exacto en nombre o pushName
    const exacto = Object.entries(clientesHistorial).find(([, datos]) =>
        camposNombre(datos).some(n => n === nombreLower)
    );
    if (exacto) return exacto;
    // Match parcial
    return Object.entries(clientesHistorial).find(([, datos]) =>
        camposNombre(datos).some(n => n.includes(nombreLower) || nombreLower.includes(n.split(' ')[0]))
    );
}

// Detecta si un texto del admin es SOLO un destinatario (número, nombre, #N, N12, "último")
// y lo resuelve a { jid, etiqueta } o devuelve null si no es un destinatario simple.
async function resolverDestinatarioAdmin(texto, sesionAdmin) {
    const t = texto.trim();

    // ── Selección por número de lista: #N, el N, solo N, N12 / n 12, nro/num/número N
    let porNumero = t.match(/^(?:#|el\s+)?(\d{1,2})$/i);
    if (!porNumero) porNumero = t.match(/^n\s*(\d{1,2})$/i);
    if (!porNumero) {
        porNumero = t.match(/^(?:nro|nº|n\.|no\.|num|numero|número)\s*(\d{1,2})$/i);
    }
    if (porNumero) {
        const n = parseInt(porNumero[1], 10);
        const jid = sesionAdmin?.listaClientes?.[n];
        if (jid) {
            const datos = getCliente(jid) || {};
            const etiqueta = datos.nombre || datos.pushName || `#${n}`;
            return { jid, etiqueta };
        }
        return null;
    }

    // ── "el último" / "último"
    if (/^(el\s+)?[uú]ltimo$/i.test(t)) {
        const candidatos = Object.values(clientesHistorial)
            .filter(d => d.remoteJid && d.ultimoMensaje)
            .sort((a, b) => b.ultimoMensaje - a.ultimoMensaje);
        if (candidatos.length > 0) {
            const d = candidatos[0];
            return { jid: d.remoteJid, etiqueta: d.nombre || d.pushName || d.remoteJid };
        }
        return null;
    }

    // ── Número de teléfono (solo dígitos, guiones y espacios)
    const soloDigitos = t.replace(/[\s\-().]/g, '');
    if (/^\d{6,}$/.test(soloDigitos)) {
        let tel = soloDigitos;
        if (!tel.startsWith('54') && tel.length <= 12) tel = '54' + tel;
        try {
            const sock = vickySocketRef.current;
            if (!sock) return null;
            const [info] = await sock.onWhatsApp(tel);
            if (info?.exists) {
                const datos = getCliente(info.jid) || {};
                const etiqueta = datos.nombre || datos.pushName || soloDigitos;
                return { jid: info.jid, etiqueta };
            }
        } catch (e) {
            console.warn(`⚠️ resolverDestinatario: no se pudo verificar ${tel}:`, e.message);
        }
        return null;
    }

    // ── Últimos 4 dígitos (*XXXX o "termina en XXXX")
    const ultimos4 = t.match(/^(?:\*|termina\s+en\s+|finalizado\s+en\s+)(\d{4})$/i);
    if (ultimos4) {
        const sufijo = ultimos4[1];
        const resultado = Object.entries(clientesHistorial).find(([key, datos]) => {
            const candidatos = [key, datos.telefono || '', (datos.remoteJid || '').replace(/@.+$/, ''),
                lidToPhone.get(key) || '', lidToPhone.get((datos.remoteJid || '').replace(/@.+$/, '')) || ''];
            return candidatos.some(c => c.endsWith(sufijo));
        });
        if (resultado) {
            const [, datos] = resultado;
            return { jid: datos.remoteJid, etiqueta: datos.nombre || datos.pushName || `…${sufijo}` };
        }
        return null;
    }

    // ── Nombre (texto corto sin verbos de acción → es un nombre)
    const VERBOS_ACCION = /\b(que|decile|avisale|mandá|contale|escribile|informale|decí|avisa|manda|envía|enviá)\b/i;
    if (t.length < 40 && !VERBOS_ACCION.test(t)) {
        const resultado = buscarClientePorNombre(t);
        if (resultado) {
            const [, datos] = resultado;
            return { jid: datos.remoteJid, etiqueta: datos.nombre || datos.pushName || t };
        }
        // No encontrado por nombre → no es un destinatario reconocible
        return null;
    }

    // Texto largo o con verbos → no es un destinatario, es una instrucción completa
    return null;
}

const SERVICIOS_PEDIDO_ADMIN = new Set(['lena', 'cerco', 'pergola', 'fogonero', 'bancos', 'madera']);
const ALIAS_SERVICIO_PEDIDO_ADMIN = {
    pergolas: 'pergola',
    cercos: 'cerco',
    fogoneros: 'fogonero',
    'sector-fogonero': 'fogonero',
    leña: 'lena',
    lenia: 'lena',
};

/** Normaliza clave de servicio para `#pedido … | servicio | …` (mismo criterio que [PEDIDO:…]). */
function normalizarServicioPedidoAdmin(raw) {
    const k = String(raw || '')
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/\p{M}/gu, '');
    const base = ALIAS_SERVICIO_PEDIDO_ADMIN[k] || k;
    return SERVICIOS_PEDIDO_ADMIN.has(base) ? base : null;
}

/** Una línea numerada para *#pedido lista* / confirmación de borrado. */
function pedidoLineaParaWhatsAppAdmin(i1, p) {
    if (!p || typeof p !== 'object') return `*${i1}.* ${String(p)}`;
    const svc = String(p.servicio || '—');
    let desc = String(p.descripcion || '').replace(/\n/g, ' ').trim();
    if (desc.length > 120) desc = `${desc.slice(0, 117)}…`;
    return `*${i1}.* ${svc}: ${desc}`;
}

function resumenPedidoEliminadoWhatsApp(p) {
    if (!p || typeof p !== 'object') return String(p);
    return `${p.servicio || '—'}: ${(p.descripcion || '').slice(0, 100)}`;
}

/** Sincroniza ficha cliente a Firestore desde `clientesHistorial` (tras #pedido u operaciones admin). */
async function syncClienteFirestoreDesdeHistorialLocal(jid) {
    if (!jid || !firestoreModule.isAvailable()) return;
    const clienteSync = getCliente(jid);
    if (!clienteSync) return;
    const docId = docIdClienteFirestore(jid, clienteSync);
    const esIgDest = String(jid || '').startsWith('ig:');
    const lidDigits = String(jid).endsWith('@lid') ? String(jid).replace(/@lid$/i, '') : null;
    const payloadHist = {
            remoteJid: jid,
            telefono: telefonoLineaParaFirestore(jid, clienteSync),
            nombre: clienteSync.nombre || null,
            direccion: clienteSync.direccion || null,
            zona: clienteSync.zona || null,
            barrio: clienteSync.barrio || null,
            localidad: clienteSync.localidad || null,
            referencia: clienteSync.referencia || null,
            notasUbicacion: clienteSync.notasUbicacion || null,
            metodoPago: clienteSync.metodoPago || null,
            estado: clienteSync.estado || 'nuevo',
            servicioPendiente: clienteSync.servicioPendiente || null,
            audioIntroEnviado: clienteSync.audioIntroEnviado || false,
            handoffEnviado: clienteSync.handoffEnviado || false,
            leadStage: clienteSync.leadStage || null,
            potencial: clienteSync.potencial || null,
            statusCrm: clienteSync.statusCrm || null,
            urgencia: clienteSync.urgencia || null,
            interes: Array.isArray(clienteSync.interes) ? clienteSync.interes : [],
            origenAnuncio: clienteSync.origenAnuncio || null,
            pedidosAnteriores: clienteSync.pedidosAnteriores || [],
            canal: clienteSync.canal || (esIgDest ? 'instagram' : undefined),
            instagramUserId: clienteSync.instagramUserId
                || (esIgDest ? String(docId).replace(/^ig:/, '') : undefined),
    };
    if (lidDigits) payloadHist.whatsappLid = lidDigits;
    await firestoreModule.syncCliente(docId, payloadHist).catch(() => {});
}

function normalizarTelefonoAdmin(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('54')) d = d.slice(2);
    if (d.startsWith('9')) d = d.slice(1);
    if (d.length < 8) return '';
    if (d.length > 13) d = d.slice(0, 13);
    return d;
}

/** Normaliza variantes *# p +*, *#p +*, *#p+* para comandos cortos de pedidos. */
function normalizarComandoPAdmin(t) {
    let x = String(t || '').trim();
    x = x.replace(/\*/g, '');
    x = x.replace(/^#\s*p/i, '#p');
    // "#plidmap …" (pegado por error o por el viejo bucle # + espacio + p)
    x = x.replace(/^#plidmap(?=\s|\d)/i, '#p lidmap ');
    x = x.replace(/^#p\s+\+/, '#p+');
    x = x.replace(/^#p\s+\-/, '#p-');
    return x;
}

function lineaPedidoGlobalAdmin(i1, row) {
    const p = row.pedido;
    const svc = (p && p.servicio) ? String(p.servicio) : '—';
    let desc = String(p?.descripcion || '').replace(/\n/g, ' ').trim();
    if (desc.length > 90) desc = `${desc.slice(0, 87)}…`;
    let telDisp = String(row.telefonoDisplay != null && row.telefonoDisplay !== '' ? row.telefonoDisplay : row.tel || '').trim();
    if ((!telDisp || telDisp === '—') && row.tel) {
        telDisp = String(row.tel);
        if (!telDisp.startsWith('ig:')) telDisp = telDisp.replace(/\D/g, '');
    }
    const nom = row.nombre ? ` · ${row.nombre}` : '';
    return `*${i1}.* ${telDisp}${nom} · ${svc}: ${desc}`;
}

/** Interpreta hilo Firestore (texto cliente/Vicky) → pedido con Gemini. */
async function extraerPedidoDesdeHiloAdmin(items) {
    if (!items?.length) return { ok: false, reason: 'empty' };
    if (!process.env.GEMINI_API_KEY) return { ok: false, reason: 'no_gemini' };
    const lines = items.map((r) => {
        const quien = r.direccion === 'saliente' ? 'Vicky' : 'Cliente';
        return `${quien}: ${r.contenido}`;
    }).join('\n');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = 'Sos asistente operativo. Hilo WhatsApp entre Vicky (bot Gardens Wood) y un cliente (leña, cercos, pérgolas, fogonero, madera). '
        + 'Inferí el pedido que el cliente quiere cerrar: cantidades, tipo de producto/servicio, dirección o zona si aparecen. '
        + 'Respondé SOLO JSON válido (sin markdown), formato: '
        + '{"servicio":"lena"|"cerco"|"pergola"|"fogonero"|"bancos"|"madera"|null,'
        + '"descripcion":"resumen breve en español (qué pide, kg/metros/etc.)","direccion":string o null,"zona":string o null}. '
        + 'Si no hay pedido claro: servicio null y descripcion una frase explicando qué falta.';
    const result = await model.generateContent([{ text: prompt }, { text: `Hilo:\n${lines}` }]);
    const txt = result.response.text().trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: 'parse', raw: txt.slice(0, 200) };
    let json;
    try {
        json = JSON.parse(m[0]);
    } catch (_) {
        return { ok: false, reason: 'json', raw: txt.slice(0, 200) };
    }
    return { ok: true, data: json };
}

/**
 * Admin #entrega + solo teléfono: infiere fecha/hora/título para `entregas_agenda` desde CRM + hilo Firestore.
 */
async function extraerEntregaAgendaDesdeContextoAdmin({ items, crmResumen, fechaHoyArg, notaDueño }) {
    if (!process.env.GEMINI_API_KEY) return { ok: false, reason: 'no_gemini' };
    const lines = items?.length
        ? items.map((r) => {
            const quien = r.direccion === 'saliente' ? 'Vicky' : 'Cliente';
            return `${quien}: ${r.contenido}`;
        }).join('\n')
        : '(No hay mensajes guardados en Firestore para este chat; usá solo CRM y la nota del dueño si hay.)';
    const hoy = fechaHoyArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const nota = notaDueño ? `\nIndicación extra del dueño: ${String(notaDueño).trim().slice(0, 500)}\n` : '';
    const prompt =
        'Sos asistente operativo de Gardens Wood (Córdoba, Argentina). '
        + `La fecha de hoy de referencia es ${hoy} (usala para resolver "mañana", "pasado", "el viernes", etc.).\n`
        + 'Tenés un resumen CRM y el hilo reciente de WhatsApp (Vicky y cliente). '
        + 'Debés inferir si hay una ENTREGA u OBRA con día concreto acordado o muy explícito.\n'
        + 'Si hay fecha clara (un día específico), respondé SOLO JSON válido (sin markdown), una sola línea:\n'
        + '{"fechaDia":"YYYY-MM-DD","horaTexto":"HH:mm" o null si es todo el día o no hay hora,"titulo":"texto corto (producto, kg, nombre si aplica)"}\n'
        + 'Si NO alcanza una fecha concreta, respondé SOLO JSON:\n'
        + '{"fechaDia":null,"horaTexto":null,"titulo":null,"motivo":"una frase en español para el dueño"}\n'
        + `${nota}CRM:\n${crmResumen}\n\nHilo:\n${lines}`;
    const result = await model.generateContent([{ text: prompt }]);
    const txt = result.response.text().trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: 'parse', raw: txt.slice(0, 200) };
    let json;
    try {
        json = JSON.parse(m[0]);
    } catch (_) {
        return { ok: false, reason: 'json', raw: txt.slice(0, 200) };
    }
    return { ok: true, data: json };
}

/** Transcripción literal para flujo admin #g (audio → vista previa → OK). */
async function transcribirAudioInstructivoGemini(audioBase64, mimeType = 'audio/ogg') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent([
        { inlineData: { data: audioBase64, mimeType } },
        { text: 'Transcribí literalmente lo que dice el audio, en español. Devolvé solo el texto transcrito, sin comentarios ni saludo.' }
    ]);
    return result.response.text().trim();
}

// Recibe el contenido (audio base64 o texto plano) y lo redacta como mensaje de Gardens Wood.
// NO interpreta destinatario — solo produce el texto del mensaje.
async function redactarMensajeAdmin(audioBase64, textoContenido) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const PROMPT_REDACCION = `Sos el asistente de redacción de Vicky, el bot de Gardens Wood.
El dueño del negocio te manda una instrucción en audio o texto con lo que quiere decirle a un cliente.
Tu trabajo es redactar el mensaje de forma natural, cálida y directa, como si lo escribiera Vicky.
Devolvé SOLO el texto del mensaje, sin explicaciones ni marcadores.
El mensaje debe ser conciso, amigable y en español rioplatense.`;

    let partes;
    if (audioBase64) {
        partes = [
            { inlineData: { data: audioBase64, mimeType: 'audio/ogg' } },
            { text: 'Transcribí el audio y redactá el mensaje para el cliente.' }
        ];
    } else {
        partes = [{ text: `Redactá este mensaje para el cliente: "${textoContenido}"` }];
    }

    const result = await model.generateContent({
        systemInstruction: PROMPT_REDACCION,
        contents: [{ role: 'user', parts: partes }]
    });
    return result.response.text().trim();
}

async function procesarComandoAdmin(adminJid, audioBase64, textoAdmin) {
    const socket = vickySocketRef.current;
    if (!socket) {
        console.warn('⚠️ procesarComandoAdmin: sin socket activo');
        return;
    }
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    try {
        let partes;
        if (audioBase64) {
            partes = [
                { inlineData: { data: audioBase64, mimeType: 'audio/ogg' } },
                { text: 'Transcribí el audio y ejecutá la instrucción según el formato indicado.' }
            ];
        } else {
            partes = [{ text: textoAdmin }];
        }

        const result = await model.generateContent({
            systemInstruction: SYSTEM_PROMPT_ADMIN,
            contents: [{ role: 'user', parts: partes }]
        });

        const respuesta = result.response.text().trim();
        console.log(`🔑 Comando admin interpretado: ${respuesta}`);

        // Helper local: envía y registra el ID para que no se interprete como mensaje humano
        const responder = async (jid, content) => {
            const sent = await socket.sendMessage(jid, content);
            if (sent?.key?.id) BOT_MSG_IDS.add(sent.key.id);
            return sent;
        };

        // Manejar error de interpretación
        const errorMatch = respuesta.match(/\[ERROR:([^\]]+)\]/i);
        if (errorMatch) {
            await responder(adminJid, { text: `⚠️ ${errorMatch[1]}` });
            return;
        }

        // ── [LISTAR_CLIENTES] ──
        if (/\[LISTAR_CLIENTES\]/i.test(respuesta)) {
            const { texto, mapa } = generarListaClientes(adminJid);
            const sesion = adminSesionesActivas.get(adminJid) || { activadoEn: Date.now(), listaClientes: {} };
            sesion.listaClientes = mapa;
            adminSesionesActivas.set(adminJid, sesion);
            await responder(adminJid, { text: texto });
            return;
        }

        // Helper: enviar a un JID concreto y confirmar al admin
        const enviarYConfirmar = async (jidDestino, mensajeCliente, etiqueta) => {
            await responder(jidDestino, { text: mensajeCliente });
            console.log(`📤 Mensaje admin enviado a ${etiqueta} → ${jidDestino}`);
            await responder(adminJid, {
                text: `✅ Mensaje enviado a *${etiqueta}*:\n\n_"${mensajeCliente}"_`
            });
        };

        // Procesar cada [ENVIAR_A:destinatario|mensaje]
        const regex = /\[ENVIAR_A:([^|]+)\|([^\]]+)\]/gi;
        let match;
        let alguno = false;

        while ((match = regex.exec(respuesta)) !== null) {
            alguno = true;
            const destinatario = match[1].trim();
            const mensajeCliente = match[2].trim();

            const mCamp = destinatario.match(/^CAMPANA_(TODOS|CLIENTES|ALL|LENA|LEÑA|CERCO|PERGOLA|PÉRGOLA|FOGONERO)$/i);
            if (mCamp) {
                const kind = mCamp[1].toUpperCase().normalize('NFD').replace(/\u0300/g, '');
                let seg = 'clientes';
                if (kind === 'TODOS' || kind === 'CLIENTES' || kind === 'ALL') seg = 'clientes';
                else if (kind === 'LENA' || kind === 'LEÑA') seg = 'leña';
                else if (kind === 'CERCO') seg = 'cerco';
                else if (kind === 'PERGOLA') seg = 'pergola';
                else if (kind === 'FOGONERO') seg = 'fogonero';
                await ejecutarBroadcastMasivo(adminJid, seg, mensajeCliente);
                continue;
            }

            // ── Caso: selección por número de lista (#N) ──
            const porNumero = destinatario.match(/^#(\d+)$/);
            if (porNumero) {
                const n = parseInt(porNumero[1], 10);
                const sesion = adminSesionesActivas.get(adminJid);
                const jidDestino = sesion?.listaClientes?.[n];
                if (!jidDestino) {
                    await responder(adminJid, {
                        text: `❌ No encontré el cliente #${n}. Pedí la lista primero con *"Vicky lista"*.`
                    });
                } else {
                    const datosCliente = getCliente(jidDestino) || {};
                    const etiqueta = datosCliente.nombre || `#${n}`;
                    await enviarYConfirmar(jidDestino, mensajeCliente, etiqueta);
                }
                continue;
            }

            // ── Caso: ULTIMO (el que habló más recientemente) ──
            const ultimoMatch = destinatario.match(/^ULTIMO(?:_(\w+))?$/i);
            if (ultimoMatch) {
                const servicioFiltro = ultimoMatch[1]?.toLowerCase() || null;
                const candidatos = Object.values(clientesHistorial)
                    .filter(d => d.remoteJid && d.remoteJid !== adminJid && d.ultimoMensaje)
                    .filter(d => {
                        if (!servicioFiltro) return true;
                        const sp = (d.servicioPendiente || '').toLowerCase();
                        return sp.includes(servicioFiltro) || servicioFiltro.includes(sp.split(' ')[0]);
                    })
                    .sort((a, b) => b.ultimoMensaje - a.ultimoMensaje);
                if (candidatos.length === 0) {
                    const tag = servicioFiltro ? ` con servicio *${servicioFiltro}*` : '';
                    await responder(adminJid, {
                        text: `❌ No encontré ningún cliente${tag} con historial reciente.`
                    });
                } else {
                    const d = candidatos[0];
                    await enviarYConfirmar(d.remoteJid, mensajeCliente, d.nombre || d.remoteJid);
                }
                continue;
            }

            // ── Caso 1: últimos 4 dígitos (*XXXX) ──
            const esUltimos4 = destinatario.startsWith('*') && /^\*\d{4}$/.test(destinatario);
            // ── Caso 2: número completo (8+ dígitos) ──
            const soloDigitos = destinatario.replace(/\D/g, '');
            const esNumeroCompleto = !esUltimos4 && soloDigitos.length >= 8;

            if (esUltimos4) {
                const sufijo = destinatario.slice(1);
                const resultado = Object.entries(clientesHistorial).find(([key, datos]) => {
                    const candidatos = [
                        key,
                        datos.telefono || '',
                        (datos.remoteJid || '').replace(/@.+$/, ''),
                        // También buscar en el teléfono real resuelto para @lid
                        lidToPhone.get(key) || '',
                        lidToPhone.get((datos.remoteJid || '').replace(/@.+$/, '')) || ''
                    ];
                    return candidatos.some(c => c.endsWith(sufijo));
                });
                if (resultado) {
                    const [, datosCliente] = resultado;
                    const nombreReal = datosCliente.nombre || `...${sufijo}`;
                    await enviarYConfirmar(datosCliente.remoteJid, mensajeCliente, `${nombreReal} (…${sufijo})`);
                } else {
                    // Fallback: pedir número completo + mostrar lista como alternativa
                    const { texto, mapa } = generarListaClientes(adminJid);
                    const sesion = adminSesionesActivas.get(adminJid) || { activadoEn: Date.now(), listaClientes: {} };
                    sesion.listaClientes = mapa;
                    adminSesionesActivas.set(adminJid, sesion);
                    await responder(adminJid, {
                        text: `❌ No encontré a nadie con número terminado en *${sufijo}*.\n\n` +
                              `💡 *Si tenés el número completo*, decime:\n` +
                              `_"mandá al 3512xx${sufijo} que..."_\n` +
                              `(con el número completo funciona siempre, aunque no esté en el historial)\n\n` +
                              `📋 *O elegí de la lista:*\n${texto}`
                    });
                }
            } else if (esNumeroCompleto) {
                let tel = soloDigitos;
                if (!tel.startsWith('54') && tel.length <= 12) tel = '54' + tel;
                let jidCliente = null;
                try {
                    const [info] = await socket.onWhatsApp(tel);
                    if (info?.exists) jidCliente = info.jid;
                } catch (e) {
                    console.warn(`⚠️ No se pudo verificar número ${tel}:`, e.message);
                }
                if (!jidCliente) {
                    await responder(adminJid, {
                        text: `❌ El número *${soloDigitos}* no está registrado en WhatsApp o no se pudo verificar.`
                    });
                } else {
                    await enviarYConfirmar(jidCliente, mensajeCliente, soloDigitos);
                }
            } else {
                // ── Buscar por nombre ──
                const resultado = buscarClientePorNombre(destinatario);
                if (resultado) {
                    const [, datosCliente] = resultado;
                    const nombreReal = datosCliente.nombre || destinatario;
                    await enviarYConfirmar(datosCliente.remoteJid, mensajeCliente, nombreReal);
                } else {
                    console.warn(`⚠️ Cliente "${destinatario}" no encontrado en historial`);
                    const { texto: textoLista, mapa: mapaLista } = generarListaClientes(adminJid);
                    const sesionFallback = adminSesionesActivas.get(adminJid) || { activadoEn: Date.now(), listaClientes: {} };
                    sesionFallback.listaClientes = mapaLista;
                    adminSesionesActivas.set(adminJid, sesionFallback);
                    await responder(adminJid, {
                        text: `❌ No encontré a *${destinatario}* en el historial.\n\n` +
                              `💡 *Si tenés el número completo*, decime:\n` +
                              `_"mandá al 3512XXXXXX que..."_\n` +
                              `(el número completo funciona siempre)\n\n` +
                              `📋 *O elegí de la lista:*\n${textoLista}`
                    });
                }
            }
        }

        if (!alguno) {
            await responder(adminJid, { text: '⚠️ No pude interpretar la instrucción. Repetila más claro.' });
        }

    } catch (err) {
        console.error('❌ Error en modo admin:', err.message);
        try { await socket.sendMessage(adminJid, { text: `❌ Error: ${err.message}` }); } catch (_) {}
    }
}

// ============================================================
// GENERADOR DE PRESUPUESTO PDF
// ============================================================
async function generarPresupuestoCercoPDF({ cliente, metros, precioUnit, alturaM, descuentoPct = 0 }) {
    try {
        const chromium = require('@sparticuz/chromium');
        const puppeteer = require('puppeteer-core');

        const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
        const subtotalBruto = metros * precioUnit;
        const descuentoMonto = descuentoPct > 0 ? Math.round(subtotalBruto * descuentoPct / 100) : 0;
        const subtotal = subtotalBruto - descuentoMonto;
        const ivaTexto = 'BONIFICADO';
        const total = subtotal;
        const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const descripcion = `Cerco de eucalipto impregnado - Altura ${alturaM} m`;

        const filaDescuento = descuentoPct > 0 ? `
            <tr class="descuento">
              <td><div class="item-desc"><h4>Descuento por volumen (${descuentoPct}%)</h4><p>Aplicado sobre ${fmt(subtotalBruto)}</p></div></td>
              <td>1 u</td>
              <td>${fmt(-descuentoMonto)}</td>
              <td>${fmt(-descuentoMonto)}</td>
            </tr>` : '';

        // Imágenes como base64
        const toBase64 = (filePath) => {
            if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath).slice(1).replace('jpg', 'jpeg');
                return `data:image/${ext};base64,` + fs.readFileSync(filePath).toString('base64');
            }
            return '';
        };

        // Cargar imágenes dinámicamente desde images/Cercos/ — si cambiás las fotos, el PDF se actualiza solo
        const cercosDir = path.join(__dirname, 'images', 'Cercos');
        const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
        const cercosImgs = fs.existsSync(cercosDir)
            ? fs.readdirSync(cercosDir)
                .filter(f => imgExts.includes(path.extname(f).toLowerCase()))
                .map(f => path.join(cercosDir, f))
            : [];

        const getImg = (idx) => cercosImgs.length > 0
            ? toBase64(cercosImgs[idx % cercosImgs.length])
            : '';

        const imgCerco   = getImg(0);   // miniatura en tabla
        const imgPaso1   = getImg(0);   // foto paso 1 — cimentación
        const imgPaso2   = getImg(1);   // foto paso 2 — refuerzo (segunda foto si existe)
        const imgEstiloA = getImg(0);   // estilo irregular
        const imgEstiloB = getImg(Math.min(1, cercosImgs.length - 1)); // estilo lineal

        let html = fs.readFileSync(path.join(__dirname, 'presupuesto-template.html'), 'utf8');
        html = html
            .replace('{{FECHA}}', fecha)
            .replace('{{CLIENTE}}', cliente)
            .replace('{{DESCRIPCION}}', descripcion)
            .replace(/{{METROS}}/g, metros)
            .replace('{{PRECIO_UNIT_FMT}}', fmt(precioUnit))
            .replace(/{{SUBTOTAL_FMT}}/g, fmt(subtotal))
            .replace('{{FILA_DESCUENTO}}', filaDescuento)
            .replace('{{IVA_TEXTO}}', ivaTexto)
            .replace('{{TOTAL_FMT}}', fmt(total))
            .replace('{{IMG_CERCO}}', imgCerco)
            .replace('{{IMG_PASO1}}', imgPaso1)
            .replace('{{IMG_PASO2}}', imgPaso2)
            .replace('{{IMG_ESTILO_A}}', imgEstiloA)
            .replace('{{IMG_ESTILO_B}}', imgEstiloB);

        const execPath = await chromium.executablePath();
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
            ],
            defaultViewport: { width: 794, height: 1123 },
            executablePath: execPath,
            headless: true,
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 800));
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        const tmpPath = path.join(os.tmpdir(), `presupuesto-cerco-${Date.now()}.pdf`);
        fs.writeFileSync(tmpPath, pdfBuffer);
        console.log(`📄 Presupuesto PDF generado: ${tmpPath}`);
        return tmpPath;
    } catch (err) {
        console.error('❌ Error generando PDF:', err.message);
        return null;
    }
}

// ============================================================
// ELEVENLABS TTS — generar y enviar audio de voz
// ============================================================
function normalizarTextoParaAudio(texto) {
    return texto
        // Paso 1: quitar puntos separadores de miles en números grandes
        // Ej: 1.597.500 → 1597500 | 140.000 → 140000 | 2.100.000 → 2100000
        // NO toca decimales como 1.8 o 2.5 (solo 1 dígito tras el punto = decimal)
        .replace(/(\d{1,3}(?:\.\d{3})+)/g, m => m.replace(/\./g, ''))
        // Paso 1b: convertir saltos de línea en pausas naturales (coma o punto)
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ', ')
        // Precios por unidad — ANTES de convertir $ genérico (orden importa)
        .replace(/\$\s*([\d.,]+)\s*\/\s*m²/gi, '$1 pesos por metro cuadrado')
        .replace(/\$\s*([\d.,]+)\s*\/\s*m2\b/gi, '$1 pesos por metro cuadrado')
        .replace(/\$\s*([\d.,]+)\s*\/\s*ml\b/gi, '$1 pesos por metro lineal')
        .replace(/\$\s*([\d.,]+)\s*\/\s*m\b/gi, '$1 pesos por metro')
        .replace(/\$\s*([\d.,]+)\s*\/\s*kg\b/gi, '$1 pesos por kilogramo')
        .replace(/\$\s*([\d.,]+)\s*\/\s*u\b/gi, '$1 pesos por unidad')
        // Multiplicación solo entre números (ej. 2 x 3, 28×1,8). NO usar \s*x\s* suelto: rompe
        // "excelente", "exterior", "próximo", etc. (ElevenLabs leía "e por celente").
        .replace(/(\d[\d.,]*)\s*[×xX]\s*(\d[\d.,]*)/g, '$1 por $2')
        .replace(/\s*=\s*/g, ' igual a ')              // = → "igual a"
        .replace(/\s*\/\s*/g, ' dividido ')            // / suelto → "dividido"
        // Medidas con número adelante
        .replace(/(\d[\d.,]*)\s*kg\b/gi, '$1 kilogramos')
        .replace(/(\d[\d.,]*)\s*tn\b/gi, '$1 toneladas')
        .replace(/(\d[\d.,]*)\s*ton\b/gi, '$1 toneladas')
        .replace(/(\d[\d.,]*)\s*m²/gi, '$1 metros cuadrados')
        .replace(/(\d[\d.,]*)\s*m2\b/gi, '$1 metros cuadrados')
        .replace(/(\d[\d.,]*)\s*m³/gi, '$1 metros cúbicos')
        .replace(/(\d[\d.,]*)\s*m3\b/gi, '$1 metros cúbicos')
        .replace(/(\d[\d.,]*)\s*ml\b/gi, '$1 metros lineales')
        .replace(/(\d[\d.,]*)\s*mts?\b/gi, '$1 metros')
        .replace(/(\d[\d.,]*)\s*cm\b/gi, '$1 centímetros')
        .replace(/(\d[\d.,]*)\s*mm\b/gi, '$1 milímetros')
        .replace(/(\d[\d.,]*)\s*km\b/gi, '$1 kilómetros')
        .replace(/(\d[\d.,]*)\s*hs\b/gi, '$1 horas')
        .replace(/(\d[\d.,]*)\s*hrs?\b/gi, '$1 horas')
        // Precios — quitar $ y decir "pesos"
        .replace(/\$\s*([\d.,]+)/g, '$1 pesos')
        // Porcentaje
        .replace(/(\d[\d.,]*)\s*%/g, '$1 por ciento')
        // Abreviaciones sueltas (sin número)
        .replace(/\bkg\b/gi, 'kilogramos')
        .replace(/\bmt\b/gi, 'metros')
        .replace(/\bmts\b/gi, 'metros')
        .replace(/\bhs\b/gi, 'horas')
        .replace(/\betc\.\b/gi, 'etcétera')
        .replace(/\bL-V\b/g, 'lunes a viernes')
        .replace(/\bSáb\b/gi, 'sábado')
        // Símbolos de markdown que suenan raro al leerlos
        .replace(/^\s*[•\-\*]\s*/gm, '')          // bullets al inicio de línea
        .replace(/\*\*(.*?)\*\*/g, '$1')           // **negrita** → texto
        .replace(/\*(.*?)\*/g, '$1')               // *cursiva* → texto
        .replace(/_{1,2}(.*?)_{1,2}/g, '$1')       // _subrayado_ → texto
        .replace(/#+\s*/g, '')                     // # títulos → sin símbolo
        .replace(/`{1,3}[^`]*`{1,3}/g, '')        // `código` → vacío
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [texto](url) → texto
        .replace(/={3,}/g, '')                     // === separadores
        .replace(/\n{3,}/g, '\n\n')               // múltiples saltos → dos
        // Emojis y símbolos que no suenan bien
        .replace(/[😊😄🙏✅❌⚠️📦🎙️💬🖼️🎤🌿🪵]/g, '')
        .trim();
}

async function generarAudioElevenLabs(texto) {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;
    try {
        // Limpiar marcadores del texto antes de convertir a audio
        const textoLimpio = normalizarTextoParaAudio(
            texto
                .replace(/\[IMG:[^\]]+\]/gi, '')
                .replace(/\[COTIZACION:[^\]]+\]/gi, '')
                .replace(/\[CONFIRMADO\]/gi, '')
                .replace(/\[NOMBRE:[^\]]+\]/gi, '')
                .replace(/\[DIRECCION:[^\]]+\]/gi, '')
                .replace(/\[ZONA:[^\]]+\]/gi, '')
        .replace(/\[BARRIO:[^\]]+\]/gi, '')
        .replace(/\[LOCALIDAD:[^\]]+\]/gi, '')
        .replace(/\[REFERENCIA:[^\]]+\]/gi, '')
        .replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '')
                .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
        ).trim();

        if (!textoLimpio) return null;

        const body = JSON.stringify({
            text: textoLimpio,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.35,
                similarity_boost: 0.75,
                style: 0.45,
                use_speaker_boost: true
            }
        });

        const resp = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body
            }
        );

        if (!resp.ok) {
            const err = await resp.text();
            console.error('❌ ElevenLabs error:', err);
            return null;
        }

        const arrayBuffer = await resp.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error('❌ Error generando audio ElevenLabs:', e.message);
        return null;
    }
}

async function enviarAudioElevenLabs(sendBotMessage, jid, texto) {
    const audioBuffer = await generarAudioElevenLabs(texto);
    if (!audioBuffer) return false;
    try {
        await sendBotMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false
        });
        console.log(`🎙️ Audio ElevenLabs enviado a ${jid}`);
        return true;
    } catch (e) {
        console.error('❌ Error enviando audio ElevenLabs:', e.message);
        return false;
    }
}

function getTel(remoteJid) {
    if (!remoteJid) return '';
    const s = String(remoteJid);
    if (s.startsWith('ig:')) return s;
    return s.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
}

function soloDigitosTel(s) {
    return String(s || '').replace(/\D/g, '');
}

/** Dígitos del otro participante del chat 1:1 (para comparar con adminPhone). */
function digitosRemitenteChat(remoteJid) {
    if (!remoteJid) return '';
    if (remoteJid.endsWith('@s.whatsapp.net')) {
        return soloDigitosTel(getTel(remoteJid));
    }
    if (remoteJid.endsWith('@lid')) {
        const lidNum = remoteJid.replace(/@lid$/, '');
        const mapped = lidToPhone.get(lidNum);
        if (mapped) return soloDigitosTel(mapped);
        const porHist = getCliente(remoteJid);
        if (porHist?.telefono) return soloDigitosTel(porHist.telefono);
        const found = Object.values(clientesHistorial).find((d) => d.remoteJid === remoteJid);
        if (found?.telefono) return soloDigitosTel(found.telefono);
        return '';
    }
    return '';
}

function telefonosMismoDueno(a, b) {
    const da = soloDigitosTel(a);
    const db = soloDigitosTel(b);
    if (da.length < 8 || db.length < 8) return false;
    if (da === db) return true;
    const tailA = da.slice(-10);
    const tailB = db.slice(-10);
    if (tailA.length === 10 && tailB.length === 10 && tailA === tailB) return true;
    return da.endsWith(db) || db.endsWith(da);
}

/** Últimos 8 dígitos (número móvil AR sin prefijos raros). */
function ultimos8Digitos(d) {
    const x = soloDigitosTel(d);
    return x.length >= 8 ? x.slice(-8) : '';
}

/** Spec: reconocer número admin — panel `adminPhone` o ADMIN_PHONE (.env / Cloud Run). */
function remitenteEsTelefonoAdminConfigurado(remoteJid) {
    const adm = soloDigitosTel(vickyRuntimeCfg.ADMIN_PHONE_DIGITS || ADMIN_PHONE || '');
    if (adm.length < 8) return false;
    const cand = digitosRemitenteChat(remoteJid);
    if (cand.length < 8) return false;
    if (telefonosMismoDueno(adm, cand)) return true;
    const u8a = ultimos8Digitos(adm);
    const u8c = ultimos8Digitos(cand);
    return u8a.length === 8 && u8c.length === 8 && u8a === u8c;
}

function getCliente(telefono) {
    return clientesHistorial[getTel(telefono)] || null;
}

/** Dígitos de línea para Firestore (reportes/admin). @s: userId WA; @lid: historial o mapeo contactos. */
function telefonoLineaParaFirestore(remoteJid, cliente) {
    if (!remoteJid) return null;
    if (String(remoteJid).startsWith('ig:')) return null;
    if (remoteJid.endsWith('@s.whatsapp.net')) {
        const d = soloDigitosTel(getTel(remoteJid));
        return d.length >= 8 ? d : null;
    }
    if (remoteJid.endsWith('@lid')) {
        const t = cliente?.telefono ? soloDigitosTel(cliente.telefono) : '';
        if (t.length >= 8) return t;
        const lidNum = remoteJid.replace(/@lid$/, '');
        const mapped = lidToPhone.get(lidNum);
        if (mapped) {
            const d = soloDigitosTel(mapped);
            if (d.length >= 8) return d;
        }
        return null;
    }
    const d = soloDigitosTel(getTel(remoteJid));
    return d.length >= 8 ? d : null;
}

/** Id de documento Firestore `clientes/{id}`: línea real si se conoce; si no, clave de historial (LID / ig:). */
function docIdClienteFirestore(remoteJid, cliente) {
    if (!remoteJid) return '';
    const rj = String(remoteJid);
    if (rj.startsWith('ig:')) return getTel(remoteJid);
    const cli = cliente !== undefined && cliente !== null ? cliente : getCliente(remoteJid);
    const linea = telefonoLineaParaFirestore(remoteJid, cli);
    const d = soloDigitosTel(linea);
    if (d.length >= 8) return d;
    return getTel(remoteJid);
}

function asegurarCliente(remoteJid) {
    const tel = getTel(remoteJid);
    const esIg = String(remoteJid || '').startsWith('ig:');
    if (!clientesHistorial[tel]) {
        clientesHistorial[tel] = {
            audioIntroEnviado: false,
            nombre: null,
            remoteJid,
            // Guardar teléfono legible si es @s.whatsapp.net, sino el ID @lid limpio
            telefono: remoteJid.includes('@s.whatsapp.net') ? tel : null,
            canal: esIg ? 'instagram' : undefined,
            instagramUserId: esIg ? tel.replace(/^ig:/, '') : undefined,
            estado: 'nuevo',
            servicioPendiente: null,
            textoCotizacion: null,
            fechaCotizacion: null,
            seguimientoEnviado: false,
            handoffEnviado: false,
            leadStage: null, // 'curioso' | 'interesado' | null
            potencial: null,
            statusCrm: null,
            urgencia: null,
            interes: [],
            direccion: null,
            zona: null,
            metodoPago: null,
            pedidosAnteriores: [],
            historial: []
        };
    } else {
        // Asegurar que tenga los campos nuevos si era un registro viejo
        if (!clientesHistorial[tel].remoteJid) clientesHistorial[tel].remoteJid = remoteJid;
        if (!clientesHistorial[tel].estado) clientesHistorial[tel].estado = 'nuevo';
        if (clientesHistorial[tel].seguimientoEnviado === undefined) clientesHistorial[tel].seguimientoEnviado = false;
        if (clientesHistorial[tel].handoffEnviado === undefined) clientesHistorial[tel].handoffEnviado = false;
        if (clientesHistorial[tel].leadStage === undefined) clientesHistorial[tel].leadStage = null;
        if (clientesHistorial[tel].direccion === undefined) clientesHistorial[tel].direccion = null;
        if (clientesHistorial[tel].zona === undefined) clientesHistorial[tel].zona = null;
        if (clientesHistorial[tel].barrio === undefined) clientesHistorial[tel].barrio = null;
        if (clientesHistorial[tel].localidad === undefined) clientesHistorial[tel].localidad = null;
        if (clientesHistorial[tel].referencia === undefined) clientesHistorial[tel].referencia = null;
        if (clientesHistorial[tel].notasUbicacion === undefined) clientesHistorial[tel].notasUbicacion = null;
        if (clientesHistorial[tel].metodoPago === undefined) clientesHistorial[tel].metodoPago = null;
        if (!clientesHistorial[tel].pedidosAnteriores) clientesHistorial[tel].pedidosAnteriores = [];
        if (clientesHistorial[tel].potencial === undefined) clientesHistorial[tel].potencial = null;
        if (clientesHistorial[tel].statusCrm === undefined) clientesHistorial[tel].statusCrm = null;
        if (clientesHistorial[tel].urgencia === undefined) clientesHistorial[tel].urgencia = null;
        if (clientesHistorial[tel].interes === undefined) clientesHistorial[tel].interes = [];
        if (esIg && clientesHistorial[tel].canal === undefined) clientesHistorial[tel].canal = 'instagram';
        if (esIg && !clientesHistorial[tel].instagramUserId) {
            clientesHistorial[tel].instagramUserId = tel.replace(/^ig:/, '');
        }
    }
    return clientesHistorial[tel];
}

function marcarAudioEnviado(remoteJid) {
    const cliente = asegurarCliente(remoteJid);
    cliente.audioIntroEnviado = true;
    saveHistorialGCS().catch(() => {});
}

function actualizarEstadoCliente(remoteJid, datos) {
    const cliente = asegurarCliente(remoteJid);
    if (!datos || typeof datos !== 'object') return;

    // Merge flexible: permite nuevos campos sin tocar este código cada vez
    for (const [k, v] of Object.entries(datos)) {
        if (v === undefined) continue;
        if (k === 'pedido' && v) {
            if (!cliente.pedidosAnteriores) cliente.pedidosAnteriores = [];
            cliente.pedidosAnteriores.push(v);
            continue;
        }
        cliente[k] = v;
    }

    saveHistorialGCS().catch(() => {});
}

// Construye el contexto previo para inyectar en Gemini cuando el cliente vuelve
function construirContextoPrevio(histCliente) {
    if (!histCliente || histCliente.estado === 'nuevo') return null;
    const ahora = Date.now();

    // Armar bloque de datos conocidos del cliente
    const datosConocidos = [];
    if (histCliente.nombre) datosConocidos.push(`- Nombre: ${histCliente.nombre}`);
    if (histCliente.direccion) datosConocidos.push(`- Dirección: ${histCliente.direccion}`);
    if (histCliente.barrio) datosConocidos.push(`- Barrio: ${histCliente.barrio}`);
    if (histCliente.localidad) datosConocidos.push(`- Localidad: ${histCliente.localidad}`);
    if (histCliente.zona) datosConocidos.push(`- Zona: ${histCliente.zona}`);
    if (histCliente.referencia) datosConocidos.push(`- Referencia para ubicar: ${histCliente.referencia}`);
    if (histCliente.notasUbicacion) datosConocidos.push(`- Notas de ubicación: ${histCliente.notasUbicacion}`);
    if (histCliente.metodoPago) datosConocidos.push(`- Método de pago preferido: ${histCliente.metodoPago}`);

    // Historial de pedidos anteriores
    const pedidosPrevios = histCliente.pedidosAnteriores && histCliente.pedidosAnteriores.length > 0
        ? histCliente.pedidosAnteriores.map(p => {
            const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString('es-AR') : 'fecha desconocida';
            return `  • ${p.servicio}: ${p.descripcion} (${fecha})`;
        }).join('\n')
        : null;

    const bloqueCliente = datosConocidos.length > 0
        ? `\nDatos conocidos del cliente:\n${datosConocidos.join('\n')}`
        : '';
    const bloquePedidos = pedidosPrevios
        ? `\nPedidos anteriores:\n${pedidosPrevios}`
        : '';
    const instruccion = `Si el cliente ya dio su dirección o método de pago, NO los vuelvas a pedir. Usá los datos que ya tenés.`;

    const servicio = histCliente.servicioPendiente || 'un servicio';

    // Descripción natural del historial de trabajos para usar en la conversación
    const resumenPedidos = pedidosPrevios
        ? `Este cliente ya compró o contrató:\n${pedidosPrevios}`
        : 'Este cliente ya tuvo interacción previa con Gardens Wood.';

    if (histCliente.estado === 'cotizacion_enviada' && histCliente.fechaCotizacion) {
        const horas = Math.round((ahora - new Date(histCliente.fechaCotizacion).getTime()) / 3600000);
        return `[CONTEXTO_SISTEMA] Este cliente ya fue atendido antes. Se le envió una cotización de ${servicio} hace aproximadamente ${horas} hora${horas !== 1 ? 's' : ''}. Aún no confirmó ni pagó la seña.
${bloqueCliente}${bloquePedidos}
${instruccion}
REGLAS DE CONTINUIDAD:
- Si el cliente hace una consulta CONCRETA (precio, producto, servicio), respondé directamente a eso. NO preguntes por la cotización pendiente.
- SOLO mencioná la cotización pendiente si el mensaje es un saludo ambiguo ("hola", "buenas", "cómo andás") sin ninguna consulta clara.
- Ejemplo correcto para saludo ambiguo: "Hola [nombre], ¿cómo estás? ¿Me escribís por la cotización de ${servicio} o tenés otra consulta?"
- Ejemplo correcto para consulta concreta de leña: respondé los precios de leña directamente, sin mencionar la cotización pendiente.`;
    }

    if (histCliente.estado === 'confirmado' || histCliente.estado === 'cliente') {
        const esCliente = histCliente.estado === 'cliente';
        return `[CONTEXTO_SISTEMA] CLIENTE CONOCIDO — ya tiene historial con Gardens Wood.
${resumenPedidos}
${bloqueCliente}
${instruccion}
REGLAS DE CONTINUIDAD CON CLIENTE CONOCIDO:
- Tratalo con familiaridad, como alguien que ya conocés. No te presentes ni expliques quién es Vicky.
- Si sabés su nombre, usalo naturalmente (solo el primer nombre, no el apellido).
- Si consulta por algo nuevo (leña, cerco, pérgola, etc.), respondé directamente sobre eso. No necesita que le expliques todo el catálogo desde cero.
- Podés hacer referencia natural al trabajo anterior si es relevante. Ejemplo: si hizo un cerco y ahora pide leña → "Dale, para la leña te cuento...". Si pregunta sobre pérgola → podés mencionar brevemente "como el cerco que te hicimos, usamos la misma calidad de madera".
- NO ofrezcas el catálogo completo ni te presentes. Ya sabe quiénes son.
- ${esCliente ? 'Ya realizó una compra o trabajo. Es un cliente fidelizado — tratalo como tal.' : 'Confirmó una compra pero puede estar en proceso. Ofrecele ayuda con lo que necesite.'}`;
    }

    return null;
}

/** Primer nombre desde CRM/historial (nombre guardado o pushName de WhatsApp). */
function primerNombreClienteDesdeHistorial(hist) {
    if (!hist) return null;
    const raw = hist.nombre || hist.pushName;
    if (!raw || !String(raw).trim()) return null;
    return String(raw).trim().split(/\s+/)[0];
}

/** contextInfo puede incluir externalAdReply en toques desde anuncios WhatsApp / Meta */
function obtenerContextInfo(msg) {
    const m = msg?.message;
    if (!m) return null;
    return (
        m.extendedTextMessage?.contextInfo
        || m.imageMessage?.contextInfo
        || m.videoMessage?.contextInfo
        || m.audioMessage?.contextInfo
        || m.documentMessage?.contextInfo
        || null
    );
}

/**
 * Detecta anuncios activos (leña / cercos) por externalAdReply o texto prefijado del lead.
 */
function detectarServicioDesdePublicidad(msg, text) {
    const ci = obtenerContextInfo(msg);
    const ad = ci?.externalAdReply;
    const adBlob = [ad?.title, ad?.body, ad?.sourceUrl, ad?.sourceId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const lenaRe = /\bleñas?\b|\blenas?\b|leña\b|lena\b|estufa|leñero|hogar.*leña/i;
    const cercoRe = /\bcerco?s?\b|\brejas?\b|alambrado|malla\s*cicl[oó]n|perimetral/i;

    const clasificar = (s) => {
        if (!s) return null;
        const L = lenaRe.test(s);
        const C = cercoRe.test(s);
        if (L && !C) return 'lena';
        if (C && !L) return 'cerco';
        return null;
    };

    if (ad && adBlob) {
        const srv = clasificar(adBlob);
        if (srv) return { servicio: srv, origen: 'publicidad_whatsapp' };
    }

    const t = (text || '').toLowerCase();
    if (t) {
        const srv = clasificar(t);
        if (srv) return { servicio: srv, origen: 'publicidad_texto' };
    }
    return null;
}

function bloqueLecturaChatPrevio(chatHistory) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return '';
    const lineas = [];
    const maxLineas = 12;
    for (let i = chatHistory.length - 1; i >= 0 && lineas.length < maxLineas; i--) {
        const turn = chatHistory[i];
        if (!turn?.parts?.length) continue;
        const txt = turn.parts.map((p) => p.text).filter(Boolean).join(' ');
        if (!txt || /^\[CONTEXTO/i.test(txt) || /^Entendido,/i.test(txt)) continue;
        const rol = turn.role === 'user' ? 'Cliente' : 'Vicky';
        const corto = txt.replace(/\s+/g, ' ').slice(0, 400);
        lineas.unshift(`${rol}: ${corto}`);
    }
    if (!lineas.length) return '';
    return `[LECTURA_CHAT_PREVIO] Mensajes recientes (leé antes de responder; no repitas saludos ni lo ya resuelto salvo que el cliente lo pida):\n${lineas.join('\n')}`;
}

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================
// ============================================================
// LLAMADA DE SEGUIMIENTO VÍA ELEVENLABS AGENT + TWILIO
// ============================================================
async function llamarClienteElevenLabs({ telefono, nombre, servicio }) {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_PHONE_NUMBER_ID) {
        console.warn('⚠️ ElevenLabs llamadas: faltan variables de entorno');
        return false;
    }
    // Normalizar número para Argentina: celulares deben ir con +549
    let toNumber = (telefono || '').replace(/\D/g, '');
    if (toNumber.startsWith('54') && !toNumber.startsWith('549')) {
        toNumber = '549' + toNumber.slice(2);
    } else if (!toNumber.startsWith('549')) {
        toNumber = '549' + toNumber.replace(/^0+/, '');
    }
    toNumber = '+' + toNumber;

    const nombreCliente = nombre || 'cliente';
    const servicioNombre = servicio || 'el presupuesto';

    const primerMensaje = `Hola${nombre ? ' ' + nombre : ''}! Te llamo de Gardens Wood, soy Vicky. Te contacto porque te enviamos un presupuesto de ${servicioNombre} y quería saber si pudiste verlo y si tenés alguna duda.`;

    const promptContexto = `Estás haciendo una llamada de seguimiento a ${nombreCliente} de parte de Gardens Wood. Se le envió un presupuesto de ${servicioNombre} hace más de 24 horas y aún no confirmó. Tu objetivo es confirmar si avanza con la seña para reservar la fecha. Sé cálida, breve y natural. Si confirma, decile que en breve le llega un WhatsApp con los datos de transferencia. Si no puede ahora, preguntale cuándo es buen momento para volver a llamar.`;

    try {
        const resp = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
            method: 'POST',
            headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_id: ELEVENLABS_AGENT_ID,
                agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID,
                to_number: toNumber,
                conversation_config_override: {
                    agent: {
                        prompt: { prompt: promptContexto },
                        first_message: primerMensaje
                    }
                }
            })
        });
        if (resp.ok) {
            console.log(`📞 Llamada ElevenLabs iniciada a ${toNumber} (${nombreCliente})`);
            return true;
        }
        const err = await resp.text();
        console.warn(`⚠️ Error llamada ElevenLabs: ${resp.status} — ${err}`);
        return false;
    } catch (e) {
        console.error('❌ Error iniciando llamada ElevenLabs:', e.message);
        return false;
    }
}

const VICKY_SEGUIMIENTO_24H_MS = 24 * 60 * 60 * 1000;
const VICKY_SEGUIMIENTO_INTERVALO_MS = 30 * 60 * 1000;

async function ejecutarSeguimientos24h() {
    const ahora = Date.now();
    for (const [tel, cliente] of Object.entries(clientesHistorial)) {
        try {
            if (
                cliente.estado === 'cotizacion_enviada' &&
                !cliente.seguimientoEnviado &&
                cliente.remoteJid &&
                cliente.fechaCotizacion
            ) {
                if (cliente.handoffEnviado) continue;
                if (firestoreModule.isAvailable()) {
                    const silence = await firestoreModule.getChatSilenceState(cliente.remoteJid);
                    if (silence?.shouldSilence) continue;
                }

                const tiempoTranscurrido = ahora - new Date(cliente.fechaCotizacion).getTime();
                if (tiempoTranscurrido >= VICKY_SEGUIMIENTO_24H_MS) {
                    const servicio = cliente.servicioPendiente || 'lo que te enviamos';
                    const esLena = servicio === 'lena';
                    const nombre = cliente.nombre ? `${cliente.nombre}` : '';
                    const saludo = nombre ? `Hola ${nombre}` : 'Hola';
                    const cuerpo = esLena
                        ? `${saludo}, soy Vicky 😊 Quería saber qué te había parecido la cotización de leña que te enviamos. ¿Pudiste definir cuándo necesitás el pedido? 🪵`
                        : `${saludo}, soy Vicky 😊 Quería saber qué te había parecido el presupuesto que te enviamos. ¿Pudiste avanzar con la seña para reservar la fecha? 🙌`;

                    const audioEnviado = await enviarAudioElevenLabs(sendBotMessage, cliente.remoteJid, cuerpo);
                    if (!audioEnviado) {
                        await sendBotMessage(cliente.remoteJid, { text: cuerpo });
                    }

                    if (cliente.telefono) {
                        setTimeout(async () => {
                            const llamadaOk = await llamarClienteElevenLabs({
                                telefono: cliente.telefono,
                                nombre: cliente.nombre,
                                servicio: cliente.servicioPendiente || 'presupuesto'
                            });
                            if (llamadaOk) {
                                console.log(`📞 Llamada de seguimiento iniciada a ${cliente.nombre} (${cliente.telefono})`);
                            }
                        }, 2 * 60 * 1000);
                    }

                    cliente.seguimientoEnviado = true;
                    await saveHistorialGCS();
                    console.log(`📬 Seguimiento 24hs enviado a ${cliente.remoteJid} (${audioEnviado ? 'audio' : 'texto'})`);
                }
            }
        } catch (errSeg) {
            console.error(`❌ Error enviando seguimiento a ${tel}:`, errSeg.message);
        }
    }
}

function jidAdminNotificaciones() {
    const d = vickyRuntimeCfg.ADMIN_PHONE_DIGITS || String(ADMIN_PHONE || '').replace(/\D/g, '');
    if (d.length < 10) return null;
    return `${d}@s.whatsapp.net`;
}

function jidOperacionDatosEntrega() {
    const d = vickyRuntimeCfg.DATOS_ENTREGA_NOTIFY_DIGITS || '';
    if (d.length < 11) return null;
    return `${d}@s.whatsapp.net`;
}

const vickyGeminiTurnDeps = {
    getModel: () => vickyGeminiModel,
    vickyRuntimeCfg,
    firestoreModule,
    delay,
    sendBotMessage,
    enviarImagenCatalogo,
    enviarAudioElevenLabs,
    generarPresupuestoCercoPDF,
    agregarAColaLena,
    aplicarEtiquetaContactarAsesor,
    jidAdminNotificaciones,
    jidOperacionDatosEntrega,
    getCliente,
    getTel,
    actualizarEstadoCliente,
    appendHistorialConsultaSync,
    limpiarTextoParaHistorialConsulta,
    telefonoLineaParaFirestore,
    docIdClienteFirestore,
    bloqueLecturaChatPrevio,
    primerNombreClienteDesdeHistorial,
    LIMITE_INDIVIDUAL_KG,
    fs,
};

async function procesarWebhookInstagramPayload(body) {
    if (!vickyBootstrapHecho) {
        console.warn('⚠️ Webhook Instagram antes del bootstrap; Meta reintentará.');
        return;
    }
    if (!instagramDmMod.isConfiguredForSend()) {
        console.warn('⚠️ Falta INSTAGRAM_PAGE_ACCESS_TOKEN: no se pueden enviar DMs');
    }
    if (body.object !== 'instagram') return;
    const events = instagramDmMod.parseInstagramMessaging(body);
    for (const ev of events) {
        if (ev.mid && instagramDmMod.wasMidProcessed(ev.mid)) continue;
        await procesarMensajeInstagram(ev.senderId, ev.text);
    }
}

async function procesarMensajeInstagram(instagramPsid, text) {
    const remoteJid = `ig:${instagramPsid}`;
    const textTrim = (text || '').trim();
    if (!textTrim) return;

    if (firestoreModule.isAvailable()) {
        const silence = await firestoreModule.getChatSilenceState(remoteJid);
        if (silence?.shouldSilence) {
            const s = SESSIONS.get(remoteJid);
            if (s) {
                s.humanAtendiendo = true;
                s.humanTimestamp = Date.now();
            }
            return;
        }
    }

    if (firestoreModule.isAvailable()) {
        const liveActivo = await firestoreModule.getBotActivoLive();
        vickyRuntimeCfg.BOT_ACTIVO = liveActivo;
        if (!liveActivo) {
            console.log(`🛑 botActivo=false: no Instagram ${remoteJid}`);
            return;
        }
        const igOn = await firestoreModule.getInstagramDmActivoLive();
        if (!igOn) {
            console.log(`🛑 instagramDmActivo=false: no Instagram ${remoteJid}`);
            return;
        }
    } else if (!vickyRuntimeCfg.BOT_ACTIVO) {
        return;
    }

    asegurarCliente(remoteJid);

    if (!SESSIONS.has(remoteJid)) {
        const telSession = getTel(remoteJid);
        await downloadHistorialConsultaIfNeeded(telSession);
        const histCliente = getCliente(remoteJid);
        const chatHistory = [];

        const contextoPrevio = construirContextoPrevio(histCliente);
        if (contextoPrevio) {
            chatHistory.push(
                { role: 'user', parts: [{ text: contextoPrevio }] },
                { role: 'model', parts: [{ text: 'Entendido, tengo el contexto del cliente.' }] }
            );
            console.log(`🔁 Contexto previo (IG) para ${remoteJid}: ${histCliente?.estado}`);
        }

        const consultasData = leerHistorialConsultasArchivo(telSession);
        if (consultasData?.nombre && !getCliente(remoteJid)?.nombre) {
            actualizarEstadoCliente(remoteJid, { nombre: consultasData.nombre });
        }
        const ctxConsultas = construirContextoHistorialConsultas(consultasData);
        if (ctxConsultas) {
            chatHistory.push(
                { role: 'user', parts: [{ text: ctxConsultas }] },
                { role: 'model', parts: [{ text: 'Entendido, tengo el historial de consultas de este contacto.' }] }
            );
            console.log(`📂 Historial consultas (IG) cargado para ${telSession}`);
        }

        const ultPersistido = histCliente?.ultimoMensaje;
        SESSIONS.set(remoteJid, {
            audioIntroEnviado: histCliente?.audioIntroEnviado === true,
            humanAtendiendo: false,
            humanTimestamp: null,
            chatHistory,
            imagenEnviada: {},
            ultimoMensajeCliente:
                typeof ultPersistido === 'number' && ultPersistido > 0 ? ultPersistido : null,
            mensajesTexto: 0,
        });
    }

    const session = SESSIONS.get(remoteJid);
    if (session.humanAtendiendo) {
        if (Date.now() - session.humanTimestamp > vickyRuntimeCfg.SILENCIO_HUMANO_MS) {
            session.humanAtendiendo = false;
            session.humanTimestamp = null;
        } else {
            return;
        }
    }

    const histCl = getCliente(remoteJid);
    firestoreModule
        .logMensaje({
            jid: remoteJid,
            tipo: 'texto',
            contenido: textTrim,
            direccion: 'entrante',
            servicio: histCl?.servicioPendiente || null,
            clienteInfo: {
                nombre: histCl?.nombre,
                estado: histCl?.estado,
                servicioPendiente: histCl?.servicioPendiente,
                humanoAtendiendo: session.humanAtendiendo,
            },
        })
        .catch(() => {});

    const ahora = Date.now();
    const minutosDesdeUltimoMensaje = session.ultimoMensajeCliente
        ? Math.round((ahora - session.ultimoMensajeCliente) / 60000)
        : null;
    session.ultimoMensajeCliente = ahora;
    actualizarEstadoCliente(remoteJid, { ultimoMensaje: ahora });
    session.mensajesTexto = (session.mensajesTexto || 0) + 1;

    const primerContacto = !session.audioIntroEnviado;
    if (primerContacto) {
        session.audioIntroEnviado = true;
        marcarAudioEnviado(remoteJid);

        const esTextoVago =
            !textTrim ||
            /^(hola|buenas|buen[ao]s?\s*(días?|tardes?|noches?)?|hey|hi|hello|saludos?|buenas?|ey|q tal|como andas?)\s*[!?¡¿.]*$/i.test(
                textTrim
            );
        if (esTextoVago) {
            try {
                await instagramDmMod.enviarDmInstagram(instagramPsid, vickyRuntimeCfg.mensajeBienvenidaActivo);
            } catch (e) {
                console.error('❌ Instagram bienvenida:', e.message);
            }
            return;
        }

        try {
            await instagramDmMod.enviarDmInstagram(instagramPsid, vickyRuntimeCfg.mensajeBienvenidaActivo);
            await delay(800);
        } catch (e) {
            console.error('❌ Instagram texto bienvenida:', e.message);
        }
    }

    if (!vickyGeminiModel) {
        try {
            await instagramDmMod.enviarDmInstagram(
                instagramPsid,
                'Disculpá, estoy teniendo un problema técnico en este momento. Volvé a escribirme en unos minutos 🙏'
            );
        } catch (_) {}
        return;
    }

    const delayIgMin = Math.max(2, Math.floor(vickyRuntimeCfg.DELAY_MIN / 1000 / 4));
    const delayIgMax = Math.max(delayIgMin + 1, Math.floor(vickyRuntimeCfg.DELAY_MAX / 1000 / 4));
    await delay((delayIgMin + Math.random() * (delayIgMax - delayIgMin)) * 1000);

    const telCliente = getTel(remoteJid);
    await ejecutarTurnoVickyGeminiCore(vickyGeminiTurnDeps, {
        canal: 'instagram',
        remoteJid,
        instagramPsid,
        session,
        telCliente,
        text: textTrim,
        tieneImagen: false,
        tieneAudio: false,
        imagenBase64: null,
        imagenMime: 'image/jpeg',
        audioClienteBase64: null,
        audioClienteMime: 'audio/ogg',
        primerContacto,
        minutosDesdeUltimoMensaje,
        publicidadLead: null,
    });
}

vickyInstagramWebhook.handlePayload = procesarWebhookInstagramPayload;

/** Gemini: instrucción del admin → mensaje para el cliente (+ img/pdf si aplica). */
async function geminiAdminParaCliente(instruccionTexto, audioAdminBase64) {
    if (!vickyGeminiModel) throw new Error('Gemini no inicializado');
    const ctxAdmin = `[INSTRUCCION_ADMIN] ⚠️ IMPORTANTE: Lo que viene a continuación es una INSTRUCCIÓN del dueño del negocio, NO un mensaje del cliente.
El dueño te dice qué querés decirle o preguntarle al cliente. Tu tarea es generar el mensaje que Vicky le enviaría AL cliente.
NO respondas como si el cliente te hubiese preguntado algo. Generá el mensaje que va para el cliente, en primera persona como Vicky.
No saludes si la relación ya está establecida. Usá [IMG:lena|cerco|pergola|fogonero|bancos] si el dueño pide catálogos.`;
    let partesAdmin;
    if (audioAdminBase64) {
        partesAdmin = [
            { text: ctxAdmin },
            { inlineData: { data: audioAdminBase64, mimeType: 'audio/ogg' } },
            { text: 'Transcribí la instrucción del dueño del audio y generá el mensaje que Vicky le envía AL cliente.' }
        ];
    } else {
        partesAdmin = [{ text: `${ctxAdmin}\nInstrucción del dueño: "${instruccionTexto}"\n\nGenerá el mensaje para el cliente:` }];
    }
    const chatAdmin = vickyGeminiModel.startChat({ history: [] });
    const resultAdmin = await chatAdmin.sendMessage(partesAdmin);
    let respuestaAdmin = resultAdmin.response.text().trim();
    const imgMatchAdmin = respuestaAdmin.match(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/i);
    respuestaAdmin = respuestaAdmin.replace(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/gi, '').trim();
    const pdfAdminMatch = respuestaAdmin.match(/\[PDF_CERCO:([^\]]+)\]/i);
    respuestaAdmin = respuestaAdmin.replace(/\[PDF_CERCO:[^\]]+\]/gi, '').trim();
    respuestaAdmin = respuestaAdmin
        .replace(/\[COTIZACION:[^\]]+\]/gi, '')
        .replace(/\[CONFIRMADO\]/gi, '')
        .replace(/\[NOMBRE:[^\]]+\]/gi, '')
        .replace(/\[DIRECCION:[^\]]+\]/gi, '')
        .replace(/\[ZONA:[^\]]+\]/gi, '')
        .replace(/\[BARRIO:[^\]]+\]/gi, '')
        .replace(/\[LOCALIDAD:[^\]]+\]/gi, '')
        .replace(/\[REFERENCIA:[^\]]+\]/gi, '')
        .replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '')
        .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
        .replace(/\[PEDIDO:[^\]]+\]/gi, '')
        .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
        .replace(/\[HANDOFF_EXPERTO:[^\]]+\]/gi, '')
        .replace(/\[NOTIFICAR_VENTA:[^\]]+\]/gi, '')
        .replace(/\[CRM:[^\]]+\]/gi, '')
        .replace(/\[AGENDAR:[^\]]+\]/gi, '')
        .replace(/\[ENTREGA:[^\]]+\]/gi, '')
        .replace(/\[AUDIO_CORTO:[^\]]+\]/gi, '')
        .replace(/\[AUDIO_FIDELIZAR:[^\]]+\]/gi, '')
        .trim();
    return { texto: respuestaAdmin, imgMatchAdmin, pdfAdminMatch };
}

async function enviarGeminiAdminACliente(remoteJidAdmin, jidDestino, etiqueta, textoInstruccion, audioBase64, enviarImagenFn) {
    const { texto, imgMatchAdmin, pdfAdminMatch } = await geminiAdminParaCliente(textoInstruccion, audioBase64);
    if (texto.length > 0) await sendBotMessage(jidDestino, { text: texto });
    if (imgMatchAdmin) await enviarImagenFn(jidDestino, imgMatchAdmin[1].toLowerCase());
    if (pdfAdminMatch) {
        const partesPdf = pdfAdminMatch[1].split('|');
        const metros = parseFloat(partesPdf[0]) || 0;
        const precioUnit = parseFloat(partesPdf[1]) || 0;
        const alturaM = partesPdf[2] || '1.8';
        const descuentoPct = parseFloat(partesPdf[3]) || 0;
        const nombreClientePdf = getCliente(jidDestino)?.nombre || etiqueta;
        if (metros > 0 && precioUnit > 0) {
            generarPresupuestoCercoPDF({ cliente: nombreClientePdf, metros, precioUnit, alturaM, descuentoPct })
                .then(async (pdfPath) => {
                    if (pdfPath) {
                        await sendBotMessage(jidDestino, {
                            document: fs.readFileSync(pdfPath),
                            mimetype: 'application/pdf',
                            fileName: `Presupuesto Cerco - ${nombreClientePdf}.pdf`
                        });
                        fs.unlinkSync(pdfPath);
                    }
                }).catch(err => console.error('❌ Error PDF cerco puente:', err.message));
        }
    }
    const resumen = texto.length > 0
        ? `\n\n_"${texto.substring(0, 120)}${texto.length > 120 ? '…' : ''}"_`
        : (imgMatchAdmin ? `\n\n_[imagen]_` : '');
    await sendBotMessage(remoteJidAdmin, { text: `✅ Enviado a *${etiqueta}*${resumen}` });
}

/** Si el último token es tipo de leña, se usa como filtro CRM y se quita del texto de producto. */
function parseProductoTipoRuta(productoField) {
    const rest = String(productoField || '').trim();
    const tipos = new Set(['hogar', 'salamandra', 'parrilla']);
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
        const last = parts[parts.length - 1].toLowerCase();
        if (tipos.has(last)) {
            return { producto: parts.slice(0, -1).join(' '), tipoFiltro: last };
        }
    }
    return { producto: rest, tipoFiltro: null };
}

function primerNombreCampana(nombre) {
    const s = String(nombre || '').trim();
    if (!s) return '';
    return s.split(/\s+/)[0];
}

function aplicarPlantillaCampanaRuta(plantilla, vars) {
    let t = String(plantilla || '');
    for (const [k, v] of Object.entries(vars)) {
        t = t.split(`{${k}}`).join(v == null ? '' : String(v));
    }
    return t;
}

/**
 * Envío real de campaña #RUTA / #ruta_geo (plantilla, Twilio opcional, delays).
 * @param {string} remoteJidAdmin
 * @param {Array<{ tel: string, remoteJid: string, nombre?: string, tipoLenaPreferido?: string | null }>} tomar
 * @param {{ zonaLabel: string, producto: string, tipoFiltro: string | null, cfgCampana: Record<string, unknown>, introAdminText: string, doneTag: string }} opts
 */
async function enviarCampanaRutaLista(remoteJidAdmin, tomar, opts) {
    const { zonaLabel, producto, tipoFiltro, cfgCampana, introAdminText, doneTag } = opts;
    const useTwilio = /^(1|true|yes)$/i.test(String(process.env.CAMPANA_USE_TWILIO || '').trim());
    const pct = vickyRuntimeCfg.CAMPANA_DESC_PCT || 10;
    const fechaTexto = String(cfgCampana.campanaRutaFechaTexto || 'mañana').trim() || 'mañana';
    const plantillaBase = String(cfgCampana.campanaRutaPlantilla || '').trim()
        || 'Hola {nombre}! Te cuento que {fechaTexto} vamos a estar por la zona *{zona}* y quería saber si necesitás *{producto}*, así aprovechás el flete sin cargo. Cualquier cosa escribime. — Vicky, Gardens Wood';
    await sendBotMessage(remoteJidAdmin, { text: introAdminText });
    const twilio = useTwilio ? require('./twilio-wa') : null;
    const contentSid = process.env.TWILIO_CAMPANA_CONTENT_SID || '';
    for (let i = 0; i < tomar.length; i++) {
        const c = tomar[i];
        const nom = primerNombreCampana(c.nombre);
        const tipoCli = String(c.tipoLenaPreferido || '').trim();
        const tipoClienteLabel = tipoCli ? `leña ${tipoCli}` : 'leña';
        const textoPersonal = aplicarPlantillaCampanaRuta(plantillaBase, {
            nombre: nom || 'te escribo desde Gardens',
            zona: zonaLabel,
            producto,
            fechaTexto,
            pct: String(pct),
            tipoCliente: tipoClienteLabel,
        });
        try {
            if (useTwilio && twilio && contentSid) {
                const to = c.tel.startsWith('+') ? c.tel : `+${c.tel.replace(/^\+/, '')}`;
                const r = await twilio.sendWhatsAppTemplate({
                    to,
                    contentSid,
                    contentVariables: { 1: String(zonaLabel), 2: String(producto), 3: String(pct) },
                });
                if (!r.ok) await sendBotMessage(c.remoteJid, { text: textoPersonal });
            } else {
                await sendBotMessage(c.remoteJid, { text: textoPersonal });
            }
        } catch (e) {
            console.warn(`⚠️ Campaña fallo a ${c.tel}:`, e.message);
        }
        const minD = vickyRuntimeCfg.CAMPANA_DELAY_MIN_MS || 15000;
        const maxD = vickyRuntimeCfg.CAMPANA_DELAY_MAX_MS || 20000;
        const span = Math.max(0, maxD - minD);
        await delay(minD + Math.floor(Math.random() * (span + 1)));
    }
    await sendBotMessage(remoteJidAdmin, {
        text: `✅ ${doneTag} finalizada: ${tomar.length} mensajes encolados/enviados.`,
    });
}

async function ejecutarCampanaRuta(remoteJidAdmin, zonaToken, productoToken) {
    const { producto, tipoFiltro } = parseProductoTipoRuta(productoToken);
    let cfgCampana = { campanaRutaFechaTexto: 'mañana', campanaRutaPlantilla: '' };
    if (firestoreModule.isAvailable()) {
        try {
            cfgCampana = await firestoreModule.getConfigGeneral({ bypassCache: true });
        } catch {
            /* defaults */
        }
    }
    const lista = firestoreModule.isAvailable()
        ? await firestoreModule.listClientesParaCampana(zonaToken, producto, { tipoLenaPreferido: tipoFiltro })
        : [];
    const maxN = vickyRuntimeCfg.CAMPANA_MAX || 40;
    const tomar = lista.slice(0, maxN);
    if (tomar.length === 0) {
        const tipoHint = tipoFiltro ? ` y tipo leña *${tipoFiltro}*` : '';
        await sendBotMessage(remoteJidAdmin, {
            text: `❌ #RUTA: no hay destinatarios con zona que contenga "${zonaToken}", servicio/interés "${producto}"${tipoHint} (revisá CRM en el panel), o todos coinciden pero están en *silencio humano* / *#silenciar* en Firestore. Tip: último token *hogar* / *salamandra* / *parrilla* filtra tipo de leña.`,
        });
        return;
    }
    await enviarCampanaRutaLista(remoteJidAdmin, tomar, {
        zonaLabel: zonaToken,
        producto,
        tipoFiltro,
        cfgCampana,
        introAdminText:
            `🚚 Campaña #RUTA: ${tomar.length} destinatarios (máx ${maxN}${tipoFiltro ? `, filtro tipo ${tipoFiltro}` : ''}). Enviando con delay anti-spam…`,
        doneTag: '#RUTA',
    });
}

/** Campaña por proximidad a polilínea (`rutas_logistica` en Firestore). */
async function ejecutarCampanaRutaGeo(remoteJidAdmin, rutaId, productoToken) {
    const id = String(rutaId || '').trim();
    const { producto, tipoFiltro } = parseProductoTipoRuta(productoToken);
    let cfgCampana = { campanaRutaFechaTexto: 'mañana', campanaRutaPlantilla: '' };
    if (firestoreModule.isAvailable()) {
        try {
            cfgCampana = await firestoreModule.getConfigGeneral({ bypassCache: true });
        } catch {
            /* defaults */
        }
    }
    if (!firestoreModule.isAvailable() || !id) {
        await sendBotMessage(remoteJidAdmin, {
            text: '❌ #ruta_geo: Firestore no disponible o falta id de ruta. Uso: *#ruta_geo ID_DOC_FIRESTORE producto* (ej. *#ruta_geo abc123 lena hogar*). Creá la ruta en el panel → Logística — ruta / campaña geo.',
        });
        return;
    }
    const ruta = await firestoreModule.getRutaLogistica(id);
    if (!ruta) {
        await sendBotMessage(remoteJidAdmin, {
            text: `❌ #ruta_geo: no existe ruta *${id}* en \`rutas_logistica\`. Creala en el dashboard.`,
        });
        return;
    }
    if (ruta.polyline.length < 2) {
        await sendBotMessage(remoteJidAdmin, {
            text: `❌ #ruta_geo: la ruta *${id}* necesita al menos 2 puntos en la polilínea.`,
        });
        return;
    }
    if (ruta.bufferMetros <= 0) {
        await sendBotMessage(remoteJidAdmin, {
            text: `❌ #ruta_geo: definí *bufferMetros* > 0 en la ruta *${id}* (panel).`,
        });
        return;
    }
    const lista = await firestoreModule.listClientesParaCampanaGeo(id, producto, { tipoLenaPreferido: tipoFiltro });
    const maxN = vickyRuntimeCfg.CAMPANA_MAX || 40;
    const tomar = lista.slice(0, maxN);
    if (tomar.length === 0) {
        const tipoHint = tipoFiltro ? ` y tipo leña *${tipoFiltro}*` : '';
        await sendBotMessage(remoteJidAdmin, {
            text:
                `❌ #ruta_geo: nadie califica dentro del corredor (${ruta.bufferMetros} m a la ruta *${ruta.nombre || id}*), servicio/interés "${producto}"${tipoHint}, o sin *lat/lng* en ficha, o en silencio. Revisá mapa logístico y CRM.`,
        });
        return;
    }
    const zonaLabel = ruta.nombre || id;
    await enviarCampanaRutaLista(remoteJidAdmin, tomar, {
        zonaLabel,
        producto,
        tipoFiltro,
        cfgCampana,
        introAdminText:
            `🗺️ Campaña #ruta_geo (*${id}* · ${ruta.bufferMetros} m): ${tomar.length} destinatarios (máx ${maxN}${tipoFiltro ? `, filtro tipo ${tipoFiltro}` : ''}). Enviando con delay anti-spam…`,
        doneTag: '#ruta_geo',
    });
}

/** Aviso masivo vía WhatsApp (Firestore → remoteJid). Mismo tope y delay que #RUTA. */
async function ejecutarBroadcastMasivo(remoteJidAdmin, segmentoToken, textoMensaje) {
    const listaRaw = firestoreModule.isAvailable()
        ? await firestoreModule.listClientesParaBroadcast(segmentoToken)
        : [];
    const maxN = vickyRuntimeCfg.CAMPANA_MAX || 40;
    const lista = listaRaw.filter((c) => c.remoteJid && c.remoteJid !== remoteJidAdmin);
    const tomar = lista.slice(0, maxN);
    const segTxt = String(segmentoToken || '').toLowerCase();
    const esTodos = !segTxt || ['clientes', 'cliente', 'todos', 'all', '*'].includes(segTxt);
    const etiquetaFiltro = esTodos ? 'todos los clientes (muestra Firestore)' : `filtró *${segmentoToken}*`;
    if (tomar.length === 0) {
        await sendBotMessage(remoteJidAdmin, {
            text: `❌ #enviar: no hay chats para ${etiquetaFiltro}. Revisá que los contactos tengan *remoteJid* sync en Firestore.`,
        });
        return;
    }
    const preview = textoMensaje.length > 180 ? `${textoMensaje.slice(0, 180)}…` : textoMensaje;
    await sendBotMessage(remoteJidAdmin, {
        text: `📣 *#enviar* → ${tomar.length} destinatarios (${etiquetaFiltro}, máx ${maxN}). Enviando con delay…\n\n_${preview}_`,
    });
    const minD = vickyRuntimeCfg.CAMPANA_DELAY_MIN_MS || 15000;
    const maxD = vickyRuntimeCfg.CAMPANA_DELAY_MAX_MS || 20000;
    const span = Math.max(0, maxD - minD);
    for (let i = 0; i < tomar.length; i++) {
        const c = tomar[i];
        try {
            await sendBotMessage(c.remoteJid, { text: textoMensaje });
        } catch (e) {
            console.warn(`⚠️ #enviar fallo a ${c.remoteJid}:`, e.message);
        }
        if (i < tomar.length - 1) {
            await delay(minD + Math.floor(Math.random() * (span + 1)));
        }
    }
    const extra = lista.length > tomar.length
        ? ` _(${lista.length - tomar.length} fuera del límite ${maxN}; ajustá en panel / config)._`
        : '';
    await sendBotMessage(remoteJidAdmin, {
        text: `✅ #enviar finalizado: ${tomar.length} mensajes.${extra}`,
    });
}

async function ejecutarCronProgramados() {
    if (!firestoreModule.isAvailable()) return 0;
    const pend = await firestoreModule.obtenerProgramadosPendientesHasta(Date.now());
    let n = 0;
    for (const p of pend) {
        try {
            const jid = p.jid;
            const texto = p.texto || 'Hola! Te escribo como habíamos acordado 😊 — Vicky';
            await sendBotMessage(jid, { text: texto });
            await firestoreModule.marcarProgramadoEstado(p.id, 'enviado');
            n++;
        } catch (e) {
            console.warn('⚠️ Cron programado:', e.message);
            await firestoreModule.marcarProgramadoEstado(p.id, 'error');
        }
    }
    if (n) console.log(`⏰ Cron programados: ${n} mensaje(s) enviado(s)`);
    return n;
}

async function ejecutarCronClima() {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) return { skipped: true, reason: 'no_OPENWEATHER_API_KEY' };
    const adminJid = jidAdminNotificaciones();
    if (!adminJid) return { skipped: true, reason: 'no_admin_phone' };

    return new Promise((resolve) => {
        const url = `https://api.openweathermap.org/data/2.5/weather?q=Cordoba,AR&units=metric&lang=es&appid=${key}`;
        https.get(url, (r) => {
            let d = '';
            r.on('data', (c) => { d += c; });
            r.on('end', async () => {
                try {
                    const j = JSON.parse(d);
                    const temp = j.main?.temp;
                    const cond = (j.weather && j.weather[0]?.main) || '';
                    const desc = (j.weather && j.weather[0]?.description) || '';
                    const frio = temp != null && temp < 8;
                    const lluvia = /rain|drizzle|thunderstorm/i.test(cond);
                    if (frio || lluvia) {
                        const msg = `🌦️ *Clima Córdoba:* ${desc}, ${temp != null ? `${Math.round(temp)}°C` : 's/d'}.${frio ? ' Frío.' : ''}${lluvia ? ' Lluvia.' : ''}\n\n¿Querés disparar campaña de *leña*? (#RUTA zona leña)`;
                        await sendBotMessage(adminJid, { text: msg });
                        resolve({ notified: true, frio, lluvia });
                    } else {
                        resolve({ notified: false, temp, cond });
                    }
                } catch (e) {
                    resolve({ error: e.message });
                }
            });
        }).on('error', (e) => resolve({ error: e.message }));
    });
}

vickyCronHandlers.ejecutarProgramados = ejecutarCronProgramados;
vickyCronHandlers.ejecutarClima = ejecutarCronClima;
vickyCronHandlers.ejecutarGeocodeClientes = ejecutarCronGeocodificacionClientes;

/** Tras aplicar instructivo en Firestore (#g + OK): mismo armado que en bootstrap (prompt + sufijo servicios). */
async function recargarVickyGeminiSystemPrompt() {
    if (!GEMINI_API_KEY || !vickyGoogleGenAI) {
        console.warn('⚠️ recargarVickyGeminiSystemPrompt: sin API key o cliente Gemini');
        return false;
    }
    try {
        const modelo = vickyRuntimeCfg.MODEL_GEMINI || 'gemini-2.5-flash';
        let full = await firestoreModule.getSystemPrompt(SYSTEM_PROMPT);
        const serviciosMap = await firestoreModule.getServicios();
        const serviciosSuffix = firestoreModule.buildServiciosPromptSuffix(serviciosMap);
        if (serviciosSuffix) full += serviciosSuffix;
        full += SYSTEM_PROMPT_SUFIJO_UBICACION_MARCADORES;
        vickyGeminiModel = vickyGoogleGenAI.getGenerativeModel({
            model: modelo,
            systemInstruction: full,
        });
        console.log('📝 Gemini: system prompt recargado (instructivo WhatsApp admin).');
        return true;
    } catch (e) {
        console.error('❌ recargarVickyGeminiSystemPrompt:', e.message);
        return false;
    }
}

async function connectToWhatsApp(isReconnect = false) {
    if (!isReconnect) {
    console.log('🔌 Iniciando conexión con WhatsApp...');
    } else {
        console.log('🔌 Reconexión WhatsApp…');
    }
    await downloadFromGCS({ quiet: isReconnect });
    loadHistorialLocal();
    await downloadColaLenaGCS({ quiet: isReconnect });

    if (!vickyBootstrapHecho) {
    await firestoreModule.initFirestore();
    if (firestoreModule.isAvailable()) {
        const nLid = await firestoreModule.loadLidMapeoIntoMap(lidToPhone);
        if (nLid > 0) console.log(`📇 Mapeos LID→tel cargados desde Firestore: ${nLid}`);
    }
    if (firestoreModule.isAvailable() && Object.keys(clientesHistorial).length > 0) {
        firestoreModule.migrarHistorialAFirestore(clientesHistorial).catch(console.warn);
    }

    let SYSTEM_PROMPT_ACTIVO = await firestoreModule.getSystemPrompt(SYSTEM_PROMPT);
        const serviciosMap = await firestoreModule.getServicios();
        const serviciosSuffix = firestoreModule.buildServiciosPromptSuffix(serviciosMap);
        if (serviciosSuffix) {
            SYSTEM_PROMPT_ACTIVO += serviciosSuffix;
            console.log('📋 Bloque DATOS_SERVICIOS_FIRESTORE anexado al system prompt.');
        }
        SYSTEM_PROMPT_ACTIVO += SYSTEM_PROMPT_SUFIJO_UBICACION_MARCADORES;

    const TEXTO_AYUDA_BIENVENIDA_DEFAULT = '¿En qué te puedo ayudar? Escribime porfa que me es más fácil responder 😊';
        vickyRuntimeCfg.mensajeBienvenidaActivo = await firestoreModule.getMensajeBienvenidaTexto(TEXTO_AYUDA_BIENVENIDA_DEFAULT);

    const configGeneral = await firestoreModule.getConfigGeneral();
    const delayMinS = Number(configGeneral.delayMinSeg);
    const delayMaxS = Number(configGeneral.delayMaxSeg);
        const minEscS = Math.max(26, Number.isFinite(delayMinS) ? delayMinS : 26);
        let maxEscS = Number.isFinite(delayMaxS) ? delayMaxS : 34;
        if (maxEscS < minEscS + 2) maxEscS = minEscS + 8;
        vickyRuntimeCfg.DELAY_MIN = minEscS * 1000;
        vickyRuntimeCfg.DELAY_MAX = maxEscS * 1000;
    const MODELO_GEMINI = configGeneral.modeloGemini || 'gemini-2.5-flash';
        const freqFidelRaw = parseInt(configGeneral.frecuenciaAudioFidelizacion, 10);
        vickyRuntimeCfg.FIDELIZAR_CADA = (Number.isFinite(freqFidelRaw) && freqFidelRaw >= 18)
            ? Math.min(99, freqFidelRaw)
            : 0;
        vickyRuntimeCfg.BOT_ACTIVO = configGeneral.botActivo !== false;
        vickyRuntimeCfg.SILENCIO_HUMANO_MS = 24 * 60 * 60 * 1000;
        const labelHandoff = String(
            configGeneral.whatsappLabelIdContactarAsesor
            || process.env.WHATSAPP_LABEL_ID_CONTACTAR_ASESOR
            || ''
        ).trim();
        vickyRuntimeCfg.WHATSAPP_LABEL_ID_CONTACTAR_ASESOR = labelHandoff;
        if (labelHandoff) {
            console.log(`🏷️ Etiqueta WA “contactar asesor” configurada (handoff → labelId=${labelHandoff})`);
        }

        vickyRuntimeCfg.ADMIN_PHONE_DIGITS = String(configGeneral.adminPhone || process.env.ADMIN_PHONE || '').replace(/\D/g, '');
        const panelDe = configGeneral.datosEntregaNotifyPhone;
        const tienePanelDe = panelDe != null && String(panelDe).replace(/\D/g, '').length > 0;
        const rawDatosEntrega = tienePanelDe
            ? panelDe
            : (process.env.VICKY_DATOS_ENTREGA_NOTIFY_PHONE || '5493512956376');
        vickyRuntimeCfg.DATOS_ENTREGA_NOTIFY_DIGITS = normalizarDigitosNotifOperacion(rawDatosEntrega);
        if (vickyRuntimeCfg.DATOS_ENTREGA_NOTIFY_DIGITS) {
            console.log(
                `📦 Notificación datos de entrega → WhatsApp ${vickyRuntimeCfg.DATOS_ENTREGA_NOTIFY_DIGITS.slice(0, 4)}… (origen: ${tienePanelDe ? 'panel' : 'env/default'})`
            );
        }
        const gjAgenda = normalizarJidGrupoAgendaEntregas(
            configGeneral.whatsappGrupoJidAgendaEntregas || process.env.WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS
        );
        vickyRuntimeCfg.GRUPO_JID_AGENDA_ENTREGAS = gjAgenda;
        vickyRuntimeCfg.NOTIFICAR_AGENDA_GRUPO_ACTIVO = configGeneral.notificarAgendaEntregasGrupoActivo !== false;
        if (String(configGeneral.whatsappGrupoJidAgendaEntregas || '').trim() || process.env.WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS) {
            if (gjAgenda.endsWith('@g.us')) {
                console.log(`📣 Agenda entregas: avisos al grupo WA (${gjAgenda.slice(0, 36)}…)`);
            } else {
                console.warn(
                    '⚠️ whatsappGrupoJidAgendaEntregas / WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS debe ser JID completo terminado en @g.us (ej. 120363…@g.us).'
                );
            }
        }
        const cMin = Number(configGeneral.campanaDelayMinSeg);
        const cMax = Number(configGeneral.campanaDelayMaxSeg);
        vickyRuntimeCfg.CAMPANA_DELAY_MIN_MS = Math.max(5000, (Number.isFinite(cMin) ? cMin : 15) * 1000);
        vickyRuntimeCfg.CAMPANA_DELAY_MAX_MS = Math.max(
            vickyRuntimeCfg.CAMPANA_DELAY_MIN_MS,
            (Number.isFinite(cMax) ? cMax : 20) * 1000
        );
        vickyRuntimeCfg.CAMPANA_MAX = Math.min(200, Math.max(5, parseInt(configGeneral.campanaMaxDestinatarios, 10) || 40));
        vickyRuntimeCfg.CAMPANA_DESC_PCT = Number.isFinite(Number(configGeneral.campanaDescuentoPct))
            ? Number(configGeneral.campanaDescuentoPct)
            : 10;

    if (GEMINI_API_KEY) {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            vickyGoogleGenAI = genAI;
            vickyRuntimeCfg.MODEL_GEMINI = MODELO_GEMINI;
            vickyGeminiModel = genAI.getGenerativeModel({
            model: MODELO_GEMINI,
            systemInstruction: SYSTEM_PROMPT_ACTIVO
        });
        console.log(`🤖 Gemini AI inicializado (${MODELO_GEMINI}).`);
        } else {
            vickyGoogleGenAI = null;
            vickyGeminiModel = null;
        }

        vickyBootstrapHecho = true;
    }

    if (firestoreModule.isAvailable() && colaLena.length > 0) {
        normalizarColaItemMeta();
        await firestoreModule.syncColaLena(colaLena).catch((e) => console.warn('⚠️ syncColaLena al conectar:', e.message));
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    if (!isReconnect) console.log(`📦 Usando Baileys v${version.join('.')}`);

    // Código numérico: WHATSAPP_PAIRING_PHONE solo dígitos, ej. 5493512345678 (AR móvil: 54 + 9 + área + número). No uses solo el número local (ej. 351… sin 549).
    let pairPhoneDigits = (process.env.WHATSAPP_PAIRING_PHONE || '').replace(/\D/g, '');
    if (pairPhoneDigits.length === 10 && !pairPhoneDigits.startsWith('54')) {
        console.warn(
            '⚠️ WHATSAPP_PAIRING_PHONE tiene 10 dígitos: falta el código de país. '
            + 'Para Argentina móvil debe ser 549 + esos dígitos (ej. 549' + pairPhoneDigits + ').'
        );
        if (/^(1|true|yes)$/i.test(String(process.env.WHATSAPP_PAIRING_AUTO_PREFIX_549 || '').trim())) {
            pairPhoneDigits = '549' + pairPhoneDigits;
            console.log('   WHATSAPP_PAIRING_AUTO_PREFIX_549: usando prefijo 549.');
        }
    }
    const usePairingCodeFlow = pairPhoneDigits.length >= 10;

    const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome')
    });
    vickySocketRef.current = socket;

    if (/^(1|true|yes)$/i.test(String(process.env.VICKY_LOG_LABELS || '').trim())) {
        console.log('🏷️ VICKY_LOG_LABELS activo: cuando WhatsApp envíe etiquetas verás id="…" name="…" (solo Business). Si no pasa nada, renombrá la etiqueta en el celular.');
        socket.ev.on('labels.edit', (p) => {
            const del = p?.deleted ? ' (eliminada)' : '';
            console.log(`🏷️ [VICKY_LOG_LABELS] etiqueta → id="${p?.id}" name="${p?.name || ''}"${del} predefinedId=${p?.predefinedId ?? ''}`);
            if (p?.id && p?.name && !p?.deleted) {
                console.log(`   👆 Copiá solo el id entre comillas para el panel: whatsappLabelIdContactarAsesor`);
            }
        });
        socket.ev.on('labels.association', (ev) => {
            const a = ev?.association;
            console.log(`🏷️ [VICKY_LOG_LABELS] asociación ${ev?.type} labelId="${a?.labelId || ''}" chat=${a?.chatId || ''}`);
        });
    }

    // requestPairingCode se llama desde connection.update cuando el WebSocket ya está activo
    // (llamarlo al instante tras makeWASocket suele dar "Connection Closed").

    // --- Enviar imagen del servicio (usa helper de módulo compartido con vicky-gemini-turn) ---
    const enviarImagen = (jid, servicioKey) => enviarImagenCatalogo(jid, servicioKey);

    // Solo subir creds.json cuando cambian las credenciales — con debounce para no saturar GCS
    let credsUploadTimer = null;
    // Captura el mapeo @lid → teléfono real cuando WhatsApp sincroniza contactos
    // Baileys incluye el campo `lid` en los contactos @s.whatsapp.net cuando el usuario
    // tiene la identidad de dispositivo vinculado activa
    socket.ev.on('contacts.upsert', (contacts) => {
        let nuevosPhone = 0;
        let nuevosNombre = 0;
        let guardadosPendientes = false;

        for (const contact of contacts) {
            const lidId = contact.id?.endsWith('@lid')
                ? contact.id.replace(/@lid$/, '')
                : (contact.lid ? contact.lid.replace(/@lid$/, '') : null);

            // ── Mapeo @lid → teléfono ──
            // Caso A: contacto @s.whatsapp.net con campo lid
            if (contact.id?.endsWith('@s.whatsapp.net') && contact.lid) {
                const phone = contact.id.replace(/@s\.whatsapp\.net$/, '');
                const lid = contact.lid.replace(/@lid$/, '');
                if (!lidToPhone.has(lid)) {
                    lidToPhone.set(lid, phone);
                    nuevosPhone++;
                    const c = clientesHistorial[lid];
                    if (c && !c.telefono) {
                        c.telefono = phone;
                        guardadosPendientes = true;
                        const digits = soloDigitosTel(phone);
                        if (digits.length >= 8) {
                            firestoreModule.saveLidMapeo(lid, digits).catch(() => {});
                            firestoreModule
                                .syncCliente(digits, {
                                    remoteJid: c.remoteJid || `${lid}@lid`,
                                    telefono: digits,
                                    whatsappLid: lid,
                                })
                                .catch(() => {});
                        }
                    }
                }
            }
            // Caso B: contacto @lid con campo lid apuntando a @s.whatsapp.net
            if (contact.id?.endsWith('@lid') && contact.lid?.endsWith('@s.whatsapp.net')) {
                const lid = contact.id.replace(/@lid$/, '');
                const phone = contact.lid.replace(/@s\.whatsapp\.net$/, '');
                if (!lidToPhone.has(lid)) {
                    lidToPhone.set(lid, phone);
                    nuevosPhone++;
                    const c = clientesHistorial[lid];
                    if (c && !c.telefono) {
                        c.telefono = phone;
                        guardadosPendientes = true;
                        const digits = soloDigitosTel(phone);
                        if (digits.length >= 8) {
                            firestoreModule.saveLidMapeo(lid, digits).catch(() => {});
                            firestoreModule
                                .syncCliente(digits, {
                                    remoteJid: c.remoteJid || `${lid}@lid`,
                                    telefono: digits,
                                    whatsappLid: lid,
                                })
                                .catch(() => {});
                        }
                    }
                }
            }

            // ── Guardar nombre/pushName para clientes existentes ──
            // contact.notify = pushName (nombre configurado en WhatsApp)
            // contact.name   = nombre guardado en agenda del teléfono del admin
            const nombreContacto = contact.notify || contact.name || null;
            if (nombreContacto && lidId) {
                const cliente = clientesHistorial[lidId];
                if (cliente && !cliente.pushName) {
                    cliente.pushName = nombreContacto;
                    nuevosNombre++;
                    guardadosPendientes = true;
                }
            }
        }

        if (guardadosPendientes) saveHistorialGCS().catch(() => {});
        if (nuevosPhone > 0) console.log(`📞 ${nuevosPhone} mapeos @lid→teléfono registrados`);
        if (nuevosNombre > 0) console.log(`📛 ${nuevosNombre} nombres de contacto guardados en historial`);
    });

    socket.ev.on('creds.update', async () => {
        await saveCreds();
        if (credsUploadTimer) clearTimeout(credsUploadTimer);
        credsUploadTimer = setTimeout(async () => {
            credsUploadTimer = null;
            const credPath = path.join(AUTH_DIR, 'creds.json');
            if (!fs.existsSync(credPath)) {
                await delay(2000);
            }
            if (!fs.existsSync(credPath)) {
                console.warn('⚠️ No se sube creds.json: el archivo no existe tras guardar (¿auth borrada en reconexión?). Reintentá al vincular de nuevo.');
                return;
            }
            try {
                await storage.bucket(BUCKET_NAME).upload(credPath, { destination: 'auth/creds.json' });
            } catch (e) {
                if (!e.message?.includes('429')) console.error('❌ Error subiendo creds.json:', e.message);
            }
        }, 10000); // espera 10s antes de subir
    });
    // NO usar fs.watch para subir archivos de sesión — genera cientos de requests GCS por minuto

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        const listoParaPairing = usePairingCodeFlow && !socket.authState.creds.registered && !pairingCodeRequestSent
            && (connection === 'connecting' || !!qr);
        if (listoParaPairing) {
            pairingCodeRequestSent = true;
            const mask = pairPhoneDigits.length <= 4
                ? '****'
                : `${'•'.repeat(Math.max(0, pairPhoneDigits.length - 4))}${pairPhoneDigits.slice(-4)}`;
            console.log(`📱 Pidiendo código para el número (${pairPhoneDigits.length} dígitos): ${mask}`);
            if (pairPhoneDigits.startsWith('54') && pairPhoneDigits.length >= 11 && pairPhoneDigits[2] !== '9') {
                console.log('⚠️ En Argentina, WhatsApp móvil suele usar 549 + área + número (falta el 9 tras 54). Si falla la vinculación, corregí WHATSAPP_PAIRING_PHONE.');
            }
            console.log('   Debe coincidir con WhatsApp → Ajustes → tu perfil. AR móvil: 549 + área + número (sin 0 inicial).');
            console.log('   Si el teléfono rechaza: probá WHATSAPP_PAIRING_SKIP_GCS_AUTH=1 en .env (ver RUNBOOK).');
            await delay(4500);
            try {
                const code = await socket.requestPairingCode(pairPhoneDigits);
                console.log('\n' + '='.repeat(56));
                console.log('📱 CÓDIGO DE VINCULACIÓN (8 caracteres):', code);
                console.log('En el celular: WhatsApp → ⋮ → Dispositivos vinculados → Vincular un dispositivo');
                console.log('→ "Vincular con número de teléfono" e ingresá el código en ~1 min (si expira, reiniciá el bot).');
                console.log('='.repeat(56) + '\n');
            } catch (e) {
                console.error('❌ No se pudo obtener el código de vinculación:', e.message);
                pairingCodeRequestSent = false;
            }
        }

        if (qr && !socket.authState.creds.registered && !usePairingCodeFlow) {
            console.log('\n📷 ESCANEÁ EL QR (terminal abajo + archivo qr.png). printQRInTerminal de Baileys está desactivado a propósito.');
            qrTerminal.generate(qr, { small: true });
            qrImage.image(qr, { type: 'png', size: 4 }).pipe(fs.createWriteStream('qr.png'));
        }
        if (connection === 'close') {
            if (agendaGrupoNotifyInterval) {
                clearInterval(agendaGrupoNotifyInterval);
                agendaGrupoNotifyInterval = null;
            }
            firestoreModule.setEntregaAgendaPostAddHook(null);
            if (credsUploadTimer) {
                clearTimeout(credsUploadTimer);
                credsUploadTimer = null;
            }
            if (!socket.authState.creds.registered) {
                pairingCodeRequestSent = false;
            }
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔌 Reconectando en 5 s…');
                if (waReconnectTimer) clearTimeout(waReconnectTimer);
                waReconnectTimer = setTimeout(() => {
                    waReconnectTimer = null;
                    connectToWhatsApp(true);
                }, 5000);
            }
        } else if (connection === 'open') {
            if (isReconnect) {
                console.log('✅ WhatsApp reconectado.');
            } else {
                console.log('✅ VINCULADO! (socket abierto con los servidores de WhatsApp)');
                const meId = socket.authState.creds.me?.id || '';
                const userPart = meId.includes('@') ? meId.split('@')[0] : meId;
                if (userPart) {
                    console.log(`   Cuenta (JID usuario): ${userPart} — tiene que ser el mismo número que ves en WhatsApp → Ajustes (formato sin +, con país).`);
                }
                console.log('   Si el celular mostró error pero acá dice vinculado: la sesión suele estar rota. Pará el bot, borrá la carpeta auth_info_baileys y vinculá de nuevo (ideal: QR).');
            }
            pairingCodeRequestSent = false;
            if (/^(1|true|yes)$/i.test(String(process.env.VICKY_LOG_LABELS || '').trim())) {
                console.log('\n🏷️ VICKY_LOG_LABELS activo: buscá en consola líneas "id=… name=…".');
                console.log('   Si no sale nada al minuto: en WhatsApp Business renombrá la etiqueta o asignala a un chat (fuerza sincronización).\n');
            }
            firestoreModule.setEntregaAgendaPostAddHook((id) => {
                void intentarNotificarNuevaEntregaAgendaGrupo(id);
            });
            if (!agendaGrupoNotifyInterval) {
                agendaGrupoNotifyInterval = setInterval(() => {
                    void procesarPendientesNotificacionAgendaGrupo();
                }, 50000);
            }
            void procesarPendientesNotificacionAgendaGrupo();
        }
    });

    // ============================================================
    // HANDLER PRINCIPAL DE MENSAJES
    // ============================================================
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            // notify = tiempo real; append = cola offline (sin esto, a veces no entra la 2.ª respuesta del cliente tras reconectar)
            if (type !== 'notify' && type !== 'append') return;

            const msg = messages[0];
            if (!msg?.message || !msg?.key) return;

            if (type === 'append') {
                const tsSec = Number(msg.messageTimestamp);
                if (tsSec && Date.now() / 1000 - tsSec > 600) return;
            }

            const remoteJid = msg.key.remoteJid;

            // --- IGNORAR GRUPOS Y ESTADOS DE WHATSAPP ---
            if (remoteJid.endsWith('@g.us')) return;
            if (remoteJid === 'status@broadcast') return;

            // --- MODO ADMIN: dueño desde otro celular (!fromMe) o desde la misma cuenta Business (fromMe en chat elegido) ---
            const textoRaw = textoAdminDesdeTextoPlano(extraerTextoParaAdmin(msg));
                const tieneAudioMsg = !!(msg.message?.audioMessage || msg.message?.pttMessage);
            const rehidratarAdminAntes =
                firestoreModule.isAvailable()
                && msg?.key
                && (
                    (msg.key.fromMe && !BOT_MSG_IDS.has(msg.key.id))
                    || remitenteEsTelefonoAdminConfigurado(remoteJid)
                );
            if (rehidratarAdminAntes) {
                await rehydrateAdminWaSessionFromFirestore(remoteJid);
            }
            if (debeEntrarModoAdmin(msg, remoteJid, textoRaw, tieneAudioMsg)) {
                const textoTrimNorm = textoRaw.trim().toLowerCase();
                if (textoTrimNorm === ADMIN_EXIT_COMMAND || textoTrimNorm === '#salir') {
                    if (adminSesionesActivas.has(remoteJid)) {
                        adminSesionesActivas.delete(remoteJid);
                        await firestoreModule.clearAdminWaSession(remoteJid);
                        await sendBotMessage(remoteJid, {
                            text: '✅ Saliste del modo admin (#SALIR / adminoff). Ya podés escribir como cliente.'
                        });
                        console.log(`🔓 Modo admin cerrado (${remoteJid})`);
                    } else {
                        await sendBotMessage(remoteJid, {
                            text: 'No tenías modo admin activo. Para entrar usá tu frase secreta al inicio del mensaje.'
                        });
                    }
                    reactivarVickyTrasSalirAdmin(remoteJid);
                    return;
                }
                try {
                const esFraseAdmin = textoTrimNorm.startsWith(ADMIN_SECRET);

                const sesionAdminData = adminSesionesActivas.get(remoteJid);
                const sesionAdminActiva = sesionAdminData &&
                    (Date.now() - sesionAdminData.activadoEn) < ADMIN_SESSION_TTL;
                const enPaso2Admin = !!sesionAdminData?.destinatarioPendiente;
                const enPuenteAdmin = !!sesionAdminData?.modoBridge;
                const enCapturaAdmin = !!(
                    sesionAdminData?.esperandoSelectorPuente ||
                    sesionAdminData?.esperandoInstructivoGemini ||
                    sesionAdminData?.borradorGeminiPreview ||
                    sesionAdminData?.esperandoMenuPrincipal ||
                    (sesionAdminData?.wizard && sesionAdminData.wizard.tipo)
                );

                // Tras vicky1234, si mandás texto normal (“hola”, “precio leña”) sin ser comando admin, se cierra la sesión y Vicky responde como a cualquier cliente.
                if (sesionAdminActiva && !esFraseAdmin && !enPaso2Admin && !enPuenteAdmin && !enCapturaAdmin && !tieneAudioMsg) {
                    const c = textoRaw.trim();
                    if (c && !textoPareceComandoAdmin(c)) {
                        adminSesionesActivas.delete(remoteJid);
                        console.log(`🔓 Modo admin cerrado automático (mensaje tipo cliente) — ${remoteJid}`);
                    }
                }

                const sesionAdminVigente = adminSesionesActivas.get(remoteJid) &&
                    (Date.now() - adminSesionesActivas.get(remoteJid).activadoEn) < ADMIN_SESSION_TTL;

                // fromMe: misma cuenta Business — # sin frase secreta.
                // !fromMe + JID con el teléfono del admin (panel config/general adminPhone o ADMIN_PHONE en .env): # sin sesión (spec “reconocer número admin”).
                // Otros números: un "#g …" suelto NO entra como borrador (hay que usar frase secreta o ser el admin configurado).
                const tTrimAdmin = textoRaw.trim();
                const hashCmdAdmin = esMensajeHashComandoAdmin(tTrimAdmin);
                const permiteComandoHashDesdeMismaCuenta = msg.key.fromMe && hashCmdAdmin;
                const permiteComandoHashTelefonoAdmin = !msg.key.fromMe && hashCmdAdmin && remitenteEsTelefonoAdminConfigurado(remoteJid);

                if (/^(1|true|yes)$/i.test(String(process.env.VICKY_LOG_ADMIN || '').trim())) {
                    console.log(
                        `🔑 [admin] jid=${remoteJid} fromMe=${msg.key.fromMe} texto="${String(textoRaw).slice(0, 100)}" `
                        + `hash=${hashCmdAdmin} sesVig=${!!sesionAdminVigente} phoneOk=${remitenteEsTelefonoAdminConfigurado(remoteJid)}`
                    );
                }

                // Sin sesión ni JID reconocido como admin: no dejar caer el # al flujo cliente (Vicky responde como si fueras cliente).
                if (!msg.key.fromMe && hashCmdAdmin && !sesionAdminVigente && !remitenteEsTelefonoAdminConfigurado(remoteJid)) {
                    await sendBotMessage(remoteJid, {
                        text: '🔐 Comando de administración no habilitado en este chat.\n\n'
                            + '• Frase secreta (ADMIN_SECRET) y *después* el comando.\n'
                            + '• Comandos: *#g* / *!!g* / *vicky:g* (instructivo Gemini), *#c* / *!!c* (puente cliente), *#entrega* / *!!entrega* (cargar agenda con *#c* o JID; *#entrega lista* / *lista todas* para ver próximos eventos), *#reporte* + *detalle …*, *#p* (*lista* / *lidmap* / *tel* / *+tel* / *-tel* / *N*), *#pedido* …, *#ruta* / *!!ruta*, *#ruta_geo* / *!!ruta_geo* (campaña por polilínea en panel), *#enviar …*, *#estado* / *!!estado*, *#silencio global* / *#activo global* / *#activo parcial*, *#silenciar …* / *!!silenciar …* / *#activar …*…\n'
                            + '• *Teléfono admin* en panel + *ADMIN_PHONE* en servidor si querés sin frase secreta.\n\n'
                            + '_La sesión admin se guarda en Firestore (varias réplicas Cloud Run)._'
                    });
                    return;
                }

                if (esFraseAdmin || sesionAdminVigente || permiteComandoHashDesdeMismaCuenta || permiteComandoHashTelefonoAdmin) {
                    // Renovar sesión admin solo al escribir de nuevo la frase secreta
                    if (esFraseAdmin) {
                        const colaSecreta = textoRaw.slice(ADMIN_SECRET.length).trim();
                        const existing = adminSesionesActivas.get(remoteJid) || {};
                        adminSesionesActivas.set(remoteJid, {
                            activadoEn: Date.now(),
                            listaClientes: existing.listaClientes || {},
                            destinatarioPendiente: null,
                            modoBridge: false,
                            bridgeTarget: null,
                            esperandoSelectorPuente: false,
                            esperandoInstructivoGemini: false,
                            borradorGeminiPreview: null,
                            esperandoMenuPrincipal: !colaSecreta,
                            wizard: null,
                            ultimoReporteIndice: existing.ultimoReporteIndice ?? null,
                            ultimoReporteAt: existing.ultimoReporteAt ?? null,
                            pListaIndex: existing.pListaIndex ?? null,
                        });
                        console.log(`🔑 Sesión admin activada para ${remoteJid} (válida 1 hora)`);
                        if (!colaSecreta) {
                            await sendBotMessage(remoteJid, { text: ADMIN_MENU_PRINCIPAL_MSG });
                            await persistAdminWaSessionFirestore(remoteJid);
                            return;
                        }
                    }

                    // Extraer texto limpio (sin el prefijo "!vicky" si lo tiene)
                    const instruccionTexto = esFraseAdmin
                        ? textoRaw.slice(ADMIN_SECRET.length).trim()
                        : textoRaw;

                    let sesion = adminSesionesActivas.get(remoteJid);
                    if (!sesion) {
                        adminSesionesActivas.set(remoteJid, {
                            activadoEn: Date.now(),
                            listaClientes: {},
                            destinatarioPendiente: null,
                            modoBridge: false,
                            bridgeTarget: null,
                            esperandoSelectorPuente: false,
                            esperandoInstructivoGemini: false,
                            borradorGeminiPreview: null,
                            esperandoMenuPrincipal: false,
                            wizard: null,
                            ultimoReporteIndice: null,
                            ultimoReporteAt: null,
                            pListaIndex: null,
                        });
                        sesion = adminSesionesActivas.get(remoteJid);
                    }
                    const tAdm = textoAdminDesdeTextoPlano(instruccionTexto || '').trim();
                    const lowAdm = tAdm.toLowerCase();

                    const limpiarCapturasGemini = () => {
                        sesion.esperandoInstructivoGemini = false;
                        sesion.borradorGeminiPreview = null;
                    };
                    const limpiarCapturaPuente = () => {
                        sesion.esperandoSelectorPuente = false;
                    };

                    // ── Wizard: agenda de entregas (menú *3*)
                    if (sesion.wizard?.tipo === 'agenda_entrega' && !tieneAudioMsg && tAdm) {
                        const w = sesion.wizard;
                        const ttW = tAdm.trim();
                        if (/^menu$/i.test(ttW)) {
                            sesion.wizard = null;
                            sesion.esperandoMenuPrincipal = true;
                            await sendBotMessage(remoteJid, { text: ADMIN_MENU_PRINCIPAL_MSG });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        }
                        if (w.paso === 'tel') {
                            let dest = await resolverDestinatarioAdmin(ttW, sesion);
                            if (!dest) {
                                const soloDig = ttW.replace(/\D/g, '');
                                if (soloDig.length >= 8) {
                                    dest = await resolverDestinatarioAdmin(soloDig, sesion);
                                }
                            }
                            if (!dest && firestoreModule.isAvailable()) {
                                const soloDig = ttW.replace(/\D/g, '');
                                if (soloDig.length >= 8) {
                                    const fsR = await firestoreModule.resolverJidClientePorVariantesTelefono(soloDig);
                                    if (fsR) {
                                        dest = {
                                            jid: fsR.jid,
                                            etiqueta: fsR.nombre || fsR.docId || soloDig,
                                        };
                                    }
                                }
                            }
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese cliente en WhatsApp ni en CRM. Pasá el número (con o sin +54) o *menu*.',
                                });
                                return;
                            }
                            w.paso = 'detalle';
                            w.jid = dest.jid;
                            w.etiqueta = dest.etiqueta;
                            await sendBotMessage(remoteJid, {
                                text:
                                    `📅 *Agenda de entregas* → *${dest.etiqueta}*\n\n`
                                    + 'En *una línea* mandá fecha, hora (o `--`) y título:\n'
                                    + '• `YYYY-MM-DD HH:mm título`\n'
                                    + '• `YYYY-MM-DD -- título` (todo el día)\n\n'
                                    + 'Ej: `2026-04-10 09:00 Entrega 1 tn leña`\n\n'
                                    + 'Después te pido *OK* para guardar o *NO* para cancelar.\n'
                                    + '_*menu*_ — menú principal.',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        }
                        if (w.paso === 'detalle') {
                            const mDet = ttW.match(/^(\d{4}-\d{2}-\d{2})\s+(\S+)\s+([\s\S]+)$/);
                            if (!mDet) {
                                await sendBotMessage(remoteJid, {
                                    text:
                                        '❌ Formato: `AAAA-MM-DD HH:mm título` o `AAAA-MM-DD -- título`.\n'
                                        + '_*menu*_ — volver.',
                                });
                                return;
                            }
                            const fechaDia = mDet[1];
                            const horaRaw = (mDet[2] || '').trim();
                            const tituloEnt = (mDet[3] || '').trim();
                            if (!tituloEnt) {
                                await sendBotMessage(remoteJid, { text: '❌ Falta el título del evento.' });
                                return;
                            }
                            w.paso = 'confirmar';
                            w.fechaDia = fechaDia;
                            w.horaTexto = horaRaw && horaRaw !== '--' ? horaRaw : null;
                            w.titulo = tituloEnt;
                            await sendBotMessage(remoteJid, {
                                text:
                                    `📋 *Confirmar agenda*\n• Cliente: *${w.etiqueta}*\n• Día: \`${fechaDia}\`\n`
                                    + (w.horaTexto ? `• Hora: \`${w.horaTexto}\`\n` : '• Hora: (día completo / sin hora)\n')
                                    + `• _${tituloEnt.length > 380 ? `${tituloEnt.slice(0, 380)}…` : tituloEnt}_\n\n`
                                    + '✅ *OK* — guardar en calendario y CRM\n❌ *NO* — cancelar',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        }
                        if (w.paso === 'confirmar') {
                            const tConf = ttW.trim();
                            const esOkW = /^(ok|dale|s[íi]|listo|guardar|confirmo)\s*$/i.test(tConf);
                            const esNoW = /^(no|cancelar|cancel)\s*$/i.test(tConf);
                            if (esNoW) {
                                sesion.wizard = null;
                                sesion.esperandoMenuPrincipal = true;
                                await sendBotMessage(remoteJid, {
                                    text: 'Listo, cancelado.\n\n' + ADMIN_MENU_PRINCIPAL_MSG,
                                });
                                persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                                return;
                            }
                            if (esOkW) {
                                if (!firestoreModule.isAvailable()) {
                                    await sendBotMessage(remoteJid, { text: '❌ Firestore no disponible.' });
                                    return;
                                }
                                const targetJid = w.jid;
                                const fechaDia = w.fechaDia;
                                const horaTexto = w.horaTexto;
                                const tituloEnt = w.titulo;
                                const cliEnt = getCliente(targetJid);
                                const telC = telefonoLineaParaFirestore(targetJid, cliEnt);
                                const productoParts = [];
                                if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));
                                const paE = cliEnt?.pedidosAnteriores;
                                if (Array.isArray(paE) && paE.length > 0) {
                                    const u = paE[paE.length - 1]?.descripcion;
                                    if (u) productoParts.push(String(u).slice(0, 220));
                                }
                                const productoStr = productoParts.length ? productoParts.join(' — ') : null;
                                const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);
                                const notasStr = notasParts.length ? notasParts.join(' · ') : null;
                                const idAg = await firestoreModule.addEntregaAgenda({
                                    jid: targetJid,
                                    fechaDia,
                                    horaTexto,
                                    titulo: tituloEnt,
                                    notas: notasStr,
                                    kg: null,
                                    origen: 'whatsapp_admin_menu_entrega',
                                    telefonoContacto: telC,
                                    direccion: cliEnt?.direccion || null,
                                    producto: productoStr,
                                });
                                sesion.wizard = null;
                                sesion.esperandoMenuPrincipal = true;
                                if (!idAg) {
                                    await sendBotMessage(remoteJid, {
                                        text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD).\n\n' + ADMIN_MENU_PRINCIPAL_MSG,
                                    });
                                    persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                                    return;
                                }
                                await sendBotMessage(remoteJid, {
                                    text:
                                        `✅ *Agenda de entregas* guardada\n• Día: \`${fechaDia}\`\n`
                                        + (horaTexto ? `• Hora: \`${horaTexto}\`\n` : '• Hora: (todo el día)\n')
                                        + `• \`${tituloEnt.length > 200 ? `${tituloEnt.slice(0, 200)}…` : tituloEnt}\`\n`
                                        + `• Chat: \`${targetJid}\`\n`
                                        + '_Panel → Agenda de entregas._\n\n'
                                        + ADMIN_MENU_PRINCIPAL_MSG,
                                });
                                persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                                return;
                            }
                        }
                    }

                    // ── Menú principal (frase secreta sola → opciones 1–4)
                    if (sesion.esperandoMenuPrincipal && !sesion.wizard && !tieneAudioMsg && tAdm) {
                        const ttM = tAdm.trim();
                        if (ttM.startsWith('#')) {
                            sesion.esperandoMenuPrincipal = false;
                        } else if (/^menu$/i.test(ttM)) {
                            await sendBotMessage(remoteJid, { text: ADMIN_MENU_PRINCIPAL_MSG });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        } else if (/^1\s*$/i.test(ttM)) {
                            sesion.esperandoMenuPrincipal = false;
                            await sendBotMessage(remoteJid, {
                                text:
                                    '📤 *Enviar mensaje al cliente*\n\n'
                                    + 'Pasá *número* (con o sin +54), *nombre*, *#N* si tenés *Vicky lista*, o *último*.\n\n'
                                    + 'En el siguiente mensaje: *texto o audio* con lo que Vicky debe decirle.\n\n'
                                    + '_*menu*_ — menú principal.',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        } else if (/^2\s*$/i.test(ttM)) {
                            sesion.esperandoMenuPrincipal = false;
                            sesion.esperandoInstructivoGemini = true;
                            sesion.borradorGeminiPreview = null;
                            await sendBotMessage(remoteJid, {
                                text: '📝 *Instructivo para Vicky (Gemini)*\n\n'
                                    + 'Mandá *texto* o *audio* con la instrucción para el system prompt.\n'
                                    + 'Después *OK* para aplicar; *NO* para descartar.\n\n'
                                    + '_Tip: *!!g* si el # no entra. *menu* — menú principal._',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        } else if (/^3\s*$/i.test(ttM)) {
                            sesion.esperandoMenuPrincipal = false;
                            sesion.wizard = { tipo: 'agenda_entrega', paso: 'tel', jid: null, etiqueta: null };
                            await sendBotMessage(remoteJid, {
                                text:
                                    '📅 *Agenda de entregas*\n\n'
                                    + 'Pasá el *número del cliente* (pegá como salga del teléfono).\n\n'
                                    + '_*menu*_ — menú principal._',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        } else if (/^4\s*$/i.test(ttM)) {
                            sesion.esperandoMenuPrincipal = false;
                            await sendBotMessage(remoteJid, {
                                text:
                                    '⚙️ *Más comandos*\n\n'
                                    + 'Podés escribirlos directo: *#reporte*, *#p lista*, *#c*, *#ruta*, *#entrega*, *#g*, *#enviar* …\n\n'
                                    + '_*menu*_ — volver al menú numerado._',
                            });
                            persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                            return;
                        } else {
                            await sendBotMessage(remoteJid, {
                                text: '❓ Mandá *1*, *2*, *3*, *4* o *menu*. Para un comando con *#*, escribilo al inicio.',
                            });
                            return;
                        }
                    }

                    // ── 1) Confirmar / cancelar instructivo (vista previa → OK aplica a sistemaPrompt / NO descarta)
                    if (sesion.borradorGeminiPreview && !tieneAudioMsg && tAdm) {
                        const tConf = tAdm.trim();
                        const esOk = /^(ok|dale|s[íi]|listo|guardar|confirmo)\s*$/i.test(tConf);
                        const esNo = /^(no|cancelar|cancel)\s*$/i.test(tConf);
                        if (esOk) {
                            const preview = sesion.borradorGeminiPreview;
                            sesion.borradorGeminiPreview = null;
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: '❌ Firestore no disponible; no se pudo aplicar el instructivo.' });
                                return;
                            }
                            const r = await firestoreModule.aplicarInstructivoWhatsAppASistemaPrompt({
                                texto: preview,
                                adminJid: remoteJid,
                                promptBaseSiVacio: SYSTEM_PROMPT,
                            });
                            if (!r.ok) {
                                await sendBotMessage(remoteJid, {
                                    text: `❌ No se pudo aplicar al system prompt: ${r.error || 'error'}`
                                });
                                return;
                            }
                            const recargado = await recargarVickyGeminiSystemPrompt();
                            const parteGem = recargado
                                ? ' Ya está activo para Vicky en este servidor.'
                                : ' Quedó guardado en Firestore; si no recargó Gemini, reiniciá el servicio.';
                            await sendBotMessage(remoteJid, {
                                text: `✅ Instructivo aplicado al system prompt.${parteGem} Con varias réplicas Cloud Run, un redeploy alinea todas.`,
                            });
                            return;
                        }
                        if (esNo) {
                            sesion.borradorGeminiPreview = null;
                            await sendBotMessage(remoteJid, { text: 'Listo, descartado. Cuando quieras mandá de nuevo *#g*.' });
                            return;
                        }
                    }

                    // ── 1b) Detalle del último #reporte: *detalle …* / *#d …* / *#detalle …*
                    if (tAdm && !tieneAudioMsg) {
                        const mDet = tAdm.match(/^(#d|#detalle|detalle)\s+([\s\S]+)$/i);
                        if (mDet) {
                            const detTxt = firestoreModule.isAvailable()
                                ? await firestoreModule.getReporteDetalleTexto(mDet[2].trim(), sesion.ultimoReporteIndice)
                                : 'Firestore no disponible.';
                            await sendBotMessage(remoteJid, { text: detTxt });
                            return;
                        }
                    }

                    // ── 2) Comandos que empiezan con # (texto)
                    if (tAdm && !tieneAudioMsg && tAdm.trimStart().startsWith('#')) {
                        if (lowAdm === '#reporte' || lowAdm.startsWith('#reporte')) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const { texto: rep, indice } = await firestoreModule.getReporteDatosAgregados();
                            sesion.ultimoReporteIndice = indice;
                            sesion.ultimoReporteAt = Date.now();
                            await sendBotMessage(remoteJid, { text: rep });
                            return;
                        }

                        const pCmd = normalizarComandoPAdmin(tAdm);
                        if (/^#p/i.test(pCmd)) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }

                            const mPTel = pCmd.match(/^#p\s+tel\s+(\d{1,4})\s+(.+)$/i);
                            if (mPTel) {
                                const n = parseInt(mPTel[1], 10);
                                const telHum = normalizarTelefonoAdmin(mPTel[2]);
                                if (!telHum) {
                                    await sendBotMessage(remoteJid, { text: '❌ Tel inválido. Ej: `#p tel 3 351265435` o `#p tel 3 549351265435`' });
                                    return;
                                }
                                const refs = Array.isArray(sesion.pListaIndex) ? sesion.pListaIndex : [];
                                const ref = refs[n - 1];
                                if (!ref?.remoteJid || !ref?.tel) {
                                    await sendBotMessage(remoteJid, { text: '❌ Ítem inválido o lista vieja. Mandá *#p lista* y reintentá.' });
                                    return;
                                }
                                // Guardar en memoria local (para que el bot lo use aunque sea @lid)
                                const cl = asegurarCliente(ref.remoteJid);
                                cl.telefono = telHum;
                                saveHistorialGCS().catch(() => {});
                                const docTel = soloDigitosTel(telHum);
                                const lidFromJid = String(ref.remoteJid).endsWith('@lid')
                                    ? String(ref.remoteJid).replace(/@lid$/i, '')
                                    : null;
                                if (lidFromJid && docTel.length >= 8) {
                                    lidToPhone.set(lidFromJid, telHum);
                                    await firestoreModule.saveLidMapeo(lidFromJid, docTel);
                                }
                                await firestoreModule.syncCliente(docTel.length >= 8 ? docTel : ref.tel, {
                                    remoteJid: ref.remoteJid,
                                    telefono: docTel.length >= 8 ? docTel : telHum,
                                    whatsappLid: lidFromJid,
                                });
                                await sendBotMessage(remoteJid, {
                                    text: `✅ Tel guardado para ítem *${n}*: *${firestoreModule.formatoTelefonoListaAdmin(telHum) || telHum}* (CRM \`clientes/${docTel.length >= 8 ? docTel : ref.tel}\`).\nVolvé a mandar *#p lista*.`,
                                });
                                return;
                            }

                            const pLid = String(pCmd)
                                .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
                                .trim();
                            let lidRaw = null;
                            let telDoc = null;
                            const strictLid = pLid.match(/^#p\s+lidmap\s+(\d{10,22})\s+(\d{8,15})\s*$/i);
                            if (strictLid) {
                                lidRaw = strictLid[1].replace(/\D/g, '');
                                telDoc = soloDigitosTel(strictLid[2]);
                            } else {
                                const looseLid = pLid.match(/^#p\s+lidmap\s+([\s\S]+)$/i);
                                if (looseLid) {
                                    const nums = looseLid[1].match(/\d{8,22}/g);
                                    if (nums && nums.length >= 2) {
                                        let a = nums[0].replace(/\D/g, '');
                                        let b = nums[1].replace(/\D/g, '');
                                        if (a.length < 14 && b.length >= 14) {
                                            const tmp = a;
                                            a = b;
                                            b = tmp;
                                        }
                                        lidRaw = a;
                                        telDoc = soloDigitosTel(b);
                                    }
                                }
                            }
                            if (lidRaw && telDoc && lidRaw.length >= 10 && telDoc.length >= 8) {
                                lidToPhone.set(lidRaw, telDoc);
                                await firestoreModule.saveLidMapeo(lidRaw, telDoc);
                                const lidJid = `${lidRaw}@lid`;
                                const cl = asegurarCliente(lidJid);
                                cl.telefono = telDoc;
                                saveHistorialGCS().catch(() => {});
                                await firestoreModule.syncCliente(telDoc, {
                                    remoteJid: lidJid,
                                    telefono: telDoc,
                                    whatsappLid: lidRaw,
                                });
                                await sendBotMessage(remoteJid, {
                                    text:
                                        `✅ *LID → CRM*\n`
                                        + `• LID: \`${lidRaw}\`\n`
                                        + `• Ficha: \`clientes/${telDoc}\`\n`
                                        + `• Chat: \`${lidJid}\`\n`
                                        + `_Los datos de entrega y [ENTREGA:…] se guardan bajo ese número._`,
                                });
                                return;
                            }

                            if (/^#p\s+lista\s*$/i.test(pCmd)) {
                                const flat = await firestoreModule.listarPedidosFlatParaAdminP();
                                for (const row of flat) {
                                    if (!String(row.nombre || '').trim()) {
                                        const cln = getCliente(row.remoteJid);
                                        const nom = String(cln?.nombre || cln?.pushName || '').trim();
                                        if (nom) row.nombre = nom;
                                    }
                                }
                                sesion.pListaIndex = flat.map(({ tel, remoteJid, idxLocal }) => ({
                                    tel,
                                    remoteJid,
                                    idxLocal,
                                }));
                                if (flat.length === 0) {
                                    await sendBotMessage(remoteJid, { text: '📋 *#p lista* — todavía no hay pedidos en clientes (Firestore).' });
                                    persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                                    return;
                                }
                                const lines = flat.slice(0, 35).map((r, i) => lineaPedidoGlobalAdmin(i + 1, r));
                                let txt = `📋 *Pedidos (#p lista)* — *${flat.length}* ítem(s)\n\n${lines.join('\n')}`;
                                if (flat.length > 35) txt += `\n_…y ${flat.length - 35} más (refiná en el panel)._`;
                                txt += '\n\n_Si falta el número: `#p tel` + ítem + cel (ej. `#p tel 2 3512644587`)_\n'
                                    + '_LID sin contacto en agenda: `#p lidmap LID_DIGITS TEL_DOC`_ (ej. `543516170743`)\n'
                                    + '*#p+* / *#p-* / *#p N* — como antes';
                                await sendBotMessage(remoteJid, { text: txt });
                                persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                                return;
                            }

                            const mPn = pCmd.match(/^#p\s+(\d{1,4})\s*$/);
                            if (mPn) {
                                const n = parseInt(mPn[1], 10);
                                const refs = Array.isArray(sesion.pListaIndex) ? sesion.pListaIndex : [];
                                const ref = refs[n - 1];
                                if (!ref || n < 1) {
                                    await sendBotMessage(remoteJid, {
                                        text: '❌ Número inválido o lista vieja. Mandá de nuevo *#p lista* y usá el ítem correcto.',
                                    });
                                    return;
                                }
                                const rDel = await firestoreModule.borrarPedidoClientePorIndice(ref.tel, {
                                    index1Based: ref.idxLocal + 1,
                                });
                                if (!rDel.ok && rDel.empty) {
                                    const c = asegurarCliente(ref.remoteJid);
                                    const pa = [...(c.pedidosAnteriores || [])];
                                    const idx = ref.idxLocal;
                                    if (idx < 0 || idx >= pa.length) {
                                        await sendBotMessage(remoteJid, {
                                            text: '❌ Ese ítem ya no existe (índice desactualizado). *#p lista* de nuevo.',
                                        });
                                        return;
                                    }
                                    const removed = pa.splice(idx, 1)[0];
                                    c.pedidosAnteriores = pa;
                                    saveHistorialGCS().catch(() => {});
                                    await syncClienteFirestoreDesdeHistorialLocal(ref.remoteJid);
                                    await sendBotMessage(remoteJid, {
                                        text: `🗑️ *Pedido #${n} eliminado*\n_${resumenPedidoEliminadoWhatsApp(removed)}_`,
                                    });
                                    return;
                                }
                                if (!rDel.ok) {
                                    await sendBotMessage(remoteJid, { text: `❌ ${rDel.error || 'No se pudo borrar.'}` });
                                    return;
                                }
                                const c2 = asegurarCliente(ref.remoteJid);
                                c2.pedidosAnteriores = rDel.pedidosAnteriores;
                                saveHistorialGCS().catch(() => {});
                                await sendBotMessage(remoteJid, {
                                    text: `🗑️ *Pedido #${n} eliminado*\n_${resumenPedidoEliminadoWhatsApp(rDel.removed)}_`,
                                });
                                return;
                            }

                            const mPadd = pCmd.match(/^#p\+([\d\s\-]{1,22})$/i);
                            if (mPadd) {
                                const soloRaw = mPadd[1].trim();
                                const solo = soloRaw.replace(/\D/g, '');
                                let dest = null;
                                if (/^\d{1,4}$/.test(soloRaw)) {
                                    const n = parseInt(soloRaw, 10);
                                    const refs = Array.isArray(sesion.pListaIndex) ? sesion.pListaIndex : [];
                                    const ref = refs[n - 1];
                                    if (ref?.remoteJid) dest = { jid: ref.remoteJid, etiqueta: `#${n}` };
                                }
                                if (!dest) {
                                    dest = await resolverDestinatarioAdmin(solo, sesion);
                                }
                                if (!dest) {
                                    await sendBotMessage(remoteJid, {
                                        text: '❌ No encontré ese cliente. Usá `#p+N` (de la lista) o `#p+549…` (tel).',
                                    });
                                    return;
                                }
                                const items = await firestoreModule.getUltimosMensajesChatItems(dest.jid, 24);
                                if (!items.length) {
                                    await sendBotMessage(remoteJid, {
                                        text: '❌ No hay mensajes guardados en Firestore para ese chat (¿el cliente nunca escribió o el log está vacío?). '
                                            + 'Podés cargar con *#pedido tel | servicio | texto*.',
                                    });
                                    return;
                                }
                                const extr = await extraerPedidoDesdeHiloAdmin(items);
                                if (!extr.ok || extr.reason === 'no_gemini') {
                                    await sendBotMessage(remoteJid, {
                                        text: extr.reason === 'no_gemini'
                                            ? '❌ Falta GEMINI_API_KEY en el servidor.'
                                            : `❌ No pude leer el pedido del hilo. ${extr.raw ? String(extr.raw).slice(0, 120) : ''}`,
                                    });
                                    return;
                                }
                                const d = extr.data || {};
                                const servicio = normalizarServicioPedidoAdmin(d.servicio);
                                let descripcion = String(d.descripcion || '').trim().replace(/\s+/g, ' ');
                                if (d.direccion && String(d.direccion).trim()) {
                                    descripcion += ` · Dir: ${String(d.direccion).trim()}`;
                                }
                                if (d.zona && String(d.zona).trim()) {
                                    descripcion += ` · Zona: ${String(d.zona).trim()}`;
                                }
                                if (!servicio || !descripcion) {
                                    await sendBotMessage(remoteJid, {
                                        text: `❌ Del chat no alcanzó para un pedido claro.\n_Gemini:_ ${descripcion || '(sin descripción)'}`
                                            + '\n\nCompletá vos con *#pedido tel | servicio | descripción* o reintentá cuando haya más mensajes.',
                                    });
                                    return;
                                }
                                const extraCliente = {};
                                if (d.direccion && String(d.direccion).trim()) extraCliente.direccion = String(d.direccion).trim();
                                if (d.zona && String(d.zona).trim()) extraCliente.zona = String(d.zona).trim();
                                const pedido = {
                                    servicio,
                                    descripcion,
                                    fecha: new Date().toISOString(),
                                    origenWhatsappAdmin: true,
                                };
                                actualizarEstadoCliente(dest.jid, { pedido, estado: 'cliente', ...extraCliente });
                                await syncClienteFirestoreDesdeHistorialLocal(dest.jid);
                                await sendBotMessage(remoteJid, {
                                    text: `✅ *Pedido (#p+)* — *${dest.etiqueta}*\n• ${servicio}: _${descripcion}_\n`
                                        + '_Inferido del hilo en Firestore + Gemini._',
                                });
                                return;
                            }

                            const mPsub = pCmd.match(/^#p\-([\d\s\-]{1,22})$/i);
                            if (mPsub) {
                                const soloRaw = mPsub[1].trim();
                                const solo = soloRaw.replace(/\D/g, '');
                                let dest = null;
                                if (/^\d{1,4}$/.test(soloRaw)) {
                                    const n = parseInt(soloRaw, 10);
                                    const refs = Array.isArray(sesion.pListaIndex) ? sesion.pListaIndex : [];
                                    const ref = refs[n - 1];
                                    if (ref?.remoteJid) dest = { jid: ref.remoteJid, etiqueta: `#${n}` };
                                }
                                if (!dest) {
                                    dest = await resolverDestinatarioAdmin(solo, sesion);
                                }
                                if (!dest) {
                                    await sendBotMessage(remoteJid, { text: '❌ No encontré ese cliente. Usá `#p-N` (de la lista) o `#p-549…` (tel).' });
                                    return;
                                }
                                const telSync = getTel(dest.jid);
                                let r = await firestoreModule.borrarPedidoClientePorIndice(telSync, { ultimo: true });
                                if (!r.ok && r.empty) {
                                    const c = asegurarCliente(dest.jid);
                                    const pa = [...(c.pedidosAnteriores || [])];
                                    if (pa.length === 0) {
                                        await sendBotMessage(remoteJid, { text: `❌ *${dest.etiqueta}* sin pedidos.` });
                                        return;
                                    }
                                    pa.pop();
                                    c.pedidosAnteriores = pa;
                                    saveHistorialGCS().catch(() => {});
                                    await syncClienteFirestoreDesdeHistorialLocal(dest.jid);
                                    await sendBotMessage(remoteJid, { text: `🗑️ *Último pedido eliminado* (${dest.etiqueta})` });
                                    return;
                                }
                                if (!r.ok) {
                                    await sendBotMessage(remoteJid, { text: `❌ ${r.error || 'No se pudo borrar.'}` });
                                    return;
                                }
                                const c2 = asegurarCliente(dest.jid);
                                c2.pedidosAnteriores = r.pedidosAnteriores;
                                saveHistorialGCS().catch(() => {});
                                await sendBotMessage(remoteJid, {
                                    text: `🗑️ *Último pedido eliminado* (${dest.etiqueta})\n_${resumenPedidoEliminadoWhatsApp(r.removed)}_`,
                                });
                                return;
                            }

                            await sendBotMessage(remoteJid, {
                                text: '❌ *#p* — no entendí el comando.\n\n'
                                    + '*#p lista* — ver todos los pedidos numerados\n'
                                    + '*#p lidmap* LID TEL — chat `@lid` → ficha `clientes/` (ej. `276883707060468 543516170743`). Sin negrita en el # si falla; probá *!!p lidmap* …\n'
                                    + '*#p tel* N cel — guardar tel en ítem N de la lista\n'
                                    + '*#p+N* — agregar leyendo el chat del ítem N (Gemini)\n'
                                    + '*#p-N* — quitar el *último* pedido del ítem N\n'
                                    + '*#p+*549…* — agregar leyendo el chat por teléfono (si está)\n'
                                    + '*#p-*549…* — quitar el *último* pedido por teléfono (si está)\n'
                                    + '*#p 12* — quitar el ítem 12 de la última *#p lista*\n\n'
                                    + 'Ej: `#p+3` `#p-3`',
                            });
                            return;
                        }

                        const mPedidoLista = tAdm.match(/^#pedido\s+lista\s+(.+)$/is);
                        if (mPedidoLista) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const dest = await resolverDestinatarioAdmin(mPedidoLista[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese cliente. Probá número, *último*, *#N*, nombre o sufijo *1234*.',
                                });
                                return;
                            }
                            const telSync = getTel(dest.jid);
                            const fr = await firestoreModule.getPedidosAnterioresClienteDoc(telSync);
                            let arr = (fr.pedidosAnteriores && fr.pedidosAnteriores.length > 0)
                                ? fr.pedidosAnteriores
                                : (getCliente(dest.jid)?.pedidosAnteriores || []);
                            const soloLocal = !(fr.pedidosAnteriores && fr.pedidosAnteriores.length > 0)
                                && (getCliente(dest.jid)?.pedidosAnteriores || []).length > 0;
                            if (!arr.length) {
                                await sendBotMessage(remoteJid, {
                                    text: `📋 *${dest.etiqueta}* — sin pedidos en historial.`,
                                });
                                return;
                            }
                            const lineas = arr.map((p, i) => pedidoLineaParaWhatsAppAdmin(i + 1, p)).join('\n');
                            const nota = soloLocal ? '\n_(Lista desde memoria local; Firestore vacío — al responder el cliente se alinea.)_\n' : '\n';
                            await sendBotMessage(remoteJid, {
                                text: `📋 *Pedidos — ${dest.etiqueta}* (${arr.length})${nota}\n${lineas}\n\n`
                                    + '_Borrar:_ `#pedido del` + mismo destino + `|` + número o `último`',
                            });
                            return;
                        }
                        const mPedidoDel = tAdm.match(/^#pedido\s+del\s+(.+?)\s*\|\s*(.+)$/is);
                        if (mPedidoDel) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const dest = await resolverDestinatarioAdmin(mPedidoDel[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese cliente.',
                                });
                                return;
                            }
                            const telSync = getTel(dest.jid);
                            const cual = mPedidoDel[2].trim().toLowerCase();
                            const ultimo = /^(último|ultimo)$/i.test(cual);
                            const index1Based = ultimo ? null : Number(cual);
                            let r = await firestoreModule.borrarPedidoClientePorIndice(telSync, {
                                ultimo,
                                index1Based: ultimo ? undefined : index1Based,
                            });
                            if (!r.ok && r.empty) {
                                const c = asegurarCliente(dest.jid);
                                const pa = [...(c.pedidosAnteriores || [])];
                                if (pa.length === 0) {
                                    await sendBotMessage(remoteJid, {
                                        text: `❌ *${dest.etiqueta}* no tiene pedidos para borrar.`,
                                    });
                                    return;
                                }
                                let idx;
                                if (ultimo) idx = pa.length - 1;
                                else if (Number.isFinite(index1Based) && index1Based >= 1 && index1Based <= pa.length) {
                                    idx = index1Based - 1;
                                } else {
                                    await sendBotMessage(remoteJid, {
                                        text: `❌ Índice inválido. Hay *${pa.length}* pedido(s): *1*–*${pa.length}* o *último*.`,
                                    });
                                    return;
                                }
                                const removed = pa.splice(idx, 1)[0];
                                c.pedidosAnteriores = pa;
                                saveHistorialGCS().catch(() => {});
                                await syncClienteFirestoreDesdeHistorialLocal(dest.jid);
                                await sendBotMessage(remoteJid, {
                                    text: `🗑️ *Pedido eliminado* (${dest.etiqueta})\n_${resumenPedidoEliminadoWhatsApp(removed)}_`,
                                });
                                return;
                            }
                            if (!r.ok) {
                                await sendBotMessage(remoteJid, {
                                    text: `❌ ${r.error || 'No se pudo borrar.'}`,
                                });
                                return;
                            }
                            const c2 = asegurarCliente(dest.jid);
                            c2.pedidosAnteriores = r.pedidosAnteriores;
                            saveHistorialGCS().catch(() => {});
                            await sendBotMessage(remoteJid, {
                                text: `🗑️ *Pedido eliminado* (${dest.etiqueta})\n_${resumenPedidoEliminadoWhatsApp(r.removed)}_`,
                            });
                            return;
                        }
                        const mPedidoAdm = tAdm.match(/^#pedido\s+(.+)$/is);
                        if (mPedidoAdm) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const cuerpo = mPedidoAdm[1].trim();
                            const tri = cuerpo.match(/^(.+?)\s*\|\s*(\S+)\s*\|\s*([\s\S]+)$/);
                            if (!tri) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ *Comandos #pedido*\n\n'
                                        + '*Listar:* `#pedido lista` + destino\n'
                                        + 'Ej: `#pedido lista 5493512345678` o `#pedido lista último`\n\n'
                                        + '*Agregar:* `#pedido` + destino + `|` + servicio + `|` + descripción\n'
                                        + 'Servicios: lena, cerco, pergola, fogonero, bancos, madera\n\n'
                                        + '*Borrar:* `#pedido del` + destino + `|` + número o `último`\n'
                                        + 'Ej: `#pedido del 5493512345678 | 2` o `#pedido del último | último`\n\n'
                                        + '_Agregar — ejemplo:_\n'
                                        + '`#pedido 5493512345678 | lena | 300kg quebracho`',
                                });
                                return;
                            }
                            const dest = await resolverDestinatarioAdmin(tri[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese cliente. Probá número completo, *último*, *#N* (con lista), nombre o sufijo *1234*.',
                                });
                                return;
                            }
                            const servicio = normalizarServicioPedidoAdmin(tri[2]);
                            const descripcion = tri[3].trim().replace(/\s+/g, ' ');
                            if (!servicio) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ Servicio no válido. Usá: *lena*, *cerco*, *pergola*, *fogonero*, *bancos*, *madera*.',
                                });
                                return;
                            }
                            if (!descripcion) {
                                await sendBotMessage(remoteJid, { text: '❌ Falta la descripción del pedido (después del segundo |).' });
                                return;
                            }
                            const pedido = {
                                servicio,
                                descripcion,
                                fecha: new Date().toISOString(),
                                origenWhatsappAdmin: true,
                            };
                            actualizarEstadoCliente(dest.jid, { pedido, estado: 'cliente' });
                            await syncClienteFirestoreDesdeHistorialLocal(dest.jid);
                            await sendBotMessage(remoteJid, {
                                text: `✅ *Pedido registrado* para *${dest.etiqueta}*\n`
                                    + `• ${servicio}: _${descripcion}_\n`
                                    + 'Aparece en *#reporte* → *detalle pedidos* y en el panel.',
                            });
                            return;
                        }
                        const mRg = tAdm.match(/^#ruta_geo\s+(\S+)\s+(.+)$/i);
                        if (mRg) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            await ejecutarCampanaRutaGeo(remoteJid, mRg[1].trim(), mRg[2].trim());
                            return;
                        }
                        const mR = tAdm.match(/^#ruta\s+(\S+)\s+(.+)$/i);
                        if (mR) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            await ejecutarCampanaRuta(remoteJid, mR[1].trim(), mR[2].trim());
                            return;
                        }
                        const mEnv = tAdm.match(/^#enviar\s+(\S+)\s+([\s\S]+)$/i);
                        if (mEnv) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const segmento = mEnv[1].trim();
                            const cuerpo = mEnv[2].trim();
                            if (!cuerpo) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ Falta el texto. Ej: *#enviar clientes Buenas tardes, te queremos avisar…* o *#enviar leña …*',
                                });
                                return;
                            }
                            await ejecutarBroadcastMasivo(remoteJid, segmento, cuerpo);
                            return;
                        }
                        const tAdmTrim = tAdm.trim();
                        if (/^#silencio\s+(global|todos)\s*$/i.test(tAdmTrim)) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const r = await firestoreModule.setBotActivoGlobal(false);
                            await sendBotMessage(remoteJid, {
                                text: r.ok
                                    ? '🔇 *Vicky silenciada para todos los chats.* Nadie recibe respuesta automática hasta *#activo global* o *#vicky activa* (o panel → General → bot activo).'
                                    : `❌ No se pudo actualizar: ${r.error || 'error'}`,
                            });
                            return;
                        }
                        if (/^#activo\s+parcial\s*$/i.test(tAdmTrim) || /^#vicky\s+parcial\s*$/i.test(tAdmTrim)) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const r = await firestoreModule.setBotActivoGlobal(true);
                            let nPar = 0;
                            if (r.ok) {
                                const rP = await firestoreModule.reactivarChatsParcialDesdeFirestore();
                                if (!rP.ok) {
                                    console.warn('⚠️ #activo parcial reactivarChatsParcial:', rP.error);
                                }
                                nPar = rP.total ?? 0;
                                const lista = rP.reactivados || [];
                                for (const jid of lista) {
                                    const sCl = SESSIONS.get(jid);
                                    if (sCl) {
                                        sCl.humanAtendiendo = false;
                                        sCl.humanTimestamp = null;
                                    }
                                }
                                reactivarVickyTrasSalirAdmin(remoteJid);
                            }
                            await sendBotMessage(remoteJid, {
                                text: r.ok
                                    ? `🔊 *Vicky activa (parcial).* Bot global encendido. Se reactivaron *${nPar}* chat(s) que *no* tenían \`humanoAtendiendo\` (intervención / #silenciar). Ese tipo de chats *no* se tocan acá; usá *#activo global* para forzar todo o *#activar* + contacto.\n\n_#estado_ lista humano vs silencio programado.`
                                    : `❌ No se pudo actualizar: ${r.error || 'error'}`,
                            });
                            return;
                        }
                        if (/^#activo\s+global\s*$/i.test(tAdmTrim) || /^#vicky\s+activa\s*$/i.test(tAdmTrim) || /^#vicky\s+on\s*$/i.test(tAdmTrim)) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const r = await firestoreModule.setBotActivoGlobal(true);
                            let nTot = 0;
                            if (r.ok) {
                                reactivarVickyTrasSalirAdmin(remoteJid);
                                const rAll = await firestoreModule.reactivarTodosLosChatsDesdeFirestore();
                                if (!rAll.ok) {
                                    console.warn('⚠️ #activo global reactivarTodosChats:', rAll.error);
                                }
                                nTot = rAll.total ?? 0;
                                limpiarHumanosLocalesSesiones();
                            }
                            await sendBotMessage(remoteJid, {
                                text: r.ok
                                    ? `🔊 *Vicky activa (global).* Bot encendido y *todos* los chats en Firestore reactivados (incluye silenciados por humano y silencio programado). Total docs \`chats\` actualizados: *${nTot}*. Memoria local de silencio humano: limpiada.`
                                    : `❌ No se pudo actualizar: ${r.error || 'error'}`,
                            });
                            return;
                        }
                        if (/^#estado\s*$/i.test(tAdmTrim)) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const estadoTxt = await firestoreModule.getEstadoVickyParaAdminTexto();
                            await sendBotMessage(remoteJid, { text: estadoTxt });
                            return;
                        }
                        const mSil1 = tAdm.match(/^#silenciar\s+([\s\S]+)$/i);
                        if (mSil1) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const dest = await resolverDestinatarioAdmin(mSil1[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese contacto. *Vicky lista*, número, nombre, *último* o *#N*.',
                                });
                                return;
                            }
                            await firestoreModule.setHumanoAtendiendo(dest.jid, true);
                            const sCl = SESSIONS.get(dest.jid);
                            if (sCl) {
                                sCl.humanAtendiendo = true;
                                sCl.humanTimestamp = Date.now();
                            }
                            await sendBotMessage(remoteJid, {
                                text: `🔇 Vicky *silenciada* solo en *${dest.etiqueta}*.\nReactivar: *#activar* + mismo criterio (nombre, número, *último*, *#N*) o desde el panel.`,
                            });
                            return;
                        }
                        const mAct1 = tAdm.match(/^#activar\s+([\s\S]+)$/i);
                        if (mAct1) {
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: 'Firestore no disponible.' });
                                return;
                            }
                            const dest = await resolverDestinatarioAdmin(mAct1[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese contacto para reactivar.',
                                });
                                return;
                            }
                            await firestoreModule.reactivarBotEnChat(dest.jid);
                            const sCl = SESSIONS.get(dest.jid);
                            if (sCl) {
                                sCl.humanAtendiendo = false;
                                sCl.humanTimestamp = null;
                            }
                            await sendBotMessage(remoteJid, {
                                text: `🔊 Vicky *reactivada* en chat *${dest.etiqueta}*.`,
                            });
                            return;
                        }
                        if (/^#c\s*$/i.test(tAdm.trim())) {
                            limpiarCapturasGemini();
                            sesion.esperandoSelectorPuente = true;
                            sesion.modoBridge = false;
                            sesion.bridgeTarget = null;
                            sesion.destinatarioPendiente = null;
                            await sendBotMessage(remoteJid, {
                                text: '🌉 *Modo puente — elegí cliente*\n\n'
                                    + 'Mandá *solo texto* con una de estas opciones:\n'
                                    + '• *#3* o *3* (número de la lista; antes *Vicky lista* si hace falta)\n'
                                    + '• *Nombre* del contacto\n'
                                    + '• *Número completo* con código de país\n'
                                    + '• *último* → el que escribió más reciente\n\n'
                                    + 'Después: *texto o audio* para el cliente, o *#entrega* para cargar el día en **Agenda de entregas**.'
                            });
                            return;
                        }
                        const mC = tAdm.match(/^#c\s+(.+)$/is);
                        if (mC) {
                            limpiarCapturaPuente();
                            limpiarCapturasGemini();
                            const dest = await resolverDestinatarioAdmin(mC[1].trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, { text: '❌ No encontré ese contacto. Probá número o nombre, o "Vicky lista".' });
                                return;
                            }
                            sesion.modoBridge = true;
                            sesion.bridgeTarget = dest;
                            sesion.destinatarioPendiente = null;
                            await sendBotMessage(remoteJid, {
                                text: `🌉 *Modo puente* → *${dest.etiqueta}*\n`
                                    + 'Mandá *texto o audio* con lo que querés que Vicky le diga (Gemini lo redacta y lo envía).\n'
                                    + '*#entrega* con fecha + hora + título → calendario **Agenda de entregas** (Firestore).\n'
                                    + 'Otro cliente: *#c*. Salir: *#SALIR* / *adminoff*.'
                            });
                            return;
                        }
                        if (/^#entrega\s+lista\b/i.test(String(tAdm || '').trim()) && !tieneAudioMsg) {
                            sesion.destinatarioPendiente = null;
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: '❌ Firestore no disponible.' });
                                return;
                            }
                            const restLista = String(tAdm || '')
                                .trim()
                                .replace(/^#entrega\s+lista\s*/i, '')
                                .trim()
                                .toLowerCase();
                            const incluirTodas = /^(todas?|todo|all)\s*$/i.test(restLista);
                            if (restLista && !incluirTodas) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ Usá *#entrega lista* o *#entrega lista todas* (incluye canceladas). *!!entrega lista* si # falla.',
                                });
                                return;
                            }
                            const txtLista = await firestoreModule.getTextoEntregaAgendaListaAdmin({
                                maxRows: 32,
                                incluirCanceladas: incluirTodas,
                            });
                            await sendBotMessage(remoteJid, { text: txtLista });
                            return;
                        }
                        const mEntregaGemTel = tAdm.match(/^#entrega\s+(\d{10,15})(?:\s+([\s\S]+))?\s*$/i);
                        if (mEntregaGemTel && !tieneAudioMsg) {
                            sesion.destinatarioPendiente = null;
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: '❌ Firestore no disponible.' });
                                return;
                            }
                            if (!process.env.GEMINI_API_KEY) {
                                await sendBotMessage(remoteJid, { text: '❌ Falta GEMINI_API_KEY en el servidor.' });
                                return;
                            }
                            const soloTel = mEntregaGemTel[1];
                            const notaDue = (mEntregaGemTel[2] || '').trim();
                            let dest = await resolverDestinatarioAdmin(soloTel, sesion);
                            if (!dest) {
                                const fsR = await firestoreModule.resolverJidClientePorVariantesTelefono(soloTel);
                                if (fsR) {
                                    dest = {
                                        jid: fsR.jid,
                                        etiqueta: fsR.nombre || fsR.docId || soloTel,
                                    };
                                }
                            }
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré cliente con ese número (WhatsApp ni `clientes/…` en Firestore).\n'
                                        + 'Probá con 549… o 5435… sin espacios, o *#c* + *#entrega YYYY-MM-DD …* manual.',
                                });
                                return;
                            }
                            const targetJid = dest.jid;
                            const items = await firestoreModule.getUltimosMensajesChatItems(targetJid, 30);
                            const c = getCliente(targetJid);
                            const crmParts = [];
                            if (c?.nombre) crmParts.push(`Nombre: ${c.nombre}`);
                            if (c?.pushName) crmParts.push(`pushName: ${c.pushName}`);
                            if (c?.telefono) crmParts.push(`Tel línea: ${c.telefono}`);
                            if (c?.direccion) crmParts.push(`Dirección: ${c.direccion}`);
                            if (c?.zona) crmParts.push(`Zona: ${c.zona}`);
                            if (c?.servicioPendiente) crmParts.push(`Servicio pendiente: ${c.servicioPendiente}`);
                            if (Array.isArray(c?.pedidosAnteriores) && c.pedidosAnteriores.length > 0) {
                                const u = c.pedidosAnteriores[c.pedidosAnteriores.length - 1];
                                if (u?.descripcion) {
                                    crmParts.push(`Último pedido: ${String(u.descripcion).slice(0, 400)}`);
                                }
                            }
                            const crmResumen = crmParts.join('\n') || '(pocos datos en historial local del bot)';
                            await sendBotMessage(remoteJid, {
                                text: `⏳ *#entrega* + tel → leo hilo y CRM de *${dest.etiqueta}* y pido fecha a Gemini…`,
                            });
                            const extr = await extraerEntregaAgendaDesdeContextoAdmin({
                                items,
                                crmResumen,
                                notaDueño: notaDue,
                            });
                            if (!extr.ok) {
                                await sendBotMessage(remoteJid, {
                                    text:
                                        extr.reason === 'no_gemini'
                                            ? '❌ Sin Gemini.'
                                            : `❌ No pude interpretar la respuesta. ${extr.raw ? String(extr.raw).slice(0, 160) : ''}`,
                                });
                                return;
                            }
                            const d0 = extr.data || {};
                            const fechaDia = d0.fechaDia != null ? String(d0.fechaDia).trim() : '';
                            const titGem = d0.titulo != null ? String(d0.titulo).trim() : '';
                            const horaGem = d0.horaTexto != null && String(d0.horaTexto).trim()
                                ? String(d0.horaTexto).trim()
                                : null;
                            if (!fechaDia || !/^\d{4}-\d{2}-\d{2}$/.test(fechaDia) || !titGem) {
                                const mot = d0.motivo ? String(d0.motivo).trim() : 'No hay día concreto en el hilo o CRM.';
                                await sendBotMessage(remoteJid, {
                                    text:
                                        `⚠️ *Gemini no alcanzó a fijar una fecha*\n_${mot}_\n\n`
                                        + 'Cargá manual: `#entrega YYYY-MM-DD HH:mm|-- título` con *#c* al cliente, o desde el panel **Agenda de entregas**.',
                                });
                                return;
                            }
                            const horaTexto = horaGem && horaGem !== '--' ? horaGem : null;
                            const cliEnt = getCliente(targetJid);
                            const telC = telefonoLineaParaFirestore(targetJid, cliEnt);
                            const productoParts = [];
                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));
                            const paE = cliEnt?.pedidosAnteriores;
                            if (Array.isArray(paE) && paE.length > 0) {
                                const u = paE[paE.length - 1]?.descripcion;
                                if (u) productoParts.push(String(u).slice(0, 220));
                            }
                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;
                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion, notaDue || null].filter(Boolean);
                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;
                            const idAg2 = await firestoreModule.addEntregaAgenda({
                                jid: targetJid,
                                fechaDia,
                                horaTexto,
                                titulo: titGem.slice(0, 500),
                                notas: notasStr,
                                kg: null,
                                origen: 'whatsapp_admin_entrega_gemini',
                                telefonoContacto: telC,
                                direccion: cliEnt?.direccion || null,
                                producto: productoStr,
                            });
                            if (!idAg2) {
                                await sendBotMessage(remoteJid, { text: '❌ Fecha inválida o error al guardar en Firestore.' });
                                return;
                            }
                            await sendBotMessage(remoteJid, {
                                text:
                                    `✅ *Agenda* (Gemini + CRM + hilo)\n• Día: \`${fechaDia}\`\n`
                                    + (horaTexto ? `• Hora: \`${horaTexto}\`\n` : '• Hora: (día completo / sin hora)\n')
                                    + `• \`${titGem.length > 200 ? `${titGem.slice(0, 200)}…` : titGem}\`\n`
                                    + `• Chat: \`${targetJid}\`\n`
                                    + '_Panel → Agenda de entregas._',
                            });
                            return;
                        }
                        const mEntregaAdm = tAdm.match(/^#entrega\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s+([\s\S]+)$/i);
                        if (mEntregaAdm && !tieneAudioMsg) {
                            sesion.destinatarioPendiente = null;
                            limpiarCapturasGemini();
                            limpiarCapturaPuente();
                            if (!firestoreModule.isAvailable()) {
                                await sendBotMessage(remoteJid, { text: '❌ Firestore no disponible.' });
                                return;
                            }
                            const fechaDia = mEntregaAdm[1];
                            const horaRaw = (mEntregaAdm[2] || '').trim();
                            const tail = (mEntregaAdm[3] || '').trim();
                            const horaTexto = horaRaw && horaRaw !== '--' ? horaRaw : null;
                            const jidExplicit = tail.match(/^(\d+@(?:s\.whatsapp\.net|lid))\s+([\s\S]+)$/i);
                            let targetJid;
                            let tituloEnt;
                            if (jidExplicit) {
                                targetJid = jidExplicit[1];
                                tituloEnt = jidExplicit[2].trim();
                            } else if (sesion.modoBridge && sesion.bridgeTarget?.jid) {
                                targetJid = sesion.bridgeTarget.jid;
                                tituloEnt = tail;
                            } else {
                                await sendBotMessage(remoteJid, {
                                    text:
                                        '📅 *#entrega* — mismo calendario que `[ENTREGA:…]` de Vicky (panel **Agenda de entregas**).\n\n'
                                        + '*Opción A — con puente al cliente que estás atendiendo:*\n'
                                        + '1) *#c* + nombre o número (o *#c* y elegí de la lista)\n'
                                        + '2) `#entrega YYYY-MM-DD HH:mm título del evento`\n'
                                        + '   Solo día: `#entrega YYYY-MM-DD -- Entrega leña coordinada`\n\n'
                                        + '*Opción B — sin puente:* JID completo y después el título:\n'
                                        + '`#entrega YYYY-MM-DD 09:00 5493512…@s.whatsapp.net 1 tn leña`\n'
                                        + '`#entrega YYYY-MM-DD -- 276…@lid Obra cerco`\n\n'
                                        + '*Opción C — solo teléfono (10–15 dígitos seguidos):* Vicky/Gemini lee CRM + hilo Firestore e intenta armar fecha y título:\n'
                                        + '`#entrega 543516170743` o `#entrega 5493516170743 texto opcional para Gemini`\n\n'
                                        + '*Listar próximos eventos (desde hoy, hora Argentina):* *#entrega lista* · con canceladas: *#entrega lista todas*\n\n'
                                        + '_No uses #g para esto: #g es solo instructivo de Gemini al system prompt._',
                                });
                                return;
                            }
                            if (!tituloEnt) {
                                await sendBotMessage(remoteJid, { text: '❌ Falta el título del evento.' });
                                return;
                            }
                            const cliEnt = getCliente(targetJid);
                            const telC = telefonoLineaParaFirestore(targetJid, cliEnt);
                            const productoParts = [];
                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));
                            const paE = cliEnt?.pedidosAnteriores;
                            if (Array.isArray(paE) && paE.length > 0) {
                                const u = paE[paE.length - 1]?.descripcion;
                                if (u) productoParts.push(String(u).slice(0, 220));
                            }
                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;
                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);
                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;
                            const idAg = await firestoreModule.addEntregaAgenda({
                                jid: targetJid,
                                fechaDia,
                                horaTexto,
                                titulo: tituloEnt,
                                notas: notasStr,
                                kg: null,
                                origen: 'whatsapp_admin_entrega',
                                telefonoContacto: telC,
                                direccion: cliEnt?.direccion || null,
                                producto: productoStr,
                            });
                            if (!idAg) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD o probá de nuevo).',
                                });
                                return;
                            }
                            await sendBotMessage(remoteJid, {
                                text:
                                    `✅ *Agenda de entregas*\n• Día: \`${fechaDia}\`\n`
                                    + (horaTexto ? `• Hora: \`${horaTexto}\`\n` : '• Hora: (todo el día / sin hora fija)\n')
                                    + `• \`${tituloEnt.length > 220 ? `${tituloEnt.slice(0, 220)}…` : tituloEnt}\`\n`
                                    + `• Chat: \`${targetJid}\`\n`
                                    + '_Visible en el panel → Agenda de entregas._',
                            });
                            return;
                        }
                        if (/^#g\s*$/i.test(tAdm.trim())) {
                            limpiarCapturaPuente();
                            sesion.esperandoInstructivoGemini = true;
                            sesion.borradorGeminiPreview = null;
                            await sendBotMessage(remoteJid, {
                                text: '📝 *Listo para el instructivo de Gemini*\n\n'
                                    + 'Mandá *texto* o *audio* con la instrucción para el system prompt.\n'
                                    + 'Si es audio, lo transcribo y te muestro el texto.\n'
                                    + 'Después *OK* para *aplicarlo* al system prompt de Vicky; *NO* para descartar.\n\n'
                                    + '_Tip: *!!g* o *vicky:g* si el # no te lo toma WhatsApp. En una línea: *!!g* + instructivo._'
                            });
                            return;
                        }
                        const mG = tAdm.match(/^#g\s+([\s\S]+)/i);
                        if (mG) {
                            limpiarCapturaPuente();
                            sesion.esperandoInstructivoGemini = false;
                            const cuerpo = mG[1].trim();
                            sesion.borradorGeminiPreview = cuerpo;
                            await sendBotMessage(remoteJid, {
                                text: `📋 *Vista previa* — se sumará al system prompt:\n\n_${cuerpo.slice(0, 3500)}${cuerpo.length > 3500 ? '…' : ''}_\n\n`
                                    + '✅ *OK* → aplicar.\n❌ *NO* → descartar.'
                            });
                            return;
                        }
                    }

                    // ── 3) #c en dos pasos: llegó el selector de cliente (texto)
                    if (sesion.esperandoSelectorPuente) {
                        if (tieneAudioMsg) {
                            await sendBotMessage(remoteJid, {
                                text: '⚠️ En este paso mandá solo *texto*: *#3*, *nombre*, *número completo* o *último*.'
                            });
                            return;
                        }
                        if (tAdm) {
                            const dest = await resolverDestinatarioAdmin(tAdm.trim(), sesion);
                            if (!dest) {
                                await sendBotMessage(remoteJid, {
                                    text: '❌ No encontré ese contacto. *Vicky lista* y elegí *#n*, o pasá *nombre* / *número completo*.'
                                });
                                return;
                            }
                            sesion.esperandoSelectorPuente = false;
                            sesion.modoBridge = true;
                            sesion.bridgeTarget = dest;
                            sesion.destinatarioPendiente = null;
                            await sendBotMessage(remoteJid, {
                                text: `👤 *${dest.etiqueta}* listo.\n\n`
                                    + 'Mandá *texto o audio* con lo que querés que Vicky le diga al cliente, o *#entrega YYYY-MM-DD HH:mm título* para la agenda.\n\n'
                                    + 'Otro cliente: *#c*. Salir: *#SALIR* / *adminoff*.'
                            });
                            return;
                        }
                    }

                    // ── 4) #g en dos pasos: llegó texto o audio del instructivo
                    const esPalabraCortaConfirma = tAdm && /^(ok|dale|s[íi]|listo|guardar|confirmo|no|cancelar|cancel)\s*$/i.test(tAdm.trim());
                    if (sesion.esperandoInstructivoGemini && (tieneAudioMsg || (tAdm && !tAdm.trimStart().startsWith('#') && !esPalabraCortaConfirma))) {
                        let textoInst = '';
                        let mimeAudio = 'audio/ogg';
                        if (tieneAudioMsg) {
                            try {
                                const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                                    logger: pino({ level: 'silent' }),
                                    reuploadRequest: socket.updateMediaMessage
                                });
                                const am = msg.message.audioMessage || msg.message.pttMessage;
                                if (am?.mimetype) mimeAudio = am.mimetype;
                                textoInst = await transcribirAudioInstructivoGemini(buf.toString('base64'), mimeAudio);
                            } catch (e) {
                                console.error('❌ Audio instructivo:', e.message);
                                await sendBotMessage(remoteJid, { text: `❌ No pude leer el audio: ${e.message}` });
                                return;
                            }
                        } else {
                            textoInst = tAdm.trim();
                        }
                        if (!textoInst) {
                            await sendBotMessage(remoteJid, { text: '⚠️ No capté texto. Repetí el *audio* o escribí el instructivo.' });
                            return;
                        }
                        sesion.esperandoInstructivoGemini = false;
                        sesion.borradorGeminiPreview = textoInst;
                        await sendBotMessage(remoteJid, {
                            text: `📋 *Vista previa* — se sumará al system prompt:\n\n_${textoInst.slice(0, 3500)}${textoInst.length > 3500 ? '…' : ''}_\n\n`
                                + '✅ *OK* → aplicar.\n❌ *NO* → descartar.'
                        });
                        return;
                    }

                    // Modo puente: reenviar al cliente (Gemini) salvo comandos # explícitos
                    if (sesion?.modoBridge && sesion.bridgeTarget && (tieneAudioMsg || tAdm)) {
                        const esComandoHash = /^#\s*(g|ruta|c|reporte|salir|enviar|silencio|silenciar|activar|activo|vicky|entrega)\b/i.test(tAdm)
                            || /^#\s*estado\s*$/i.test(tAdm);
                        if (tieneAudioMsg || (tAdm && !esComandoHash)) {
                            let audioB64 = null;
                            if (tieneAudioMsg) {
                                try {
                                    const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                                        logger: pino({ level: 'silent' }),
                                        reuploadRequest: socket.updateMediaMessage
                                    });
                                    audioB64 = buf.toString('base64');
                                } catch (e) {
                                    console.error('❌ Audio puente:', e.message);
                                }
                            }
                            try {
                                await enviarGeminiAdminACliente(
                                    remoteJid,
                                    sesion.bridgeTarget.jid,
                                    sesion.bridgeTarget.etiqueta,
                                    tieneAudioMsg ? '' : tAdm,
                                    audioB64,
                                    enviarImagen
                                );
                            } catch (err) {
                                await sendBotMessage(remoteJid, { text: `❌ Puente: ${err.message}` });
                            }
                            return;
                        }
                    }

                    // ── Activación sin instrucción (p. ej. solo frase secreta ya mostró menú; reingreso vacío)
                    if (!tieneAudioMsg && !instruccionTexto) {
                        if (sesion?.esperandoMenuPrincipal) {
                            await sendBotMessage(remoteJid, {
                                text: 'Elegí *1*–*4* o escribí *menu*. Para comandos con almohadilla, mandalos con *#* al inicio.',
                            });
                        } else {
                            await sendBotMessage(remoteJid, {
                                text: '🔑 Sesión admin activada. ¿A quién le mando?\n\n_Mandá el número, el nombre o elegí de la lista con "Vicky lista"._',
                            });
                        }
                        return;
                    }

                    if (tieneAudioMsg || instruccionTexto) {
                        console.log(`🔑 Comando admin desde ${remoteJid} (${esFraseAdmin ? 'frase secreta' : 'sesión activa'})`);

                        sesion = adminSesionesActivas.get(remoteJid);

                        // ── PASO 2: hay destinatario pendiente + llega audio o texto con contenido
                        if (sesion?.destinatarioPendiente && (tieneAudioMsg || instruccionTexto)) {
                            const { jid: jidDestino, etiqueta } = sesion.destinatarioPendiente;

                            let audioAdminBase64 = null;
                            if (tieneAudioMsg) {
                                try {
                                    const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                                        logger: pino({ level: 'silent' }),
                                        reuploadRequest: socket.updateMediaMessage
                                    });
                                    audioAdminBase64 = buf.toString('base64');
                                } catch (e) {
                                    console.error('❌ Error descargando audio admin:', e.message);
                                }
                            }

                            try {
                                // Usar Gemini con el SYSTEM_PROMPT de Vicky para que interprete
                                // la instrucción del admin y genere la respuesta completa al cliente
                                // (puede incluir catálogos, imágenes, info de servicios, etc.)
                                if (!vickyGeminiModel) throw new Error('Gemini no inicializado');

                                const ctxAdmin = `[INSTRUCCION_ADMIN] ⚠️ IMPORTANTE: Lo que viene a continuación es una INSTRUCCIÓN del dueño del negocio, NO un mensaje del cliente.
El dueño te dice qué querés decirle o preguntarle al cliente. Tu tarea es generar el mensaje que Vicky le enviaría AL cliente.
NO respondas como si el cliente te hubiese preguntado algo. Generá el mensaje que va para el cliente, en primera persona como Vicky.
No saludes si la relación ya está establecida. Usá [IMG:lena|cerco|pergola|fogonero] si el dueño pide catálogos.
Ejemplos de cómo traducir instrucciones:
- "Preguntale si lo podemos ayudar" → "Hola! Pasaba a ver si te podemos ayudar en algo 😊"
- "Decile que el pedido llega mañana" → "Tu pedido llega mañana! Cualquier cosa avisame."
- "Mandá el catálogo de leña" → [el texto con los precios de leña] [IMG:lena]
- "Avisale que pasamos el jueves a las 10" → "Confirmamos que pasamos el jueves a las 10. Cualquier cambio te aviso."`;
                                let partesAdmin;
                                if (audioAdminBase64) {
                                    partesAdmin = [
                                        { text: ctxAdmin },
                                        { inlineData: { data: audioAdminBase64, mimeType: 'audio/ogg' } },
                                        { text: 'Transcribí la instrucción del dueño del audio y generá el mensaje que Vicky le envía AL cliente. Recordá: el audio es una instrucción, no un mensaje del cliente.' }
                                    ];
                                } else {
                                    partesAdmin = [{ text: `${ctxAdmin}\nInstrucción del dueño: "${instruccionTexto}"\n\nGenerá el mensaje para el cliente:` }];
                                }

                                const chatAdmin = vickyGeminiModel.startChat({ history: [] });
                                const resultAdmin = await chatAdmin.sendMessage(partesAdmin);
                                let respuestaAdmin = resultAdmin.response.text().trim();
                                console.log(`🔑 Respuesta Gemini 2-pasos: ${respuestaAdmin.substring(0, 120)}`);

                                // Procesar [IMG:xxx] → enviar imagen/video del catálogo
                                const imgMatchAdmin = respuestaAdmin.match(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/i);
                                respuestaAdmin = respuestaAdmin.replace(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/gi, '').trim();

                                // Procesar [PDF_CERCO:metros|precioUnit|alturaM|descuentoPct]
                                const pdfAdminMatch = respuestaAdmin.match(/\[PDF_CERCO:([^\]]+)\]/i);
                                respuestaAdmin = respuestaAdmin.replace(/\[PDF_CERCO:[^\]]+\]/gi, '').trim();

                                // Limpiar otros marcadores internos que no aplican al envío directo
                                respuestaAdmin = respuestaAdmin
                                    .replace(/\[COTIZACION:[^\]]+\]/gi, '')
                                    .replace(/\[CONFIRMADO\]/gi, '')
                                    .replace(/\[NOMBRE:[^\]]+\]/gi, '')
                                    .replace(/\[DIRECCION:[^\]]+\]/gi, '')
                                    .replace(/\[ZONA:[^\]]+\]/gi, '')
        .replace(/\[BARRIO:[^\]]+\]/gi, '')
        .replace(/\[LOCALIDAD:[^\]]+\]/gi, '')
        .replace(/\[REFERENCIA:[^\]]+\]/gi, '')
        .replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '')
                                    .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
                                    .replace(/\[PEDIDO:[^\]]+\]/gi, '')
                                    .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
                                    .replace(/\[AUDIO_CORTO:[^\]]+\]/gi, '')
                                    .replace(/\[AUDIO_FIDELIZAR:[^\]]+\]/gi, '')
                                    .trim();

                                // Enviar texto al cliente
                                if (respuestaAdmin.length > 0) {
                                    await sendBotMessage(jidDestino, { text: respuestaAdmin });
                                }

                                // Enviar imagen/video del catálogo si corresponde
                                if (imgMatchAdmin) {
                                    await enviarImagen(jidDestino, imgMatchAdmin[1].toLowerCase());
                                }

                                // Generar y enviar PDF de cerco si corresponde
                                if (pdfAdminMatch) {
                                    const partesPdf = pdfAdminMatch[1].split('|');
                                    const metros = parseFloat(partesPdf[0]) || 0;
                                    const precioUnit = parseFloat(partesPdf[1]) || 0;
                                    const alturaM = partesPdf[2] || '1.8';
                                    const descuentoPct = parseFloat(partesPdf[3]) || 0;
                                    const nombreClientePdf = getCliente(jidDestino)?.nombre || etiqueta;
                                    if (metros > 0 && precioUnit > 0) {
                                        generarPresupuestoCercoPDF({ cliente: nombreClientePdf, metros, precioUnit, alturaM, descuentoPct })
                                            .then(async (pdfPath) => {
                                                if (pdfPath) {
                                                    await sendBotMessage(jidDestino, {
                                                        document: fs.readFileSync(pdfPath),
                                                        mimetype: 'application/pdf',
                                                        fileName: `Presupuesto Cerco - ${nombreClientePdf}.pdf`
                                                    });
                                                    fs.unlinkSync(pdfPath);
                                                }
                                            }).catch(err => console.error('❌ Error PDF cerco 2-pasos:', err.message));
                                    }
                                }

                                console.log(`📤 Mensaje 2-pasos enviado a ${etiqueta} (${jidDestino})`);
                                const resumen = respuestaAdmin.length > 0
                                    ? `\n\n_"${respuestaAdmin.substring(0, 120)}${respuestaAdmin.length > 120 ? '…' : ''}"_`
                                    : (imgMatchAdmin ? `\n\n_[imagen de ${imgMatchAdmin[1]}]_` : '');
                                await sendBotMessage(remoteJid, {
                                    text: `✅ Enviado a *${etiqueta}*${resumen}`
                                });

                                // Limpiar destinatario para el próximo envío
                                sesion.destinatarioPendiente = null;
                            } catch (err) {
                                console.error('❌ Error en envío 2-pasos:', err.message);
                                await sendBotMessage(remoteJid, { text: `❌ Error al enviar: ${err.message}` });
                            }
                            return;
                        }

                        // ── PASO 1: llega texto sin audio → intentar resolver como destinatario
                        if (!tieneAudioMsg && instruccionTexto) {
                            const destinatario = await resolverDestinatarioAdmin(instruccionTexto, sesion);
                            if (destinatario) {
                                // Es un destinatario reconocible → guardarlo y pedir el contenido
                                if (sesion) sesion.destinatarioPendiente = destinatario;
                                await sendBotMessage(remoteJid, {
                                    text: `👤 Listo, ¿qué le mando a *${destinatario.etiqueta}*?\n\n`
                                        + '_Mandá el audio o escribí el mensaje que Vicky le tiene que decir al cliente._\n\n'
                                        + '_No era esto:_ si querías cargar la **agenda** con Gemini, mandá en un mensaje nuevo '
                                        + '*#entrega* seguido del tel (ej. `#entrega 3516170743`) o *!!entrega* si WhatsApp come el #. '
                                        + '_Para salir de este paso sin enviar nada:_ *adminoff* y volvé a entrar con la frase secreta.',
                                });
                                return;
                            }
                            // No es un destinatario simple → es una instrucción completa, flujo original
                        }

                        // ── FLUJO ORIGINAL (fallback): audio o instrucción completa con destinatario incluido
                        let audioAdminBase64 = null;
                        if (tieneAudioMsg) {
                            try {
                                const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                                    logger: pino({ level: 'silent' }),
                                    reuploadRequest: socket.updateMediaMessage
                                });
                                audioAdminBase64 = buf.toString('base64');
                            } catch (e) {
                                console.error('❌ Error descargando audio admin:', e.message);
                            }
                        }
                        if (audioAdminBase64 || instruccionTexto) {
                            await procesarComandoAdmin(remoteJid, audioAdminBase64, instruccionTexto);
                        }
                        return;
                    }
                }
                } finally {
                    // No tocar Firestore en chats cliente (!fromMe sin teléfono admin): evita deletes innecesarios por mensaje.
                    if (rehidratarAdminAntes || adminSesionesActivas.has(remoteJid)) {
                        persistAdminWaSessionFirestore(remoteJid).catch(() => {});
                    }
                }
            }

            // --- DEDUPE: evitar procesar el mismo mensaje entrante 2 veces ---
            if (!msg.key.fromMe && msg.key.id) {
                if (wasIncomingProcessed(msg.key.id)) {
                    return;
                }
                markIncomingProcessed(msg.key.id);
            }

            // --- SILENCIO REAL (panel / Firestore) ---
            // Si un operador silenció el chat desde el dashboard, el bot no debe contestar,
            // ni enviar audio de bienvenida, ni continuar el flujo normal.
            if (!msg.key.fromMe && firestoreModule.isAvailable()) {
                const silence = await firestoreModule.getChatSilenceState(remoteJid);
                if (silence?.shouldSilence) {
                    // Mantener también la sesión local en modo humano para cortar rápido
                    const s = SESSIONS.get(remoteJid);
                    if (s) {
                        s.humanAtendiendo = true;
                        s.humanTimestamp = Date.now();
                    }
                    return;
                }
            }

            if (!msg.key.fromMe && firestoreModule.isAvailable()) {
                const liveActivo = await firestoreModule.getBotActivoLive();
                vickyRuntimeCfg.BOT_ACTIVO = liveActivo;
                if (!liveActivo) {
                    console.log(`🛑 botActivo=false (Firestore config/general): no se responde a ${remoteJid}`);
                    return;
                }
            } else if (!msg.key.fromMe && !vickyRuntimeCfg.BOT_ACTIVO) {
                console.log(`🛑 botActivo=false (sin lectura Firestore): no se responde a ${remoteJid}`);
                return;
            }

            if (!msg.key.fromMe && /^(1|true|yes)$/i.test(String(process.env.VICKY_LOG_INCOMING || '').trim())) {
                console.log(`📩 Entrante jid=${remoteJid} id=${msg.key.id || ''}`);
            }

            // --- GUARDAR PUSHNAME (nombre WhatsApp del cliente) ---
            // msg.pushName es el nombre que el cliente tiene configurado en su WhatsApp.
            // Lo guardamos como fallback para identificar clientes @lid sin teléfono.
            if (!msg.key.fromMe && msg.pushName) {
                const clientePush = asegurarCliente(remoteJid);
                if (!clientePush.pushName && msg.pushName) {
                    clientePush.pushName = msg.pushName;
                    saveHistorialGCS().catch(() => {});
                    console.log(`📛 pushName guardado para ${remoteJid}: "${msg.pushName}"`);
                }
            }

            // --- INICIALIZAR SESIÓN ---
            if (!SESSIONS.has(remoteJid)) {
                const telSession = getTel(remoteJid);
                await downloadHistorialConsultaIfNeeded(telSession);
                const histCliente = getCliente(remoteJid);
                const chatHistory = [];

                // Inyectar contexto previo si el cliente ya tuvo interacciones
                const contextoPrevio = construirContextoPrevio(histCliente);
                if (contextoPrevio) {
                    chatHistory.push(
                        { role: 'user', parts: [{ text: contextoPrevio }] },
                        { role: 'model', parts: [{ text: 'Entendido, tengo el contexto del cliente.' }] }
                    );
                    console.log(`🔁 Contexto previo inyectado para ${remoteJid}: ${histCliente?.estado}`);
                }

                const consultasData = leerHistorialConsultasArchivo(telSession);
                if (consultasData?.nombre && !getCliente(remoteJid)?.nombre) {
                    actualizarEstadoCliente(remoteJid, { nombre: consultasData.nombre });
                }
                const ctxConsultas = construirContextoHistorialConsultas(consultasData);
                if (ctxConsultas) {
                    chatHistory.push(
                        { role: 'user', parts: [{ text: ctxConsultas }] },
                        { role: 'model', parts: [{ text: 'Entendido, tengo el historial de consultas de este contacto.' }] }
                    );
                    console.log(`📂 Historial de consultas previas cargado para ${telSession}`);
                }

                const ultPersistido = histCliente?.ultimoMensaje;
                SESSIONS.set(remoteJid, {
                    audioIntroEnviado: histCliente?.audioIntroEnviado === true,
                    humanAtendiendo: false,
                    humanTimestamp: null,
                    chatHistory,
                    imagenEnviada: {},
                    // Así tras redeploy/reinicio se calcula bien el silencio (nombre + saludo “de retorno”)
                    ultimoMensajeCliente: (typeof ultPersistido === 'number' && ultPersistido > 0)
                        ? ultPersistido
                        : null,
                    mensajesTexto: 0  // contador de mensajes de texto consecutivos para trigger de audio fidelización
                });
            }

            const session = SESSIONS.get(remoteJid);

            // --- DETECCIÓN DE HUMANO ATENDIENDO ---
            if (msg.key.fromMe) {
                const tsOut = lastBotOutTsByJid.get(remoteJid);
                const ecoBotReciente = tsOut != null && Date.now() - tsOut < BOT_OUT_GRACE_MS;
                if (!BOT_MSG_IDS.has(msg.key.id) && !ecoBotReciente) {
                    session.humanAtendiendo = true;
                    session.humanTimestamp = Date.now();
                    console.log(`👤 Humano respondió en ${remoteJid}. Bot silenciado 24hs.`);
                    firestoreModule.setHumanoAtendiendo(remoteJid, true).catch(() => {});
                } else if (ecoBotReciente && !BOT_MSG_IDS.has(msg.key.id)) {
                    console.log(`🤖 Eco saliente ignorado (no marcar humano) — ${remoteJid}`);
                }
                return;
            }

            if (session.humanAtendiendo) {
                if (Date.now() - session.humanTimestamp > vickyRuntimeCfg.SILENCIO_HUMANO_MS) {
                    session.humanAtendiendo = false;
                    session.humanTimestamp = null;
                } else {
                return;
                }
            }

            // --- EXTRAER TEXTO, IMAGEN Y AUDIO ---
            const text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ''
            ).trim();

            const publicidadLead = detectarServicioDesdePublicidad(msg, text);
            if (publicidadLead && !getCliente(remoteJid)?.origenAnuncio) {
                actualizarEstadoCliente(remoteJid, { origenAnuncio: publicidadLead.servicio });
                const clAd = getCliente(remoteJid);
                const pubPatch = {
                    remoteJid,
                    origenAnuncio: publicidadLead.servicio,
                    telefono: telefonoLineaParaFirestore(remoteJid, clAd),
                };
                if (String(remoteJid).endsWith('@lid')) {
                    pubPatch.whatsappLid = String(remoteJid).replace(/@lid$/i, '');
                }
                firestoreModule.syncCliente(docIdClienteFirestore(remoteJid, clAd), pubPatch).catch(() => {});
            }

            const tieneImagen = !!(msg.message.imageMessage);
            const tieneAudio = !!(msg.message.audioMessage || msg.message.pttMessage);

            // Ignorar si no hay texto, imagen ni audio
            if (!text && !tieneImagen && !tieneAudio) return;

            console.log(`📨 Mensaje de ${remoteJid}: "${text.substring(0, 80)}"${tieneImagen ? ' 📷 [imagen]' : ''}${tieneAudio ? ' 🎤 [audio]' : ''}${publicidadLead ? ` 📢 [ad:${publicidadLead.servicio}]` : ''}`);

            // Log en Firestore (Dashboard)
            const telCliente = getTel(remoteJid);
            const histCl = getCliente(remoteJid);
            firestoreModule.logMensaje({
                jid: remoteJid,
                tipo: tieneImagen ? 'imagen' : tieneAudio ? 'audio' : 'texto',
                contenido: text || (tieneImagen ? '[imagen]' : tieneAudio ? '[audio de voz]' : ''),
                direccion: 'entrante',
                servicio: histCl?.servicioPendiente || null,
                clienteInfo: {
                    nombre: histCl?.nombre,
                    estado: histCl?.estado,
                    servicioPendiente: histCl?.servicioPendiente,
                    humanoAtendiendo: session.humanAtendiendo,
                },
            }).catch(() => {});

            // Registrar timestamp del último mensaje del cliente
            const ahora = Date.now();
            const minutosDesdeUltimoMensaje = session.ultimoMensajeCliente
                ? Math.round((ahora - session.ultimoMensajeCliente) / 60000)
                : null;
            session.ultimoMensajeCliente = ahora;
            // Persistir en historial GCS para poder ordenar lista de clientes por recencia
            actualizarEstadoCliente(remoteJid, { ultimoMensaje: ahora });

            // Contador de mensajes de texto consecutivos (reset si manda audio)
            if (tieneAudio) {
                session.mensajesTexto = 0;
            } else {
                session.mensajesTexto = (session.mensajesTexto || 0) + 1;
            }

            // Descargar imagen si la hay
            let imagenBase64 = null;
            let imagenMime = 'image/jpeg';
            if (tieneImagen) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    imagenBase64 = buffer.toString('base64');
                    imagenMime = msg.message.imageMessage.mimetype || 'image/jpeg';
                    console.log(`🖼️ Imagen descargada (${Math.round(buffer.length / 1024)}kb, ${imagenMime})`);
                } catch (errImg) {
                    console.error('❌ Error descargando imagen:', errImg.message);
                }
            }

            // Descargar audio si lo hay
            let audioClienteBase64 = null;
            let audioClienteMime = 'audio/ogg; codecs=opus';
            if (tieneAudio) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    audioClienteBase64 = buffer.toString('base64');
                    // Forzar audio/ogg sin especificación de codec — Gemini no reconoce "audio/ogg; codecs=opus"
                    audioClienteMime = 'audio/ogg';
                    console.log(`🎤 Audio descargado (${Math.round(buffer.length / 1024)}kb, ${audioClienteMime})`);
                } catch (errAudio) {
                    console.error('❌ Error descargando audio:', errAudio.message);
                }
            }

            // --- AUDIO DE BIENVENIDA (solo la primera vez por cliente, para siempre) ---
            // primerMensajeConContenido: si el cliente ya incluyó info en su primer mensaje,
            // NO cortamos con return — dejamos que Gemini responda a lo que preguntó.
            const primerContacto = !session.audioIntroEnviado;
            if (primerContacto) {
                session.audioIntroEnviado = true;
                marcarAudioEnviado(remoteJid);

                console.log(`🎵 Enviando audio de bienvenida a ${remoteJid}`);
                if (AUDIO_INTRO_EXISTS) {
                    try {
                        await sendBotMessage(remoteJid, {
                            audio: fs.readFileSync(AUDIO_INTRO_PATH),
                            mimetype: 'audio/mpeg',
                            ptt: false
                        });
                        await delay(1500);
                    } catch (errAudio) {
                        console.error('❌ Error enviando audio:', errAudio.message);
                    }
                }

                // Si el primer mensaje solo es un saludo vacío (sin contenido relevante),
                // enviamos el mensaje de bienvenida y esperamos su respuesta.
                const esTextoVago = !text || /^(hola|buenas|buen[ao]s?\s*(días?|tardes?|noches?)?|hey|hi|hello|saludos?|buenas?|ey|q tal|como andas?)\s*[!?¡¿.]*$/i.test(text.trim());
                if (esTextoVago && !tieneImagen && !tieneAudio) {
                    await sendBotMessage(remoteJid, { text: vickyRuntimeCfg.mensajeBienvenidaActivo });
                    return;
                }

                // Si ya trajo consulta concreta y viene de publicidad, no repetimos el texto fijo (solo audio + Gemini).
                const omitirTextoBienvenidaExtra = !!(publicidadLead && !esTextoVago);
                if (!omitirTextoBienvenidaExtra) {
                    await sendBotMessage(remoteJid, { text: vickyRuntimeCfg.mensajeBienvenidaActivo });
                    await delay(1000);
                }
                // Caemos al bloque de Gemini con contexto especial de que es el primer mensaje.
            }

            // --- CONSULTAR GEMINI ---
            if (!vickyGeminiModel) {
                await sendBotMessage(remoteJid, {
                    text: `Disculpá, estoy teniendo un problema técnico en este momento. Volvé a escribirme en unos minutos 🙏`
                });
                return;
            }

            // Primero todo el tiempo de "escribiendo…", después se llama a Gemini (más lento y natural).
            await simularEscrituraVicky(remoteJid);

            await ejecutarTurnoVickyGeminiCore(vickyGeminiTurnDeps, {
                canal: 'whatsapp',
                            remoteJid,
                instagramPsid: null,
                session,
                telCliente,
                text,
                tieneImagen,
                tieneAudio,
                imagenBase64,
                imagenMime,
                audioClienteBase64,
                audioClienteMime,
                primerContacto,
                minutosDesdeUltimoMensaje,
                publicidadLead,
            });

        } catch (globalError) {
            console.error('❌ CRASH en messages.upsert:', globalError.stack);
        }
    });

    if (!vickySeguimientoIniciado) {
        vickySeguimientoIniciado = true;
        setTimeout(ejecutarSeguimientos24h, 5 * 60 * 1000);
        setInterval(ejecutarSeguimientos24h, VICKY_SEGUIMIENTO_INTERVALO_MS);
        console.log('⏰ Timer de seguimiento 24hs activo (una vez por proceso).');
    }
}

connectToWhatsApp(false);
