'use strict';

/**
 * Admin WhatsApp: comandos *#kp* / *!!kp* (Kontrolpro / Supabase).
 * Si en el futuro se conecta a Lovable/Supabase, implementar aquí los wizards `kontrolpro_*`.
 */

/**
 * @param {object} ctx
 * @param {string} ctx.remoteJid
 * @param {object} ctx.sesion
 * @param {string} ctx.tAdm
 * @param {boolean} ctx.tieneAudioMsg
 * @param {function} ctx.sendBotMessage
 * @param {function} ctx.persistAdminWaSessionFirestore
 * @returns {Promise<boolean>} true si consumió el mensaje
 */
async function handleKontrolproWizard(ctx) {
    const {
        remoteJid,
        sesion,
        tAdm,
        tieneAudioMsg,
        sendBotMessage,
        persistAdminWaSessionFirestore,
    } = ctx;
    const w = sesion?.wizard;
    if (!w || typeof w.tipo !== 'string' || !w.tipo.startsWith('kontrolpro_')) {
        return false;
    }
    if (tieneAudioMsg) {
        await sendBotMessage(remoteJid, {
            text: '❌ El asistente Kontrolpro no acepta audio en este paso. Mandá *texto* o escribí *menu*.',
        });
        return true;
    }
    const tt = String(tAdm || '').trim();
    if (/^menu$/i.test(tt)) {
        sesion.wizard = null;
        sesion.esperandoMenuPrincipal = true;
        await sendBotMessage(remoteJid, { text: ctx.adminMenuPrincipalMsg || 'Menú admin.' });
        persistAdminWaSessionFirestore(remoteJid).catch(() => {});
        return true;
    }
    sesion.wizard = null;
    await sendBotMessage(remoteJid, {
        text: '⚠️ *Kontrolpro*: el flujo por WhatsApp no está activo en esta versión.\n'
            + 'Usá el panel / Supabase o pedí que se restaure el conector completo.\n\n'
            + 'Escribí *menu* para el menú admin.',
    });
    persistAdminWaSessionFirestore(remoteJid).catch(() => {});
    return true;
}

/**
 * @param {object} ctx — mismo shape que `handleKontrolproWizard`
 * @returns {Promise<boolean>}
 */
async function handleKontrolproRootCommand(ctx) {
    const { remoteJid, tAdm, tieneAudioMsg, sendBotMessage } = ctx;
    const m = String(tAdm || '').trim();
    if (!/^#kp\b|^!!kp\b/i.test(m)) return false;
    if (tieneAudioMsg) {
        await sendBotMessage(remoteJid, { text: '❌ *#kp* va en *texto* (no audio).' });
        return true;
    }
    const url = String(process.env.KONTROLPRO_LOVABLE_EXTERNAL_API_URL || '').trim();
    const hasKey = !!String(process.env.KONTROLPRO_EXTERNAL_API_KEY || '').trim();
    await sendBotMessage(remoteJid, {
        text: url && hasKey
            ? '📊 *Kontrolpro* (#kp): variables `KONTROLPRO_*` detectadas en el servidor, pero el flujo por WhatsApp aún no está cableado en esta imagen.\n'
                + 'Usá el dashboard o la API externa hasta que se active el wizard completo.'
            : '📊 *Kontrolpro* (#kp): faltan `KONTROLPRO_LOVABLE_EXTERNAL_API_URL` y/o `KONTROLPRO_EXTERNAL_API_KEY` en Cloud Run, o el conector WhatsApp no está desplegado.',
    });
    return true;
}

module.exports = {
    handleKontrolproWizard,
    handleKontrolproRootCommand,
};
