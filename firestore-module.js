/**
 * firestore-module.js
 * Módulo de integración con Firestore para el bot Vicky.
 * Maneja: logging de chats, sync de clientes, config dinámica.
 */

let firestoreDb = null;
let configCache = null;
let configLastFetch = 0;
const CONFIG_TTL = 5 * 60 * 1000; // cache de config por 5 min

// ── Cache para estado de silencio por chat ─────────────────────────────
let chatSilenceCache = new Map(); // jid -> { value, fetchedAt }
let chatSilenceTtlMs = 8 * 1000; // cache corto: evita lecturas por cada msg

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
        const telLegible = String(jid || '').startsWith('ig:')
            ? jid
            : jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
        const chatUpdate = {
            ultimoMensaje: contenido?.slice(0, 150) || '',
            ultimoMensajeAt: timestamp,
            mensajesCount: FieldValue.increment(1),
            tel: telLegible,
        };
        if (String(jid || '').startsWith('ig:')) {
            chatUpdate.canal = 'instagram';
        }
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
/** ISO string o vacío (acepta Timestamp de Admin SDK). */
function fechaPedidoIso(p) {
    if (!p || typeof p !== 'object') return '';
    const f = p.fecha;
    if (f == null) return '';
    if (typeof f === 'string') return f;
    if (typeof f.toDate === 'function') return f.toDate().toISOString();
    return String(f);
}

/** Clave estable para unificar ítems de pedidos (evita duplicados al fusionar). */
function fingerprintPedidoFirestore(p) {
    if (p == null) return '';
    if (typeof p !== 'object') return String(p);
    const s = String(p.servicio || '').trim();
    const d = String(p.descripcion || '').trim();
    const f = fechaPedidoIso(p);
    const m = p.monto != null && p.monto !== '' ? String(p.monto) : '';
    const o = p.origenPanel ? '1' : (p.origenWhatsappAdmin ? '2' : '');
    return `${s}|${d}|${f}|${m}|${o}`;
}

/** Une arrays de pedidos (Firestore + memoria del bot) sin perder altas manuales del panel. */
function mergePedidosAnterioresFirestore(existing, incoming) {
    const a = Array.isArray(existing) ? existing : [];
    const b = Array.isArray(incoming) ? incoming : [];
    const seen = new Set();
    const out = [];
    for (const p of [...a, ...b]) {
        const fp = fingerprintPedidoFirestore(p);
        if (!fp || seen.has(fp)) continue;
        seen.add(fp);
        out.push(p);
    }
    out.sort((x, y) => {
        const tx = Date.parse(fechaPedidoIso(x)) || 0;
        const ty = Date.parse(fechaPedidoIso(y)) || 0;
        return tx - ty;
    });
    return out;
}

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
        for (const k of Object.keys(update)) {
            if (update[k] === undefined) delete update[k];
        }

        const snap = await docRef.get();
        if (Object.prototype.hasOwnProperty.call(datos, 'pedidosAnteriores')) {
            const prev = snap.exists ? (snap.data().pedidosAnteriores || []) : [];
            update.pedidosAnteriores = mergePedidosAnterioresFirestore(prev, datos.pedidosAnteriores || []);
        }

        if (!snap.exists) {
            update.fechaPrimerContacto = FieldValue.serverTimestamp();
        }

        await docRef.set(update, { merge: true });
    } catch (e) {
        console.warn('⚠️ Error syncCliente Firestore:', e.message);
    }
}

// ── Sincronización de cola de leña ─────────────────────────────────────
const COLA_LENA_FS_BATCH = 400;

/**
 * Replica la cola del bot en Firestore (panel cola-lena). No borra docs ausentes del array.
 * @param {Array<object>} colaLena
 */
async function syncColaLena(colaLena) {
    if (!firestoreDb || !Array.isArray(colaLena) || colaLena.length === 0) return;
    try {
        const admin = require('firebase-admin');
        const Timestamp = admin.firestore.Timestamp;
        const FieldValue = admin.firestore.FieldValue;

        for (let off = 0; off < colaLena.length; off += COLA_LENA_FS_BATCH) {
            const batch = firestoreDb.batch();
            const slice = colaLena.slice(off, off + COLA_LENA_FS_BATCH);
            for (const pedido of slice) {
                if (!pedido || !pedido.id) continue;
                const ref = firestoreDb.collection('colaLena').doc(String(pedido.id));

                let fechaTs;
                const fp = pedido.fechaPedido;
                if (fp && typeof fp.toDate === 'function') {
                    try {
                        fechaTs = Timestamp.fromDate(fp.toDate());
                    } catch {
                        fechaTs = Timestamp.now();
                    }
                } else if (typeof fp === 'string') {
                    const ms = Date.parse(fp);
                    fechaTs = Number.isFinite(ms) ? Timestamp.fromMillis(ms) : Timestamp.now();
                } else if (typeof fp === 'number' && Number.isFinite(fp)) {
                    fechaTs = Timestamp.fromMillis(fp);
                } else {
                    fechaTs = Timestamp.now();
                }

                /** @type {Record<string, unknown>} */
                const data = {
                    remoteJid: pedido.remoteJid || null,
                    nombre: pedido.nombre ?? null,
                    direccion: pedido.direccion ?? null,
                    zona: pedido.zona ?? null,
                    cantidadKg: Number(pedido.cantidadKg) || 0,
                    tipoLena: pedido.tipoLena ?? null,
                    tel: pedido.tel || String(pedido.id).replace(/^cola_/, '') || null,
                    fechaPedido: fechaTs,
                    estado: pedido.estado || 'en_cola',
                };

                if (pedido.estado === 'en_cola') {
                    data.ordenRuta = FieldValue.delete();
                    data.rutaGrupoId = FieldValue.delete();
                } else {
                    if (pedido.ordenRuta != null && Number.isFinite(Number(pedido.ordenRuta))) {
                        data.ordenRuta = Number(pedido.ordenRuta);
                    }
                    if (pedido.rutaGrupoId) data.rutaGrupoId = String(pedido.rutaGrupoId);
                }

                batch.set(ref, data, { merge: true });
            }
            await batch.commit();
        }
    } catch (e) {
        console.warn('⚠️ Error syncColaLena Firestore:', e.message);
    }
}

// ── Lectura de config dinámica ─────────────────────────────────────────
/**
 * Lee la configuración general desde Firestore con cache de 5 minutos.
 * Fallback a valores por defecto si Firestore no está disponible.
 */
function invalidateConfigCache() {
    configCache = null;
    configLastFetch = 0;
}

/**
 * @param {{ bypassCache?: boolean }} [opts] — bypassCache: leer siempre (p. ej. tras #silencio global o cada mensaje cliente para botActivo).
 */
