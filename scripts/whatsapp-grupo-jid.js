#!/usr/bin/env node
/**
 * Obtiene el JID de un grupo de WhatsApp (…@g.us) con la misma sesión Baileys que `bot.js`.
 *
 * IMPORTANTE: pará el bot (Cloud Run no aplica; en tu PC: `node bot.js` en otra terminal) antes de ejecutar.
 *
 * Uso:
 *   npm run wa:grupo-jid -- --invite CODIGO
 *   El CODIGO es lo que va después de https://chat.whatsapp.com/ en el enlace de invitación al grupo.
 *
 *   npm run wa:grupo-jid -- --list
 *   Lista grupos donde participa la cuenta del bot (primera columna = JID para el panel).
 */

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
} = require('@whiskeysockets/baileys');

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
    } catch (_) {
        /* ignore */
    }
})();

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

function parseArgs() {
    const args = process.argv.slice(2);
    const list = args.includes('--list');
    let inviteCode = '';
    const eq = args.find((a) => a.startsWith('--invite='));
    if (eq) inviteCode = eq.slice('--invite='.length).trim();
    else {
        const i = args.indexOf('--invite');
        if (i >= 0 && args[i + 1]) inviteCode = String(args[i + 1]).trim();
    }
    return { list, inviteCode };
}

async function main() {
    const { list, inviteCode } = parseArgs();
    if (!list && !inviteCode) {
        console.log(`
Uso:
  npm run wa:grupo-jid -- --invite CODIGO
    CODIGO = parte final del enlace https://chat.whatsapp.com/XXXXXXXX

  npm run wa:grupo-jid -- --list
    Lista JID de todos los grupos donde está la cuenta del bot.
`);
        process.exit(1);
    }

    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.error('❌ No hay sesión en auth_info_baileys/creds.json. Vinculá primero con node bot.js (o bajá creds desde GCS).');
        process.exit(1);
    }

    console.log('⚠️  Si tenés node bot.js corriendo, paralo antes.\n');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome (grupo-jid)'),
    });

    socket.ev.on('creds.update', saveCreds);

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout 60s sin conectar a WhatsApp')), 60000);
        const onUpdate = async (u) => {
            if (u.connection !== 'open') return;
            clearTimeout(timer);
            socket.ev.off('connection.update', onUpdate);
            try {
                if (list) {
                    const groups = await socket.groupFetchAllParticipating();
                    const rows = Object.entries(groups || {});
                    if (rows.length === 0) {
                        console.log('(No se listaron grupos; puede tardar la sync — reintentá o usá --invite.)');
                    } else {
                        console.log('JID\t\t\t\t\tAsunto');
                        rows.sort((a, b) => (a[1].subject || '').localeCompare(b[1].subject || ''));
                        for (const [jid, meta] of rows) {
                            console.log(`${jid}\t${meta.subject || ''}`);
                        }
                    }
                } else {
                    const meta = await socket.groupGetInviteInfo(inviteCode);
                    const id = meta?.id || '';
                    if (!id.endsWith('@g.us')) {
                        console.error('❌ Respuesta sin JID @g.us:', id);
                    } else {
                        console.log('\n✅ Pegá esto en Panel → General → JID del grupo (agenda de entregas):\n');
                        console.log(id);
                        if (meta.subject) console.log('\nGrupo:', meta.subject);
                    }
                }
            } catch (e) {
                console.error('❌', e.message || e);
            }
            resolve();
        };
        socket.ev.on('connection.update', onUpdate);
    });

    setTimeout(() => process.exit(0), 800);
}

main().catch((e) => {
    console.error('❌', e.message || e);
    process.exit(1);
});
