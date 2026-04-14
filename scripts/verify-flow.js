/**
 * Chequeos estáticos del entorno y archivos del bot (sin llamar a Gemini).
 * Uso: npm run verify
 * Con el bot corriendo local, también prueba GET :8080.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Storage } = require('@google-cloud/storage');

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

const root = path.join(__dirname, '..');
let failed = false;
let done = false;

function ok(msg) {
    console.log('✅', msg);
}
function bad(msg) {
    console.log('❌', msg);
    failed = true;
}

const audioIntro = path.join(root, 'ElevenLabs_2026-03-21T11_41_40_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');
const audioConf = path.join(root, 'ElevenLabs_2026-03-21T12_03_41_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');

async function gcsTryDownloadFirstExisting(bucketName, destPath, candidates) {
    if (fs.existsSync(destPath)) return true;
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const storage = new Storage();
    const bucket = storage.bucket(bucketName);
    for (const key of candidates) {
        const k = String(key || '').replace(/^\/+/, '');
        if (!k) continue;
        try {
            const f = bucket.file(k);
            const [exists] = await f.exists();
            if (!exists) continue;
            await f.download({ destination: destPath });
            return true;
        } catch (_) {
            /* seguir probando keys */
        }
    }
    return fs.existsSync(destPath);
}

async function tryHydrateMediaFromGcsIfMissing() {
    const bucketName = String(process.env.VICKY_GCS_BUCKET || 'webgardens-8655d_whatsapp_session').trim();
    const targets = [
        {
            dest: audioIntro,
            keys: [
                path.basename(audioIntro),
                `media/${path.basename(audioIntro)}`,
                `bot_media/${path.basename(audioIntro)}`,
                `assets/audio/${path.basename(audioIntro)}`,
            ],
        },
        {
            dest: audioConf,
            keys: [
                path.basename(audioConf),
                `media/${path.basename(audioConf)}`,
                `bot_media/${path.basename(audioConf)}`,
                `assets/audio/${path.basename(audioConf)}`,
            ],
        },
        {
            dest: path.join(root, 'assets', 'madera_premium.png'),
            keys: ['assets/madera_premium.png', 'media/madera_premium.png', 'bot_media/madera_premium.png'],
        },
        {
            dest: path.join(root, 'images', 'Cercos', 'cerco1.jpeg'),
            keys: ['images/Cercos/cerco1.jpeg', 'media/cerco1.jpeg', 'bot_media/cerco1.jpeg'],
        },
    ];

    let anyMissing = targets.some(t => !fs.existsSync(t.dest));
    if (!anyMissing) return;

    try {
        for (const t of targets) {
            if (fs.existsSync(t.dest)) continue;
            await gcsTryDownloadFirstExisting(bucketName, t.dest, t.keys);
        }
        console.log('💡 Intenté hidratar media faltante desde GCS (si hay credenciales ADC / SA).');
    } catch (e) {
        console.log('⚠️  No se pudo hidratar media desde GCS:', e.message);
    }
}

(async function mainChecks() {
    await tryHydrateMediaFromGcsIfMissing();

    if (process.env.GEMINI_API_KEY) ok('GEMINI_API_KEY definida');
    else bad('GEMINI_API_KEY ausente (.env) — el bot no responderá con IA');

    if (fs.existsSync(audioIntro)) ok('Audio intro de bienvenida');
    else bad('Falta audio intro: ' + path.basename(audioIntro));

    if (fs.existsSync(audioConf)) ok('Audio confirmado');
    else bad('Falta audio confirmado: ' + path.basename(audioConf));

    for (const rel of ['assets/madera_premium.png', 'images/Cercos/cerco1.jpeg']) {
        const p = path.join(root, rel);
        if (fs.existsSync(p)) ok(`Media: ${rel}`);
        else bad(`Falta ${rel}`);
    }

    runHttpHealth();
})();

function runHttpHealth() {
    try {
        const fm = require('../firestore-module.js');
        if (typeof fm.initFirestore === 'function' && typeof fm.logMensaje === 'function') ok('firestore-module carga');
        else bad('firestore-module incompleto');
    } catch (e) {
        bad('firestore-module: ' + e.message);
    }

    const req = http.get('http://127.0.0.1:8080', { timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
            if (res.statusCode === 200 && /online|vicky/i.test(body)) ok('Salud HTTP :8080 (bot en ejecución)');
            else bad(`Salud :8080 código ${res.statusCode}`);
            finish();
        });
    });
    req.on('error', () => {
        console.log('⚠️  Puerto 8080 no responde — normal si el bot no está corriendo ahora');
        finish();
    });
    req.on('timeout', () => {
        req.destroy();
        console.log('⚠️  Timeout :8080 — bot no detectado en local');
        finish();
    });
}

function finish() {
    if (done) return;
    done = true;
    console.log(failed ? '\n→ Corregí los ítems marcados con ❌' : '\n→ Chequeo estático OK. Probá el flujo WhatsApp con la checklist del runbook.');
    process.exit(failed ? 1 : 0);
}
