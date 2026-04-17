'use strict';

/**
 * Kontrolpro → contexto de cliente para Gemini (solo lectura).
 * Modos: POST a KONTROLPRO_PROXY_URL (Edge Function) o lectura directa REST a Supabase.
 * Apagar: VICKY_KONTROLPRO_CONTEXTO_CLIENTE=0|false|off|no
 */

function normPhoneDb(p) {
    return String(p || '').replace(/\D/g, '');
}

function ultimos10Digitos(digits) {
    const x = normPhoneDb(digits);
    return x.length >= 10 ? x.slice(-10) : x;
}

function variantesTelefonoClienteKontrol(digitsRaw) {
    const d = normPhoneDb(digitsRaw);
    if (d.length < 8) return [];
    const s = new Set();
    const add = (x) => {
        const n = normPhoneDb(x);
        if (n.length >= 8) s.add(n);
    };
    add(d);
    if (d.startsWith('549')) add(d.slice(3));
    if (d.startsWith('54') && !d.startsWith('549') && d.length >= 10) add(`549${d.slice(2)}`);
    if (d.length === 10 && !d.startsWith('54')) add(`549${d}`);
    if (d.length >= 10) add(d.slice(-10));
    if (d.length >= 8) add(d.slice(-8));
    return [...s];
}

function mismoTelefonoKontrol(vars, phoneDb) {
    const pn = normPhoneDb(phoneDb);
    if (pn.length < 8) return false;
    const tailPn = ultimos10Digitos(pn);
    for (const v of vars) {
        if (!v) continue;
        if (pn === v || v === pn) return true;
        if (v.length >= 10 && pn.endsWith(v)) return true;
        if (pn.length >= 10 && v.endsWith(pn)) return true;
        const tailV = ultimos10Digitos(v);
        if (tailPn.length >= 10 && tailV.length >= 10 && tailPn === tailV) return true;
    }
    return false;
}

