#!/usr/bin/env node
/**
 * Graba en Firestore el mapeo LID → línea (doc clientes/{telefono}) y sincroniza la ficha.
 * Equivalente admin WhatsApp: !vicky #p lidmap LID TEL
 *
 *   node scripts/seed-lid-mapeo.js 276883707060468 543516170743
 */

async function initAdmin() {
    const admin = require('firebase-admin');
    if (admin.apps.length) return admin;
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.FIREBASE_ADMIN_PROJECT_ID || 'webgardens-8655d';
    const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (clientEmail && privateKey) {
        admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
    } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
    }
    return admin;
}

async function main() {
    const lid = String(process.argv[2] || '').replace(/\D/g, '');
    const tel = String(process.argv[3] || '').replace(/\D/g, '');
    if (!lid || !tel) {
        console.log('Uso: node scripts/seed-lid-mapeo.js <LID> <TELEFONO_DOC>\nEj: node scripts/seed-lid-mapeo.js 276883707060468 543516170743');
        process.exit(1);
    }
    if (lid.length < 10 || tel.length < 8) {
        console.error('LID o tel demasiado cortos.');
        process.exit(1);
    }
    await initAdmin();
    const fm = require('../firestore-module');
    await fm.initFirestore();
    if (!fm.isAvailable()) {
        console.error('Firestore no disponible.');
        process.exit(1);
    }
    await fm.saveLidMapeo(lid, tel);
    const lidJid = `${lid}@lid`;
    await fm.syncCliente(tel, {
        remoteJid: lidJid,
        telefono: tel,
        whatsappLid: lid,
    });
    console.log(`OK: lid_mapeo/${lid} → telefono ${tel}, clientes/${tel} (remoteJid ${lidJid})`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