async function getConfigGeneral(opts) {
    const DEFAULT_CONFIG = {
        delayMinSeg: 26,
        delayMaxSeg: 34,
        modeloGemini: 'gemini-2.5-flash',
        frecuenciaAudioFidelizacion: 0,
        tiempoSilencioHumanoHoras: 24,
        botActivo: true,
        /** Si es false, el bot no responde DMs de Instagram (WhatsApp sigue según botActivo). */
        instagramDmActivo: true,
        whatsappLabelIdContactarAsesor: '',
        campanaDelayMinSeg: 15,
        campanaDelayMaxSeg: 20,
        campanaMaxDestinatarios: 40,
        campanaDescuentoPct: 10,
        campanaRutaFechaTexto: 'mañana',
        campanaRutaPlantilla:
            'Hola {nombre}! Te cuento que {fechaTexto} vamos a estar por la zona *{zona}* y quería saber si necesitás *{producto}*, así aprovechás el flete sin cargo. Cualquier cosa escribime. — Vicky, Gardens Wood',
        /** Dígitos WhatsApp (ej. 5493512956376) — reenvío cuando el cliente manda datos de entrega; vacío = env/default en el bot. */
        datosEntregaNotifyPhone: '',
        /** Cron HTTP `/internal/cron/geocode-clientes`: si es false, el job no escribe (panel General). */
        geocodeCronActivo: true,
        /** Máximo de fichas a geocodificar por ejecución del cron (1–80 en servidor). */
        geocodeCronMaxPorEjecucion: 30,
        /** JID del grupo WA (…@g.us) donde avisar cada alta en `entregas_agenda`. Vacío = desactivado. */
        whatsappGrupoJidAgendaEntregas: '',
        /** Si es false, no se envía mensaje al grupo aunque haya JID (panel General). */
        notificarAgendaEntregasGrupoActivo: true,
    };

    if (!firestoreDb) return DEFAULT_CONFIG;

    const now = Date.now();
    const bypass = opts && opts.bypassCache === true;
    if (!bypass && configCache && (now - configLastFetch) < CONFIG_TTL) {
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

/** Lee botActivo en Firestore sin usar el cache de getConfigGeneral (cada mensaje cliente). */
async function getBotActivoLive() {
    if (!firestoreDb) return true;
    try {
        const snap = await firestoreDb.collection('config').doc('general').get();
        if (!snap.exists) return true;
        return snap.data()?.botActivo !== false;
    } catch (e) {
        console.warn('⚠️ getBotActivoLive:', e.message);
        return true;
    }
}

/** Lee instagramDmActivo (panel → General). Default true si no existe el campo. */
async function getInstagramDmActivoLive() {
    if (!firestoreDb) return true;
    try {
        const snap = await firestoreDb.collection('config').doc('general').get();
        if (!snap.exists) return true;
        const v = snap.data()?.instagramDmActivo;
        if (v === undefined || v === null) return true;
        return v !== false;
    } catch (e) {
        console.warn('⚠️ getInstagramDmActivoLive:', e.message);
        return true;
    }
}

/** Apaga/enciende respuestas de Vicky para *todos* los chats (config/general.botActivo). */
async function setBotActivoGlobal(activo) {
    if (!firestoreDb) return { ok: false, error: 'sin_firestore' };
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        await firestoreDb.collection('config').doc('general').set(
            { botActivo: !!activo, ultimaActualizacion: FieldValue.serverTimestamp() },
            { merge: true }
        );
        invalidateConfigCache();
        return { ok: true };
    } catch (e) {
        console.warn('⚠️ setBotActivoGlobal:', e.message);
        return { ok: false, error: e.message };
    }
}

/**
 * Texto multilínea para comando admin #estado (global + chats silenciados en Firestore).
 */
async function getEstadoVickyParaAdminTexto() {
    if (!firestoreDb) return '❌ Firestore no disponible.';

    const admin = require('firebase-admin');
    const Timestamp = admin.firestore.Timestamp;
    const nowMs = Date.now();
    const nowTs = Timestamp.fromMillis(nowMs);

    let cfg = {};
    try {
        const gsnap = await firestoreDb.collection('config').doc('general').get();
        if (gsnap.exists) cfg = gsnap.data() || {};
    } catch (e) {
        console.warn('⚠️ getEstadoVickyParaAdminTexto config:', e.message);
    }
    const botActivo = cfg.botActivo !== false;
    const igActivo = cfg.instagramDmActivo !== false;

    const lineas = [];
    lineas.push('📊 *Estado Vicky*\n');
    lineas.push(
        botActivo
            ? '• *WhatsApp (todos):* ✅ Activa'
            : '• *WhatsApp (todos):* 🔇 *Apagada* — nadie recibe respuesta automática (#activo global o panel General).'
    );
    lineas.push(
        igActivo
            ? '• *Instagram DM:* ✅ Activa (si global WhatsApp está apagado, igual no hay respuestas).'
            : '• *Instagram DM:* 🔇 Apagada (panel General → Instagram DM).'
    );

    const LIM_LISTA = 100;

    function lineaChat(docId, data, extra) {
        const d = data || {};
        const tel = d.tel
            || String(docId).replace(/@s\.whatsapp\.net$/i, '').replace(/@lid$/i, '')
            || docId;
        const nombre = d.nombre ? String(d.nombre) : '';
        const canal = d.canal === 'instagram' ? ' [IG]' : '';
        const nom = nombre ? ` (${nombre})` : '';
        return `• ${tel}${canal}${nom} — _${extra}_`;
    }

    lineas.push('\n*1) Humano atendiendo / #silenciar (`humanoAtendiendo`):*');
    try {
        const q1 = await firestoreDb.collection('chats').where('humanoAtendiendo', '==', true).limit(LIM_LISTA).get();
        if (q1.empty) {
            lineas.push('_Ninguno._');
        } else {
            const rows = [];
            q1.forEach((doc) => {
                const d = doc.data() || {};
                const tel = d.tel
                    || String(doc.id).replace(/@s\.whatsapp\.net$/i, '').replace(/@lid$/i, '')
                    || doc.id;
                rows.push({ sort: `${tel}`, line: lineaChat(doc.id, d, 'humano / panel / #silenciar') });
            });
            rows.sort((a, b) => a.sort.localeCompare(b.sort, 'es'));
            rows.forEach((r) => lineas.push(r.line));
            if (q1.size >= LIM_LISTA) lineas.push(`_(Mostrando hasta ${LIM_LISTA} chats.)_`);
        }
    } catch (e) {
        lineas.push(`_(Error humanoAtendiendo: ${e.message})_`);
    }

    lineas.push('\n*2) Silencio programado (`silenciadoHasta` vigente):*');
    try {
        const q2 = await firestoreDb.collection('chats').where('silenciadoHasta', '>', nowTs).limit(LIM_LISTA).get();
        if (q2.empty) {
            lineas.push('_Ninguno._');
        } else {
            const rows = [];
            q2.forEach((doc) => {
                const d = doc.data() || {};
                const sh = d.silenciadoHasta;
                let hastaTxt = 'programado';
                if (sh && typeof sh.toDate === 'function') {
                    hastaTxt = sh.toDate().toLocaleString('es-AR', {
                        timeZone: 'America/Argentina/Cordoba',
                        dateStyle: 'short',
                        timeStyle: 'short',
                    });
                }
                const extra = `silencio hasta ${hastaTxt}`;
                const tel = d.tel
                    || String(doc.id).replace(/@s\.whatsapp\.net$/i, '').replace(/@lid$/i, '')
                    || doc.id;
                rows.push({ sort: `${tel}`, line: lineaChat(doc.id, d, extra) });
            });
            rows.sort((a, b) => a.sort.localeCompare(b.sort, 'es'));
            rows.forEach((r) => lineas.push(r.line));
            if (q2.size >= LIM_LISTA) lineas.push(`_(Mostrando hasta ${LIM_LISTA} chats.)_`);
        }
    } catch (e) {
        lineas.push(`_(Error silenciadoHasta: ${e.message})_`);
    }

    lineas.push(
        '\n_#silencio global · #activo global (reactiva *todos* los chats, incl. humano) · #activo parcial (todos menos `humanoAtendiendo`) · #silenciar / #activar + contacto · #estado_'
    );
    return lineas.join('\n');
}

/**
 * Últimos mensajes del subchat en Firestore (misma fuente que el panel).
 * @returns {string} Bloque de texto para system/user context o ''.
 */
async function getUltimosMensajesChatParaContexto(jid, limit = 12) {
    if (!firestoreDb || !jid) return '';
    const lim = Math.min(20, Math.max(4, Number(limit) || 12));
    try {
        const snap = await firestoreDb
            .collection('chats')
            .doc(jid)
            .collection('mensajes')
            .orderBy('timestamp', 'desc')
            .limit(lim)
            .get();
        if (snap.empty) return '';
        const items = snap.docs.map((d) => d.data()).reverse();
        const lines = items.map((row) => {
            const dir = row.direccion === 'saliente' ? 'Vicky' : 'Cliente';
            let ts = '';
            if (row.timestamp && typeof row.timestamp.toDate === 'function') {
                ts = row.timestamp.toDate().toLocaleString('es-AR');
            }
            const txt = String(row.contenido || '').replace(/\s+/g, ' ').trim().slice(0, 400);
            return `• ${ts} ${dir}: ${txt}`;
        });
        return `[HILO_WHATSAPP_RECIENTE] Últimos mensajes del chat (registro Firestore; el texto que manda el cliente en este turno va aparte abajo):\n${lines.join('\n')}\nContinuidad: usá esto para saber de qué hablaban (producto, cotización, zona).`;
    } catch (e) {
        console.warn('⚠️ getUltimosMensajesChatParaContexto:', e.message);
        return '';
    }
}

/** Ítems del hilo (admin / extracción #p+). */
async function getUltimosMensajesChatItems(jid, limit = 24) {
    if (!firestoreDb || !jid) return [];
    const lim = Math.min(40, Math.max(5, Number(limit) || 24));
    try {
        const snap = await firestoreDb
            .collection('chats')
            .doc(jid)
            .collection('mensajes')
            .orderBy('timestamp', 'desc')
            .limit(lim)
            .get();
        if (snap.empty) return [];
        const rows = snap.docs.map((d) => d.data()).reverse();
        return rows.map((row) => ({
            direccion: row.direccion || 'entrante',
            contenido: String(row.contenido || '').slice(0, 2000),
        }));
    } catch (e) {
        console.warn('⚠️ getUltimosMensajesChatItems:', e.message);
        return [];
    }
}

function _pedidoFechaMsFirestore(p) {
    if (!p || typeof p !== 'object') return 0;
    const f = p.fecha;
    if (!f) return 0;
    if (typeof f === 'string') return Date.parse(f) || 0;
    if (typeof f.toDate === 'function') return f.toDate().getTime();
    return 0;
}

/** Todos los pedidos de clientes (muestra 800 docs), orden global reciente→antiguo para *#p lista*. */
async function listarPedidosFlatParaAdminP() {
    if (!firestoreDb) return [];
    try {
        const snap = await firestoreDb.collection('clientes').limit(800).get();
        const preparados = [];
        const jids = new Set();
        for (const d of snap.docs) {
            const tel = d.id;
            const x = d.data() || {};
            const pa = x.pedidosAnteriores;
            if (!Array.isArray(pa) || pa.length === 0) continue;
            let remoteJid = x.remoteJid || null;
            if (!remoteJid) {
                remoteJid = String(tel).startsWith('ig:') ? tel : `${String(tel).replace(/\D/g, '')}@s.whatsapp.net`;
            }
            jids.add(remoteJid);
            preparados.push({
                tel,
                x,
                remoteJid,
                nombre: String(x.nombre || '').trim(),
                pa,
            });
        }
        const chatTels = await batchChatTelPorJids([...jids]);
        const flat = [];
        for (const row of preparados) {
            const chatTel = chatTels.get(row.remoteJid);
            const telefonoDisplay = telefonoDisplayListaPedidosAdmin(row.tel, row.x, row.remoteJid, chatTel);
            row.pa.forEach((pedido, idxLocal) => {
                flat.push({
                    tel: row.tel,
                    remoteJid: row.remoteJid,
                    nombre: row.nombre,
                    idxLocal,
                    pedido,
                    telefonoDisplay,
                });
            });
        }
        flat.sort((a, b) => {
            const mb = _pedidoFechaMsFirestore(b.pedido) - _pedidoFechaMsFirestore(a.pedido);
            if (mb !== 0) return mb;
            return String(a.tel).localeCompare(String(b.tel), 'es') || a.idxLocal - b.idxLocal;
        });
        return flat;
    } catch (e) {
        console.warn('⚠️ listarPedidosFlatParaAdminP:', e.message);
        return [];
    }
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
 * Texto fijo después del audio de bienvenida (panel → config/prompts).
 */
async function getMensajeBienvenidaTexto(fallback) {
    if (!firestoreDb) return fallback;
    try {
        const snap = await firestoreDb.collection('config').doc('prompts').get();
        const t = snap.exists ? snap.data()?.mensajeBienvenidaTexto : null;
        if (t && String(t).trim()) return String(t).trim();
    } catch (e) {
        console.warn('⚠️ Error leyendo mensaje bienvenida Firestore:', e.message);
    }
    return fallback;
}

/** WhatsApp al cliente cuando admin dispara #final_entrega (panel → config/prompts). */
async function getMensajeClienteCierreEntregaHumano(fallback) {
    if (!firestoreDb) return fallback;
    try {
        const snap = await firestoreDb.collection('config').doc('prompts').get();
        const t = snap.exists ? snap.data()?.mensajeClienteCierreEntregaHumano : null;
        if (t && String(t).trim()) return String(t).trim();
    } catch (e) {
        console.warn('⚠️ Error leyendo mensajeClienteCierreEntregaHumano:', e.message);
    }
    return fallback;
}

/** Instrucción extra a Gemini mientras cierreEntregaAsistido (panel → config/prompts). */
async function getInstruccionCierreEntregaHumanoGemini(fallback) {
    if (!firestoreDb) return fallback;
    try {
        const snap = await firestoreDb.collection('config').doc('prompts').get();
        const t = snap.exists ? snap.data()?.instruccionCierreEntregaHumanoGemini : null;
        if (t && String(t).trim()) return String(t).trim();
    } catch (e) {
        console.warn('⚠️ Error leyendo instruccionCierreEntregaHumanoGemini:', e.message);
    }
    return fallback;
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

/**
 * Serializa el mapa `servicios` (id → datos del doc) para anexar al system prompt.
 * Los precios del panel prevalecen sobre ejemplos genéricos en el resto de las instrucciones.
 */
function buildServiciosPromptSuffix(servicios) {
    if (!servicios || typeof servicios !== 'object') return '';
    const ids = Object.keys(servicios).filter((k) => servicios[k] && typeof servicios[k] === 'object');
    if (ids.length === 0) return '';
    const lines = [
        '\n\n---\n[DATOS_SERVICIOS_FIRESTORE] Precios y condiciones editados desde el panel (Precios y servicios). Si chocan con cifras de ejemplo en el resto de esta instrucción, prevalece este bloque.',
    ];
    for (const id of ids.sort()) {
        const s = servicios[id];
        const nombre = s.nombre || id;
        if (s.activo === false) {
            lines.push(`\n• ${id} (${nombre}): SERVICIO INACTIVO — no ofrecer salvo seguimiento de un cliente que ya consultó por este rubro.`);
            continue;
        }
        lines.push(`\n• ${id} (${nombre})`);
        if (s.tieneEnvio && s.infoEnvio) {
            lines.push(`  Envío: ${String(s.infoEnvio).slice(0, 800)}`);
        }
        const precios = Array.isArray(s.precios) ? s.precios : [];
        for (const p of precios) {
            const desc = p.descripcion != null ? String(p.descripcion) : '';
            const precio = p.precio != null ? p.precio : '';
            const unidad = p.unidad != null ? String(p.unidad) : '';
            lines.push(`  - ${desc}: $${precio} / ${unidad}`);
        }
        if (s.marcador) lines.push(`  Marcador catálogo: ${s.marcador}`);
    }
    lines.push('\n---');
    return lines.join('');
}

// ── Actualizar estado humanoAtendiendo en Firestore ───────────────────
async function setHumanoAtendiendo(jid, value) {
    if (!firestoreDb) return;
    try {
        await firestoreDb.collection('chats').doc(jid).set(
            { humanoAtendiendo: value, humanoAtendiendoAt: value ? require('firebase-admin').firestore.FieldValue.serverTimestamp() : null },
            { merge: true }
        );
        // invalidar cache local
        chatSilenceCache.delete(jid);
    } catch (e) {
        console.warn('⚠️ Error setHumanoAtendiendo:', e.message);
    }
}

/** Quita silencio de panel (humano / silenciado hasta) para que Vicky vuelva a responder en ese JID. */
async function reactivarBotEnChat(jid) {
    if (!firestoreDb || !jid) return;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        await firestoreDb.collection('chats').doc(jid).set(
            {
                humanoAtendiendo: false,
                humanoAtendiendoAt: FieldValue.delete(),
                silenciadoHasta: FieldValue.delete(),
            },
            { merge: true }
        );
        chatSilenceCache.delete(jid);
    } catch (e) {
        console.warn('⚠️ Error reactivarBotEnChat:', e.message);
    }
}

/** Solo quita `humanoAtendiendo` (no toca `silenciadoHasta` del panel). Para #final_entrega post-handoff. */
async function quitarHumanoAtendiendoChat(jid) {
    if (!firestoreDb || !jid) return;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        await firestoreDb.collection('chats').doc(jid).set(
            {
                humanoAtendiendo: false,
                humanoAtendiendoAt: FieldValue.delete(),
            },
            { merge: true }
        );
        chatSilenceCache.delete(jid);
    } catch (e) {
        console.warn('⚠️ Error quitarHumanoAtendiendoChat:', e.message);
    }
}

async function setCierreEntregaAsistido(jid, value) {
    if (!firestoreDb || !jid) return;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const on = value === true;
        await firestoreDb.collection('chats').doc(jid).set(
            {
                cierreEntregaAsistido: on,
                cierreEntregaAsistidoAt: on ? FieldValue.serverTimestamp() : FieldValue.delete(),
            },
            { merge: true }
        );
        chatSilenceCache.delete(jid);
    } catch (e) {
        console.warn('⚠️ Error setCierreEntregaAsistido:', e.message);
    }
}