function contextoClienteDesactivado() {
    const v = String(process.env.VICKY_KONTROLPRO_CONTEXTO_CLIENTE || '').trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function hasProxy() {
    const u = String(process.env.KONTROLPRO_PROXY_URL || '').trim();
    const s = String(process.env.KONTROLPRO_PROXY_SECRET || '').trim();
    return !!(u && s);
}

function hasSupabaseDirect() {
    const u = String(process.env.KONTROLPRO_SUPABASE_URL || '').trim();
    const k = String(process.env.KONTROLPRO_SUPABASE_SERVICE_ROLE_KEY || '').trim();
    return !!(u && k);
}

function isConfigured() {
    if (contextoClienteDesactivado()) return false;
    return hasProxy() || hasSupabaseDirect();
}

function formatContextBlock(client, sales) {
    if (!client) return '';
    const name = String(client.name || '').trim() || 'Cliente';
    const phone = String(client.phone || '').trim();
    const saldo =
        client.saldo_cta_cte != null && client.saldo_cta_cte !== ''
            ? Number(client.saldo_cta_cte)
            : null;
    const lines = [
        '[CONTEXTO_KONTROLPRO]',
        `Cliente en sistema de oficina (Kontrolpro): ${name}${phone ? ` — tel. registrado: ${phone}` : ''}.`,
    ];
    if (Number.isFinite(saldo)) {
        lines.push(`Saldo cuenta corriente (referencia): $${Math.round(saldo).toLocaleString('es-AR')}.`);
    }
    const sl = Array.isArray(sales) ? sales : [];
    if (sl.length) {
        lines.push('Últimas ventas / trabajos en sistema (no modificar desde el chat; derivar a administración si el cliente pide cambios):');
        for (const row of sl.slice(0, 12)) {
            const total = row.total != null ? Number(row.total) : null;
            const st = String(row.status || '').trim();
            const ss = String(row.service_status || '').trim();
            const dd = String(row.delivery_date || '').trim();
            const ds = String(row.delivery_status || '').trim();
            const sd = String(row.scheduled_date || '').trim();
            const stt = String(row.scheduled_time || '').trim();
            const bal = row.balance_due != null ? Number(row.balance_due) : null;
            const bits = [];
            if (Number.isFinite(total)) bits.push(`total $${Math.round(total).toLocaleString('es-AR')}`);
            if (st) bits.push(`estado ${st}`);
            if (Number.isFinite(bal) && bal > 0) bits.push(`saldo venta $${Math.round(bal).toLocaleString('es-AR')}`);
            if (sd) bits.push(`trabajo programado ${sd}${stt ? ` ${stt}` : ''}${ss ? ` (${ss})` : ''}`);
            if (dd) bits.push(`entrega ${dd}${ds ? ` (${ds})` : ''}`);
            lines.push(`- ${bits.join(' · ') || 'venta sin detalle'}`);
        }
    } else {
        lines.push('Sin ventas recientes enlazadas en el sistema para este teléfono.');
    }
    lines.push(
        'Usá estos datos solo como contexto interno; no prometas modificar fechas, saldos ni pagos desde WhatsApp.'
    );
    return lines.join('\n');
}

async function viaProxy(telDigits) {
    const url = String(process.env.KONTROLPRO_PROXY_URL || '').trim();
    const secret = String(process.env.KONTROLPRO_PROXY_SECRET || '').trim();
    const headers = {
        'Content-Type': 'application/json',
        'x-kontrolpro-proxy-secret': secret,
    };
    const anon = String(process.env.KONTROLPRO_PROXY_SUPABASE_ANON_KEY || '').trim();
    if (anon) {
        headers.Authorization = `Bearer ${anon}`;
        headers.apikey = anon;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'getClienteContext', args: { telDigits } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.ok) return '';
    return formatContextBlock(data.client, data.sales);
}

async function viaSupabaseRest(telDigits) {
    const base = String(process.env.KONTROLPRO_SUPABASE_URL || '').replace(/\/$/, '');
    const key = String(process.env.KONTROLPRO_SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const vars = variantesTelefonoClienteKontrol(telDigits);
    if (!vars.length) return '';

    const hdr = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
    };

    const orInner = vars.map((v) => `phone.eq.${v}`).join(',');
    const q1 = `${base}/rest/v1/clients?or=${encodeURIComponent(`(${orInner})`)}&select=id,name,phone,saldo_cta_cte,type&limit=8`;
    const r1 = await fetch(q1, { headers: hdr });
    let clients = r1.ok ? await r1.json().catch(() => []) : [];
    if (!Array.isArray(clients)) clients = [];
    clients = clients.filter((cl) => mismoTelefonoKontrol(vars, String(cl.phone ?? '')));

    if (!clients.length) {
        const tail = ultimos10Digitos(vars[0] || telDigits);
        if (tail.length >= 8) {
            const pat = `%${tail}%`;
            const q2 = `${base}/rest/v1/clients?phone=ilike.${encodeURIComponent(pat)}&select=id,name,phone,saldo_cta_cte,type&limit=20`;
            const r2 = await fetch(q2, { headers: hdr });
            const raw = r2.ok ? await r2.json().catch(() => []) : [];
            if (Array.isArray(raw)) {
                clients = raw.filter((cl) => mismoTelefonoKontrol(vars, String(cl.phone ?? '')));
            }
        }
    }
    if (!clients.length) return '';

    let c = clients[0];
    if (clients.length > 1) {
        const hit = clients.find((cl) => {
            const pn = normPhoneDb(String(cl.phone ?? ''));
            return vars.some((v) => pn === v);
        });
        if (hit) c = hit;
    }

    const sel =
        'id,total,amount_paid,balance_due,status,scheduled_date,scheduled_time,service_status,' +
        'delivery_date,delivery_time,delivery_status,requires_delivery,created_at,is_service,payment_method,notes';
    const q3 = `${base}/rest/v1/sales?client_id=eq.${encodeURIComponent(c.id)}&select=${sel}&order=created_at.desc&limit=15`;
    const r3 = await fetch(q3, { headers: hdr });
    const sales = r3.ok ? await r3.json().catch(() => []) : [];
    return formatContextBlock(c, Array.isArray(sales) ? sales : []);
}

/**
 * @param {string} telDigits — dígitos del chat (normalizado por el caller)
 * @returns {Promise<string>}
 */
async function buildContextoClienteParaGemini(telDigits) {
    if (!isConfigured()) return '';
    const dig = String(telDigits || '').replace(/\D/g, '');
    if (dig.length < 8) return '';
    try {
        if (hasProxy()) return await viaProxy(dig);
        if (hasSupabaseDirect()) return await viaSupabaseRest(dig);
    } catch (e) {
        if (String(process.env.VICKY_LOG_KONTROLPRO_CLIENTE || '').trim() === '1') {
            console.warn('[kontrolpro-cliente]', e.message);
        }
    }
    return '';
}

module.exports = {
    isConfigured,
    buildContextoClienteParaGemini,
};
