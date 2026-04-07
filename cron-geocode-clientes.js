'use strict';

/**
 * Cron HTTP: geocodificación automática (Nominatim + Firestore).
 * Requiere Firestore inicializado y `config/general.geocodeCronActivo !== false`.
 */

const firestoreModule = require('./firestore-module');
const { runGeocodeClientesBatch } = require('./geocode-clientes-core');

const CRON_MAX_CAP = 80;

/**
 * @param {{ max?: number, dryRun?: boolean, forceRegeocode?: boolean }} [opts]
 */
async function ejecutarCronGeocodificacionClientes(opts = {}) {
    await firestoreModule.initFirestore();
    if (!firestoreModule.isAvailable()) {
        return { skipped: true, reason: 'no_firestore' };
    }

    const cfg = await firestoreModule.getConfigGeneral({ bypassCache: true });
    if (cfg.geocodeCronActivo === false) {
        return { skipped: true, reason: 'disabled_panel' };
    }

    let max = opts.max;
    if (max == null || !Number.isFinite(Number(max))) {
        max = Number(cfg.geocodeCronMaxPorEjecucion);
    }
    if (!Number.isFinite(max) || max < 1) max = 30;
    max = Math.min(CRON_MAX_CAP, Math.max(1, Math.floor(max)));

    const admin = require('firebase-admin');
    const db = admin.firestore();

    const r = await runGeocodeClientesBatch(db, {
        max,
        dryRun: !!opts.dryRun,
        forceRegeocode: !!opts.forceRegeocode,
        userAgent: process.env.GEOCODE_NOMINATIM_UA,
        _source: 'cron',
    });

    if (r.attempted > 0) {
        console.log(
            `🗺️ Cron geocode: eligible=${r.eligible} attempted=${r.attempted} written=${r.written} failed=${r.failed} dryPreview=${r.dryRunPreview}`
        );
    }

    return { ok: true, ...r };
}

module.exports = { ejecutarCronGeocodificacionClientes, CRON_MAX_CAP };
