'use strict';

/**
 * Lógica compartida: geocodificar fichas `clientes` con `direccion` vía Nominatim.
 * Usado por el script CLI y por el cron HTTP de Cloud Run.
 * Política: https://operations.osmfoundation.org/policies/nominatim/
 */

const NOMINATIM_DELAY_MS = 1100;
const DEFAULT_UA_SCRIPT = 'VickyGeocodeScript/1.0 (Gardens Wood; batch CRM)';
const DEFAULT_UA_CRON = 'VickyGeocodeCron/1.0 (Gardens Wood; Cloud Run)';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function readScalar(v) {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const n = parseFloat(v.trim().replace(',', '.'));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function tieneCoords(data) {
    const lat = readScalar(data.lat);
    const lng = readScalar(data.lng);
    return lat != null && lng != null;
}

const MAX_NOTAS_GEO = 140;

function truncGeo(s, n) {
    const t = String(s || '').trim();
    if (t.length <= n) return t;
    return `${t.slice(0, n - 1)}…`;
}

/** Arma la consulta Nominatim con todo lo guardado en la ficha (mapa / logística). */
function buildQuery(data) {
    const parts = [
        String(data.direccion || '').trim(),
        String(data.barrio || '').trim(),
        String(data.localidad || '').trim(),
        String(data.zona || '').trim(),
        String(data.referencia || '').trim(),
        truncGeo(data.notasUbicacion, MAX_NOTAS_GEO),
        'Provincia de Córdoba',
        'Argentina',
    ].filter(Boolean);
    return parts.join(', ');
}

/** Hay material suficiente para intentar geocodificar (no solo calle). */
function tieneTextoParaGeocode(data) {
    const q = buildQuery(data);
    const core = q.replace(/, Provincia de Córdoba, Argentina$/i, '').trim();
    return core.length >= 4;
}

async function nominatimSearch(q, userAgent) {
    const trimmed = q.trim();
    if (trimmed.length < 4) return null;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, {
        headers: {
            Accept: 'application/json',
            'Accept-Language': 'es',
            'User-Agent': userAgent || DEFAULT_UA_SCRIPT,
        },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit?.lat || !hit?.lon) return null;
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ max?: number, dryRun?: boolean, forceRegeocode?: boolean, collectionLimit?: number, userAgent?: string, _source?: string }} options
 */
async function runGeocodeClientesBatch(db, options = {}) {
    const dryRun = !!options.dryRun;
    const forceRegeocode = !!options.forceRegeocode;
    const collectionLimit = Math.min(5000, Math.max(100, Number(options.collectionLimit) || 2000));
    let max = Number(options.max);
    if (!Number.isFinite(max)) max = 40;
    max = Math.min(500, Math.max(1, Math.floor(max)));

    const ua =
        options.userAgent ||
        process.env.GEOCODE_NOMINATIM_UA ||
        (options._source === 'cron' ? DEFAULT_UA_CRON : DEFAULT_UA_SCRIPT);

    const snap = await db.collection('clientes').limit(collectionLimit).get();
    const candidatos = [];
    for (const d of snap.docs) {
        const id = d.id;
        if (id.startsWith('ig:')) continue;
        const x = d.data() || {};
        if (!tieneTextoParaGeocode(x)) continue;
        if (!forceRegeocode && tieneCoords(x)) continue;
        candidatos.push({ ref: d.ref, id, query: buildQuery(x) });
    }

    const tomar = candidatos.slice(0, max);
    let written = 0;
    let dryRunPreview = 0;
    let failed = 0;

    for (let i = 0; i < tomar.length; i++) {
        const { ref, query } = tomar[i];
        if (i > 0) await sleep(NOMINATIM_DELAY_MS);

        let coords;
        try {
            coords = await nominatimSearch(query, ua);
        } catch {
            failed++;
            continue;
        }
        if (!coords) {
            failed++;
            continue;
        }

        if (dryRun) {
            dryRunPreview++;
            continue;
        }

        await ref.update({
            lat: coords.lat,
            lng: coords.lng,
        });
        written++;
    }

    return {
        eligible: candidatos.length,
        attempted: tomar.length,
        written,
        dryRunPreview,
        failed,
        dryRun,
    };
}

module.exports = {
    runGeocodeClientesBatch,
    readScalar,
    tieneCoords,
    buildQuery,
    tieneTextoParaGeocode,
    nominatimSearch,
    NOMINATIM_DELAY_MS,
    DEFAULT_UA_SCRIPT,
    DEFAULT_UA_CRON,
};
