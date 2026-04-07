#!/usr/bin/env node
/**
 * Lee Firestore (Admin): ficha cliente por teléfono y eventos en entregas_agenda para ese JID.
 *
 * Requisitos: igual que geocodificar-clientes — ADC o FIREBASE_ADMIN_* (ver scripts/geocodificar-clientes-direccion.js)
 *
 * Uso:
 *   node scripts/verificar-cliente-agenda.js 3516170743
 *   node scripts/verificar-cliente-agenda.js 5493516170743
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

/** IDs de documento clientes/{id} habituales para la misma línea AR. */
function candidateClienteDocIds(rawDigits) {
    const d = String(rawDigits || '').replace(/\D/g, '');
    const out = [];
    if (!d) return out;
    const push = (x) => {
        if (x && !out.includes(x)) out.push(x);
    };
    push(d);
    if (d.length === 10 && !d.startsWith('54')) push(`549${d}`);
    if (d.length === 11 && d.startsWith('54') && !d.startsWith('549')) push(`549${d.slice(2)}`);
    if (d.startsWith('549') && d.length > 3) push(d.slice(3));
    return out;
}

function jidVariantsForDocId(docId) {
    const digits = String(docId).replace(/\D/g, '');
    const jids = new Set();
    jids.add(`${digits}@s.whatsapp.net`);
    if (digits.length === 10) jids.add(`549${digits}@s.whatsapp.net`);
    if (digits.startsWith('549')) jids.add(`${digits}@s.whatsapp.net`);
    return [...jids];
}

async function main() {
    const arg = process.argv[2];
    if (!arg || arg === '-h' || arg === '--help') {
        console.log('Uso: node scripts/verificar-cliente-agenda.js <tel_dígitos>\nEj: node scripts/verificar-cliente-agenda.js 3516170743');
        process.exit(arg ? 0 : 1);
    }

    const admin = await initAdmin();
    const db = admin.firestore();

    const lidArg = process.argv.find((x) => x.startsWith('--lid='))?.slice('--lid='.length)?.replace(/\D/g, '');
    if (lidArg && lidArg.length >= 10) {
        const m = await db.collection('lid_mapeo').doc(lidArg).get();
        console.log('\n🔗 lid_mapeo/' + lidArg + ':', m.exists ? JSON.stringify(m.data(), null, 2) : '(no existe)');
    }

    const ids = candidateClienteDocIds(arg);
    console.log('\n📋 IDs de cliente a probar:', ids.join(', ') || '(vacío)');

    let found = null;
    let foundId = null;
    for (const id of ids) {
        const snap = await db.collection('clientes').doc(id).get();
        if (snap.exists) {
            found = snap.data();
            foundId = id;
            break;
        }
    }

    if (!found) {
        console.log('\n⚠️  No hay documento en clientes/* para esos dígitos.');
        console.log('   En consola Firebase buscá también por nombre (Iván Bitar) o por JID en chats/*.\n');
    } else {
        console.log(`\n✅ Cliente encontrado: clientes/${foundId}`);
        const pick = [
            'nombre',
            'tel',
            'remoteJid',
            'whatsappLid',
            'direccion',
            'zona',
            'barrio',
            'localidad',
            'referencia',
            'notasUbicacion',
            'servicioPendiente',
            'tipoLenaPreferido',
            'interes',
            'notas',
        ];
        const out = {};
        for (const k of pick) {
            if (found[k] !== undefined && found[k] !== null && found[k] !== '') out[k] = found[k];
        }
        console.log(JSON.stringify(out, null, 2));
    }

    const jids = new Set();
    if (found && found.remoteJid) jids.add(String(found.remoteJid));
    if (foundId) {
        for (const j of jidVariantsForDocId(foundId)) jids.add(j);
    }
    for (const id of ids) {
        for (const j of jidVariantsForDocId(id)) jids.add(j);
    }

    const jidList = [...jids].filter(Boolean);
    console.log('\n📅 Buscando entregas_agenda con jid en:', jidList.join(', ') || '(ninguno)');

    if (jidList.length === 0) {
        process.exit(0);
    }

    const chunks = [];
    for (let i = 0; i < jidList.length; i += 10) chunks.push(jidList.slice(i, i + 10));

    const entregas = [];
    for (const chunk of chunks) {
        const q = await db.collection('entregas_agenda').where('jid', 'in', chunk).get();
        q.forEach((d) => entregas.push({ id: d.id, ...d.data() }));
    }

    entregas.sort((a, b) => String(a.fechaDia || '').localeCompare(String(b.fechaDia || '')));

    if (entregas.length === 0) {
        console.log('   (Sin filas; el evento puede no tener jid o usar otro JID @lid.)');
    } else {
        for (const e of entregas) {
            console.log('\n---');
            console.log(
                JSON.stringify(
                    {
                        id: e.id,
                        fechaDia: e.fechaDia,
                        horaTexto: e.horaTexto,
                        titulo: e.titulo,
                        telefonoContacto: e.telefonoContacto,
                        direccion: e.direccion,
                        producto: e.producto,
                        kg: e.kg,
                        notas: e.notas,
                        jid: e.jid,
                        estado: e.estado,
                        origen: e.origen,
                    },
                    null,
                    2
                )
            );
        }
    }

    console.log('\n💡 Para cargar o corregir: panel → Agenda de entregas → Nueva entrega (o editar en consola Firestore).\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