const REACTIVAR_CHAT_BATCH = 400;

/**
 * #activo global: reactiva todos los docs en `chats` (quita humano + silencio programado).
 */
async function reactivarTodosLosChatsDesdeFirestore() {
    if (!firestoreDb) return { ok: false, error: 'sin_firestore', total: 0 };
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const snap = await firestoreDb.collection('chats').get();
        let batch = firestoreDb.batch();
        let n = 0;
        let total = 0;
        for (const doc of snap.docs) {
            batch.set(
                doc.ref,
                {
                    humanoAtendiendo: false,
                    humanoAtendiendoAt: FieldValue.delete(),
                    silenciadoHasta: FieldValue.delete(),
                },
                { merge: true }
            );
            chatSilenceCache.delete(doc.id);
            n++;
            total++;
            if (n >= REACTIVAR_CHAT_BATCH) {
                await batch.commit();
                batch = firestoreDb.batch();
                n = 0;
            }
        }
        if (n > 0) await batch.commit();
        return { ok: true, total };
    } catch (e) {
        console.warn('⚠️ reactivarTodosLosChatsDesdeFirestore:', e.message);
        return { ok: false, error: e.message, total: 0 };
    }
}

/**
 * #activo parcial: reactiva chats que NO tienen `humanoAtendiendo` (intervención humana / #silenciar).
 * Los que siguen con humano=true no se tocan.
 */
async function reactivarChatsParcialDesdeFirestore() {
    if (!firestoreDb) return { ok: false, error: 'sin_firestore', total: 0, reactivados: [] };
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const snap = await firestoreDb.collection('chats').get();
        let batch = firestoreDb.batch();
        let n = 0;
        const reactivados = [];
        for (const doc of snap.docs) {
            const d = doc.data() || {};
            if (d.humanoAtendiendo === true) continue;
            batch.set(
                doc.ref,
                {
                    humanoAtendiendo: false,
                    humanoAtendiendoAt: FieldValue.delete(),
                    silenciadoHasta: FieldValue.delete(),
                },
                { merge: true }
            );
            chatSilenceCache.delete(doc.id);
            reactivados.push(doc.id);
            n++;
            if (n >= REACTIVAR_CHAT_BATCH) {
                await batch.commit();
                batch = firestoreDb.batch();
                n = 0;
            }
        }
        if (n > 0) await batch.commit();
        return { ok: true, total: reactivados.length, reactivados };
    } catch (e) {
        console.warn('⚠️ reactivarChatsParcialDesdeFirestore:', e.message);
        return { ok: false, error: e.message, total: 0, reactivados: [] };
    }
}

/**
 * Lee si un chat está silenciado por humano desde Firestore.
 * Retorna { humanoAtendiendo, silenciadoHasta, shouldSilence }.
 */
async function getChatSilenceState(jid) {
    const fallback = { humanoAtendiendo: false, silenciadoHasta: null, shouldSilence: false, cierreEntregaAsistido: false };
    if (!firestoreDb || !jid) return fallback;

    const now = Date.now();
    const cached = chatSilenceCache.get(jid);
    if (cached && (now - cached.fetchedAt) < chatSilenceTtlMs) {
        const v = cached.value || {};
        return {
            humanoAtendiendo: v.humanoAtendiendo === true,
            silenciadoHasta: v.silenciadoHasta ?? null,
            shouldSilence: v.shouldSilence === true,
            cierreEntregaAsistido: v.cierreEntregaAsistido === true,
        };
    }

    try {
        const snap = await firestoreDb.collection('chats').doc(jid).get();
        if (!snap.exists) {
            const value = { ...fallback, cierreEntregaAsistido: false };
            chatSilenceCache.set(jid, { value, fetchedAt: now });
            return value;
        }
        const d = snap.data() || {};
        const humanoAtendiendo = d.humanoAtendiendo === true;

        // silenciadoHasta puede venir como Timestamp de Firestore
        let silenciadoHastaMs = null;
        const sh = d.silenciadoHasta;
        if (sh && typeof sh.toDate === 'function') {
            silenciadoHastaMs = sh.toDate().getTime();
        } else if (typeof sh === 'number') {
            silenciadoHastaMs = sh;
        } else if (typeof sh === 'string') {
            const t = Date.parse(sh);
            silenciadoHastaMs = Number.isFinite(t) ? t : null;
        }

        const shouldSilence = humanoAtendiendo || (silenciadoHastaMs ? (silenciadoHastaMs > now) : false);
        const cierreEntregaAsistido = d.cierreEntregaAsistido === true;
        const value = { humanoAtendiendo, silenciadoHasta: silenciadoHastaMs, shouldSilence, cierreEntregaAsistido };
        chatSilenceCache.set(jid, { value, fetchedAt: now });
        return value;
    } catch (e) {
        // No cortar el bot por error Firestore
        console.warn('⚠️ Error getChatSilenceState:', e.message);
        const value = fallback;
        chatSilenceCache.set(jid, { value, fetchedAt: now });
        return value;
    }
}

/**
 * Permite ajustar el TTL del cache de silencio (ms).
 */
function setChatSilenceCacheTtl(ms) {
    const v = parseInt(ms, 10);
    if (Number.isFinite(v) && v >= 0) chatSilenceTtlMs = v;
}

// ── Borradores de instrucciones (#G) → revisión en panel ───────────────
/** Máx. caracteres del instructivo #g (Firestore doc ~1MB; systemInstruction del modelo también tiene techo). */
const MAX_INSTRUCTIVO_WHATSAPP_CHARS = 32000;

async function addPromptBorrador({ texto, adminJid }) {
    if (!firestoreDb || !String(texto || '').trim()) return null;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const ref = await firestoreDb
            .collection('config').doc('prompts')
            .collection('borradores')
            .add({
                texto: String(texto).slice(0, MAX_INSTRUCTIVO_WHATSAPP_CHARS),
                adminJid: adminJid || null,
                estado: 'pendiente',
                creadoEn: FieldValue.serverTimestamp(),
            });
        return ref.id;
    } catch (e) {
        console.warn('⚠️ Error addPromptBorrador:', e.message);
        return null;
    }
}

/** Fusiona el instructivo de WhatsApp (#g + OK) en `config/prompts.sistemaPrompt` (misma idea que “Aplicar” en el panel). */
async function aplicarInstructivoWhatsAppASistemaPrompt({ texto, adminJid, promptBaseSiVacio }) {
    if (!firestoreDb || !String(texto || '').trim()) {
        return { ok: false, error: 'Firestore no disponible o texto vacío' };
    }
    try {
        const ref = firestoreDb.collection('config').doc('prompts');
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const slice = String(texto).slice(0, MAX_INSTRUCTIVO_WHATSAPP_CHARS);
        const jid = String(adminJid || '').slice(0, 120);
        await firestoreDb.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            let actual = snap.exists ? String(snap.data().sistemaPrompt || '') : '';
            if (!actual.trim() && String(promptBaseSiVacio || '').trim()) {
                actual = String(promptBaseSiVacio);
            }
            const tag = new Date().toISOString();
            const bloque = `\n\n---\n[Instrucción aplicada desde WhatsApp — ${tag}]${jid ? ` (${jid})` : ''}\n${slice}\n---\n`;
            tx.set(
                ref,
                {
                    sistemaPrompt: actual + bloque,
                    ultimaActualizacion: FieldValue.serverTimestamp(),
                },
                { merge: true }
            );
        });
        return { ok: true };
    } catch (e) {
        console.warn('⚠️ aplicarInstructivoWhatsAppASistemaPrompt:', e.message);
        return { ok: false, error: e.message };
    }
}

// ── Reporte admin (#REPORTE) ─────────────────────────────────────────
function normalizarTextoReporte(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '');
}

function soloDigitosTelReporte(s) {
    return String(s || '').replace(/\D/g, '');
}

/**
 * Id de doc `clientes/{id}` = userId de WA (10–15 dígitos). Los @lid suelen ser más largos: no es el celular.
 */
function docIdPareceUserIdWhatsapp(idDigits) {
    const d = String(idDigits || '');
    return d.length >= 10 && d.length <= 15 && /^\d+$/.test(d);
}

function esClienteDocLid(datos, idDigits) {
    const rj = String(datos?.remoteJid || '');
    if (rj.endsWith('@lid')) return true;
    return String(idDigits || '').length > 15;
}

/**
 * Lista reporte: quita 54 y 9 móvil; bloque 351 + 6–8; o 9351… sin país.
 */
function telefonoParaListaReporte(digitsRaw) {
    let d = soloDigitosTelReporte(digitsRaw);
    if (d.length < 8) return '';

    if (d.startsWith('54')) {
        d = d.slice(2);
        if (d.startsWith('9')) d = d.slice(1);
    } else if (/^9351\d{6,}/.test(d)) {
        d = d.slice(1);
    }

    const m0 = d.match(/^351\d{6,8}/);
    if (m0) return m0[0];
    const m1 = d.match(/351\d{6,8}/);
    if (m1) return m1[0];
    if (d.length >= 8 && d.length <= 11) return d;
    if (d.length <= 13) return d;
    return d.slice(0, 13);
}

/**
 * Usa `telefono` del doc cuando el id es LID u otro id interno; si no, userId WA en doc id / tel.
 */
function telefonoDisplayCliente(docId, datos) {
    const x = datos || {};
    const idD = soloDigitosTelReporte(String(docId || ''));
    const telCampo = soloDigitosTelReporte(String(x.tel || ''));
    const telHumano = soloDigitosTelReporte(String(x.telefono || x.telefonoNormalizado || ''));

    if (esClienteDocLid(x, idD) || !docIdPareceUserIdWhatsapp(idD)) {
        if (telHumano.length >= 8) {
            const r = telefonoParaListaReporte(telHumano);
            if (r) return r;
        }
        if (telCampo.length >= 8 && telCampo !== idD) {
            const r = telefonoParaListaReporte(telCampo);
            if (r) return r;
        }
    }

    const orden = [idD, telHumano, telCampo].filter((t) => t.length >= 8);
    for (const t of orden) {
        const r = telefonoParaListaReporte(t);
        if (r) return r;
    }
    return orden[0] || '—';
}

function telefonoSoloDesdeJidWhatsapp(jid) {
    const j = String(jid || '');
    const m = j.match(/^(\d{8,20})@s\.whatsapp\.net$/i);
    if (!m) return '';
    return telefonoParaListaReporte(m[1]);
}

/** Evita mostrar userIds internos de WhatsApp (14–15 dígitos) como celular; acepta típico AR (10–11 dígitos sin país). */
function digitosParecenTelefonoArgMostrable(digitsRaw) {
    const d = soloDigitosTelReporte(digitsRaw);
    if (d.length < 8 || d.length > 13) return false;
    if (d.length >= 10 && d.length <= 11) return true;
    if (d.startsWith('351') && d.length >= 9) return true;
    if (d.startsWith('11') && d.length >= 10) return true;
    return false;
}

