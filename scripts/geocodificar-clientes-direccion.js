#!/usr/bin/env node
/**
 * Geocodifica clientes con dirección (y opcionalmente zona) pero sin lat/lng en Firestore.
 * Usa OpenStreetMap Nominatim (~1 solicitud/seg). Política: https://operations.osmfoundation.org/policies/nominatim/
 *
 * Requisitos:
 *   - Firebase Admin: `gcloud auth application-default login` (mismo proyecto que el bot)
 *     o variables FIREBASE_ADMIN_* como en dashboard/scripts/seed-firestore.js
 *   - Ejecutar desde la raíz del repo Bot_WhatsApp_Lena
 *
 * Uso:
 *   node scripts/geocodificar-clientes-direccion.js
 *   node scripts/geocodificar-clientes-direccion.js --max=25 --dry-run
 *   node scripts/geocodificar-clientes-direccion.js --max=50 --force-regeocode
 *
 * Opciones:
 *   --max=N        Máximo de clientes a procesar en esta corrida (default 40)
 *   --dry-run      Solo muestra qué haría, no escribe Firestore
 *   --force-regeocode  Vuelve a geocodificar aunque ya tengan lat/lng (útil si corregiste la dirección)
 */

const { runGeocodeClientesBatch } = require('../geocode-clientes-core');

function parseArgs() {
    const out = { max: 40, dryRun: false, forceRegeocode: false };
    for (const a of process.argv.slice(2)) {
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--force-regeocode') out.forceRegeocode = true;
        else if (a.startsWith('--max=')) out.max = Math.max(1, Math.min(500, parseInt(a.slice(6), 10) || 40));
    }
    return out;
}

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

async function main() {
    const opts = parseArgs();
    console.log(`\n🗺️  Geocodificación por dirección — max=${opts.max} dryRun=${opts.dryRun} force=${opts.forceRegeocode}\n`);

    const admin = await initAdmin();
    const db = admin.firestore();

    const r = await runGeocodeClientesBatch(db, {
        max: opts.max,
        dryRun: opts.dryRun,
        forceRegeocode: opts.forceRegeocode,
    });

    console.log(
        `Encontrados ${r.eligible} cliente(s) elegibles (dirección y/o datos de ubicación en CRM; sin coords o --force-regeocode). ` +
            `Procesados ${r.attempted} en esta corrida.`
    );
    if (r.attempted === 0) {
        console.log('Nada que procesar.');
        process.exit(0);
    }

    const ok = opts.dryRun ? r.dryRunPreview : r.written;
    console.log(`\n✅ Listo: ${ok} OK, ${r.failed} sin coords / error.\n`);
}

main().catch((e) => {
    console.error('❌', e);
    process.exit(1);
});
