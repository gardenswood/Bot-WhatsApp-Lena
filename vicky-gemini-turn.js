'use strict';

const kontrolproBridge = require('./kontrolpro-bridge');

/** TTS de acuse si el cliente mandó nota de voz y Gemini no envía [AUDIO_CORTO:…]. Variado; no repetir la misma que el turno anterior (sesión). */
const FALLBACK_AUDIO_CORTO_SIN_NOMBRE = [
    'Dale, mirá el mensaje de texto.',
    'Te lo dejé escrito abajo.',
    'Listo, fijate en el texto que te mandé.',
    'Buenísimo, está todo en el mensaje escrito.',
    'Perfecto, ahí va el detalle por escrito.',
    'Dale, anotá en el chat lo que te pasé.',
    'Genial, mirá la respuesta por texto.',
    'Bárbaro, te lo dejé en el chat escrito.',
    'Listo, leé el mensaje de texto.',
    'Dale, en el texto tenés todo despacito.',
    'Ahí va, está en el mensaje de abajo.',
    'Mirá el chat, te pasé todo escrito.',
    'Dale, el detalle está en el mensaje.',
    'Ok, te lo mandé por escrito abajo.',
];

const FALLBACK_AUDIO_CORTO_CON_NOMBRE = [
    'Dale {n}, mirá el texto.',
    '{n}, te lo dejé escrito abajo.',
    '{n}, fijate en el mensaje de texto.',
    'Buenísimo {n}, está todo en el chat escrito.',
    'Listo {n}, mirá lo que te mandé por escrito.',
    'Perfecto {n}, en el texto tenés el detalle.',
    '{n}, ahí va la respuesta por escrito.',
    'Dale {n}, leé el mensaje de abajo.',
    'Genial {n}, está en el texto del chat.',
    '{n}, te pasé todo por escrito.',
    'Bárbaro {n}, mirá el mensaje escrito.',
    'Ok {n}, en el texto está la info.',
];

function elegirFraseFallbackAudioCortoAcuse(session, primerNombre) {
    const ultima = session?.ultimoFallbackAudioCortoAcuse ? String(session.ultimoFallbackAudioCortoAcuse) : null;
    const n = primerNombre && String(primerNombre).trim() ? String(primerNombre).trim() : '';
    const pool = n
        ? FALLBACK_AUDIO_CORTO_CON_NOMBRE.map((t) => t.replace(/\{n\}/g, n))
        : [...FALLBACK_AUDIO_CORTO_SIN_NOMBRE];
    const distintos = ultima ? pool.filter((f) => f !== ultima) : pool;
    const usar = distintos.length ? distintos : pool;
    return usar[Math.floor(Math.random() * usar.length)];
}

/**
 * Núcleo compartido: Gemini + marcadores + historial (WhatsApp e Instagram DM).
 * @param {object} deps - dependencias inyectadas desde bot.js
 * @param {object} params - turno actual
 */