/**
 * Lee `tel` del doc padre `chats/{jid}` (mismo valor que en log de mensajes).
 * Firestore getAll: máx. 10 refs por llamada.
 */
async function batchChatTelPorJids(jids) {
    const map = new Map();
    if (!firestoreDb || !jids?.length) return map;
    const uniq = [...new Set(jids.filter(Boolean))];
    const chunk = 10;
    try {
        for (let i = 0; i < uniq.length; i += chunk) {
            const part = uniq.slice(i, i + chunk);
            const refs = part.map((jid) => firestoreDb.collection('chats').doc(jid));
            const snaps = await firestoreDb.getAll(...refs);
            for (const snap of snaps) {
                if (!snap.exists) continue;
                const t = snap.data()?.tel;
                const s = String(t || '').trim();
                if (s) map.set(snap.id, s);
            }
        }
    } catch (e) {
        console.warn('⚠️ batchChatTelPorJids:', e.message);
    }
    return map;
}

/**
 * Teléfono legible para *#p lista*: `telefono` del doc, `chats/{jid}.tel`, userId en `@s.whatsapp.net`
 * (normalizado con la misma lógica que reportes). Si no hay celular real (p. ej. solo `@lid` sin `telefono`),
 * mostramos referencia + comando para cargarlo.
 */
function telefonoDisplayListaPedidosAdmin(docId, datos, remoteJid, chatTelRaw) {
    const x = datos || {};
    const rj = String(remoteJid || '');

    if (String(docId || '').startsWith('ig:') || rj.startsWith('ig:')) {
        const hum = soloDigitosTelReporte(String(x.telefono || x.telefonoNormalizado || x.tel || ''));
        if (hum.length >= 8) return telefonoParaListaReporte(hum) || 'Instagram';
        return 'Instagram';
    }

    const hum = soloDigitosTelReporte(String(x.telefono || x.telefonoNormalizado || x.telLinea || x.tel || ''));
    if (hum.length >= 8) {
        const r = telefonoParaListaReporte(hum);
        if (r) return r;
    }

    if (chatTelRaw) {
        const cdc = soloDigitosTelReporte(String(chatTelRaw));
        if (cdc.length >= 8) {
            const rc = telefonoParaListaReporte(cdc);
            if (rc) return rc;
        }
    }

    if (rj.endsWith('@s.whatsapp.net')) {
        const uid = soloDigitosTelReporte(rj.replace(/@s\.whatsapp\.net$/i, ''));
        const r = telefonoParaListaReporte(uid);
        if (r) return r;
        if (uid.length >= 8 && uid.length <= 15) return uid;
    }

    if (rj.endsWith('@lid')) {
        if (hum.length >= 8) {
            const r = telefonoParaListaReporte(hum);
            if (r) return r;
        }
        const lidNum = soloDigitosTelReporte(rj.replace(/@lid$/i, ''));
        if (lidNum.length >= 6) {
            return `LID·${lidNum.slice(-10)}`;
        }
    }

    const conNombre = telefonoDisplayCliente(docId, x);
    if (conNombre && conNombre !== '—') {
        const cn = soloDigitosTelReporte(conNombre);
        if (digitosParecenTelefonoArgMostrable(cn) || (cn.length >= 8 && cn.length <= 11)) return conNombre;
    }

    const idD = soloDigitosTelReporte(String(docId || ''));
    const rNormId = telefonoParaListaReporte(idD);
    if (rNormId) return rNormId;
    if (idD.length >= 10 && idD.length <= 15) return idD;

    const telSoloCampo = soloDigitosTelReporte(String(x.tel || ''));
    if (telSoloCampo.length >= 8 && telSoloCampo !== idD) {
        const rt = telefonoParaListaReporte(telSoloCampo);
        if (rt) return rt;
    }

    return '_(asigná cel: `#p tel N 351…`)_';
}

/** Formato legible para listados admin (misma lógica que reporte). */
function formatoTelefonoListaAdmin(raw) {
    const d = soloDigitosTelReporte(String(raw || ''));
    if (d.length < 8) return '';
    return telefonoParaListaReporte(d) || d;
}

/** JID de chat → teléfono mostrable (clientes.remoteJid o mismo número @s.whatsapp.net). */
function construirMapaJidATelefonoCliente(snap) {
    const map = new Map();
    if (!snap?.docs) return map;
    for (const d of snap.docs) {
        const x = d.data() || {};
        const display = telefonoDisplayCliente(d.id, x);
        const rj = String(x.remoteJid || '').trim();
        if (rj) map.set(rj, display);
        const idDigits = soloDigitosTelReporte(d.id);
        if (idDigits.length >= 8) {
            map.set(`${idDigits}@s.whatsapp.net`, display);
        }
    }
    return map;
}

/** Agregados + índice para seguimiento *detalle …* tras #reporte. */
async function getReporteDatosAgregados() {
    if (!firestoreDb) {
        return { texto: 'Firestore no disponible.', indice: null };
    }
    try {
        const snap = await firestoreDb.collection('clientes').limit(800).get();
        const byEstado = {};
        const byServicio = {};
        let potCaliente = 0;
        let potTibio = 0;
        let potFrio = 0;
        let conPedidosRegistrados = 0;
        for (const d of snap.docs) {
            const x = d.data() || {};
            const e = x.estado || 'nuevo';
            byEstado[e] = (byEstado[e] || 0) + 1;
            if (x.servicioPendiente) {
                const sp = x.servicioPendiente;
                byServicio[sp] = (byServicio[sp] || 0) + 1;
            }
            const p = (x.potencial || '').toLowerCase();
            if (p === 'caliente') potCaliente++;
            else if (p === 'tibio') potTibio++;
            else if (p === 'frío' || p === 'frio') potFrio++;
            const pa = x.pedidosAnteriores;
            if (Array.isArray(pa) && pa.length > 0) conPedidosRegistrados++;
        }
        const dias = 2;
        const desde = new Date(Date.now() - dias * 86400000);
        const logSnap = await firestoreDb.collection('mensajes_log')
            .where('timestamp', '>=', desde)
            .limit(500)
            .get()
            .catch(() => ({ docs: [] }));
        const logN = logSnap.docs?.length || 0;
        const lines = [
            `📊 *Reporte Gardens Wood* (${snap.size} clientes en muestra)`,
            '',
            `Potencial: frío ${potFrio} · tibio ${potTibio} · caliente ${potCaliente}`,
            `Con *pedido* en historial (\`pedidosAnteriores\`, marcador [PEDIDO:…]): *${conPedidosRegistrados}*`,
            '',
            '*Por estado:*',
            ...Object.entries(byEstado).sort((a, b) => b[1] - a[1]).map(([k, v]) => `· ${k}: ${v}`),
            '',
            '*Consultas por servicio (servicioPendiente):*',
            ...(Object.keys(byServicio).length
                ? Object.entries(byServicio).sort((a, b) => b[1] - a[1]).map(([k, v]) => `· ${k}: ${v}`)
                : ['· (sin datos)']),
            '',
            `Mensajes log (~${logN} en ${dias}d).`,
            '',
            '_Aviso masivo (mismo límite y delay que #ruta): *#enviar clientes …texto…* o *#enviar leña …* / *cerco* / *pergola* / *fogonero* (también *!!enviar*)._',
            '',
            '_Listado de quienes tienen pedido guardado: *detalle pedidos* (o *#d pedidos*). Otros: *detalle caliente* / *detalle estado X*, *detalle servicio X*, *detalle log*._',
        ];
        const indice = {
            muestra: snap.size,
            diasLog: dias,
            potencial: { frio: potFrio, tibio: potTibio, caliente: potCaliente },
            estados: { ...byEstado },
            servicios: { ...byServicio },
            logCount: logN,
            conPedidosRegistrados,
        };
        return { texto: lines.join('\n'), indice };
    } catch (e) {
        console.warn('⚠️ getReporteDatosAgregados:', e.message);
        return { texto: `Error armando reporte: ${e.message}`, indice: null };
    }
}

async function getReporteResumenTexto() {
    const { texto } = await getReporteDatosAgregados();
    return texto;
}

function parseConsultaDetalleReporte(raw, indice) {
    const q0 = String(raw || '').trim();
    if (!q0) return { error: 'Escribí qué querés detallar.' };
    const q = q0.toLowerCase();
    const norm = normalizarTextoReporte(q0);

    if (/^(log|mensajes)$/i.test(q)) return { tipo: 'log' };

    if (/^pedidos?\s*$/i.test(q.trim()) || /^con\s+pedidos?\s*$/i.test(q.trim())) {
        return { tipo: 'pedidos' };
    }

    let m = q.match(/^potencial\s+(.+)$/);
    if (m) {
        const p = matchPotencialDetalle(m[1]);
        if (p) return { tipo: 'potencial', valor: p };
    }
    m = q.match(/^estado\s+(.+)$/);
    if (m) return { tipo: 'estado', valor: m[1].trim() };

    m = q.match(/^servicio\s+(.+)$/);
    if (m) return { tipo: 'servicio', valor: m[1].trim() };

    const pSolo = matchPotencialDetalle(q);
    if (pSolo) return { tipo: 'potencial', valor: pSolo };

    if (indice?.estados && typeof indice.estados === 'object') {
        for (const k of Object.keys(indice.estados)) {
            const nk = normalizarTextoReporte(k);
            if (nk === norm || norm.includes(nk) || nk.includes(norm)) {
                return { tipo: 'estado', valor: k };
            }
        }
    }
    if (indice?.servicios && typeof indice.servicios === 'object') {
        for (const k of Object.keys(indice.servicios)) {
            const nk = normalizarTextoReporte(k);
            if (nk && (nk === norm || norm.includes(nk) || nk.includes(norm))) {
                return { tipo: 'servicio', valor: k };
            }
        }
    }

    const estadosEj = indice?.estados ? Object.keys(indice.estados).slice(0, 8).join(', ') : 'nuevo, cotizado…';
    const servEj = indice?.servicios ? Object.keys(indice.servicios).slice(0, 6).join(', ') : 'lena, pergola…';
    return {
        error: `No ubiqué “${q0}”. Probá: *detalle pedidos*, *detalle caliente*, *detalle estado ${estadosEj.split(',')[0] || 'nuevo'}*, *detalle servicio lena*, *detalle log*.\n_Estados: ${estadosEj} · Servicios: ${servEj}_`,
    };
}

function matchPotencialDetalle(s) {
    const t = normalizarTextoReporte(s);
    if (!t) return null;
    if (t.includes('caliente')) return 'caliente';
    if (t.includes('tibio')) return 'tibio';
    if (t.includes('frio')) return 'frio';
    return null;
}

/** Clientes con al menos un ítem en `pedidosAnteriores` (marcador [PEDIDO:…] en chat). */
async function listarClientesConPedidosReporte() {
    const snap = await firestoreDb.collection('clientes').limit(800).get();
    const rows = [];
    for (const d of snap.docs) {
        const x = d.data() || {};
        const pa = x.pedidosAnteriores;
        if (!Array.isArray(pa) || pa.length === 0) continue;
        const ultimo = pa[pa.length - 1];
        let ultimoPedido = '';
        if (ultimo && typeof ultimo === 'object') {
            ultimoPedido = `${ultimo.servicio || '—'}: ${ultimo.descripcion || ''}`.trim();
        } else {
            ultimoPedido = String(ultimo || '');
        }
        rows.push({
            tel: d.id,
            telefonoDisplay: telefonoDisplayCliente(d.id, x),
            nombre: String(x.nombre || '').trim(),
            zona: String(x.zona || '').trim(),
            direccion: String(x.direccion || '').trim(),
            estado: x.estado || 'nuevo',
            nPedidos: pa.length,
            ultimoPedido,
        });
    }
    rows.sort((a, b) => (a.nombre || a.tel).localeCompare(b.nombre || b.tel, 'es'));
    return rows;
}

