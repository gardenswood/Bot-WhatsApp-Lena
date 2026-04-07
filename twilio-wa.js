/**
 * Envío opcional por Twilio WhatsApp API (plantillas Meta).
 * El bot principal sigue en Baileys; este módulo se usa si hay credenciales
 * y se elige canal Twilio para campañas (#RUTA con useTwilio) o integraciones futuras.
 */

const https = require('https');

function postTwilioForm(path, bodyParams, accountSid, authToken) {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const body = new URLSearchParams(bodyParams).toString();
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'api.twilio.com',
                path,
                method: 'POST',
                headers: {
                    Authorization: `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, body: data });
                    else reject(new Error(`Twilio HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Envía mensaje de plantilla de WhatsApp vía Twilio (Content SID o Messaging SID legacy).
 * @param {string} to E.164 +549...
 * @param {string} contentSid Content SID de plantilla aprobada (Twilio Content API)
 * @param {object} contentVariables JSON stringificado para variables de plantilla
 */
async function sendWhatsAppTemplate({ to, contentSid, contentVariables }) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) {
        return { ok: false, reason: 'missing_twilio_env' };
    }
    const toWa = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const fromWa = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
    const params = {
        To: toWa,
        From: fromWa,
    };
    if (contentSid) {
        params.ContentSid = contentSid;
        if (contentVariables) params.ContentVariables = typeof contentVariables === 'string' ? contentVariables : JSON.stringify(contentVariables);
    }
    try {
        await postTwilioForm(`/2010-04-01/Accounts/${sid}/Messages.json`, params, sid, token);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

module.exports = { sendWhatsAppTemplate };
