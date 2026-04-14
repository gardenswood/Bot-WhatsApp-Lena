/**
 * Webhook Instagram Messaging (Meta) + envío por Graph API.
 * Variables: INSTAGRAM_WEBHOOK_VERIFY_TOKEN, META_APP_SECRET, INSTAGRAM_PAGE_ACCESS_TOKEN
 */

const crypto = require('crypto');

/** Cloud Run a veces tiene typos en el nombre de la variable (espacio al inicio/fin). */
function envPrimeroNoVacio(keys) {
    for (const k of keys) {
        if (!k) continue;
        const v = process.env[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}

const VERIFY = envPrimeroNoVacio(['INSTAGRAM_WEBHOOK_VERIFY_TOKEN']);
const APP_SECRET = envPrimeroNoVacio([
    'META_APP_SECRET',
    ' META_APP_SECRET',
    'FACEBOOK_APP_SECRET',
]);
const PAGE_TOKEN = envPrimeroNoVacio([
    'INSTAGRAM_PAGE_ACCESS_TOKEN',
    'INSTAGRAM_PAGE_ACCESS_TOKEN ',
    'FACEBOOK_PAGE_ACCESS_TOKEN',
]);
const GRAPH_VER = String(process.env.META_GRAPH_VERSION || 'v21.0').replace(/^v?/, 'v');

const processedMids = new Map();
const MID_TTL_MS = 60 * 60 * 1000;

function cleanupProcessedMids() {
    const now = Date.now();
    for (const [k, t] of processedMids) {
        if (now - t > MID_TTL_MS) processedMids.delete(k);
    }
}

/** @returns {boolean} true si ya estaba visto (no procesar de nuevo) */
function wasMidProcessed(mid) {
    cleanupProcessedMids();
    if (!mid) return false;
    if (processedMids.has(mid)) return true;
    processedMids.set(mid, Date.now());
    return false;
}

/**
 * GET verify Meta webhook.
 * @param {Record<string, string>} query - p.ej. { 'hub.mode', 'hub.verify_token', 'hub.challenge' }
 */
function verifyWebhookGet(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && VERIFY && token === VERIFY && challenge) {
        return { ok: true, challenge: String(challenge) };
    }
    return { ok: false };
}

/**
 * Valida X-Hub-Signature-256. Si META_APP_SECRET está vacío, en desarrollo se omite (log de advertencia).
 */
function verifySignature(rawBody, sigHeader) {
    if (!APP_SECRET) {
        console.warn('⚠️ META_APP_SECRET vacío: firma del webhook NO validada (solo para desarrollo local)');
        return true;
    }
    const sh = String(sigHeader || '');
    if (!sh.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
    const received = sh.slice('sha256='.length);
    if (received.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
        return false;
    }
}

/**
 * Extrae mensajes de texto del body del webhook (object instagram).
 * @returns {{ senderId: string, mid?: string, text: string, timestamp?: number }[]}
 */
function parseInstagramMessaging(body) {
    const out = [];
    if (!body || body.object !== 'instagram') return out;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const ent of entries) {
        const messaging = Array.isArray(ent.messaging) ? ent.messaging : [];
        for (const ev of messaging) {
            const sender = ev.sender?.id;
            const message = ev.message;
            if (!sender || !message) continue;
            if (message.is_echo) continue;
            const mid = message.mid;
            const text = (message.text && String(message.text).trim()) || '';
            if (!text) continue;
            out.push({
                senderId: String(sender),
                mid: mid ? String(mid) : undefined,
                text,
                timestamp: ev.timestamp,
            });
        }
    }
    return out;
}

async function enviarDmInstagram(recipientPsid, text) {
    if (!PAGE_TOKEN) throw new Error('INSTAGRAM_PAGE_ACCESS_TOKEN no configurado');
    const q = new URLSearchParams({ access_token: PAGE_TOKEN });
    const url = `https://graph.facebook.com/${GRAPH_VER}/me/messages?${q.toString()}`;
    const body = {
        recipient: { id: String(recipientPsid) },
        message: { text: String(text || '').slice(0, 2000) },
        messaging_type: 'RESPONSE',
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = j.error?.message || JSON.stringify(j);
        console.error('❌ Graph API Instagram messages:', msg);
        throw new Error(msg);
    }
    return j;
}

function isConfiguredForSend() {
    return !!PAGE_TOKEN;
}

function isConfiguredForVerify() {
    return !!VERIFY;
}

module.exports = {
    verifyWebhookGet,
    verifySignature,
    parseInstagramMessaging,
    enviarDmInstagram,
    wasMidProcessed,
    isConfiguredForSend,
    isConfiguredForVerify,
};