async function listarClientesReporteDetalle({ potencial, estado, servicioSub }) {
    const snap = await firestoreDb.collection('clientes').limit(800).get();
    const rows = [];
    for (const d of snap.docs) {
        const x = d.data() || {};
        const tel = d.id;
        if (potencial) {
            const p = normalizarTextoReporte(x.potencial || '');
            const ok = potencial === 'caliente' ? p === 'caliente'
                : potencial === 'tibio' ? p === 'tibio'
                    : potencial === 'frio' ? (p === 'frio' || p === 'frío')
                        : false;
            if (!ok) continue;
        } else if (estado != null && estado !== '') {
            const e = normalizarTextoReporte(x.estado || 'nuevo');
            if (e !== normalizarTextoReporte(estado)) continue;
        } else if (servicioSub != null && servicioSub !== '') {
            const sp = String(x.servicioPendiente || '').toLowerCase();
            const needle = String(servicioSub).toLowerCase();
            if (!sp.includes(needle)) continue;
        } else {
            continue;
        }
        rows.push({
            tel,
            telefonoDisplay: telefonoDisplayCliente(tel, x),
            nombre: String(x.nombre || '').trim(),
            zona: String(x.zona || '').trim(),
            estado: x.estado || 'nuevo',
            servicioPendiente: String(x.servicioPendiente || '').trim(),
            potencial: String(x.potencial || '').trim(),
        });
    }
    rows.sort((a, b) => (a.nombre || a.tel).localeCompare(b.nombre || b.tel, 'es'));
    return rows;
}

async function textoDetalleLogReporte(dias = 2) {
    const desde = new Date(Date.now() - dias * 86400000);
    const logSnap = await firestoreDb.collection('mensajes_log')
        .where('timestamp', '>=', desde)
        .limit(500)
        .get()
        .catch(() => ({ docs: [] }));
    const clientesSnap = await firestoreDb.collection('clientes').limit(1000).get().catch(() => ({ docs: [] }));
    const jidToTel = construirMapaJidATelefonoCliente(clientesSnap);

    const byJid = {};
    for (const doc of logSnap.docs || []) {
        const x = doc.data() || {};
        const jid = x.jid || '?';
        byJid[jid] = (byJid[jid] || 0) + 1;
    }
    const sorted = Object.entries(byJid).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
        return '📋 *Detalle log*\n(sin registros en el período).';
    }
    const lines = [
        `📋 *Detalle mensajes log* (${dias}d, hasta ${sorted.length} chats con actividad)`,
        '_Tel sin +54/9; zona 351 = *351* + 6–8 dígitos (móvil suele 7)._',
        '',
    ];
    const top = sorted.slice(0, 30);
    for (const [jid, n] of top) {
        const porCliente = jidToTel.get(jid);
        const porJid = telefonoSoloDesdeJidWhatsapp(jid);
        const tel = porCliente || porJid;
        if (tel) {
            lines.push(`· *${tel}* — *${n}* msgs`);
        } else {
            const hint = jid.includes('@lid') ? 'contacto @lid (sin tel en clientes)' : String(jid).slice(0, 48);
            lines.push(`· _${hint}_ — *${n}* msgs`);
        }
    }
    if (sorted.length > top.length) {
        lines.push(`\n_…y ${sorted.length - top.length} chats más con menos volumen._`);
    }
    return lines.join('\n');
}

const MAX_DETALLE_FILAS = 55;

/** Tras *#reporte*: *detalle …* o *#d …* — lista clientes o resumen del log. */
async function getReporteDetalleTexto(consultaRaw, indice) {
    if (!firestoreDb) return 'Firestore no disponible.';
    if (!indice || typeof indice !== 'object') {
        return 'ℹ️ Primero pedí *#reporte* para generar el resumen; después podés usar *detalle …*.';
    }
    const parsed = parseConsultaDetalleReporte(consultaRaw, indice);
    if (parsed.error) return `❌ ${parsed.error}`;

    try {
        if (parsed.tipo === 'log') {
            return await textoDetalleLogReporte(indice.diasLog || 2);
        }
        if (parsed.tipo === 'pedidos') {
            const rowsP = await listarClientesConPedidosReporte();
            if (rowsP.length === 0) {
                return '📋 *Detalle — pedidos*\n\n(sin clientes con pedidos en `pedidosAnteriores` en la muestra de 800).\n_Si Vicky no agregó [PEDIDO:…], el historial puede estar vacío aunque el cliente haya “confirmado”._';
            }
            const out = [
                '📋 *Detalle — clientes con pedido registrado*',
                `_${rowsP.length} contacto(s). Muestra máx. ${MAX_DETALLE_FILAS}._`,
                '',
            ];
            const slice = rowsP.slice(0, MAX_DETALLE_FILAS);
            for (const r of slice) {
                const tel = r.telefonoDisplay || telefonoDisplayCliente(r.tel, {});
                const nom = r.nombre || '(sin nombre)';
                const z = r.zona ? ` · ${r.zona}` : '';
                const dir = r.direccion ? ` · 📍 ${r.direccion.slice(0, 60)}${r.direccion.length > 60 ? '…' : ''}` : '';
                const up = r.ultimoPedido
                    ? `\n  _Último: ${r.ultimoPedido.slice(0, 140)}${r.ultimoPedido.length > 140 ? '…' : ''}_`
                    : '';
                out.push(`· *${tel}* — ${nom}${z}${dir} · *${r.nPedidos}* pedido(s) · estado *${r.estado}*${up}`);
            }
            if (rowsP.length > slice.length) {
                out.push(`\n_…y ${rowsP.length - slice.length} más._`);
            }
            return out.join('\n');
        }
        let rows = [];
        let titulo = '';
        if (parsed.tipo === 'potencial') {
            titulo = `Potencial *${parsed.valor}*`;
            rows = await listarClientesReporteDetalle({ potencial: parsed.valor });
        } else if (parsed.tipo === 'estado') {
            titulo = `Estado *${parsed.valor}*`;
            rows = await listarClientesReporteDetalle({ estado: parsed.valor });
        } else if (parsed.tipo === 'servicio') {
            titulo = `Servicio *${parsed.valor}* (servicioPendiente)`;
            rows = await listarClientesReporteDetalle({ servicioSub: parsed.valor });
        } else {
            return '❌ Tipo de detalle no soportado.';
        }
        if (rows.length === 0) {
            return `📋 *${titulo}*\n\n(sin contactos en la muestra de 800 clientes).`;
        }
        const out = [
            `📋 *Detalle — ${titulo}*`,
            `_${rows.length} contacto(s). Muestra máx. ${MAX_DETALLE_FILAS}._`,
            '_Celular: campo *telefono* (línea) o número del doc; el bot rellena *telefono* al sincronizar._',
            '',
        ];
        const slice = rows.slice(0, MAX_DETALLE_FILAS);
        for (const r of slice) {
            const nom = r.nombre || '(sin nombre)';
            const z = r.zona ? ` · ${r.zona}` : '';
            const sp = r.servicioPendiente ? ` · srv: ${r.servicioPendiente}` : '';
            const pot = r.potencial ? ` · ${r.potencial}` : '';
            const tel = r.telefonoDisplay || telefonoDisplayCliente(r.tel, {});
            const idDoc = String(r.tel || '');
            const refId = tel === '—' && idDoc
                ? ` _[id doc: ${idDoc.length > 22 ? `${idDoc.slice(0, 20)}…` : idDoc}]_`
                : '';
            out.push(`· *${tel}* — ${nom}${z}${sp}${pot} · estado: ${r.estado}${refId}`);
        }
        if (rows.length > slice.length) {
            out.push(`\n_…y ${rows.length - slice.length} más. Afiná el filtro (servicio/estado) si hace falta._`);
        }
        return out.join('\n');
    } catch (e) {
        console.warn('⚠️ getReporteDetalleTexto:', e.message);
        return `❌ Error: ${e.message}`;
    }
}

/**
 * JIDs con silencio activo en `chats/*` (humano atendiendo o `silenciadoHasta` vigente).
 * Evita #RUTA / #enviar a quien el bot ya no debe molestar.
 */
async function getJidsConSilencioCampana() {
    if (!firestoreDb) return new Set();
    const admin = require('firebase-admin');
    const nowTs = admin.firestore.Timestamp.now();
    const LIM = 3000;
    const jids = new Set();
    try {
        const s1 = await firestoreDb.collection('chats').where('humanoAtendiendo', '==', true).limit(LIM).get();
        s1.docs.forEach((d) => jids.add(d.id));
    } catch (e) {
        console.warn('⚠️ getJidsConSilencioCampana humanoAtendiendo:', e.message);
    }
    try {
        const s2 = await firestoreDb.collection('chats').where('silenciadoHasta', '>', nowTs).limit(LIM).get();
        s2.docs.forEach((d) => jids.add(d.id));
    } catch (e) {
        console.warn('⚠️ getJidsConSilencioCampana silenciadoHasta:', e.message);
    }
    return jids;
}

/**
 * Clientes para campaña #RUTA: zona (substring) + servicio (id o nombre parcial o interés).
 * Excluye Instagram y chats con `humanoAtendiendo` / `silenciadoHasta` vigente.
 * @param {{ tipoLenaPreferido?: string | null }} [opts]
 */
async function listClientesParaCampana(zonaFiltro, servicioFiltro, opts = {}) {
    if (!firestoreDb) return [];
    const z = String(zonaFiltro || '').trim().toLowerCase();
    const s = String(servicioFiltro || '').trim().toLowerCase();
    const tipoFiltro = String(opts.tipoLenaPreferido || '').trim().toLowerCase();
    const tiposValidos = new Set(['hogar', 'salamandra', 'parrilla']);
    try {
        const silenciados = await getJidsConSilencioCampana();
        const snap = await firestoreDb.collection('clientes').limit(1000).get();
        const out = [];
        for (const d of snap.docs) {
            const x = d.data() || {};
            const tel = d.id;
            const zonaDoc = String(x.zona || '').toLowerCase();
            if (z && !zonaDoc.includes(z)) continue;
            const sp = String(x.servicioPendiente || '').toLowerCase();
            const intereses = Array.isArray(x.interes) ? x.interes : [];
            const matchInteres = intereses.some((i) => {
                const il = String(i || '').toLowerCase();
                if (!s) return true;
                return il.includes(s) || s.includes(il);
            });
            if (s && !sp.includes(s) && !String(tel).includes(s) && !matchInteres) continue;
            if (tipoFiltro && tiposValidos.has(tipoFiltro)) {
                const tp = String(x.tipoLenaPreferido || '').toLowerCase();
                if (tp !== tipoFiltro) continue;
            }
            const rj = String(x.remoteJid || '').trim() || `${tel}@s.whatsapp.net`;
            if (rj.startsWith('ig:')) continue;
            if (silenciados.has(rj)) continue;
            out.push({
                tel,
                remoteJid: rj,
                nombre: x.nombre || tel,
                zona: x.zona || '',
                tipoLenaPreferido: x.tipoLenaPreferido || null,
            });
        }
        return out;
    } catch (e) {
        console.warn('⚠️ listClientesParaCampana:', e.message);
        return [];
    }
}

