/**
 * Prueba de llamada saliente ElevenLabs + Twilio (misma API que bot.js).
 * Uso: node scripts/test-outbound-call.js +543512956376
 * Requiere: ELEVENLABS_API_KEY (y opcionalmente ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID)
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[k] === undefined) process.env[k] = v;
    }
}

async function main() {
    loadEnvFile();
    const raw = process.argv[2] || '';
    const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
    const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || 'agent_6101kmm5scd6evw8xqbyespx4dfe';
    const ELEVENLABS_PHONE_NUMBER_ID = process.env.ELEVENLABS_PHONE_NUMBER_ID || 'phnum_9501kmmbjr2cfyj8r9cbwnr9b7g3';

    if (!ELEVENLABS_API_KEY) {
        console.error('Falta ELEVENLABS_API_KEY en el entorno o en .env');
        process.exit(1);
    }
    if (!raw) {
        console.error('Uso: node scripts/test-outbound-call.js +543512956376');
        process.exit(1);
    }

    let toNumber = raw.replace(/\D/g, '');
    if (toNumber.startsWith('54') && !toNumber.startsWith('549')) {
        toNumber = '549' + toNumber.slice(2);
    } else if (!toNumber.startsWith('549')) {
        toNumber = '549' + toNumber.replace(/^0+/, '');
    }
    toNumber = '+' + toNumber;

    const nombre = 'prueba';
    const servicio = 'cotización de prueba';
    const primerMensaje = `Hola! Te llamo de Gardens Wood, soy Vicky. Esta es una llamada de prueba del sistema.`;
    const promptContexto = `Estás en una llamada de PRUEBA técnica. Saludá breve, confirmá que te escuchan bien y despedite en menos de 30 segundos. No pidas datos de pago ni presupuestos reales.`;

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

    const body = await resp.text();
    if (resp.ok) {
        console.log('OK', resp.status, body);
        console.log(`Llamada iniciada hacia ${toNumber}`);
    } else {
        console.error('Error', resp.status, body);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
