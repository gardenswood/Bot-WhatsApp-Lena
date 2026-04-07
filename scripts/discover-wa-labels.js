#!/usr/bin/env node
/**
 * Descubre IDs de etiquetas de WhatsApp Business (misma sesión que bot.js).
 *
 * IMPORTANTE: pará el bot (node bot.js) antes de ejecutar esto — dos procesos con la misma auth rompen la sesión.
 *
 * Uso:  npm run labels:discover
 */

const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

(function loadEnvLocal() {
    try {
        const envPath = path.join(__dirname, '..', '.env');
        if (!fs.existsSync(envPath)) return;
        const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 1) {
                if (t.trim() === 'VICKY_LOG_LABELS' && process.env.VICKY_LOG_LABELS === undefined) {
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

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');
const WAIT_MS = Math.min(180000, Math.max(30000, parseInt(process.env.LABELS_DISCOVER_WAIT_MS || '90000', 10) || 90000));

async function main() {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  Descubrir IDs de etiquetas — WhatsApp Business + Baileys');
    console.log('══════════════════════════════════════════════════════════\n');

    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.error('❌ No hay sesión en auth_info_baileys/creds.json. Vinculá primero con node bot.js.');
        process.exit(1);
    }

    console.log('⚠️  Si tenés node bot.js corriendo, PARALO (Ctrl+C) y volvé a ejecutar este script.\n');

    const byId = new Map();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome (labels)'),
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('labels.edit', (p) => {
        if (!p?.id) return;
        if (p.deleted) {
            byId.delete(p.id);
            console.log(`🏷️  Eliminada (ya no uses): id="${p.id}" name="${p.name || ''}"`);
            return;
        }
        byId.set(p.id, { name: p.name || '', color: p.color, predefinedId: p.predefinedId });
        console.log(`\n✅ ETIQUETA →  id="${p.id}"  |  nombre="${p.name || '(sin nombre)'}"`);
        console.log(`   Copiá el valor de id (entre comillas) al panel: Configuración general → ID etiqueta “Contactar asesor”\n`);
    });

    socket.ev.on('labels.association', (ev) => {
        const a = ev?.association;
        console.log(`📎 Asociación ${ev?.type}: labelId="${a?.labelId}" chat=${a?.chatId || ''}`);
    });

    socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('✅ Conectado. Esperando sincronización de etiquetas…\n');
            console.log('   Si en 60 s no aparece ninguna línea "✅ ETIQUETA":');
            console.log('   1) La cuenta debe ser WhatsApp BUSINESS (no Personal).');
            console.log('   2) En el celular: abrí la etiqueta, cambiá el nombre o color, o asignala a un chat.');
            console.log('   3) Esperá; este script sigue escuchando', Math.round(WAIT_MS / 1000), 's.\n');
        }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                console.error('❌ Sesión cerrada (logged out). Volvé a vincular con node bot.js.');
            }
        }
    });

    await new Promise((resolve) => {
        setTimeout(resolve, WAIT_MS);
    });

    console.log('\n──────── Resumen (último estado) ────────');
    if (byId.size === 0) {
        console.log('No se recibió ninguna etiqueta. Revisá cuenta Business y forzá cambio en la etiqueta desde el teléfono.');
    } else {
        for (const [id, meta] of byId) {
            console.log(`  id="${id}"  →  ${meta.name || '(sin nombre)'}`);
        }
    }
    console.log('──────────────────────────────────────────\n');

    try {
        if (socket.ws) socket.ws.close();
    } catch (_) {}
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