function readScalarCoordCampana(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const t = String(v).trim().replace(',', '.');
        if (!t) return null;
        const n = parseFloat(t);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** @param {Record<string, unknown>} x - doc clientes */
function clienteLatLngFromDocCampana(x) {
    const lat = readScalarCoordCampana(x.lat);
    const lng = readScalarCoordCampana(x.lng);
    if (lat != null && lng != null) return { lat, lng };
    const g = x.ubicacion || x.coordinates;
    if (g && typeof g === 'object') {
        const o = /** @type {{ latitude?: unknown; longitude?: unknown }} */ (g);
        const la = readScalarCoordCampana(o.latitude);
        const ln = readScalarCoordCampana(o.longitude);
        if (la != null && ln != null) return { lat: la, lng: ln };
    }
    return null;
}

/**
 * Lee una ruta guardada por el panel (`rutas_logistica`).
 * @param {string} rutaId
 * @returns {Promise<null | { id: string, nombre: string, polyline: { lat: number, lng: number }[], bufferMetros: number, activa: boolean, notas: string }>}
 */
async function getRutaLogistica(rutaId) {
    if (!firestoreDb || !rutaId) return null;
    try {
        const snap = await firestoreDb.collection('rutas_logistica').doc(String(rutaId).trim()).get();
        if (!snap.exists) return null;
        const d = snap.data() || {};
        const raw = Array.isArray(d.polyline) ? d.polyline : [];
        const polyline = [];
        for (const p of raw) {
            if (!p || typeof p !== 'object') continue;
            const lat = Number(/** @type {{ lat?: unknown }} */ (p).lat);
            const lng = Number(/** @type {{ lng?: unknown }} */ (p).lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) polyline.push({ lat, lng });
        }
        const bufferMetros = Number(d.bufferMetros);
        return {
            id: snap.id,
            nombre: String(d.nombre || snap.id).trim() || snap.id,
            polyline,
            bufferMetros: Number.isFinite(bufferMetros) && bufferMetros > 0 ? bufferMetros : 0,
            activa: d.activa !== false,
            notas: String(d.notas || ''),
        };
    } catch (e) {
        console.warn('⚠️ getRutaLogistica:', e.message);
        return null;
    }
}

/**
 * Igual que listClientesParaCampana pero sin filtro de zona; solo clientes con lat/lng dentro del corredor (buffer a la polilínea).
 * @param {string} rutaId
 * @param {string} servicioFiltro
 * @param {{ tipoLenaPreferido?: string | null }} [opts]
 */
async function listClientesParaCampanaGeo(rutaId, servicioFiltro, opts = {}) {
    if (!firestoreDb) return [];
    let turf;
    try {
        turf = require('@turf/turf');
    } catch (e) {
        console.warn('⚠️ listClientesParaCampanaGeo: falta @turf/turf', e.message);
        return [];
    }
    const ruta = await getRutaLogistica(rutaId);
    if (!ruta || ruta.polyline.length < 2 || ruta.bufferMetros <= 0) return [];

    const coords = ruta.polyline.map((p) => [p.lng, p.lat]);
    let line;
    try {
        line = turf.lineString(coords);
    } catch (e) {
        console.warn('⚠️ listClientesParaCampanaGeo lineString:', e.message);
        return [];
    }

    const s = String(servicioFiltro || '').trim().toLowerCase();
    const tipoFiltro = String(opts.tipoLenaPreferido || '').trim().toLowerCase();
    const tiposValidos = new Set(['hogar', 'salamandra', 'parrilla']);
    const bufferM = ruta.bufferMetros;

    try {
        const silenciados = await getJidsConSilencioCampana();
        const snap = await firestoreDb.collection('clientes').limit(1000).get();
        const out = [];
        for (const d of snap.docs) {
            const x = d.data() || {};
            const tel = d.id;
            const sp = String(x.servicioPendiente || '').toLowerCase();
            const intereses = Array.isArray(x.interes) ? x.interes : [];
            const matchInteres = intereses.some((i) => {
                const il = String(i || '').toLowerCase();
                if (!s) return true;
                return il.includes(s) || s.includes(il);
            });
            if (s && !sp.includes(s) && !String(tel).includes(s) && !matchInteres) continue;
            if (tipoFiltro && tiposValidos.has(tipoFiltro)) {
                const tp = String(x.tipoLenaPreferido || '').toLowerCase();
                if (tp !== tipoFiltro) continue;
            }
            const rj = String(x.remoteJid || '').trim() || `${tel}@s.whatsapp.net`;
            if (rj.startsWith('ig:')) continue;
            if (silenciados.has(rj)) continue;

            const ll = clienteLatLngFromDocCampana(x);
            if (!ll) continue;
            const pt = turf.point([ll.lng, ll.lat]);
            let distM;
            try {
                distM = turf.pointToLineDistance(pt, line, { units: 'meters' });
            } catch {
                continue;
            }
            if (!Number.isFinite(distM) || distM > bufferM) continue;

            out.push({
                tel,
                remoteJid: rj,
                nombre: x.nombre || tel,
                zona: x.zona || '',
                tipoLenaPreferido: x.tipoLenaPreferido || null,
            });
        }
        return out;
    } catch (e) {
        console.warn('⚠️ listClientesParaCampanaGeo:', e.message);
        return [];
    }
}

/**
 * Destinatarios para avisos masivos (#enviar) desde Firestore.
 * @param {string} segmento - vacío / clientes / todos → sin filtro de servicio; lena|cerco|pergola|fogonero filtran por servicioPendiente.
 */
async function listClientesParaBroadcast(segmento) {
    if (!firestoreDb) return [];
    const raw = String(segmento || '').trim().toLowerCase();
    const sinFiltroServicio = !raw
        || raw === 'clientes'
        || raw === 'cliente'
        || raw === 'todos'
        || raw === 'all'
        || raw === '*';
    const token = sinFiltroServicio ? '' : normalizarSegmentoBroadcast(raw);
    try {
        const silenciados = await getJidsConSilencioCampana();
        const snap = await firestoreDb.collection('clientes').limit(1000).get();
        const out = [];
        const seen = new Set();
        for (const d of snap.docs) {
            const x = d.data() || {};
            const sp = String(x.servicioPendiente || '');
            if (!sinFiltroServicio && !coincideServicioBroadcast(sp, token)) continue;
            let rj = String(x.remoteJid || '').trim();
            if (!rj) {
                const id = d.id;
                if (/^\d{8,15}$/.test(id)) rj = `${id}@s.whatsapp.net`;
            }
            if (!rj || rj.endsWith('@g.us')) continue;
            if (silenciados.has(rj)) continue;
            if (seen.has(rj)) continue;
            seen.add(rj);
            out.push({ tel: d.id, remoteJid: rj, nombre: x.nombre || d.id });
        }
        return out;
    } catch (e) {
        console.warn('⚠️ listClientesParaBroadcast:', e.message);
        return [];
    }
}

function normalizarSegmentoBroadcast(seg) {
    const s = String(seg || '').trim().toLowerCase();
    const a = s.normalize('NFD').replace(/\u0300/g, '');
    if (s === 'leña' || s === 'lena' || a === 'lena') return 'lena';
    if (s.includes('cerco')) return 'cerco';
    if (s.includes('pergol')) return 'pergola';
    if (s.includes('fogon')) return 'fogonero';
    return s;
}

function coincideServicioBroadcast(servicioPendiente, tokenNorm) {
    const sp = String(servicioPendiente || '').toLowerCase();
    const t = String(tokenNorm || '').toLowerCase();
    if (!t) return true;
    if (sp.includes(t)) return true;
    const spA = sp.normalize('NFD').replace(/\u0300/g, '');
    const tA = t.normalize('NFD').replace(/\u0300/g, '');
    if (spA.includes(tA)) return true;
    if (t === 'lena' || t === 'leña') {
        return /leña|lena|carbón|carbon/.test(sp) || /lena|carbon/.test(spA);
    }
    return false;
}

// ── Mensajes programados (seguimiento) ───────────────────────────────
async function addMensajeProgramado({ jid, texto, runAtMs, origen }) {
    if (!firestoreDb || !jid || !texto) return null;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const ref = await firestoreDb.collection('mensajes_programados').add({
            jid,
            texto: String(texto).slice(0, 2000),
            runAt: admin.firestore.Timestamp.fromMillis(Number(runAtMs)),
            estado: 'pendiente',
            origen: origen || 'bot',
            creadoEn: FieldValue.serverTimestamp(),
        });
        return ref.id;
    } catch (e) {
        console.warn('⚠️ addMensajeProgramado:', e.message);
        return null;
    }
}

async function obtenerProgramadosPendientesHasta(ahoraMs) {
    if (!firestoreDb) return [];
    try {
        const admin = require('firebase-admin');
        const snap = await firestoreDb.collection('mensajes_programados')
            .where('estado', '==', 'pendiente')
            .where('runAt', '<=', admin.firestore.Timestamp.fromMillis(ahoraMs))
            .limit(50)
            .get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('⚠️ obtenerProgramadosPendientesHasta:', e.message);
        return [];
    }
}