async function ejecutarTurnoVickyGeminiCore(deps, params) {
    const {
        getModel,
        vickyRuntimeCfg,
        firestoreModule,
        delay,
        sendBotMessage,
        enviarImagenCatalogo,
        enviarAudioElevenLabs,
        generarPresupuestoCercoPDF,
        agregarAColaLena,
        aplicarEtiquetaContactarAsesor,
        jidAdminNotificaciones,
        jidOperacionDatosEntrega,
        getCliente,
        getTel,
        actualizarEstadoCliente,
        appendHistorialConsultaSync,
        limpiarTextoParaHistorialConsulta,
        telefonoLineaParaFirestore,
        docIdClienteFirestore,
        bloqueLecturaChatPrevio,
        primerNombreClienteDesdeHistorial,
        LIMITE_INDIVIDUAL_KG,
        fs,
    } = deps;

    const {
        canal,
        remoteJid,
        instagramPsid,
        session,
        telCliente,
        text,
        tieneImagen,
        tieneAudio,
        imagenBase64,
        imagenMime,
        audioClienteBase64,
        audioClienteMime,
        primerContacto,
        minutosDesdeUltimoMensaje,
        publicidadLead,
    } = params;

    const esIg = canal === 'instagram';
    const instagramDm = esIg ? require('./instagram-dm') : null;

    function textoPareceDatosEntrega(t) {
        const s = String(t || '').trim();
        if (s.length < 20) return false;
        const low = s.toLowerCase();

        // Teléfono: 10-13 dígitos (con o sin separadores)
        const digits = low.replace(/\D/g, '');
        const tieneTel = /\b\d{10,13}\b/.test(digits);

        // Dirección / zona: keywords típicas + algún número (altura)
        const tieneDirKw = /\b(calle|av\.?|avenida|barrio|b°|altura|esq\.?|esquina|mza|manzana|lote|dpto|dept\.?|casa|km)\b/i.test(low);
        const tieneNumero = /\b\d{1,5}\b/.test(low);
        const tieneDireccion = tieneDirKw && tieneNumero;

        // Horario / franja: horas + hs o palabras típicas
        const tieneHora = /\b([01]?\d|2[0-3])([:.][0-5]\d)?\s*(hs|h)\b/i.test(low)
            || /\b(mañana|manana|tarde|noche|mediod[ií]a)\b/i.test(low)
            || /\b(desde|hasta|entre)\b/i.test(low);

        return tieneTel && tieneDireccion && tieneHora;
    }

    async function sendTextoSaliente(t) {
        const s = (t || '').trim();
        if (!s) return;
        if (esIg) await instagramDm.enviarDmInstagram(instagramPsid, s);
        else await sendBotMessage(remoteJid, { text: s });
    }

    async function sendSalienteMedia(content) {
        if (esIg) {
            console.log('⚠️ Instagram DM: no se envía adjunto binario en esta versión');
            return;
        }
        await sendBotMessage(remoteJid, content);
    }

    const vickyGeminiModel = getModel();
    if (!vickyGeminiModel) {
        await sendTextoSaliente(
            'Disculpá, estoy teniendo un problema técnico en este momento. Volvé a escribirme en unos minutos 🙏'
        );
        return;
    }

    // Última línea de defensa: humano / panel silenciaron mientras el bot “escribía” (WhatsApp e Instagram).
    if (firestoreModule.isAvailable() && typeof firestoreModule.getChatSilenceState === 'function') {
        try {
            const st0 = await firestoreModule.getChatSilenceState(remoteJid, { bypassCache: true });
            if (st0?.shouldSilence) {
                if (session) {
                    session.humanAtendiendo = true;
                    session.humanTimestamp = Date.now();
                }
                console.log(`🔇 Gemini omitido: chat silenciado (${remoteJid})`);
                return;
            }
        } catch (_) {
            /* no cortar */
        }
    }

    try {
        const chat = vickyGeminiModel.startChat({
            history: session.chatHistory,
        });

        let ctxSaludo;
        if (primerContacto) {
            ctxSaludo = esIg
                ? '[CONTEXTO: Ya enviamos el mensaje de bienvenida por Instagram (solo texto). NO saludes de nuevo, NO repitas "Hola" ni la frase de bienvenida. Respondé DIRECTO a la consulta del cliente.]'
                : '[CONTEXTO: El audio y el mensaje de bienvenida ya fueron enviados en este mismo instante. NO saludes, NO digas "Hola", "Buenas", "Contame" ni nada similar. El cliente te escribió con una consulta específica. Respondé DIRECTAMENTE a lo que preguntó, como si ya estuvieras en medio de la conversación.]';
        } else if (minutosDesdeUltimoMensaje === null) {
            ctxSaludo =
                '[CONTEXTO: Es el primer mensaje de esta sesión activa (sin antigüedad de silencio registrada). Podés saludar. Si en el historial aparece un nombre conocido, usalo con naturalidad.]';
        } else if (minutosDesdeUltimoMensaje >= 360) {
            const horas = Math.round(minutosDesdeUltimoMensaje / 60);
            const histRetorno = getCliente(remoteJid);
            const primerNom = primerNombreClienteDesdeHistorial(histRetorno);
            const partes = [
                `El cliente no escribía hace ${minutosDesdeUltimoMensaje} minutos (aprox. ${horas} h). Es un retorno: saludá breve y con calidez.`,
            ];
            if (primerNom) {
                partes.push(
                    `Conocés a esta persona como "${primerNom}" — usalo en el saludo (solo primer nombre, natural).`
                );
            }
            partes.push(
                'Antes de responder, releé en el historial de este chat los bloques [CONTEXTO_HISTORIAL_CONSULTAS] y [LECTURA_CHAT_PREVIO] si aparecen: ahí está de qué hablaron (producto, cotización, zona). Continuá en coherencia; no repitas lo ya resuelto salvo que el cliente lo pida.'
            );
            if (minutosDesdeUltimoMensaje >= 1440) {
                partes.push(
                    'Llevan más de ~24 h sin mensajes: podés una frase corta para retomar (ej. si sigue con lo que consultaba).'
                );
            }
            partes.push(
                'Si el mensaje actual es una consulta concreta (precio, producto, medida), respondé directo a eso aunque sea retorno.'
            );
            ctxSaludo = `[CONTEXTO: ${partes.join(' ')}]`;
        } else {
            ctxSaludo = `[CONTEXTO: La charla es fluida, el último mensaje fue hace ${minutosDesdeUltimoMensaje} minutos. NO saludes de nuevo, continuá la conversación directamente.]`;
        }

        const mensajesTextoActual = session.mensajesTexto || 0;
        const ctxFidelizar =
            !esIg &&
            vickyRuntimeCfg.FIDELIZAR_CADA > 0 &&
            !tieneAudio &&
            mensajesTextoActual > 0 &&
            mensajesTextoActual % vickyRuntimeCfg.FIDELIZAR_CADA === 0
                ? `[CONTEXTO_AUDIO: Llevamos ${mensajesTextoActual} mensajes de texto seguidos. Es un buen momento para romper la frialdad del chat con un audio breve y cálido. Incluí al inicio de tu respuesta el marcador [AUDIO_FIDELIZAR:frase] con una frase corta, natural y cálida de máximo 12 palabras que refuerce la confianza. Ejemplo: "¡Me alegra que estés interesado! Cualquier duda me avisás." Variá la frase según el contexto de la conversación.]`
                : '';

        const ctxLectura = bloqueLecturaChatPrevio(session.chatHistory);
        const ctxHiloFs = firestoreModule.isAvailable()
            ? await firestoreModule.getUltimosMensajesChatParaContexto(remoteJid, 14)
            : '';
        const DEFAULT_INSTRUCCION_CIERRE_ENTREGA_HUMANO_GEMINI =
            '[CONTEXTO_CIERRE_ENTREGA_POST_HUMANO] Un asesor humano ya atendió la venta; Vicky vuelve solo para coordinar la entrega. Objetivo: en pocos mensajes obtener día (y hora o `--` si es solo el día), dirección/zona clara, teléfono de contacto en puerta si no es el de este chat, y confirmación breve de producto/cantidad si no está en CRM. Usá los marcadores internos habituales ([DIRECCION:…], [ZONA:…], etc.). Cuando el cliente confirme fecha concreta: [ENTREGA:YYYY-MM-DD|HH:mm o --|título breve]. Si en un solo mensaje mandó tel + dirección/zona + franja, podés usar [NOTIFICAR_DATOS_ENTREGA] según reglas 21b/21c del instructivo. Tono breve y operativo.';
        let ctxCierreEntregaPostHumano = '';
        if (!esIg && firestoreModule.isAvailable() && typeof firestoreModule.getChatSilenceState === 'function') {
            try {
                const st = await firestoreModule.getChatSilenceState(remoteJid);
                if (st?.cierreEntregaAsistido) {
                    const bloque = await firestoreModule.getInstruccionCierreEntregaHumanoGemini(
                        DEFAULT_INSTRUCCION_CIERRE_ENTREGA_HUMANO_GEMINI
                    );
                    if (bloque && String(bloque).trim()) ctxCierreEntregaPostHumano = `${String(bloque).trim()}\n`;
                }
            } catch (_) {
                /* no cortar turno */
            }
        }
        let ctxKontrolpro = '';
        if (
            !esIg
            && kontrolproBridge.isConfigured()
            && typeof digitosRemitenteChat === 'function'
        ) {
            try {
                const dig = digitosRemitenteChat(remoteJid);
                if (dig && String(dig).replace(/\D/g, '').length >= 8) {
                    ctxKontrolpro = await kontrolproBridge.buildContextoClienteParaGemini(dig);
                }
            } catch (e) {
                console.warn('Kontrolpro contexto cliente (Gemini):', e.message);
            }
        }

        const ctxLeerPrimero =
            '[LECTURA_OBLIGATORIA] Antes de redactar, integrá en orden: (1) [HILO_CHAT_RECIENTE] si aparece abajo, (2) [CONTEXTO_KONTROLPRO] si aparece abajo (datos de oficina: saldos y fechas de trabajos/entregas), (3) [CONTEXTO_HISTORIAL_CONSULTAS] y [CONTEXTO_SISTEMA] si están en el historial del modelo, (4) [LECTURA_CHAT_PREVIO], y (5) el mensaje actual del cliente. Respondé alineado al tema que venían tratando; no reinicies de cero salvo que el cliente cambie de asunto.';
        const nomServPub =
            publicidadLead?.servicio === 'lena'
                ? 'leña'
                : publicidadLead?.servicio === 'cerco'
                  ? 'cercos'
                  : '';
        const ctxPublicidad = publicidadLead
            ? `[CONTEXTO_PUBLICIDAD] El cliente llegó desde publicidad (${publicidadLead.origen}) sobre ${nomServPub}. NO preguntes qué producto le interesa ni enumeres otros servicios. Respondé directo con precios/info del sistema para ${nomServPub}. Si el mensaje es muy vago, pedí UN dato concreto (medidas, cantidad o zona) para ese producto.`
            : '';

        const ctxCanalIg = esIg
            ? '[CONTEXTO_CANAL_INSTAGRAM] Mismas reglas operativas que WhatsApp: precios y textos de Firestore servicios/*, tono e instructivo del panel, marcadores CRM/handoff. Respondé con la misma calidad que en WhatsApp: cotizá, orientá y usá marcadores; no digas que "por Instagram no podés ayudar" ni desvíes la venta sin motivo. El cliente ya está en DM de @gardens.wood: no lo mandés a "mirar el perfil de Instagram" o "ver fotos en Instagram" para inspirarse — ya está en el canal. Si necesita galería en imágenes, PDF o nota de voz, ahí sí invitá a escribir por WhatsApp a Gardens Wood (mismo negocio y precios). Por DM no se envían adjuntos binarios: los [IMG:…] los traduce el sistema a texto puente. [PEDIDO_LENA] no encola reparto desde Instagram; para cola de ruta de leña y seguimiento fino ofrecé WhatsApp. No inventes números de teléfono.'
            : '';

        const ctxTiempo = [
            ctxHiloFs,
            ctxKontrolpro,
            ctxCanalIg,
            ctxCierreEntregaPostHumano,
            ctxLeerPrimero,
            ctxLectura,
            ctxSaludo,
            ctxFidelizar,
            ctxPublicidad,
        ]
            .filter(Boolean)
            .join('\n');

        const textoNorm = (text || '').toLowerCase();
        const mencionaIntencion =
            /\b(presupuesto|cotizaci[oó]n|cotizar|avanz(ar|amos)?|seña|senia|se\u00f1a|reserv(ar|a|e)?|contratar|hacerlo|lo hacemos|quiero hacerlo)\b/i.test(
                text || ''
            );
        const pidePrecio = /\b(precio|vale|cu[aá]nto sale|cu[aá]nto cuesta|presu|coti)\b/i.test(text || '');
        const tieneMedidasOCantidad =
            /\b(\d{1,4}([.,]\d{1,2})?)\s*(kg|kilos?|tn|ton(eladas?)?|m2|m²|m3|m³|ml|mts?|metros?|metro|cm|cent[ií]metros?)\b/i.test(
                text || ''
            ) || /\b\d{1,4}\s*(x|×)\s*\d{1,4}\b/i.test(text || '');

        let leadStage = null;
        if (mencionaIntencion) leadStage = 'interesado';
        else if (pidePrecio && !tieneMedidasOCantidad) leadStage = 'curioso';

        if (leadStage) {
            actualizarEstadoCliente(remoteJid, { leadStage });
        }

        const ctxLead =
            leadStage === 'curioso'
                ? `[CONTEXTO_EMBUDO] El cliente está en modo CURIOSO/GENERAL. Objetivo: responder breve con guía de precios si corresponde y pedir SOLO 1 dato clave (medidas/cantidad/zona/uso) para poder cotizar. IMPORTANTE: NO armes una cotización total, NO uses [COTIZACION:*] ni [PDF_CERCO:*] en esta respuesta.`
                : leadStage === 'interesado'
                  ? `[CONTEXTO_EMBUDO] El cliente muestra INTENCIÓN (presupuesto/avanzar/seña). Si tenés datos suficientes para armar una cotización completa con total, podés enviarla con [COTIZACION:servicio]. Si y solo si envias una cotización completa (con total) debés incluir además al final: [HANDOFF_EXPERTO:cotizacion_lista] para que continúe un asesor y el bot se silencie. Mantené el mensaje directo y claro.`
                  : '';

        let contenidoMensaje;
        if (audioClienteBase64) {
            const partes = [];
            partes.push({ inlineData: { data: audioClienteBase64, mimeType: audioClienteMime } });
            partes.push({
                text: `${ctxTiempo}\n${ctxLead}\nEl cliente envió este mensaje de voz. Transcribí internamente TODO lo que dice (de principio a fin, sin cortar) y respondé como Vicky según el contenido completo del audio.`,
            });
            contenidoMensaje = partes;
        } else if (imagenBase64) {
            const partes = [];
            partes.push({ inlineData: { data: imagenBase64, mimeType: imagenMime } });
            partes.push({
                text: `${ctxTiempo}\n${ctxLead}\nEl cliente envió esta foto. Analizala en el contexto de los servicios y productos de Gardens Wood y respondé lo que corresponda.`,
            });
            contenidoMensaje = partes;
        } else {
            contenidoMensaje = `${ctxTiempo}\n${ctxLead}\n${text}`;
        }

        let result = null;
        const MAX_REINTENTOS = 3;
        const ESPERAS = [30000, 60000, 90000];
        for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
            try {
                result = await chat.sendMessage(contenidoMensaje);
                break;
            } catch (errApi) {
                const es429 = errApi.message && errApi.message.includes('429');
                if (es429 && intento < MAX_REINTENTOS - 1) {
                    console.warn(
                        `⚠️ Gemini 429, reintentando en ${ESPERAS[intento] / 1000}s... (intento ${intento + 1})`
                    );
                    await delay(ESPERAS[intento]);
                } else {
                    throw errApi;
                }
            }
        }
        if (!result) throw new Error('Sin respuesta después de reintentos');

        let respuesta = result.response.text();

        let userParts;
        if (audioClienteBase64) {
            userParts = [
                { inlineData: { data: audioClienteBase64, mimeType: audioClienteMime } },
                { text: text || '[audio]' },
            ];
        } else if (imagenBase64) {
            userParts = [
                { inlineData: { data: imagenBase64, mimeType: imagenMime } },
                { text: text || '[imagen]' },
            ];
        } else {
            userParts = [{ text }];
        }
        session.chatHistory.push(
            { role: 'user', parts: userParts },
            { role: 'model', parts: [{ text: respuesta }] }
        );

        if (session.chatHistory.length > 20) {
            session.chatHistory = session.chatHistory.slice(-20);
        }

        const cotizMatch = respuesta.match(/\[COTIZACION:(lena|cerco|pergola|fogonero|bancos)\]/i);
        const huboCotizacionMarcador = !!cotizMatch;
        if (cotizMatch) {
            const srv = cotizMatch[1].toLowerCase();
            respuesta = respuesta.replace(/\[COTIZACION:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, {
                estado: 'cotizacion_enviada',
                servicioPendiente: srv,
                textoCotizacion: text,
                fechaCotizacion: new Date().toISOString(),
                seguimientoEnviado: false,
            });
            console.log(`📋 Cotización registrada para ${remoteJid} (${srv})`);
        }

        const pdfCercoMatch = respuesta.match(/\[PDF_CERCO:([^\]]+)\]/i);
        if (pdfCercoMatch) {
            respuesta = respuesta.replace(/\[PDF_CERCO:[^\]]+\]/gi, '').trim();
            const partesPdf = pdfCercoMatch[1].split('|');
            const metros = parseFloat(partesPdf[0]) || 0;
            const precioUnit = parseFloat(partesPdf[1]) || 0;
            const alturaM = partesPdf[2] || '1.8';
            const descuentoPct = parseFloat(partesPdf[3]) || 0;
            const nombreCliente = getCliente(remoteJid)?.nombre || 'Cliente';

            if (metros > 0 && precioUnit > 0) {
                generarPresupuestoCercoPDF({
                    cliente: nombreCliente,
                    metros,
                    precioUnit,
                    alturaM,
                    descuentoPct,
                })
                    .then(async (pdfPath) => {
                        if (!pdfPath) return;
                        try {
                            if (esIg) {
                                await sendTextoSaliente(
                                    'Te armé el presupuesto de cerco en el sistema. Por Instagram no puedo adjuntar el PDF: si querés el archivo, escribinos por WhatsApp a Gardens Wood y te lo mandamos 📄'
                                );
                                fs.unlinkSync(pdfPath);
                                console.log(`📄 PDF cerco generado para ${remoteJid} (Instagram: solo aviso texto)`);
                            } else {
                                await sendSalienteMedia({
                                    document: fs.readFileSync(pdfPath),
                                    mimetype: 'application/pdf',
                                    fileName: `Presupuesto Cerco - ${nombreCliente}.pdf`,
                                });
                                fs.unlinkSync(pdfPath);
                                console.log(`📄 PDF cerco enviado a ${remoteJid}`);
                            }
                        } catch (errPdf) {
                            console.error('❌ Error enviando PDF:', errPdf.message);
                        }
                    })
                    .catch((err) => console.error('❌ Error generando PDF cerco:', err.message));
            }
        }

        let huboConfirmadoMarcador = false;
        if (/\[CONFIRMADO\]/i.test(respuesta)) {
            huboConfirmadoMarcador = true;
            respuesta = respuesta.replace(/\[CONFIRMADO\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { estado: 'confirmado' });
            console.log(`✅ Cliente ${remoteJid} confirmó.`);
        }

        const nombreMatch = respuesta.match(/\[NOMBRE:([^\]]+)\]/i);
        if (nombreMatch) {
            const nombre = nombreMatch[1].trim();
            respuesta = respuesta.replace(/\[NOMBRE:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { nombre });
            console.log(`👤 Nombre registrado para ${remoteJid}: ${nombre}`);
        }

        const dirMatch = respuesta.match(/\[DIRECCION:([^\]]+)\]/i);
        if (dirMatch) {
            const direccion = dirMatch[1].trim();
            respuesta = respuesta.replace(/\[DIRECCION:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { direccion });
            console.log(`📍 Dirección registrada para ${remoteJid}: ${direccion}`);
        }

        const zonaMatch = respuesta.match(/\[ZONA:([^\]]+)\]/i);
        if (zonaMatch) {
            const zona = zonaMatch[1].trim();
            respuesta = respuesta.replace(/\[ZONA:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { zona });
            console.log(`🗺️ Zona registrada para ${remoteJid}: ${zona}`);
        }

        const barrioMatch = respuesta.match(/\[BARRIO:([^\]]+)\]/i);
        if (barrioMatch) {
            const barrio = barrioMatch[1].trim();
            respuesta = respuesta.replace(/\[BARRIO:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { barrio });
            console.log(`🏘️ Barrio registrado para ${remoteJid}: ${barrio}`);
        }

        const locMatch = respuesta.match(/\[LOCALIDAD:([^\]]+)\]/i);
        if (locMatch) {
            const localidad = locMatch[1].trim();
            respuesta = respuesta.replace(/\[LOCALIDAD:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { localidad });
            console.log(`📌 Localidad registrada para ${remoteJid}: ${localidad}`);
        }

        const refMatch = respuesta.match(/\[REFERENCIA:([^\]]+)\]/i);
        if (refMatch) {
            const referencia = refMatch[1].trim();
            respuesta = respuesta.replace(/\[REFERENCIA:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { referencia });
            console.log(`📍 Referencia registrada para ${remoteJid}: ${referencia}`);
        }

        const notasUbiMatch = respuesta.match(/\[NOTAS_UBICACION:([^\]]+)\]/i);
        if (notasUbiMatch) {
            const notasUbicacion = notasUbiMatch[1].trim().slice(0, 800);
            respuesta = respuesta.replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { notasUbicacion });
            console.log(`📝 Notas ubicación para ${remoteJid} (${notasUbicacion.length} chars)`);
        }

        const pagoMatch = respuesta.match(/\[METODO_PAGO:([^\]]+)\]/i);
        if (pagoMatch) {
            const metodoPago = pagoMatch[1].trim();
            respuesta = respuesta.replace(/\[METODO_PAGO:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { metodoPago });
            console.log(`💳 Método de pago registrado para ${remoteJid}: ${metodoPago}`);
        }

        const pedidoMatch = respuesta.match(/\[PEDIDO:([^\]]+)\]/i);
        if (pedidoMatch) {
            const partesP = pedidoMatch[1].split('|');
            const pedido = {
                servicio: partesP[0]?.trim(),
                descripcion: partesP[1]?.trim() || '',
                fecha: new Date().toISOString(),
            };
            respuesta = respuesta.replace(/\[PEDIDO:[^\]]+\]/gi, '').trim();
            actualizarEstadoCliente(remoteJid, { pedido, estado: 'cliente' });
            console.log(`📦 Pedido registrado para ${remoteJid}: ${pedido.servicio} - ${pedido.descripcion}`);
        }

        const pedidoLenaMatch = respuesta.match(/\[PEDIDO_LENA:([^\]]+)\]/i);
        if (pedidoLenaMatch && !esIg) {
            const partesL = pedidoLenaMatch[1].split('|');
            const cantidadKg = parseInt(partesL[0]?.trim(), 10) || 0;
            const direccionLena = partesL[1]?.trim() || null;
            const tipoRaw = partesL[2]?.trim();
            /** @type {string | null} */
            let tipoLena = null;
            if (tipoRaw) {
                const t = tipoRaw.toLowerCase();
                const alias = { grande: 'hogar', mediana: 'salamandra', fino: 'parrilla' };
                const norm = alias[t] || t;
                if (['hogar', 'salamandra', 'parrilla'].includes(norm)) tipoLena = norm;
            }
            respuesta = respuesta.replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '').trim();

            const histCliente = getCliente(remoteJid);
            const nombreCliente = histCliente?.nombre || null;
            const zonaCliente = histCliente?.zona || null;
            const dirFinal = direccionLena || histCliente?.direccion || 'Sin dirección';

            if (cantidadKg > 0 && cantidadKg <= LIMITE_INDIVIDUAL_KG) {
                if (direccionLena) actualizarEstadoCliente(remoteJid, { direccion: direccionLena });
                await agregarAColaLena(remoteJid, nombreCliente, dirFinal, zonaCliente, cantidadKg, tipoLena);
                const telFs = docIdClienteFirestore(remoteJid, getCliente(remoteJid));
                if (telFs && firestoreModule.syncCliente) {
                    const fsPatch = { direccion: dirFinal };
                    if (tipoLena) fsPatch.tipoLenaPreferido = tipoLena;
                    firestoreModule.syncCliente(telFs, fsPatch).catch(() => {});
                }
            } else if (cantidadKg > LIMITE_INDIVIDUAL_KG) {
                console.log(`🚚 Pedido de ${cantidadKg}kg → entrega individual, no va a cola`);
            }
        } else if (pedidoLenaMatch && esIg) {
            respuesta = respuesta.replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '').trim();
            console.log('ℹ️ Instagram: [PEDIDO_LENA] ignorado (cola leña solo WhatsApp)');
        }

        const handoffMatch = respuesta.match(/\[HANDOFF_EXPERTO:([^\]]+)\]/i);
        let handoffReason = null;
        if (handoffMatch) {
            handoffReason = (handoffMatch[1] || '').trim();
            respuesta = respuesta.replace(/\[HANDOFF_EXPERTO:[^\]]+\]\s*/gi, '').trim();

            const lower = respuesta.toLowerCase();
            const mencionaAsesor = lower.includes('asesor') || lower.includes('experto') || lower.includes('equipo');
            if (!mencionaAsesor) {
                const suf = 'En breve te continúa un asesor para terminar de ajustar el presupuesto.';
                respuesta = respuesta ? `${respuesta}\n\n${suf}` : suf;
            }
        }

        const crmMatch = respuesta.match(/\[CRM:([^\]]+)\]/i);
        if (crmMatch) {
            const p = crmMatch[1].split('|').map((x) => x.trim());
            const potRaw = (p[0] || '').toLowerCase();
            const pot = potRaw === 'frio' ? 'frío' : potRaw;
            const st = (p[1] || '').toLowerCase();
            const urg = (p[2] || '').toLowerCase();
            const zonaCrm = p[3] || '';
            const interCsv = p[4] || '';
            const upd = {};
            if (['frío', 'tibio', 'caliente'].includes(pot)) upd.potencial = pot;
            if (['pendiente_cotizacion', 'seguimiento', 'concreto', 'en_obra'].includes(st)) upd.statusCrm = st;
            if (['alta', 'media', 'baja'].includes(urg)) upd.urgencia = urg;
            if (zonaCrm) upd.zona = zonaCrm;
            if (interCsv) upd.interes = interCsv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            if (Object.keys(upd).length) actualizarEstadoCliente(remoteJid, upd);
            respuesta = respuesta.replace(/\[CRM:[^\]]+\]/gi, '').trim();
        }

        const ventaMatch = respuesta.match(/\[NOTIFICAR_VENTA:([^\]]+)\]/i);
        let notificarVentaResumen = null;
        if (ventaMatch) {
            notificarVentaResumen = (ventaMatch[1] || '').trim();
            respuesta = respuesta.replace(/\[NOTIFICAR_VENTA:[^\]]+\]/gi, '').trim();
            const lowV = respuesta.toLowerCase();
            if (!lowV.includes('asesor') && !lowV.includes('humano') && !lowV.includes('contact')) {
                const sufV = 'En breve un asesor humano te contacta para cerrar el pedido. ¡Gracias por elegirnos!';
                respuesta = respuesta ? `${respuesta}\n\n${sufV}` : sufV;
            }
        }

        const datosEntregaMatch = respuesta.match(/\[NOTIFICAR_DATOS_ENTREGA\]/i);
        let notificarDatosEntrega = false;
        if (datosEntregaMatch) {
            notificarDatosEntrega = true;
            respuesta = respuesta.replace(/\[NOTIFICAR_DATOS_ENTREGA\]/gi, '').trim();
        }

        const agendaMatch = respuesta.match(/\[AGENDAR:([0-9]{4}-[0-9]{2}-[0-9]{2})\|([^\]]+)\]/i);
        if (agendaMatch && firestoreModule.isAvailable()) {
            const fechaStr = agendaMatch[1];
            const txtAg = (agendaMatch[2] || '').trim();
            const runMs = Date.parse(`${fechaStr}T14:00:00-03:00`);
            if (Number.isFinite(runMs) && txtAg) {
                await firestoreModule.addMensajeProgramado({
                    jid: remoteJid,
                    texto: txtAg,
                    runAtMs: runMs,
                    origen: 'gemini_agendar',
                });
            }
            respuesta = respuesta.replace(/\[AGENDAR:[^\]]+\]/gi, '').trim();
        }

        const entregaMatch = respuesta.match(
            /\[ENTREGA:([0-9]{4}-[0-9]{2}-[0-9]{2})\|([^|]*)\|([^\]]+)\]/i
        );
        if (entregaMatch && firestoreModule.isAvailable()) {
            const fechaDia = entregaMatch[1];
            const horaRaw = (entregaMatch[2] || '').trim();
            const tituloEnt = (entregaMatch[3] || '').trim();
            const horaTexto = horaRaw && horaRaw !== '--' ? horaRaw : null;
            if (tituloEnt && /^\d{4}-\d{2}-\d{2}$/.test(fechaDia)) {
                const cliEnt = getCliente(remoteJid);
                const telC = telefonoLineaParaFirestore(remoteJid, cliEnt);
                const productoParts = [];
                if (cliEnt?.servicioPendiente) productoParts.push(String(cliEnt.servicioPendiente));
                const paE = cliEnt?.pedidosAnteriores;
                if (Array.isArray(paE) && paE.length > 0) {
                    const u = paE[paE.length - 1]?.descripcion;
                    if (u) productoParts.push(String(u).slice(0, 220));
                }
                const productoStr = productoParts.length ? productoParts.join(' — ') : null;
                const notasParts = [cliEnt?.zona, cliEnt?.notasUbicacion].filter(Boolean);
                const notasStr = notasParts.length ? notasParts.join(' · ') : null;
                const idEntrega = await firestoreModule.addEntregaAgenda({
                    jid: remoteJid,
                    fechaDia,
                    horaTexto,
                    titulo: tituloEnt,
                    notas: notasStr,
                    kg: null,
                    origen: 'gemini_entrega',
                    telefonoContacto: telC,
                    direccion: cliEnt?.direccion || null,
                    producto: productoStr,
                });
                if (idEntrega && typeof firestoreModule.setCierreEntregaAsistido === 'function') {
                    await firestoreModule.setCierreEntregaAsistido(remoteJid, false);
                }
            }
            respuesta = respuesta.replace(/\[ENTREGA:[^\]]+\]/gi, '').trim();
        }

        const estadoCliente = getCliente(remoteJid)?.estado;
        // WhatsApp: los audios TTS (respuesta a voz del cliente, audio junto a imagen, [AUDIO_CORTO:])
        // deben seguir aunque el CRM marque "confirmado". Solo la fidelización proactiva se omite tras confirmar.
        const audioTtsHabilitado = !esIg;
        const audioFidelizacionHabilitado = estadoCliente !== 'confirmado' && !esIg;

        const fidelizarMatch = respuesta.match(/\[AUDIO_FIDELIZAR:([^\]]+)\]/i);
        let fraseFidelizarEnviada = null;
        if (fidelizarMatch && audioFidelizacionHabilitado) {
            const fraseFidelizar = fidelizarMatch[1].trim();
            fraseFidelizarEnviada = fraseFidelizar;
            respuesta = respuesta.replace(/\[AUDIO_FIDELIZAR:[^\]]+\]\s*/i, '').trim();
            await enviarAudioElevenLabs(sendBotMessage, remoteJid, fraseFidelizar);
            await delay(1000);
            console.log(`🎙️ Audio fidelización enviado a ${remoteJid}`);
        } else if (fidelizarMatch) {
            respuesta = respuesta.replace(/\[AUDIO_FIDELIZAR:[^\]]+\]\s*/i, '').trim();
        }

        let fraseAudioCorto = null;
        const audioCortoMatch = respuesta.match(/\[AUDIO_CORTO:([^\]]+)\]/i);
        if (audioCortoMatch) {
            const contenido = audioCortoMatch[1].trim();
            const palabras = contenido.split(/\s+/).length;
            if (palabras <= 25) {
                fraseAudioCorto = contenido;
                respuesta = respuesta.replace(/\[AUDIO_CORTO:[^\]]+\]\s*/i, '').trim();
            } else {
                respuesta = respuesta.replace(/\[AUDIO_CORTO:([^\]]+)\]/i, '$1').trim();
                console.log(`⚠️ AUDIO_CORTO demasiado largo (${palabras} palabras), usando como texto`);
            }
        }

        let audioEnviado = false;
        /** TTS corto ante nota de voz del cliente: no debe silenciar la respuesta larga de Gemini (solo acuse). */
        let audioEnviadoEsSoloAcuseNotaCliente = false;
        if (tieneAudio && audioTtsHabilitado) {
            const histCliente = getCliente(remoteJid);
            const primerNom = primerNombreClienteDesdeHistorial(histCliente);
            if (fraseAudioCorto) {
                audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, fraseAudioCorto);
            } else {
                const fallback = elegirFraseFallbackAudioCortoAcuse(session, primerNom);
                audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, fallback);
                if (audioEnviado && session) session.ultimoFallbackAudioCortoAcuse = fallback;
            }
            if (audioEnviado) {
                audioEnviadoEsSoloAcuseNotaCliente = true;
                await delay(800);
            }
        }

        const imgMatch = respuesta.match(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/i);
        if (imgMatch) {
            respuesta = respuesta.replace(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/gi, '').trim();
        }

        if (tieneImagen && audioTtsHabilitado && !audioEnviado) {
            const textoParaAudio = respuesta
                .replace(/\[COTIZACION:[^\]]+\]/gi, '')
                .replace(/\[CONFIRMADO\]/gi, '')
                .replace(/\[NOMBRE:[^\]]+\]/gi, '')
                .replace(/\[DIRECCION:[^\]]+\]/gi, '')
                .replace(/\[ZONA:[^\]]+\]/gi, '')
                .replace(/\[BARRIO:[^\]]+\]/gi, '')
                .replace(/\[LOCALIDAD:[^\]]+\]/gi, '')
                .replace(/\[REFERENCIA:[^\]]+\]/gi, '')
                .replace(/\[NOTAS_UBICACION:[^\]]+\]/gi, '')
                .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
                .replace(/\[CRM:[^\]]+\]/gi, '')
                .replace(/\[NOTIFICAR_VENTA:[^\]]+\]/gi, '')
                .replace(/\[NOTIFICAR_DATOS_ENTREGA\]/gi, '')
                .replace(/\[AGENDAR:[^\]]+\]/gi, '')
                .replace(/\[ENTREGA:[^\]]+\]/gi, '')
                .trim();
            audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, textoParaAudio);
            if (audioEnviado) await delay(800);
        }

        let textoSinSaludo = respuesta.trim();
        if (audioEnviado || fraseFidelizarEnviada) {
            textoSinSaludo = textoSinSaludo
                .replace(/^(hola\b[^!\n]*[!.]?\s*)/i, '')
                .replace(/^(buenas?\b[^!\n]*[!.]?\s*)/i, '')
                .replace(/^(bárbaro[^!\n]*[!.]?\s*)/i, '')
                .replace(/^(claro[,!]?\s*(te cuento|te paso|acá)[^!\n]*[!.]?\s*)/i, '')
                .replace(/^(dale[,!]?\s*(te paso|te mando|ya)[^!\n]*[!.]?\s*)/i, '')
                .replace(/^(perfecto[,!]?\s*[^!\n]{0,40}[!.]?\s*)/i, '')
                .trim();
        }
        const textoFinal = textoSinSaludo;
        const hayImagen = !!imgMatch;
        const debeEnviarTexto =
            !audioEnviado
            || (audioEnviado && hayImagen)
            || (audioEnviado && audioEnviadoEsSoloAcuseNotaCliente);
        console.log(
            `📝 Texto (${textoFinal.length} chars, audio=${audioEnviado}, img=${hayImagen}, enviar=${debeEnviarTexto}): "${textoFinal.substring(0, 100)}"`
        );
        let mensajeSalienteTexto = null;
        if (debeEnviarTexto && textoFinal.length > 0) {
            await sendTextoSaliente(textoFinal);
            mensajeSalienteTexto = textoFinal;
            const histClienteActualizado = getCliente(remoteJid);
            firestoreModule
                .logMensaje({
                    jid: remoteJid,
                    tipo: 'texto',
                    contenido: textoFinal,
                    direccion: 'saliente',
                    marcadores: [
                        ...(imgMatch ? [`IMG:${imgMatch[1]}`] : []),
                        ...(huboCotizacionMarcador ? ['COTIZACION'] : []),
                        ...(huboConfirmadoMarcador ? ['CONFIRMADO'] : []),
                    ],
                    servicio: histClienteActualizado?.servicioPendiente || null,
                    clienteInfo: {
                        nombre: histClienteActualizado?.nombre,
                        estado: histClienteActualizado?.estado,
                        servicioPendiente: histClienteActualizado?.servicioPendiente,
                    },
                })
                .catch(() => {});

            const clienteSync = getCliente(remoteJid);
            const docFs = docIdClienteFirestore(remoteJid, clienteSync);
            if (clienteSync) {
                const lidDigits = String(remoteJid).endsWith('@lid')
                    ? String(remoteJid).replace(/@lid$/i, '')
                    : null;
                const fsCliente = {
                    remoteJid,
                    telefono: telefonoLineaParaFirestore(remoteJid, clienteSync),
                    nombre: clienteSync.nombre || null,
                    direccion: clienteSync.direccion || null,
                    zona: clienteSync.zona || null,
                    barrio: clienteSync.barrio || null,
                    localidad: clienteSync.localidad || null,
                    referencia: clienteSync.referencia || null,
                    notasUbicacion: clienteSync.notasUbicacion || null,
                    metodoPago: clienteSync.metodoPago || null,
                    estado: clienteSync.estado || 'nuevo',
                    servicioPendiente: clienteSync.servicioPendiente || null,
                    audioIntroEnviado: clienteSync.audioIntroEnviado || false,
                    handoffEnviado: clienteSync.handoffEnviado || false,
                    leadStage: clienteSync.leadStage || null,
                    potencial: clienteSync.potencial || null,
                    statusCrm: clienteSync.statusCrm || null,
                    urgencia: clienteSync.urgencia || null,
                    interes: Array.isArray(clienteSync.interes) ? clienteSync.interes : [],
                    origenAnuncio: clienteSync.origenAnuncio || null,
                    pedidosAnteriores: clienteSync.pedidosAnteriores || [],
                    canal: clienteSync.canal || (esIg ? 'instagram' : undefined),
                    instagramUserId:
                        clienteSync.instagramUserId || (esIg ? String(instagramPsid) : undefined),
                };
                if (lidDigits) fsCliente.whatsappLid = lidDigits;
                firestoreModule.syncCliente(docFs, fsCliente).catch(() => {});
            }
        } else if (!audioEnviado) {
            console.warn(`⚠️ Respuesta vacía sin audio para ${remoteJid} — enviando fallback`);
            const textoFallback = `Disculpá, no logré entender bien tu consulta 😅\n¿Podés contarme un poco más? Así te oriento bien.`;
            await sendTextoSaliente(textoFallback);
            mensajeSalienteTexto = textoFallback;
        } else if (audioEnviado && textoFinal.length > 0) {
            console.log(
                `🎙️ Audio enviado; texto de ${textoFinal.length} chars omitido (TTS ya cubría la respuesta o canal sin duplicar).`
            );
        } else {
            console.log(`⚠️ Texto vacío pero audio enviado — OK`);
        }

        if (imgMatch) {
            const servicioKey = imgMatch[1].toLowerCase();
            if (!session.imagenEnviada[servicioKey]) {
                session.imagenEnviada[servicioKey] = true;
                await delay(800);
                if (esIg) {
                    await sendTextoSaliente(
                        `Por Instagram te paso la info del catálogo (${servicioKey}). Si querés ver fotos o video, escribinos por WhatsApp a Gardens Wood y te las mandamos al toque 📷`
                    );
                } else {
                    await enviarImagenCatalogo(remoteJid, servicioKey);
                }
            }
        }

        if (handoffMatch || notificarVentaResumen) {
            session.humanAtendiendo = true;
            session.humanTimestamp = Date.now();
            firestoreModule.setHumanoAtendiendo(remoteJid, true).catch(() => {});
            actualizarEstadoCliente(remoteJid, { handoffEnviado: true });
            if (handoffMatch) {
                console.log(`🤝 Handoff activado para ${remoteJid}${handoffReason ? ` — ${handoffReason}` : ''}`);
            }
            if (notificarVentaResumen) {
                const adm = jidAdminNotificaciones();
                const telC = getTel(remoteJid);
                const nom = getCliente(remoteJid)?.nombre || '';
                const aviso = `🔔 *Posible venta / cierre*\n*Cliente:* ${nom || telC} (${telC})\n*Detalle:* ${notificarVentaResumen}`;
                if (adm) await sendBotMessage(adm, { text: aviso }).catch(() => {});
                console.log(`🔔 NOTIFICAR_VENTA → admin (${notificarVentaResumen?.slice(0, 80)})`);
            }
            aplicarEtiquetaContactarAsesor(remoteJid).catch(() => {});
        }

        const txtInDatosEntrega = String(text || '').trim();
        const porHeuristicaDatosEntrega = !esIg && textoPareceDatosEntrega(txtInDatosEntrega);
        const debeNotificarDatosEntrega = !esIg && (notificarDatosEntrega || porHeuristicaDatosEntrega);
        if (debeNotificarDatosEntrega) {
            const opJid = typeof jidOperacionDatosEntrega === 'function' ? jidOperacionDatosEntrega() : null;
            const txtIn = txtInDatosEntrega;
            if (opJid && txtIn.length > 12) {
                const dedupe = `${remoteJid}:${txtIn.slice(0, 800)}`;
                if (session.notifDatosEntregaDedupe !== dedupe) {
                    session.notifDatosEntregaDedupe = dedupe;
                    const cli = getCliente(remoteJid);
                    const nom = cli?.nombre || '';
                    const telLinea = telefonoLineaParaFirestore(remoteJid, cli) || getTel(remoteJid) || '';
                    const razon = notificarDatosEntrega ? 'marcador' : 'heurística';
                    const aviso =
                        `📦 *Datos de entrega (cliente)*\n`
                        + `*Chat:* ${nom ? `${nom} — ` : ''}${telLinea || '—'}\n`
                        + `*JID:* ${remoteJid}\n\n`
                        + `*Mensaje del cliente:*\n${txtIn.slice(0, 3800)}`;
                    await sendBotMessage(opJid, { text: aviso }).catch(() => {});
                    console.log(`📦 NOTIFICAR_DATOS_ENTREGA → operación (${razon}) (${telLinea || remoteJid})`);
                    firestoreModule
                        .addDatosEntregaRegistro({
                            jid: remoteJid,
                            telefonoLinea: telLinea || null,
                            nombre: nom || null,
                            mensajeCliente: txtIn,
                            origen: notificarDatosEntrega ? 'gemini_marcador' : 'heuristica',
                        })
                        .catch(() => {});
                }
            }
        }

        const hcEntrada = [text || '', tieneAudio ? '[audio de voz]' : '', tieneImagen ? '[imagen]' : '']
            .filter(Boolean)
            .join(' ')
            .trim() || '(sin texto)';
        const partesSalida = [];
        if (mensajeSalienteTexto) partesSalida.push(mensajeSalienteTexto);
        if (audioEnviado) partesSalida.push(fraseAudioCorto ? `Audio: ${fraseAudioCorto}` : 'Audio TTS');
        if (fraseFidelizarEnviada) partesSalida.push(`Audio fidelización: ${fraseFidelizarEnviada}`);
        if (imgMatch) partesSalida.push(`Catálogo ${imgMatch[1]}`);
        const salidaHistorial = limpiarTextoParaHistorialConsulta(partesSalida.join(' | ') || '[sin contenido]');
        const nombreHc = getCliente(remoteJid)?.nombre || null;
        appendHistorialConsultaSync(telCliente, {
            entradaCliente: hcEntrada.slice(0, 2500),
            salidaVicky: salidaHistorial,
            nombre: nombreHc,
        });

        console.log(
            `✅ Respuesta Gemini enviada a ${remoteJid} (${tieneAudio ? '🎙️+💬' : tieneImagen ? '🖼️🎙️+💬' : '💬'})`
        );
    } catch (geminiError) {
        console.error('❌ Error llamando a Gemini:', geminiError.message);
        await sendTextoSaliente(`Disculpá, tuve un problema para procesar tu consulta. ¿Podés escribirme de nuevo? 🙏`);
    }
}

module.exports = { ejecutarTurnoVickyGeminiCore };
