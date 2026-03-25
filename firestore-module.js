/**
 * firestore-module.js
 * Módulo de integración con Firestore para el bot Vicky.
 * Maneja: logging de chats, sync de clientes, config dinámica.
 */

let firestoreDb = null;
let configCache = null;
let configLastFetch = 0;
const CONFIG_TTL = 5 * 60 * 1000; // cache de config por 5 min

async function initFirestore() {
    try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                projectId: process.env.FIREBASE_PROJECT_ID || 'webgardens-8655d',
            });
        }
        firestoreDb = admin.firestore();
        console.log('🔥 Firestore inicializado correctamente.');
        return true;
    } catch (e) {
        console.warn('⚠️ Firestore no disponible:', e.message, '— bot funcionará en modo fallback.');
        return false;
    }
}

// ── Logging de mensajes ────────────────────────────────────────────────
/**
 * Loguea un mensaje (entrante o saliente) en Firestore.
 * Colección: chats/{jid}/mensajes/{id}
 * También actualiza el doc padre chats/{jid} con metadata del último mensaje.
 */
async function logMensaje({ jid, tipo, contenido, direccion, marcadores, servicio, clienteInfo }) {
    if (!firestoreDb) return;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const timestamp = FieldValue.serverTimestamp();

        // Registrar el mensaje individual
        const mensajeRef = firestoreDb
            .collection('chats').doc(jid)
            .collection('mensajes').doc();
        await mensajeRef.set({
            contenido: contenido?.slice(0, 2000) || '', // limitar tamaño
            tipo: tipo || 'texto',
            direccion: direccion || 'entrante',
            timestamp,
            marcadores: marcadores || [],
            servicio: servicio || null,
        });

        // Actualizar doc padre del chat con último mensaje y metadata del cliente
        const chatUpdate = {
            ultimoMensaje: contenido?.slice(0, 150) || '',
            ultimoMensajeAt: timestamp,
            mensajesCount: FieldValue.increment(1),
            tel: jid.replace('@s.whatsapp.net', '').replace('@g.us', ''),
        };
        if (clienteInfo?.nombre) chatUpdate.nombre = clienteInfo.nombre;
        if (clienteInfo?.estado) chatUpdate.estado = clienteInfo.estado;
        if (clienteInfo?.servicioPendiente) chatUpdate.servicioPendiente = clienteInfo.servicioPendiente;
        if (clienteInfo?.humanoAtendiendo !== undefined) chatUpdate.humanoAtendiendo = clienteInfo.humanoAtendiendo;

        await firestoreDb.collection('chats').doc(jid).set(chatUpdate, { merge: true });

        // Añadir al log global de mensajes (para analytics de volumen diario)
        await firestoreDb.collection('mensajes_log').add({
            jid,
            tipo: tipo || 'texto',
            direccion,
            servicio: servicio || null,
            timestamp,
        });
    } catch (e) {
        // No interrumpir el flujo del bot por errores de Firestore
        if (!e.message?.includes('NOT_FOUND')) {
            console.warn('⚠️ Error logMensaje Firestore:', e.message);
        }
    }
}

// ── Sincronización de clientes ─────────────────────────────────────────
/**
 * Sincroniza el estado de un cliente a Firestore.
 * Colección: clientes/{tel}
 */
async function syncCliente(tel, datos) {
    if (!firestoreDb) return;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const docRef = firestoreDb.collection('clientes').doc(tel);

        const update = {
            ...datos,
            tel,
            fechaUltimoContacto: FieldValue.serverTimestamp(),
        };

        // Si es la primera vez, agregar fecha de primer contacto
        const snap = await docRef.get();
        if (!snap.exists) {
            update.fechaPrimerContacto = FieldValue.serverTimestamp();
        }

        await docRef.set(update, { merge: true });
    } catch (e) {
        console.warn('⚠️ Error syncCliente Firestore:', e.message);
    }
}

// ── Sincronización de cola de leña ─────────────────────────────────────
async function syncColaLena(colaLena) {
    if (!firestoreDb || !colaLena?.length) return;
    try {
        const batch = firestoreDb.batch();
        for (const pedido of colaLena) {
            if (!pedido.id) continue;
            const ref = firestoreDb.collection('colaLena').doc(pedido.id);
            batch.set(ref, pedido, { merge: true });
        }
        await batch.commit();
    } catch (e) {
        console.warn('⚠️ Error syncColaLena Firestore:', e.message);
    }
}

// ── Lectura de config dinámica ─────────────────────────────────────────
/**
 * Lee la configuración general desde Firestore con cache de 5 minutos.
 * Fallback a valores por defecto si Firestore no está disponible.
 */
