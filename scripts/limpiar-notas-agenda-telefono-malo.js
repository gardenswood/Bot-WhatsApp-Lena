#!/usr/bin/env node
/**
 * Quita de entregas_agenda.notas el fragmento "Cliente: …" que contiene 7728958
 * (dato viejo mezclado con otro contacto). Idempotente.
 *
 * ADC o FIREBASE_ADMIN_* — igual que verificar-cliente-agenda.js
 *
 * Uso: node scripts/limpiar-notas-agenda-telefono-malo.js
 *      node scripts/limpiar-notas-agenda-telefono-malo.js --dry-run
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

const SUB = '7728958';

function limpiarNotas(notas) {
    const raw = String(notas || '').trim();
    if (!raw.includes(SUB)) return raw;
    const parts = raw.split(/\s*·\s*/).map((p) => p.trim()).filter(Boolean);
    const kept = parts.filter((p) => {
        if (!/^Cliente:\s*/i.test(p)) return true;
        return !p.includes(SUB);
    });
    return kept.join(' · ').trim();
}

async function main() {
    const dry = process.argv.includes('--dry-run');
    const admin = await initAdmin();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    const snap = await db.collection('entregas_agenda').get();
    const updates = [];
    for (const doc of snap.docs) {
        const d = doc.data() || {};
        const antes = d.notas;
        if (antes == null || String(antes) === '') continue;
        if (!String(antes).includes(SUB)) continue;
        const despues = limpiarNotas(antes);
        if (despues === String(antes).trim()) continue;
        updates.push({ ref: doc.ref, id: doc.id, antes, despues });
    }

    if (updates.length === 0) {
        console.log('ℹ️ Ningún documento en entregas_agenda tenía notas con', SUB);
        return;
    }

    console.log(`📋 ${updates.length} documento(s) a actualizar${dry ? ' (dry-run)' : ''}:\n`);
    for (const u of updates) {
        console.log(`  ${u.id}`);
        console.log(`    antes: ${String(u.antes).slice(0, 200)}${String(u.antes).length > 200 ? '…' : ''}`);
        console.log(`    después: ${u.despues || '(vacío)'}\n`);
    }

    if (dry) {
        console.log('Dry-run: no se escribió nada.');
        return;
    }

    let batch = db.batch();
    let count = 0;
    for (const u of updates) {
        const patch = {
            actualizadoEn: FieldValue.serverTimestamp(),
        };
        if (u.despues) patch.notas = u.despues;
        else patch.notas = FieldValue.delete();
        batch.update(u.ref, patch);
        count++;
        if (count >= 400) {
            await batch.commit();
            batch = db.batch();
            count = 0;
        }
    }
    if (count > 0) await batch.commit();
    console.log('✅ Listo.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
