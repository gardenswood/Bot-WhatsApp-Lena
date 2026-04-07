/**
 * Prueba rápida: GEMINI_API_KEY + modelo gemini-3.1-flash-lite-preview (sin imprimir la clave).
 * Uso: node scripts/smoke-gemini-model.js
 */
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

(function loadEnvLocal() {
    try {
        const envPath = path.join(__dirname, '..', '.env');
        if (!fs.existsSync(envPath)) return;
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 1) continue;
            const key = t.slice(0, eq).trim();
            let val = t.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = val;
        }
    } catch (_) { /* ignore */ }
})();

const MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview').trim();
const key = process.env.GEMINI_API_KEY;

async function main() {
    if (!key) {
        console.log('⚠️  Sin GEMINI_API_KEY (.env o entorno) — omito llamada a la API.');
        process.exit(0);
    }
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: MODEL });
    const result = await model.generateContent('Respondé exactamente la palabra: PONG');
    const text = (await result.response.text()).trim();
    console.log(`✅ Gemini OK · modelo=${MODEL} · respuesta: ${text.slice(0, 80)}`);
}

main().catch((e) => {
    console.error('❌ Gemini:', e.message);
    process.exit(1);
});