async function getConfigGeneral() {
    const DEFAULT_CONFIG = {
        delayMinSeg: 10,
        delayMaxSeg: 15,
        modeloGemini: 'gemini-2.5-flash',
        frecuenciaAudioFidelizacion: 4,
        tiempoSilencioHumanoHoras: 24,
        botActivo: true,
    };

    if (!firestoreDb) return DEFAULT_CONFIG;

    const now = Date.now();
    if (configCache && (now - configLastFetch) < CONFIG_TTL) {
        return { ...DEFAULT_CONFIG, ...configCache };
    }

    try {
        const snap = await firestoreDb.collection('config').doc('general').get();
        if (snap.exists) {
            configCache = snap.data();
            configLastFetch = now;
            return { ...DEFAULT_CONFIG, ...configCache };
        }
    } catch (e) {
        console.warn('⚠️ Error leyendo config Firestore:', e.message);
    }
    return DEFAULT_CONFIG;
}

/**
 * Lee el system prompt desde Firestore.
 * Fallback al prompt hardcodeado si no está en Firestore.
 */
async function getSystemPrompt(fallbackPrompt) {
    if (!firestoreDb) return fallbackPrompt;
    try {
        const snap = await firestoreDb.collection('config').doc('prompts').get();
        if (snap.exists && snap.data()?.sistemaPrompt) {
            console.log('📝 System prompt cargado desde Firestore.');
            return snap.data().sistemaPrompt;
        }
    } catch (e) {
        console.warn('⚠️ Error leyendo prompt Firestore:', e.message);
    }
    return fallbackPrompt;
}

/**
 * Lee los precios de servicios desde Firestore.
 * Retorna null si no hay datos (el bot usa el prompt hardcodeado).
 */
async function getServicios() {
    if (!firestoreDb) return null;
    try {
        const snap = await firestoreDb.collection('servicios').get();
        if (snap.empty) return null;
        const servicios = {};
        snap.docs.forEach((d) => { servicios[d.id] = d.data(); });
        return servicios;
    } catch (e) {
        console.warn('⚠️ Error leyendo servicios Firestore:', e.message);
        return null;
    }
}

// ── Actualizar estado humanoAtendiendo en Firestore ───────────────────
async function setHumanoAtendiendo(jid, value) {
    if (!firestoreDb) return;
    try {
        await firestoreDb.collection('chats').doc(jid).set(
            { humanoAtendiendo: value, humanoAtendiendoAt: value ? require('firebase-admin').firestore.FieldValue.serverTimestamp() : null },
            { merge: true }
        );
    } catch (e) {
        console.warn('⚠️ Error setHumanoAtendiendo:', e.message);
    }
}

// ── Migración one-time: usuarios_vistos.json → Firestore ──────────────
async function migrarHistorialAFirestore(clientesHistorial) {
    if (!firestoreDb || !clientesHistorial || Object.keys(clientesHistorial).length === 0) return;

    console.log(`🔄 Migrando ${Object.keys(clientesHistorial).length} clientes a Firestore...`);
    const admin = require('firebase-admin');
    const FieldValue = admin.firestore.FieldValue;

    const batch = firestoreDb.batch();
    let count = 0;

    for (const [tel, datos] of Object.entries(clientesHistorial)) {
        if (!tel) continue;
        const ref = firestoreDb.collection('clientes').doc(tel);
        const snap = await ref.get();
        if (!snap.exists) {
            batch.set(ref, {
                tel,
                remoteJid: datos.remoteJid || `${tel}@s.whatsapp.net`,
                nombre: datos.nombre || null,
                direccion: datos.direccion || null,
                zona: datos.zona || null,
                metodoPago: datos.metodoPago || null,
                estado: datos.estado || 'nuevo',
                servicioPendiente: datos.servicioPendiente || null,
                audioIntroEnviado: datos.audioIntroEnviado || false,
                pedidosAnteriores: datos.pedidosAnteriores || [],
                fechaPrimerContacto: FieldValue.serverTimestamp(),
                fechaUltimoContacto: FieldValue.serverTimestamp(),
            });
            count++;

            if (count % 499 === 0) {
                await batch.commit();
                console.log(`✅ ${count} clientes migrados...`);
            }
        }
    }

    if (count > 0) {
        await batch.commit();
        console.log(`✅ Migración completa: ${count} clientes nuevos en Firestore.`);
    } else {
        console.log('ℹ️ Todos los clientes ya están en Firestore.');
    }
}

module.exports = {
    initFirestore,
    logMensaje,
    syncCliente,
    syncColaLena,
    getConfigGeneral,
    getSystemPrompt,
    getServicios,
    setHumanoAtendiendo,
    migrarHistorialAFirestore,
    isAvailable: () => !!firestoreDb,
};
