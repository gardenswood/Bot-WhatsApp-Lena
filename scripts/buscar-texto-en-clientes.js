#!/usr/bin/env node
/**
 * Recorre `clientes/*` y lista documentos donde aparezca un texto (p. ej. últimos dígitos de un celular).
 * Sirve para encontrar un número pegado en `nombre`, `pushName`, `telefono`, `remoteJid`, etc.
 *
 * Requisitos: ADC (`gcloud auth application-default login`) o FIREBASE_ADMIN_* (ver verificar-cliente-agenda.js)
 *
 * Uso:
 *   node scripts/buscar-texto-en-clientes.js 7728958
 *   node scripts/buscar-texto-en-clientes.js "351 772"
 */

async function initAdmin() {
    const admin = require('firebase-admin');
    if (admin.apps.length) return admin;

    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_ADMIN_PROJECT_ID || 'webgardens-8655d';
    const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (clientEmail && privateKey) {
        admin.initializeApp({
            credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });
    } else {
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            projectId,
        });
    }
    return admin;
}

const CAMPOS = [
    'nombre',
    'pushName',
    'telefono',
    'remoteJid',
    'whatsappLid',
    'direccion',
    'zona',
    'notasUbicacion',
    'statusCrm',
    'servicioPendiente',
];

function strVal(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => String(x)).join(', ');
    return String(v);
}

async function main() {
    const needle = process.argv[2];
    if (!needle || needle === '-h' || needle === '--help') {
        console.log(
            'Uso: node scripts/buscar-texto-en-clientes.js <texto>\n'
                + 'Ej: node scripts/buscar-texto-en-clientes.js 7728958\n\n'
                + 'Recorre toda la colección clientes (puede tardar).'
        );
        process.exit(needle ? 0 : 1);
    }

    const admin = await initAdmin();
    const db = admin.firestore();
    const n = needle.toLowerCase();

    console.log(`\n🔍 Buscando "${needle}" en clientes/* (proyecto ${process.env.FIREBASE_PROJECT_ID || 'webgardens-8655d'})…\n`);

    const snap = await db.collection('clientes').get();
    let hits = 0;
    for (const doc of snap.docs) {
        const d = doc.data() || {};
        const id = doc.id;
        const matches = [];
        if (String(id).toLowerCase().includes(n)) matches.push(`[docId] ${id}`);
        for (const key of CAMPOS) {
            const s = strVal(d[key]).toLowerCase();
            if (s && s.includes(n)) matches.push(`${key}: ${strVal(d[key]).slice(0, 200)}`);
        }
        if (matches.length === 0) continue;
        hits++;
        console.log('—'.repeat(60));
        console.log(`📄 clientes/${id}`);
        matches.forEach((m) => console.log(`   ${m}`));
    }

    console.log('\n' + '—'.repeat(60));
    console.log(hits ? `✅ ${hits} documento(s) con coincidencias.` : 'ℹ️ Ningún documento contiene ese texto en los campos revisados.');
    console.log(
        '\n_Si no aparece nada: el número solo existía en memoria del bot o en un mensaje viejo del grupo, no en Firestore._'
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