async function marcarProgramadoEstado(docId, estado) {
    if (!firestoreDb || !docId) return;
    try {
        await firestoreDb.collection('mensajes_programados').doc(docId).update({
            estado,
            actualizadoEn: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
        console.warn('⚠️ marcarProgramadoEstado:', e.message);
    }
}

// ── Agenda de entregas (panel + marcador [ENTREGA:…] en Gemini) ─────────
function validarFechaDiaAgenda(s) {
    if (!s || typeof s !== 'string') return false;
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T12:00:00`);
    return Number.isFinite(t);
}

/** Tras crear doc en `entregas_agenda` (bot); el proceso host envía WA al grupo. */
let entregaAgendaPostAddHook = null;
function setEntregaAgendaPostAddHook(fn) {
    entregaAgendaPostAddHook = typeof fn === 'function' ? fn : null;
}

async function addEntregaAgenda({
    jid,
    fechaDia,
    horaTexto,
    titulo,
    notas,
    kg,
    origen,
    telefonoContacto,
    direccion,
    producto,
}) {
    if (!firestoreDb || !validarFechaDiaAgenda(fechaDia) || !titulo) return null;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const ht = horaTexto != null ? String(horaTexto).trim() : '';
        const tc =
            telefonoContacto != null && String(telefonoContacto).trim()
                ? String(telefonoContacto).trim().slice(0, 40)
                : null;
        const dir =
            direccion != null && String(direccion).trim() ? String(direccion).trim().slice(0, 500) : null;
        const prod =
            producto != null && String(producto).trim() ? String(producto).trim().slice(0, 500) : null;
        const ref = await firestoreDb.collection('entregas_agenda').add({
            fechaDia,
            horaTexto: ht && ht !== '--' ? ht.slice(0, 32) : null,
            titulo: String(titulo).trim().slice(0, 500),
            notas: notas != null && String(notas).trim() ? String(notas).trim().slice(0, 2000) : null,
            jid: jid || null,
            telefonoContacto: tc,
            direccion: dir,
            producto: prod,
            kg: typeof kg === 'number' && Number.isFinite(kg) ? kg : null,
            origen: origen || 'bot',
            estado: 'pendiente',
            creadoEn: FieldValue.serverTimestamp(),
            /** false hasta que el bot confirme envío al grupo WA (evita duplicados entre réplicas). */
            notificadoGrupoAgenda: false,
        });
        const newId = ref.id;
        if (entregaAgendaPostAddHook && newId) {
            Promise.resolve(entregaAgendaPostAddHook(newId)).catch((e) =>
                console.warn('⚠️ entregaAgendaPostAddHook:', e?.message || e)
            );
        }
        return newId;
    } catch (e) {
        console.warn('⚠️ addEntregaAgenda:', e.message);
        return null;
    }
}

/**
 * Transacción: marca como notificado solo si aún era false (una sola réplica envía).
 * @returns {Promise<boolean>}
 */
async function claimEntregaAgendaNotificacionGrupo(docId) {
    if (!firestoreDb || !docId) return false;
    const admin = require('firebase-admin');
    const ref = firestoreDb.collection('entregas_agenda').doc(docId);
    try {
        return await firestoreDb.runTransaction(async (t) => {
            const snap = await t.get(ref);
            if (!snap.exists) return false;
            const d = snap.data() || {};
            if (d.notificadoGrupoAgenda === true) return false;
            t.update(ref, {
                notificadoGrupoAgenda: true,
                notificadoGrupoAgendaEn: admin.firestore.FieldValue.serverTimestamp(),
            });
            return true;
        });
    } catch (e) {
        console.warn('⚠️ claimEntregaAgendaNotificacionGrupo:', e.message);
        return false;
    }
}

async function revertEntregaAgendaNotificacionGrupo(docId) {
    if (!firestoreDb || !docId) return;
    const admin = require('firebase-admin');
    try {
        await firestoreDb.collection('entregas_agenda').doc(docId).update({
            notificadoGrupoAgenda: false,
            notificadoGrupoAgendaEn: admin.firestore.FieldValue.delete(),
        });
    } catch (e) {
        console.warn('⚠️ revertEntregaAgendaNotificacionGrupo:', e.message);
    }
}

async function getEntregaAgendaDocData(docId) {
    if (!firestoreDb || !docId) return null;
    try {
        const snap = await firestoreDb.collection('entregas_agenda').doc(docId).get();
        if (!snap.exists) return null;
        return snap.data() || null;
    } catch (e) {
        console.warn('⚠️ getEntregaAgendaDocData:', e.message);
        return null;
    }
}


/** Ids candidatos `clientes/{id}` según dígitos de línea (misma lógica que agenda / resolver tel). */
function variantesDocIdClienteDesdeDigitos(rawDigits) {
    const d = String(rawDigits || '').replace(/\D/g, '');
    const ids = [];
    const push = (x) => {
        if (x && !ids.includes(x)) ids.push(x);
    };
    if (d.length < 8) return ids;
    push(d);
    if (d.length === 10 && !d.startsWith('54')) push(`549${d}`);
    if (d.length === 11 && d.startsWith('54') && !d.startsWith('549')) push(`549${d.slice(2)}`);
    if (d.startsWith('549') && d.length > 3) push(d.slice(3));
    return ids;
}

function soloDigitosTelFs(s) {
    return String(s || '').replace(/\D/g, '');
}

/** Alineado con `telefonosMismoDueno` en bot.js (prefijos 54 / cola móvil AR). */
function telefonosCoincidenFs(a, b) {
    const da = soloDigitosTelFs(a);
    const db = soloDigitosTelFs(b);
    if (da.length < 8 || db.length < 8) return false;
    if (da === db) return true;
    const tailA = da.slice(-10);
    const tailB = db.slice(-10);
    if (tailA.length === 10 && tailB.length === 10 && tailA === tailB) return true;
    return da.endsWith(db) || db.endsWith(da);
}

function docClienteCoincideConDigitos(data, docId, digitosObjetivo) {
    const D = soloDigitosTelFs(digitosObjetivo);
    if (D.length < 8) return false;
    const rj = String(data?.remoteJid || '').trim();
    // Si hay JID @s con usuario largo, solo aceptamos si coincide con D (no alcanza docId por cola de 10 dígitos).
    if (rj.endsWith('@s.whatsapp.net')) {
        const userJ = soloDigitosTelFs(rj.replace(/@s\.whatsapp\.net$/i, ''));
        if (userJ.length >= 8) {
            return telefonosCoincidenFs(D, userJ);
        }
    }
    const parts = [docId, data?.telefono].filter(Boolean);
    return parts.some((p) => telefonosCoincidenFs(D, p));
}

/**
 * Entre varios `clientes/{id}` candidatos, devuelve el doc cuyo id / remoteJid / telefono
 * coincide con `digitosObjetivo`. Evita tomar un doc “corto” que sea de otro cliente.
 * @returns {{ docId: string, data: object }|null}
 */
async function encontrarClienteDocCoincidentePorIds(ids, digitosObjetivo) {
    if (!firestoreDb || !ids?.length) return null;
    const D = soloDigitosTelFs(digitosObjetivo);
    if (D.length < 8) return null;
    const candidatos = [];
    try {
        for (const id of ids) {
            const snap = await firestoreDb.collection('clientes').doc(id).get();
            if (snap.exists) candidatos.push({ docId: id, data: snap.data() || {} });
        }
    } catch (e) {
        console.warn('⚠️ encontrarClienteDocCoincidentePorIds:', e.message);
        return null;
    }
    const ok = candidatos.filter((c) => docClienteCoincideConDigitos(c.data, c.docId, D));
    if (ok.length === 0) return null;
    if (ok.length === 1) return ok[0];
    const exactId = ok.find((c) => soloDigitosTelFs(c.docId) === D);
    if (exactId) return exactId;
    const porJid = ok.find((c) => {
        const rj = String(c.data.remoteJid || '').trim();
        if (!rj.endsWith('@s.whatsapp.net')) return false;
        return soloDigitosTelFs(rj.replace(/@s\.whatsapp\.net$/i, '')) === D;
    });
    if (porJid) return porJid;
    return ok[0];
}

/**
 * Datos ligeros de `clientes/*` para armar aviso de agenda al grupo (tel / nombre) cuando el proceso no tiene memoria local.
 * Chats `@lid`: los docs son `clientes/{tel}`, no `clientes/{lid}` — se resuelve por `lid_mapeo`, `whatsappLid` o `remoteJid`.
 * @param {string} jid
 * @returns {Promise<object|null>}
 */
async function getClienteDocDataParaAvisoAgenda(jid) {
    if (!firestoreDb || !jid) return null;
    const j = String(jid).trim();
    if (j.startsWith('ig:')) return null;
    try {
        if (j.endsWith('@s.whatsapp.net')) {
            const d = j.replace(/@s\.whatsapp\.net$/i, '').replace(/\D/g, '');
            if (d.length < 8) return null;
            const ids = variantesDocIdClienteDesdeDigitos(d);
            const hit = await encontrarClienteDocCoincidentePorIds(ids, d);
            return hit ? hit.data : null;
        }
        if (j.endsWith('@lid')) {
            const lidDigits = j.replace(/@lid$/i, '').replace(/\D/g, '');
            if (lidDigits.length < 5) return null;
            const mapeo = await firestoreDb.collection('lid_mapeo').doc(lidDigits).get();
            if (mapeo.exists) {
                const tel = String(mapeo.data()?.telefono || '').replace(/\D/g, '');
                if (tel.length >= 8) {
                    const idsM = variantesDocIdClienteDesdeDigitos(tel);
                    const hitM = await encontrarClienteDocCoincidentePorIds(idsM, tel);
                    if (hitM) return hitM.data;
                }
            }
            let q = await firestoreDb.collection('clientes').where('whatsappLid', '==', lidDigits).limit(1).get();
            if (!q.empty) return q.docs[0].data() || {};
            q = await firestoreDb.collection('clientes').where('remoteJid', '==', j).limit(1).get();
            if (!q.empty) return q.docs[0].data() || {};
            return null;
        }
    } catch (e) {
        console.warn('⚠️ getClienteDocDataParaAvisoAgenda:', e.message);
    }
    return null;
}

/** IDs con notificadoGrupoAgenda == false (altas desde panel u omitidas por socket cerrado). */
async function listEntregaAgendaIdsPendientesNotificarGrupo(limit = 12) {
    if (!firestoreDb) return [];
    try {
        const snap = await firestoreDb
            .collection('entregas_agenda')
            .where('notificadoGrupoAgenda', '==', false)
            .limit(Math.min(25, Math.max(1, limit)))
            .get();
        return snap.docs.map((d) => d.id);
    } catch (e) {
        console.warn('⚠️ listEntregaAgendaIdsPendientesNotificarGrupo:', e.message);
        return [];
    }
}

async function updateEntregaAgendaEstado(docId, estado) {
    if (!firestoreDb || !docId) return;
    if (!['pendiente', 'hecha', 'cancelada'].includes(estado)) return;
    try {
        await firestoreDb.collection('entregas_agenda').doc(docId).update({
            estado,
            actualizadoEn: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
        console.warn('⚠️ updateEntregaAgendaEstado:', e.message);
    }
}

/** Fecha local Argentina (YYYY-MM-DD) para filtros de agenda. */
function fechaIsoHoyArgentina() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' });
}

/**
 * Texto para WhatsApp admin: eventos en `entregas_agenda` desde hoy (AR), ordenados por día.
 * @param {{ maxRows?: number, incluirCanceladas?: boolean }} opts
 */
async function getTextoEntregaAgendaListaAdmin(opts = {}) {
    const maxRows = Math.min(60, Math.max(5, Number(opts.maxRows) || 40));
    const incluirCanceladas = !!opts.incluirCanceladas;
    if (!firestoreDb) return '❌ Firestore no disponible.';
    const hoyISO = fechaIsoHoyArgentina();
    try {
        const snap = await firestoreDb
            .collection('entregas_agenda')
            .where('fechaDia', '>=', hoyISO)
            .orderBy('fechaDia', 'asc')
            .limit(120)
            .get();
        const rows = [];
        for (const d of snap.docs) {
            const x = d.data() || {};
            const est = String(x.estado || 'pendiente');
            if (!incluirCanceladas && est === 'cancelada') continue;
            rows.push({ id: d.id, fechaDia: x.fechaDia, horaTexto: x.horaTexto, titulo: x.titulo, jid: x.jid, telefonoContacto: x.telefonoContacto, _est: est });
            if (rows.length >= maxRows) break;
        }
        if (rows.length === 0) {
            return (
                `📅 *Agenda (#entrega lista)*\n\n`
                + `Sin eventos desde *${hoyISO}* (o todos cancelados).\n`
                + '_Calendario completo: panel → Agenda de entregas._'
            );
        }
        const lines = [
            `📅 *Agenda de entregas* (${rows.length} ítem(s), desde \`${hoyISO}\`, hora AR)`,
            '',
        ];
        for (const r of rows) {
            const est = r._est;
            let pref = '⏳ ';
            if (est === 'hecha') pref = '✅ ';
            if (est === 'cancelada') pref = '❌ ';
            const hora = r.horaTexto && String(r.horaTexto).trim() ? String(r.horaTexto).trim() : '—';
            let tit = String(r.titulo || '—').replace(/\n/g, ' ').trim();
            if (tit.length > 85) tit = `${tit.slice(0, 82)}…`;
            const tel = r.telefonoContacto ? String(r.telefonoContacto).replace(/\D/g, '') : '';
            const telShow = tel.length >= 8 ? tel : '';
            let jidShort = '';
            if (r.jid) {
                const j = String(r.jid);
                jidShort = j.replace(/@s\.whatsapp\.net$/i, '').replace(/(\d+)@lid$/i, '$1@lid');
            }
            const suf = telShow ? ` · ${telShow}` : jidShort ? ` · \`${jidShort.slice(0, 40)}\`` : '';
            lines.push(`${pref}*${r.fechaDia}* ${hora} — ${tit}${suf}`);
        }
        lines.push('', '_Panel → Agenda de entregas_');
        if (!incluirCanceladas) {
            lines.push('_Canceladas ocultas: *#entrega lista todas*_');
        }
        if (!incluirCanceladas && rows.length >= maxRows) {
            lines.push('_Tope del mensaje; puede haber más en el panel._');
        }
        return lines.join('\n');
    } catch (e) {
        console.warn('⚠️ getTextoEntregaAgendaListaAdmin:', e.message);
        return `❌ Error leyendo agenda: ${e.message}`;
    }
}

// ── Mapeo LID WhatsApp → línea telefónica (doc `clientes/{tel}`) ────────
/** @param {string} lidDigits sin @lid */
async function saveLidMapeo(lidDigits, telefonoDigits) {
    if (!firestoreDb || !lidDigits || !telefonoDigits) return;
    try {
        const admin = require('firebase-admin');
        const lid = String(lidDigits).replace(/\D/g, '');
        const tel = String(telefonoDigits).replace(/\D/g, '');
        if (lid.length < 10 || tel.length < 8) return;
        await firestoreDb
            .collection('lid_mapeo')
            .doc(lid)
            .set(
                {
                    telefono: tel,
                    actualizadoEn: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true },
            );
    } catch (e) {
        console.warn('⚠️ saveLidMapeo:', e.message);
    }
}

/**
 * Carga `lid_mapeo/*` en el Map en memoria del bot (lid → dígitos línea).
 * @param {Map<string, string>} lidToPhoneMap
 * @returns {Promise<number>} cantidad de filas aplicadas
 */
async function loadLidMapeoIntoMap(lidToPhoneMap) {
    if (!firestoreDb || !lidToPhoneMap) return 0;
    try {
        const snap = await firestoreDb.collection('lid_mapeo').get();
        let n = 0;
        for (const d of snap.docs) {
            const t = d.data()?.telefono;
            if (t && d.id) {
                lidToPhoneMap.set(d.id, String(t).replace(/\D/g, ''));
                n++;
            }
        }
        return n;
    } catch (e) {
        console.warn('⚠️ loadLidMapeoIntoMap:', e.message);
        return 0;
    }
}

/** Registro cuando el cliente envía datos de entrega (panel + auditoría). */
async function addDatosEntregaRegistro({ jid, telefonoLinea, nombre, mensajeCliente, origen }) {
    if (!firestoreDb || !jid) return null;
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const ref = await firestoreDb.collection('datos_entrega_cliente').add({
            jid: String(jid).slice(0, 120),
            telefonoLinea: telefonoLinea != null ? String(telefonoLinea).replace(/\D/g, '').slice(0, 20) : null,
            nombre: nombre != null ? String(nombre).trim().slice(0, 120) : null,
            mensajeCliente: String(mensajeCliente || '').slice(0, 8000),
            origen: origen || 'bot',
            estado: 'recibido',
            creadoEn: FieldValue.serverTimestamp(),
        });
        return ref.id;
    } catch (e) {
        console.warn('⚠️ addDatosEntregaRegistro:', e.message);
        return null;
    }
}

// ── Sesión admin WhatsApp (multi-instancia Cloud Run) ─────────────────
/** ID de documento seguro para JID (Admin SDK ignora reglas de cliente). */
function adminWaDocId(remoteJid) {
    return String(remoteJid || 'x').replace(/\//g, '_');
}

/** No persistir flujo #g (borrador prompt): solo memoria del contenedor; aplicar al system prompt es solo desde el panel. */
function serializeAdminWaSesion(s) {
    if (!s) return null;
    return {
        activadoEn: Number(s.activadoEn) || Date.now(),
        listaClientes: s.listaClientes && typeof s.listaClientes === 'object' ? { ...s.listaClientes } : {},
        destinatarioPendiente: s.destinatarioPendiente || null,
        modoBridge: !!s.modoBridge,
        bridgeTarget: s.bridgeTarget || null,
        esperandoSelectorPuente: !!s.esperandoSelectorPuente,
        esperandoInstructivoGemini: false,
        borradorGeminiPreview: null,
        ultimoReporteAt: Number(s.ultimoReporteAt) && Number.isFinite(Number(s.ultimoReporteAt)) ? Number(s.ultimoReporteAt) : null,
        ultimoReporteIndice:
            s.ultimoReporteIndice && typeof s.ultimoReporteIndice === 'object'
                ? JSON.parse(JSON.stringify(s.ultimoReporteIndice))
                : null,
        pListaIndex: Array.isArray(s.pListaIndex)
            ? s.pListaIndex.slice(0, 400).map((x) => ({
                tel: String(x.tel || ''),
                remoteJid: String(x.remoteJid || ''),
                idxLocal: Number(x.idxLocal) | 0,
            }))
            : null,
        esperandoMenuPrincipal: !!s.esperandoMenuPrincipal,
        wizard:
            s.wizard && typeof s.wizard === 'object'
                ? JSON.parse(JSON.stringify(s.wizard))
                : null,
    };
}

function activadoEnToMillis(v) {
    if (v == null) return NaN;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'object' && typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    return NaN;
}

function deserializeAdminWaSesion(d) {
    if (!d) return null;
    const activadoEn = activadoEnToMillis(d.activadoEn);
    if (!Number.isFinite(activadoEn)) return null;
    return {
        activadoEn,
        listaClientes: d.listaClientes && typeof d.listaClientes === 'object' ? { ...d.listaClientes } : {},
        destinatarioPendiente: d.destinatarioPendiente || null,
        modoBridge: !!d.modoBridge,
        bridgeTarget: d.bridgeTarget || null,
        esperandoSelectorPuente: !!d.esperandoSelectorPuente,
        esperandoInstructivoGemini: false,
        borradorGeminiPreview: null,
        ultimoReporteAt: Number(d.ultimoReporteAt) && Number.isFinite(Number(d.ultimoReporteAt)) ? Number(d.ultimoReporteAt) : null,
        ultimoReporteIndice:
            d.ultimoReporteIndice && typeof d.ultimoReporteIndice === 'object'
                ? JSON.parse(JSON.stringify(d.ultimoReporteIndice))
                : null,
        pListaIndex: Array.isArray(d.pListaIndex)
            ? d.pListaIndex.slice(0, 400).map((x) => ({
                tel: String(x.tel || ''),
                remoteJid: String(x.remoteJid || ''),
                idxLocal: Number(x.idxLocal) | 0,
            }))
            : null,
        esperandoMenuPrincipal: !!d.esperandoMenuPrincipal,
        wizard: d.wizard && typeof d.wizard === 'object' ? JSON.parse(JSON.stringify(d.wizard)) : null,
    };
}

async function saveAdminWaSession(remoteJid, sesionObj) {
    if (!firestoreDb || !remoteJid || !sesionObj) return;
    try {
        const payload = serializeAdminWaSesion(sesionObj);
        payload.remoteJid = remoteJid;
        await firestoreDb.collection('adminWaSesion').doc(adminWaDocId(remoteJid)).set(payload, { merge: true });
    } catch (e) {
        console.warn('⚠️ saveAdminWaSession:', e.message);
    }
}

async function getAdminWaSession(remoteJid) {
    if (!firestoreDb || !remoteJid) return null;
    try {
        const snap = await firestoreDb.collection('adminWaSesion').doc(adminWaDocId(remoteJid)).get();
        if (!snap.exists) return null;
        return deserializeAdminWaSesion(snap.data());
    } catch (e) {
        return null;
    }
}

async function clearAdminWaSession(remoteJid) {
    if (!firestoreDb || !remoteJid) return;
    try {
        await firestoreDb.collection('adminWaSesion').doc(adminWaDocId(remoteJid)).delete();
    } catch (e) {
        console.warn('⚠️ clearAdminWaSession:', e.message);
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

/**
 * Busca `clientes/{id}` probando variantes de dígitos (misma lógica que el panel Agenda).
 * @returns {{ jid: string, docId: string, nombre: string|null }|null}
 */
async function resolverJidClientePorVariantesTelefono(rawDigits) {
    if (!firestoreDb) return null;
    const d = String(rawDigits || '').replace(/\D/g, '');
    if (d.length < 8) return null;
    const ids = variantesDocIdClienteDesdeDigitos(d);
    try {
        const hit = await encontrarClienteDocCoincidentePorIds(ids, d);
        if (!hit) return null;
        const x = hit.data;
        const rj = String(x.remoteJid || '').trim();
        const jid = rj || `${hit.docId}@s.whatsapp.net`;
        return {
            jid,
            docId: hit.docId,
            nombre: x.nombre ? String(x.nombre) : null,
        };
    } catch (e) {
        console.warn('⚠️ resolverJidClientePorVariantesTelefono:', e.message);
    }
    return null;
}

/**
 * CRM `clientes/*` que coincide con estos dígitos (misma regla que agenda / #entrega).
 * Útil cuando el JID resuelto y el teléfono tipeado deben alinear el nombre en el bloque copiable.
 */
async function getClienteDocDataCoincidenteSoloDigitos(rawDigits) {
    const d = String(rawDigits || '').replace(/\D/g, '');
    if (!firestoreDb || d.length < 8) return null;
    const hit = await encontrarClienteDocCoincidentePorIds(variantesDocIdClienteDesdeDigitos(d), d);
    return hit ? hit.data : null;
}

/** Lee `pedidosAnteriores` del doc `clientes/{tel}` (array vacío si no existe). */
async function getPedidosAnterioresClienteDoc(tel) {
    if (!firestoreDb) return { ok: false, pedidosAnteriores: [], noFirestore: true };
    try {
        const snap = await firestoreDb.collection('clientes').doc(tel).get();
        if (!snap.exists) return { ok: true, pedidosAnteriores: [], noDoc: true };
        const pa = snap.data().pedidosAnteriores;
        const arr = Array.isArray(pa) ? [...pa] : [];
        return { ok: true, pedidosAnteriores: arr, noDoc: false };
    } catch (e) {
        console.warn('⚠️ getPedidosAnterioresClienteDoc:', e.message);
        return { ok: false, pedidosAnteriores: [], error: e.message };
    }
}

/**
 * Quita un ítem de `pedidosAnteriores` en Firestore.
 * @param {{ ultimo?: boolean, index1Based?: number }} opts — uno de los dos
 */
async function borrarPedidoClientePorIndice(tel, opts) {
    if (!firestoreDb) return { ok: false, error: 'Firestore no disponible.' };
    try {
        const admin = require('firebase-admin');
        const FieldValue = admin.firestore.FieldValue;
        const ref = firestoreDb.collection('clientes').doc(tel);
        const snap = await ref.get();
        const pa0 = snap.exists ? [...(snap.data().pedidosAnteriores || [])] : [];
        if (pa0.length === 0) {
            return { ok: false, error: 'EMPTY', empty: true };
        }
        const ultimo = !!opts?.ultimo;
        let idx;
        if (ultimo) {
            idx = pa0.length - 1;
        } else {
            const n = Number(opts?.index1Based);
            if (!Number.isFinite(n) || n < 1 || n > pa0.length) {
                return {
                    ok: false,
                    error: `Índice inválido. Hay *${pa0.length}* pedido(s): usá del *1* al *${pa0.length}* o *último*.`,
                };
            }
            idx = n - 1;
        }
        const removed = pa0[idx];
        pa0.splice(idx, 1);
        await ref.set(
            {
                pedidosAnteriores: pa0,
                ultimaActualizacion: FieldValue.serverTimestamp(),
            },
            { merge: true },
        );
        return { ok: true, removed, pedidosAnteriores: pa0 };
    } catch (e) {
        console.warn('⚠️ borrarPedidoClientePorIndice:', e.message);
        return { ok: false, error: e.message || 'error' };
    }
}

module.exports = {
    initFirestore,
    logMensaje,
    syncCliente,
    syncColaLena,
    getConfigGeneral,
    invalidateConfigCache,
    getBotActivoLive,
    getInstagramDmActivoLive,
    setBotActivoGlobal,
    getEstadoVickyParaAdminTexto,
    getUltimosMensajesChatParaContexto,
    getSystemPrompt,
    getMensajeBienvenidaTexto,
    getServicios,
    buildServiciosPromptSuffix,
    setHumanoAtendiendo,
    reactivarBotEnChat,
    quitarHumanoAtendiendoChat,
    setCierreEntregaAsistido,
    getMensajeClienteCierreEntregaHumano,
    getInstruccionCierreEntregaHumanoGemini,
    reactivarTodosLosChatsDesdeFirestore,
    reactivarChatsParcialDesdeFirestore,
    getChatSilenceState,
    setChatSilenceCacheTtl,
    migrarHistorialAFirestore,
    addPromptBorrador,
    aplicarInstructivoWhatsAppASistemaPrompt,
    getReporteResumenTexto,
    getReporteDatosAgregados,
    getReporteDetalleTexto,
    listClientesParaCampana,
    getRutaLogistica,
    listClientesParaCampanaGeo,
    listClientesParaBroadcast,
    addMensajeProgramado,
    obtenerProgramadosPendientesHasta,
    marcarProgramadoEstado,
    addEntregaAgenda,
    updateEntregaAgendaEstado,
    getTextoEntregaAgendaListaAdmin,
    setEntregaAgendaPostAddHook,
    claimEntregaAgendaNotificacionGrupo,
    revertEntregaAgendaNotificacionGrupo,
    getEntregaAgendaDocData,
    getClienteDocDataParaAvisoAgenda,
    getClienteDocDataCoincidenteSoloDigitos,
    listEntregaAgendaIdsPendientesNotificarGrupo,
    saveLidMapeo,
    loadLidMapeoIntoMap,
    addDatosEntregaRegistro,
    saveAdminWaSession,
    getAdminWaSession,
    clearAdminWaSession,
    getPedidosAnterioresClienteDoc,
    resolverJidClientePorVariantesTelefono,
    borrarPedidoClientePorIndice,
    getUltimosMensajesChatItems,
    listarPedidosFlatParaAdminP,
    formatoTelefonoListaAdmin,
    isAvailable: () => !!firestoreDb,
};
