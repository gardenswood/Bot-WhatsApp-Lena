# Script one-shot (no editar a mano)

```javascript
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const botPath = path.join(root, "bot.js");
const fsModPath = path.join(root, "firestore-module.js");
const schemaPath = path.join(root, "docs", "FIRESTORE_SCHEMA.md");

// ── firestore-module.js ─────────────────────────────────────────────
let fm = fs.readFileSync(fsModPath, "utf8");
if (!fm.includes("getClienteDocDataParaAvisoAgenda")) {
  const insert = `
/**
 * Datos ligeros de \`clientes/*\` para armar aviso de agenda al grupo (tel / nombre) cuando el proceso no tiene memoria local.
 * @param {string} jid
 * @returns {Promise<object|null>}
 */
async function getClienteDocDataParaAvisoAgenda(jid) {
    if (!firestoreDb || !jid) return null;
    const j = String(jid).trim();
    if (j.startsWith('ig:')) return null;
    const ids = [];
    const push = (x) => {
        if (x && !ids.includes(x)) ids.push(x);
    };
    if (j.endsWith('@s.whatsapp.net')) {
        const d = j.replace(/@s\\.whatsapp\\.net$/i, '').replace(/\\D/g, '');
        if (d.length < 8) return null;
        push(d);
        if (d.length === 10 && !d.startsWith('54')) push(\`549\${d}\`);
        if (d.length === 11 && d.startsWith('54') && !d.startsWith('549')) push(\`549\${d.slice(2)}\`);
        if (d.startsWith('549') && d.length > 3) push(d.slice(3));
    } else if (j.endsWith('@lid')) {
        const lid = j.replace(/@lid$/i, '');
        if (lid) push(lid);
    } else {
        return null;
    }
    try {
        for (const id of ids) {
            const snap = await firestoreDb.collection('clientes').doc(id).get();
            if (snap.exists) return snap.data() || {};
        }
    } catch (e) {
        console.warn('⚠️ getClienteDocDataParaAvisoAgenda:', e.message);
    }
    return null;
}

`;
  const anchor = "/** IDs con notificadoGrupoAgenda == false";
  const i = fm.indexOf(anchor);
  if (i < 0) throw new Error("firestore anchor");
  fm = fm.slice(0, i) + insert + fm.slice(i);
  fm = fm.replace(
    "    getEntregaAgendaDocData,\n    listEntregaAgendaIdsPendientesNotificarGrupo,",
    "    getEntregaAgendaDocData,\n    getClienteDocDataParaAvisoAgenda,\n    listEntregaAgendaIdsPendientesNotificarGrupo,"
  );
  fs.writeFileSync(fsModPath, fm, "utf8");
  console.log("OK firestore-module.js");
} else {
  console.log("Skip firestore-module.js");
}

// ── bot.js ──────────────────────────────────────────────────────────
let s = fs.readFileSync(botPath, "utf8");

const HELPERS = `
/** Fecha local Argentina (Córdoba) de mañana en formato YYYY-MM-DD. */
function fechaIsoManianaArgentina() {
    try {
        const tz = 'America/Argentina/Cordoba';
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
        const t = new Date();
        t.setDate(t.getDate() + 1);
        const parts = fmt.formatToParts(t);
        const y = parts.find((p) => p.type === 'year')?.value;
        const m = parts.find((p) => p.type === 'month')?.value;
        const d = parts.find((p) => p.type === 'day')?.value;
        if (y && m && d) return \`\${y}-\${m}-\${d}\`;
    } catch (_) {}
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
}

function tituloSugeridoEntregaDesdeCliente(c) {
    const nombre = (c?.nombre && String(c.nombre).trim()) || (c?.pushName && String(c.pushName).trim()) || '';
    const interes = (c?.interes && String(c.interes).trim()) || '';
    const prod = (c?.producto && String(c.producto).trim()) || '';
    const partes = [];
    if (nombre) partes.push(nombre);
    if (interes) partes.push(interes);
    if (prod) partes.push(prod);
    const base = partes.join(' · ').trim();
    return base || 'Entrega';
}

/** Teléfono a guardar en entregas_agenda.telefonoContacto (fallback dígitos admin / @s). */
function telefonoContactoParaEntregaAgenda(remoteJid, cliente, digitosFallback) {
    const tf = telefonoLineaParaFirestore(remoteJid, cliente);
    if (tf) return tf;
    const dig = String(digitosFallback || '').replace(/\\D/g, '');
    if (dig.length >= 8) return dig.slice(0, 40);
    if (remoteJid && String(remoteJid).endsWith('@s.whatsapp.net')) {
        const solo = soloDigitosTel(getTel(remoteJid));
        return solo.length >= 8 ? solo.slice(0, 40) : null;
    }
    return null;
}

function telefonoLegibleParaAvisoEntrega(entrega, clienteDoc) {
    const tEnt = entrega && typeof entrega.telefonoContacto === 'string' ? entrega.telefonoContacto.trim() : '';
    if (tEnt) return tEnt;
    const tDoc = clienteDoc && typeof clienteDoc.telefono === 'string' ? clienteDoc.telefono.trim() : '';
    const soloDoc = soloDigitosTel(tDoc);
    if (soloDoc.length >= 8) return soloDoc;
    const jid = entrega && typeof entrega.jid === 'string' ? entrega.jid.trim() : '';
    if (jid.endsWith('@s.whatsapp.net')) {
        const solo = soloDigitosTel(getTel(jid));
        if (solo.length >= 8) return solo;
    }
    return '';
}

`;

if (!s.includes("function fechaIsoManianaArgentina")) {
  const needle = "/** Id de documento Firestore `clientes/{id}`: línea real si se conoce; si no, clave de historial (LID / ig:). */";
  const i = s.indexOf(needle);
  if (i < 0) throw new Error("needle docIdClienteFirestore comment");
  s = s.slice(0, i) + HELPERS + s.slice(i);
}

const OLD_TEXTO = [
  "function textoNotificacionEntregaAgendaEnGrupo(docId, d) {",
  "    if (!d || typeof d !== 'object') return `📅 *Agenda de entregas* — id \\`${docId}\\``;",
  "    const lines = ['📅 *Nueva entrada en agenda de entregas*', ''];",
  "    if (d.fechaDia) lines.push(`📆 Día: *${String(d.fechaDia)}*`);",
  "    if (d.horaTexto) lines.push(`🕐 Hora: ${String(d.horaTexto)}`);",
  "    lines.push(`📝 ${String(d.titulo || '—').slice(0, 400)}`);",
  "    if (d.origen) lines.push(`📎 Origen: _${String(d.origen)}_`);",
  "    if (d.telefonoContacto) lines.push(`📞 Contacto: \\`${String(d.telefonoContacto)}\\``);",
  "    if (d.direccion) lines.push(`📍 ${String(d.direccion).slice(0, 220)}`);",
  "    if (d.producto) lines.push(`📦 ${String(d.producto).slice(0, 220)}`);",
  "    if (d.notas) lines.push(`ℹ️ ${String(d.notas).slice(0, 280)}`);",
  "    if (d.jid) lines.push(`💬 Chat: \\`${String(d.jid)}\\``);",
  "    lines.push('', `\\`id:${docId}\\``);",
  "    return lines.join('\\n').slice(0, 3800);",
  "}",
].join("\n");

const NEW_TEXTO = [
  "function textoNotificacionEntregaAgendaEnGrupo(docId, d, clienteDoc) {",
  "    if (!d || typeof d !== 'object') return `📅 *Agenda de entregas* — id \\`${docId}\\``;",
  "    const telAviso = telefonoLegibleParaAvisoEntrega(d, clienteDoc);",
  "    const nombreCliente =",
  "        (clienteDoc && clienteDoc.nombre && String(clienteDoc.nombre).trim()) ||",
  "        (clienteDoc && clienteDoc.pushName && String(clienteDoc.pushName).trim()) ||",
  "        '';",
  "    const jidStr = d.jid ? String(d.jid).trim() : '';",
  "    const esLid = jidStr.endsWith('@lid');",
  "    const lineaChat =",
  "        telAviso || (esLid && !telAviso)",
  "            ? ''",
  "            : d.jid",
  "              ? `💬 Chat: \\`${String(d.jid)}\\``",
  "              : '';",
  "    const lines = ['📅 *Nueva entrada en agenda de entregas*', ''];",
  "    if (d.fechaDia) lines.push(`📆 Día: *${String(d.fechaDia)}*`);",
  "    if (d.horaTexto) lines.push(`🕐 Hora: ${String(d.horaTexto)}`);",
  "    lines.push(`📝 ${String(d.titulo || '—').slice(0, 400)}`);",
  "    if (d.origen) lines.push(`📎 Origen: _${String(d.origen)}_`);",
  "    if (telAviso) lines.push(`📞 \\`${String(telAviso)}\\``);",
  "    else if (esLid) lines.push('📞 _(ver teléfono en panel / CRM · chat LID)_');",
  "    if (nombreCliente) lines.push(`👤 ${String(nombreCliente).slice(0, 120)}`);",
  "    if (d.direccion) lines.push(`📍 ${String(d.direccion).slice(0, 220)}`);",
  "    if (d.producto) lines.push(`📦 ${String(d.producto).slice(0, 220)}`);",
  "    if (d.notas) lines.push(`ℹ️ ${String(d.notas).slice(0, 280)}`);",
  "    if (lineaChat) lines.push(lineaChat);",
  "    lines.push('', `\\`id:${docId}\\``);",
  "    return lines.join('\\n').slice(0, 3800);",
  "}",
].join("\n");

if (s.includes(OLD_TEXTO)) {
  s = s.replace(OLD_TEXTO, NEW_TEXTO);
} else if (!s.includes("function textoNotificacionEntregaAgendaEnGrupo(docId, d, clienteDoc)")) {
  throw new Error("textoNotificacion bloque no coincide");
}

const OLD_GET = [
  "    const d = await firestoreModule.getEntregaAgendaDocData(docId);",
  "    if (!d) {",
  "        await firestoreModule.revertEntregaAgendaNotificacionGrupo(docId);",
  "        return;",
  "    }",
  "    const text = textoNotificacionEntregaAgendaEnGrupo(docId, d);",
].join("\n");

const NEW_GET = [
  "    const d = await firestoreModule.getEntregaAgendaDocData(docId);",
  "    if (!d) {",
  "        await firestoreModule.revertEntregaAgendaNotificacionGrupo(docId);",
  "        return;",
  "    }",
  "    let clienteDocAviso = null;",
  "    if (d.jid && firestoreModule.getClienteDocDataParaAvisoAgenda) {",
  "        try {",
  "            clienteDocAviso = await firestoreModule.getClienteDocDataParaAvisoAgenda(String(d.jid).trim());",
  "        } catch (_) {}",
  "    }",
  "    const text = textoNotificacionEntregaAgendaEnGrupo(docId, d, clienteDocAviso);",
].join("\n");

if (s.includes(OLD_GET)) {
  s = s.replace(OLD_GET, NEW_GET);
} else if (!s.includes("getClienteDocDataParaAvisoAgenda")) {
  throw new Error("bloque getEntregaAgendaDocData no encontrado");
}

s = s.replace(
  "sesion.wizard = { tipo: 'agenda_entrega', paso: 'tel', jid: null, etiqueta: null };",
  "sesion.wizard = { tipo: 'agenda_entrega', paso: 'tel', jid: null, etiqueta: null, digitosIngresados: null };"
);

const OLD_TEL = [
  "                            w.paso = 'detalle';",
  "                            w.jid = dest.jid;",
  "                            w.etiqueta = dest.etiqueta;",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `📅 *Agenda de entregas* → *${dest.etiqueta}*\\n\\n`",
  "                                    + 'En *una línea* mandá fecha, hora (o `--`) y título:\\n'",
  "                                    + '• `YYYY-MM-DD HH:mm título`\\n'",
  "                                    + '• `YYYY-MM-DD -- título` (todo el día)\\n\\n'",
  "                                    + 'Ej: `2026-04-10 09:00 Entrega 1 tn leña`\\n\\n'",
  "                                    + 'Después te pido *OK* para guardar o *NO* para cancelar.\\n'",
  "                                    + '_*menu*_ — menú principal.',",
  "                            });",
].join("\n");

const NEW_TEL = [
  "                            w.paso = 'detalle';",
  "                            w.jid = dest.jid;",
  "                            w.etiqueta = dest.etiqueta;",
  "                            const soloDigTelWizard = ttW.replace(/\\D/g, '');",
  "                            w.digitosIngresados = soloDigTelWizard.length >= 8 ? soloDigTelWizard : null;",
  "                            const cliTpl = getCliente(dest.jid);",
  "                            const fechaM = fechaIsoManianaArgentina();",
  "                            const titSug = tituloSugeridoEntregaDesdeCliente(cliTpl);",
  "                            const lineaCopiar = `${fechaM} 09:00 ${titSug}`;",
  "                            const telRef =",
  "                                telefonoContactoParaEntregaAgenda(dest.jid, cliTpl, w.digitosIngresados) ||",
  "                                w.digitosIngresados ||",
  "                                '—';",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `📅 *Agenda de entregas* → *${dest.etiqueta}*\\n\\n`",
  "                                    + 'En *una línea* mandá fecha, hora (o `--`) y título:\\n'",
  "                                    + '• `YYYY-MM-DD HH:mm título`\\n'",
  "                                    + '• `YYYY-MM-DD -- título` (todo el día)\\n\\n'",
  "                                    + '*Plantilla para copiar/pegar* (mañana AR, ajustá hora o `--`):\\n'",
  "                                    + `\\`${lineaCopiar}\\`\\n\\n`",
  "                                    + `📞 Referencia: \\`${telRef}\\`\\n\\n`",
  "                                    + 'Después te pido *OK* para guardar o *NO* para cancelar.\\n'",
  "                                    + '_*menu*_ — menú principal.',",
  "                            });",
].join("\n");

if (s.includes(OLD_TEL)) {
  s = s.replace(OLD_TEL, NEW_TEL);
} else {
  throw new Error("wizard tel bloque");
}

const OLD_WIZ_OK = [
  "                                const cliEnt = getCliente(targetJid);",
  "                                const telC = telefonoLineaParaFirestore(targetJid, cliEnt);",
  "                                const productoParts = [];",
  "                                if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                                const paE = cliEnt?.pedidosAnteriores;",
  "                                if (Array.isArray(paE) && paE.length > 0) {",
  "                                    const u = paE[paE.length - 1]?.descripcion;",
  "                                    if (u) productoParts.push(String(u).slice(0, 220));",
  "                                }",
  "                                const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                                const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);",
  "                                const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                                const idAg = await firestoreModule.addEntregaAgenda({",
  "                                    jid: targetJid,",
  "                                    fechaDia,",
  "                                    horaTexto,",
  "                                    titulo: tituloEnt,",
  "                                    notas: notasStr,",
  "                                    kg: null,",
  "                                    origen: 'whatsapp_admin_menu_entrega',",
  "                                    telefonoContacto: telC,",
  "                                    direccion: cliEnt?.direccion || null,",
  "                                    producto: productoStr,",
  "                                });",
  "                                sesion.wizard = null;",
  "                                sesion.esperandoMenuPrincipal = true;",
  "                                if (!idAg) {",
  "                                    await sendBotMessage(remoteJid, {",
  "                                        text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD).\\n\\n' + ADMIN_MENU_PRINCIPAL_MSG,",
  "                                    });",
  "                                    persistAdminWaSessionFirestore(remoteJid).catch(() => {});",
  "                                    return;",
  "                                }",
  "                                await sendBotMessage(remoteJid, {",
  "                                    text:",
  "                                        `✅ *Agenda de entregas* guardada\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                        + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (todo el día)\\n')",
  "                                        + `• \\`${tituloEnt.length > 200 ? `${tituloEnt.slice(0, 200)}…` : tituloEnt}\\`\\n`",
  "                                        + `• Chat: \\`${targetJid}\\`\\n`",
  "                                        + '_Panel → Agenda de entregas._\\n\\n'",
  "                                        + ADMIN_MENU_PRINCIPAL_MSG,",
  "                                });",
].join("\n");

const NEW_WIZ_OK = [
  "                                const cliEnt = getCliente(targetJid);",
  "                                const productoParts = [];",
  "                                if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                                const paE = cliEnt?.pedidosAnteriores;",
  "                                if (Array.isArray(paE) && paE.length > 0) {",
  "                                    const u = paE[paE.length - 1]?.descripcion;",
  "                                    if (u) productoParts.push(String(u).slice(0, 220));",
  "                                }",
  "                                const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                                const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);",
  "                                const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                                const telAg = telefonoContactoParaEntregaAgenda(targetJid, cliEnt, w.digitosIngresados);",
  "                                const idAg = await firestoreModule.addEntregaAgenda({",
  "                                    jid: targetJid,",
  "                                    fechaDia,",
  "                                    horaTexto,",
  "                                    titulo: tituloEnt,",
  "                                    notas: notasStr,",
  "                                    kg: null,",
  "                                    origen: 'whatsapp_admin_menu_entrega',",
  "                                    telefonoContacto: telAg,",
  "                                    direccion: cliEnt?.direccion || null,",
  "                                    producto: productoStr,",
  "                                });",
  "                                sesion.wizard = null;",
  "                                sesion.esperandoMenuPrincipal = true;",
  "                                if (!idAg) {",
  "                                    await sendBotMessage(remoteJid, {",
  "                                        text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD).\\n\\n' + ADMIN_MENU_PRINCIPAL_MSG,",
  "                                    });",
  "                                    persistAdminWaSessionFirestore(remoteJid).catch(() => {});",
  "                                    return;",
  "                                }",
  "                                await sendBotMessage(remoteJid, {",
  "                                    text:",
  "                                        `✅ *Agenda de entregas* guardada\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                        + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (todo el día)\\n')",
  "                                        + `• \\`${tituloEnt.length > 200 ? `${tituloEnt.slice(0, 200)}…` : tituloEnt}\\`\\n`",
  "                                        + (telAg ? `• 📞 \\`${telAg}\\`\\n` : '')",
  "                                        + `• Chat: \\`${targetJid}\\`\\n`",
  "                                        + '_Panel → Agenda de entregas._\\n\\n'",
  "                                        + ADMIN_MENU_PRINCIPAL_MSG,",
  "                                });",
].join("\n");

if (s.includes(OLD_WIZ_OK)) {
  s = s.replace(OLD_WIZ_OK, NEW_WIZ_OK);
} else {
  throw new Error("wizard OK bloque");
}

const OLD_GEM = [
  "                            const cliEnt = getCliente(targetJid);",
  "                            const telC = telefonoLineaParaFirestore(targetJid, cliEnt);",
  "                            const productoParts = [];",
  "                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                            const paE = cliEnt?.pedidosAnteriores;",
  "                            if (Array.isArray(paE) && paE.length > 0) {",
  "                                const u = paE[paE.length - 1]?.descripcion;",
  "                                if (u) productoParts.push(String(u).slice(0, 220));",
  "                            }",
  "                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion, notaDue || null].filter(Boolean);",
  "                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                            const idAg2 = await firestoreModule.addEntregaAgenda({",
  "                                jid: targetJid,",
  "                                fechaDia,",
  "                                horaTexto,",
  "                                titulo: titGem.slice(0, 500),",
  "                                notas: notasStr,",
  "                                kg: null,",
  "                                origen: 'whatsapp_admin_entrega_gemini',",
  "                                telefonoContacto: telC,",
  "                                direccion: cliEnt?.direccion || null,",
  "                                producto: productoStr,",
  "                            });",
  "                            if (!idAg2) {",
  "                                await sendBotMessage(remoteJid, { text: '❌ Fecha inválida o error al guardar en Firestore.' });",
  "                                return;",
  "                            }",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `✅ *Agenda* (Gemini + CRM + hilo)\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                    + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (día completo / sin hora)\\n')",
  "                                    + `• \\`${titGem.length > 200 ? `${titGem.slice(0, 200)}…` : titGem}\\`\\n`",
  "                                    + `• Chat: \\`${targetJid}\\`\\n`",
  "                                    + '_Panel → Agenda de entregas._',",
  "                            });",
].join("\n");

const NEW_GEM = [
  "                            const cliEnt = getCliente(targetJid);",
  "                            const telGem = telefonoContactoParaEntregaAgenda(targetJid, cliEnt, soloTel);",
  "                            const productoParts = [];",
  "                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                            const paE = cliEnt?.pedidosAnteriores;",
  "                            if (Array.isArray(paE) && paE.length > 0) {",
  "                                const u = paE[paE.length - 1]?.descripcion;",
  "                                if (u) productoParts.push(String(u).slice(0, 220));",
  "                            }",
  "                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion, notaDue || null].filter(Boolean);",
  "                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                            const idAg2 = await firestoreModule.addEntregaAgenda({",
  "                                jid: targetJid,",
  "                                fechaDia,",
  "                                horaTexto,",
  "                                titulo: titGem.slice(0, 500),",
  "                                notas: notasStr,",
  "                                kg: null,",
  "                                origen: 'whatsapp_admin_entrega_gemini',",
  "                                telefonoContacto: telGem,",
  "                                direccion: cliEnt?.direccion || null,",
  "                                producto: productoStr,",
  "                            });",
  "                            if (!idAg2) {",
  "                                await sendBotMessage(remoteJid, { text: '❌ Fecha inválida o error al guardar en Firestore.' });",
  "                                return;",
  "                            }",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `✅ *Agenda* (Gemini + CRM + hilo)\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                    + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (día completo / sin hora)\\n')",
  "                                    + `• \\`${titGem.length > 200 ? `${titGem.slice(0, 200)}…` : titGem}\\`\\n`",
  "                                    + (telGem ? `• 📞 \\`${telGem}\\`\\n` : '')",
  "                                    + `• Chat: \\`${targetJid}\\`\\n`",
  "                                    + '_Panel → Agenda de entregas._',",
  "                            });",
].join("\n");

if (s.includes(OLD_GEM)) {
  s = s.replace(OLD_GEM, NEW_GEM);
} else {
  throw new Error("gemini bloque");
}

const OLD_MAN = [
  "                            const cliEnt = getCliente(targetJid);",
  "                            const telC = telefonoLineaParaFirestore(targetJid, cliEnt);",
  "                            const productoParts = [];",
  "                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                            const paE = cliEnt?.pedidosAnteriores;",
  "                            if (Array.isArray(paE) && paE.length > 0) {",
  "                                const u = paE[paE.length - 1]?.descripcion;",
  "                                if (u) productoParts.push(String(u).slice(0, 220));",
  "                            }",
  "                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);",
  "                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                            const idAg = await firestoreModule.addEntregaAgenda({",
  "                                jid: targetJid,",
  "                                fechaDia,",
  "                                horaTexto,",
  "                                titulo: tituloEnt,",
  "                                notas: notasStr,",
  "                                kg: null,",
  "                                origen: 'whatsapp_admin_entrega',",
  "                                telefonoContacto: telC,",
  "                                direccion: cliEnt?.direccion || null,",
  "                                producto: productoStr,",
  "                            });",
  "                            if (!idAg) {",
  "                                await sendBotMessage(remoteJid, {",
  "                                    text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD o probá de nuevo).',",
  "                                });",
  "                                return;",
  "                            }",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `✅ *Agenda de entregas*\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                    + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (todo el día / sin hora fija)\\n')",
  "                                    + `• \\`${tituloEnt.length > 220 ? `${tituloEnt.slice(0, 220)}…` : tituloEnt}\\`\\n`",
  "                                    + `• Chat: \\`${targetJid}\\`\\n`",
  "                                    + '_Visible en el panel → Agenda de entregas._',",
  "                            });",
].join("\n");

const NEW_MAN = [
  "                            const cliEnt = getCliente(targetJid);",
  "                            const telMan = telefonoContactoParaEntregaAgenda(targetJid, cliEnt, null);",
  "                            const productoParts = [];",
  "                            if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));",
  "                            const paE = cliEnt?.pedidosAnteriores;",
  "                            if (Array.isArray(paE) && paE.length > 0) {",
  "                                const u = paE[paE.length - 1]?.descripcion;",
  "                                if (u) productoParts.push(String(u).slice(0, 220));",
  "                            }",
  "                            const productoStr = productoParts.length ? productoParts.join(' — ') : null;",
  "                            const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);",
  "                            const notasStr = notasParts.length ? notasParts.join(' · ') : null;",
  "                            const idAg = await firestoreModule.addEntregaAgenda({",
  "                                jid: targetJid,",
  "                                fechaDia,",
  "                                horaTexto,",
  "                                titulo: tituloEnt,",
  "                                notas: notasStr,",
  "                                kg: null,",
  "                                origen: 'whatsapp_admin_entrega',",
  "                                telefonoContacto: telMan,",
  "                                direccion: cliEnt?.direccion || null,",
  "                                producto: productoStr,",
  "                            });",
  "                            if (!idAg) {",
  "                                await sendBotMessage(remoteJid, {",
  "                                    text: '❌ No se pudo guardar (revisá la fecha AAAA-MM-DD o probá de nuevo).',",
  "                                });",
  "                                return;",
  "                            }",
  "                            await sendBotMessage(remoteJid, {",
  "                                text:",
  "                                    `✅ *Agenda de entregas*\\n• Día: \\`${fechaDia}\\`\\n`",
  "                                    + (horaTexto ? `• Hora: \\`${horaTexto}\\`\\n` : '• Hora: (todo el día / sin hora fija)\\n')",
  "                                    + `• \\`${tituloEnt.length > 220 ? `${tituloEnt.slice(0, 220)}…` : tituloEnt}\\`\\n`",
  "                                    + (telMan ? `• 📞 \\`${telMan}\\`\\n` : '')",
  "                                    + `• Chat: \\`${targetJid}\\`\\n`",
  "                                    + '_Visible en el panel → Agenda de entregas._',",
  "                            });",
].join("\n");

if (s.includes(OLD_MAN)) {
  s = s.replace(OLD_MAN, NEW_MAN);
} else {
  throw new Error("manual bloque");
}

fs.writeFileSync(botPath, s, "utf8");
console.log("OK bot.js");

// ── schema ──────────────────────────────────────────────────────────
let doc = fs.readFileSync(schemaPath, "utf8");
const rowOld =
  "| `telefonoContacto` | string (opcional) | Teléfono en puerta si difiere del WhatsApp; el panel **Agenda** lo guarda al crear evento. |";
const rowNew =
  "| `telefonoContacto` | string (opcional) | Línea de contacto: el bot intenta rellenarlo con mapeo LID→WA, JID `@s.whatsapp.net`, o los dígitos del admin (wizard menú *3* o `#entrega` + solo tel); el panel **Agenda** también puede editarlo. En el aviso al grupo, si no hay número claro y el chat es `@lid`, el texto indica revisar panel/CRM. |";
if (doc.includes(rowOld)) {
  doc = doc.replace(rowOld, rowNew);
  fs.writeFileSync(schemaPath, doc, "utf8");
  console.log("OK FIRESTORE_SCHEMA.md");
} else if (!doc.includes("wizard menú")) {
  console.warn("Skip schema row (ya reemplazada o texto distinto)");
}

console.log("Listo.");
```
