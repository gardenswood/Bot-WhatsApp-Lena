// bot.js - Vicky Bot - Asistente WhatsApp con Gemini AI
// Gardens Wood - Leña, Cercos, Pérgolas, Sector Fogonero

const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrTerminal = require('qrcode-terminal');
const qrImage = require('qr-image');
const { Storage } = require('@google-cloud/storage');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const http = require('http');

// --- MÓDULO FIRESTORE (Dashboard) ---
const firestoreModule = require('./firestore-module');

// --- SERVIDOR PARA CLOUD RUN (Salud) ---
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Vicky Bot is Online! 🪵💨');
});
server.listen(PORT, () => console.log(`📡 Servidor de salud escuchando en puerto ${PORT}`));

// --- CONFIGURACIÓN DE NUBE ---
const BUCKET_NAME = 'webgardens-8655d_whatsapp_session';
const storage = new Storage();
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const HISTORIAL_PATH = path.join(__dirname, 'usuarios_vistos.json');

// --- AUDIO DE BIENVENIDA (se envía solo la primera vez por cliente) ---
const AUDIO_INTRO_PATH = path.join(__dirname, 'ElevenLabs_2026-03-21T11_41_40_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');
const AUDIO_INTRO_EXISTS = fs.existsSync(AUDIO_INTRO_PATH);
console.log(`🎵 Audio intro: ${AUDIO_INTRO_EXISTS ? '✅ encontrado' : '❌ NO encontrado en ' + AUDIO_INTRO_PATH}`);

const AUDIO_CONFIRMADO_PATH = path.join(__dirname, 'ElevenLabs_2026-03-21T12_03_41_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3');
const AUDIO_CONFIRMADO_EXISTS = fs.existsSync(AUDIO_CONFIRMADO_PATH);
console.log(`🎵 Audio confirmado: ${AUDIO_CONFIRMADO_EXISTS ? '✅ encontrado' : '❌ NO encontrado en ' + AUDIO_CONFIRMADO_PATH}`);

// --- IMÁGENES POR SERVICIO ---
const IMAGENES = {
    lena:     path.join(__dirname, 'assets', 'madera_premium.png'),
    cerco:    path.join(__dirname, 'images', 'Cercos', 'cerco1.jpeg'),
    pergola:  path.join(__dirname, 'images', 'Pergolas', '1.png'),
    fogonero: path.join(__dirname, 'images', 'Sector Fogonero', 'WhatsApp Image 2026-03-18 at 16.11.59 (1).jpeg'),
    bancos:   path.join(__dirname, 'images', 'Bancos', 'bancos1.mp4')  // video
};

// --- GEMINI AI ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY no configurada. El bot no podrá responder.');
}

const SYSTEM_PROMPT = `Sos Vicky, la asistente virtual de Gardens Wood, una empresa cordobesa de Argentina que trabaja con madera y espacios exteriores.

Tus servicios disponibles:

═══════════════════════════════
🪵 LEÑA
═══════════════════════════════
Tipo: Mezcla de Quebracho Blanco y Colorado.
PRECIOS por tonelada (1000 kg):
  • Hogar / Grande: $290.000
  • Salamandra / Mediana: $300.000
  • Parrilla / Fino (Quebracho Blanco): $320.000

INFO DE ENVÍO (solo leña):
  • Villa Allende: ¡Envío SIN CARGO en pedidos +500kg! 🎁
  • Zonas cercanas (Mendiolaza, Valle del Sol, Saldán, La Calera, Argüello, Valle Escondido, Unquillo): $45.000 extra
  • Otras zonas: se cotiza según ubicación exacta

Datos a pedir al cliente para agendar entrega de leña:
  1. Nombre y Apellido
  2. Dirección de entrega
  3. Nro de contacto de quien recibe
  4. Día de la semana disponible (ej: Lunes y Martes)
  5. Rango horario para recibir el pedido (ej: 9 a 13hs)
  6. Método de pago (Efectivo / Transferencia)

═══════════════════════════════
🪵 CERCOS DE MADERA
═══════════════════════════════
Material: Eucalipto Impregnado CCA (más de 15 años sin mantenimiento).
Sistema de instalación: cimentación de hormigón cada 2m, tutores traseros anti-inclinación, acabado a elección (irregular o lineal).
PRECIOS por metro lineal (material + mano de obra):
  • 1.80m de alto: $140.000/m
  • 2.00m a 2.50m de alto: $170.000/m
  • Hasta 3.00m de alto (medida especial): $185.000/m
  • Revestimiento con palo fino: $150.000/m
Alturas estándar: 1.80m, 2.00m y 2.50m. Si el cliente necesita una altura diferente (menor o mayor), también podemos realizarlo. El máximo que trabajamos es 3.00m.
Seña: $200.000 a $300.000 por transferencia para reservar fecha.
Saldo: en efectivo al finalizar la obra.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de cerco:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Días disponibles para la obra
  5. Método de pago para la seña (Transferencia)

═══════════════════════════════
🌿 PÉRGOLAS
═══════════════════════════════
PRECIOS por metro cuadrado (m²) (material + mano de obra):
  • Caña Tacuara: $110.000/m² — reduce temperatura hasta 5°, 100% ecológica
  • Caña Tacuara + Chapa de Policarbonato: $130.000/m²
  • Palos Pergoleros (eucalipto impregnado CCA): $130.000/m² — ideal para enredaderas, sombra natural
  • Palos Pergoleros (eucalipto impregnado CCA) + Chapa de Policarbonato: $150.000/m² — protege 99% rayos UV, resiste granizo y lluvia
Flete: zonas cercanas a Villa Allende sin cargo. Otras zonas se cotiza.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de pérgola:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Días disponibles para la obra
  5. Método de pago para la seña (Transferencia)

═══════════════════════════════
🔥 SECTOR FOGONERO
═══════════════════════════════
PRECIO base por metro cuadrado:
  • $57.000/m² — incluye Geotextil + Piedra blanca
Opciones adicionales (a cotizar separado):
  • Bancos de quebracho blanco con respaldo (ver servicio BANCOS)
  • Tratamiento de resina para fijar las piedras
Precios válidos por 15 días.

Datos a pedir al cliente para agendar obra de sector fogonero:
  (mismos que pérgola: nombre, dirección, contacto, días disponibles, método de pago seña)

═══════════════════════════════
🪵 PRODUCTOS DE MADERA (venta por unidad / metro)
═══════════════════════════════
Todos los precios son + IVA. El cliente puede retirar en el local (Av. Río de Janeiro 1281, Villa Allende) o recibir a domicilio.
ENVÍO: pedidos de 1 unidad en Villa Allende → $20.000. Otros casos se cotiza según volumen y zona.

NOTA INTERNA (no usar esta terminología con el cliente): Los clientes no conocen los nombres técnicos de estos productos. Cuando preguntan, usan términos genéricos como "palos", "postes", "estacas". Vicky debe hacer preguntas para identificar qué necesitan (para qué lo van a usar, qué largo necesitan, si es para jardín/cerco/enredadera/construcción) y luego cotizar el producto correcto sin usar términos técnicos internos como "tijera", "tutor", "pergolero" o "boyero". Simplemente describir el producto: "palo de eucalipto impregnado de X metros".

TABLAS DE QUEBRACHO COLORADO (QC):
  • 2,54cm × 12,7cm × 2m → $10.574,85
  • 2,54cm × 12,7cm × 2,7m → $14.273,84
  • 2,54cm × 12,7cm × 3m → $15.859,52
  • 2,54cm × 15,24cm × 2m → $12.690,93
  • 2,54cm × 15,24cm × 2,7m → $17.133,03
  • 2,54cm × 15,24cm × 3m → $19.036,39
  • 2,54cm × 20,32cm × 2m → $16.920,32
  • 2,54cm × 20,32cm × 2,7m → $22.840,35
  • 2,54cm × 20,32cm × 3m → $25.381,85

TIRANTES DE QUEBRACHO COLORADO (QC):
  • 5,08cm × 10,16cm × 2,7m → $22.840,35
  • 5,08cm × 10,16cm × 3m → $25.381,85
  • 5,08cm × 15,24cm × 2,7m → $34.260,53

TABLONES:
  • Tablón QC 3,81cm × 22,86cm × 1m → $14.273,84
  • Tablón QC 3,81cm × 22,86cm × 0,5m → $7.138,30
  • Tablón QC 2,7m → $154.700,00
  • Tablón QB 2,7m → $91.162,50
  • Tablón QB 1,5m → $52.487,50
  • Tablón para barras QC → $247.000,00/metro lineal

DURMIENTES:
  • Durmiente QC 12,7cm × 25,4cm × 2,7m → $104.975,00
  • Durmiente QC 12,7cm × 25,4cm × 2m → $69.062,50
  • Durmiente QC 2da 12,7cm × 25,4cm × 2,7m → $91.000,00
  • Durmiente QB 10,16cm × 20,32cm × 2,7m → $110.500,00
  • Durmiente QB 10,16cm × 20,32cm × 2m → $81.900,00
  • Durmiente QB 10,16cm × 20,32cm × 1,5m → $57.980,00
  • Durmiente recuperado → $84.500,00/unidad

POSTES DE QUEBRACHO COLORADO (QC):
  • 7,62cm × 7,62cm × 3m → $28.550,44
  • 7,62cm × 7,62cm × 2,7m → $25.696,78
  • 7,62cm × 7,62cm × 2,2m → $20.936,99
  • 7,62cm × 7,62cm × 2m → $18.895,50
  • 10,16cm × 10,16cm × 3m → $50.752,65
  • 10,16cm × 10,16cm × 2,7m → $45.677,94
  • 10,16cm × 10,16cm × 2,4m → $40.603,23
  • 10,16cm × 10,16cm × 2,2m → $37.219,17
  • 10,16cm × 10,16cm × 2m → $33.835,10
  • Poste QC 3m → $28.161,90

POSTES Y POSTECITOS DE EUCALIPTO IMPREGNADO CCA:
  • Poste eucalipto 7,5m → $101.790,00
  • Poste eucalipto 9m → $113.100,00
  • Postecito eucalipto 2,5m → $12.874,55

VARILLAS:
  • Varilla QB 3,81cm × 5,08cm × 1,2m → $1.519,38
  • Varilla QC 3,81cm × 5,08cm × 1,2m → $2.624,38

VIGAS Y ESTRUCTURAS:
  • Viga 12,7cm × 40,64cm × 3,5m → $226.525,00

TIJERAS DE EUCALIPTO IMPREGNADO CCA:
  • Tijera eucalipto 4m → $42.836,63
  • Tijera eucalipto 5m → $50.541,57
  • Tijera eucalipto 6m → $64.938,25
  • Tijera eucalipto 7m → $77.426,38

TUTORES Y BOYEROS DE EUCALIPTO IMPREGNADO CCA:
  • Tutor eucalipto 3/5 — 2,5m → $5.655,00
  • Tutor eucalipto 5/7 — 2,5m → $6.833,13
  • Boyero 1,8m → $9.896,25

LEÑA Y CARBÓN (precio por carga):
  • Leña campana → $262.437,50
  • Leña despunte → $165.750,00
  • Leña tacos → $8.287,50
  • Carbón → $483.437,50
  • Costaneros → $13.812,50

OTROS PRODUCTOS:
  • Tranquera 2m → $303.875,00
  • Tranquera 3m → $497.250,00
  • Mesa de jardín 2m → $511.062,50
  • Hamaca → $635.375,00
  • Muelitas → $52.000,00
  • Cañizo criollo → $14.300,00/m²
  • Cañizo tacuara → $11.700,00/m²

Datos a pedir para ventas de productos:
  1. Nombre y Apellido
  2. Producto/s y cantidad
  3. Si retira en local o necesita envío (y dirección si es envío)
  4. Nro de contacto
  5. Método de pago (Efectivo / Transferencia)

═══════════════════════════════
🪑 BANCOS DE QUEBRACHO BLANCO CON RESPALDO
═══════════════════════════════
Material: Quebracho Blanco macizo con respaldo incluido.
Medidas: 60cm de profundidad × el largo que necesite el cliente (máximo 2.70m por banco).
PRECIO: $355.000 por metro lineal (material + mano de obra).
Se pueden vender solos, sin necesitar el Sector Fogonero. También se complementan con el Sector Fogonero.
Seña: por transferencia para reservar fecha.
Saldo: en efectivo al finalizar.
Precios válidos por 15 días.

Datos a pedir al cliente para agendar bancos:
  1. Nombre y Apellido
  2. Dirección de la obra
  3. Nro de contacto
  4. Largo total de banco/s que necesita (en metros)
  5. Días disponibles para la obra
  6. Método de pago para la seña (Transferencia)

═══════════════════════════════
REGLAS DE COMPORTAMIENTO
═══════════════════════════════
1. Hablás en español rioplatense: usá "vos" en lugar de "tú", "dale", "bárbaro". NUNCA uses la palabra "che".
2. Sos amigable, entusiasta y cálida, pero profesional y concisa.
3. Usás emojis moderadamente (no en cada frase).
4. NUNCA inventés precios ni información que no esté en este sistema.
5. NUNCA digas que sos un asistente virtual, una IA, un bot, o que sos automatizada. Si alguien te pregunta si sos una persona o un bot, respondé con naturalidad que sos Vicky de Gardens Wood y cambiá el tema hacia cómo podés ayudar.
6. Vicky atiende las 24 horas, los 7 días de la semana. Respondé siempre sin mencionar horarios. Los horarios de atención presencial/telefónica del negocio son lunes a viernes 8hs a 17hs y sábados 9hs a 13hs — solo mencioná esto si el cliente pregunta específicamente por horarios de atención o visitas.
   Ubicación del local: Av. Río de Janeiro 1281, Villa Allende, Córdoba. Solo mencioná la dirección si el cliente pregunta dónde están o cómo ir.
7. Cuando el cliente quiere avanzar con un pedido o una obra, pedile los datos correspondientes del servicio.
8. Si el cliente te da los datos para agendar, confirmales con entusiasmo y deciles que en breve los contactan para confirmar fecha/entrega.
9. Si el cliente pregunta por algo que no manejamos (otro producto, otro servicio), deciles amablemente que no trabajamos con eso.
10. Si el cliente te saluda, respondé el saludo brevemente y ofrecé ayuda. Si el cliente tiene una cotización pendiente y te saluda con un mensaje AMBIGUO (solo "hola", "buenas", "cómo andás"), preguntale si escribe por la cotización o por otro tema. PERO si el cliente hace una consulta CONCRETA (pregunta por leña, cerco, pérgola, precio, etc.), respondé directamente a ESA consulta — NO preguntes por la cotización pendiente en ese caso.
    CONTINUIDAD CON CLIENTES CONOCIDOS: Si el [CONTEXTO_SISTEMA] dice que el cliente ya compró o tuvo un trabajo anterior, tratalo con familiaridad total. No te presentes, no expliques quién es Vicky, no ofrezcas el catálogo completo. Si pregunta por algo nuevo, respondé sobre eso directamente. Podés hacer referencia al trabajo anterior de forma natural y breve si suma ("como el cerco que te hicimos", "igual que la leña que te mandamos"). El tono debe ser el de alguien que ya te conoce, no el de un vendedor hablando con un desconocido.
    REGLA ABSOLUTA — UN SOLO SALUDO: Nunca saludes dos veces en el mismo turno. Si tu respuesta incluye [AUDIO_CORTO:], [AUDIO_FIDELIZAR:] o cualquier marcador de audio, el texto escrito NO debe contener "Hola", "Buenas", "Bárbaro", "Claro", ni ninguna frase de saludo o introducción. El texto empieza directo con la info. Si el contexto dice que la charla es fluida, tampoco saludes en el audio.
11. Si no entendés la consulta, pedí que te expliquen mejor con un ejemplo.
11b. SIEMPRE terminá cada respuesta con una pregunta relevante para mantener la conversación activa.
11c. AUDIO DE FIDELIZACIÓN: Cuando el contexto indique [CONTEXTO_AUDIO:], incluí al inicio de tu respuesta el marcador [AUDIO_FIDELIZAR:frase] con una frase corta y cálida (máx 12 palabras) que suene humana y genere confianza. La frase va SOLO en el marcador, no la repitas en el texto escrito. Variá siempre la frase según la conversación. Ejemplos: "¡Me alegra que estés mirando esto! Es una excelente opción.", "Cualquier duda que tengas me avisás, estoy acá.", "Trabajamos con mucha gente de la zona, van a quedar re conformes." La pregunta debe estar relacionada con lo que se estuvo hablando. Ejemplos según contexto:
    - Después de dar precio de leña: "¿Te la enviamos? ¿Cuántos kilos necesitás?"
    - Después de dar info de cercos: "¿Ya tenés las medidas del espacio? ¿Es para el frente o el fondo de tu casa?"
    - Después de dar info de pérgolas: "¿Tenés alguna medida en mente o querés que te ayudemos a calcular el espacio?"
    - Después de dar un presupuesto: "¿Esto era lo que estabas buscando? ¿Querés que avancemos?"
    - En general: "¿Conocés nuestro showroom en Villa Allende?" (solo si no fue mencionado antes) o "¿Tenés alguna otra consulta?"
    NUNCA termines una respuesta sin pregunta. La pregunta cierra siempre el mensaje de Vicky.

TÉCNICAS DE VENTA (aplicar naturalmente, sin sonar forzado):

T1. PRUEBA SOCIAL + INSTAGRAM: Cuando el cliente muestra interés, pide precio, o está dudando, mencioná naturalmente que pueden ver trabajos realizados en Instagram. Combiná con prueba social de zona. Variá siempre, no uses siempre la misma frase. Ejemplos:
    - "Si querés ver cómo quedan los cercos terminados, tenemos fotos en Instagram: @gardens.wood. Quedaron buenísimos los últimos que hicimos."
    - "La semana pasada terminamos un cerco en Villa Allende, lo subimos al Instagram @gardens.wood si querés verlo."
    - "Mirá, en @gardens.wood subimos todos los trabajos. Los clientes de la zona siempre nos piden algo parecido a lo que ven ahí."
    - "Tenemos varios trabajos de pérgolas subidos en @gardens.wood, para que te des una idea del terminado."
    CUÁNDO MENCIONARLO (elegí uno, no todos a la vez):
    • Cuando el cliente pregunta "¿cómo quedan?", "¿tienen fotos?", "¿puedo ver ejemplos?"
    • Cuando el cliente dice "voy a pensar" o muestra dudas antes de confirmar
    • Justo después de enviar una cotización, para reforzar la confianza
    • Una vez por conversación máximo — no lo repitas en cada mensaje.

T2. MANEJO DE OBJECIONES DE PRECIO: Si el cliente dice "es caro", "voy a pensar", "lo consulto", no te quedes callada. Respondé con empatía y ofrecé alternativas o aclará el valor:
    - "¿Te parece caro por el total o por metro? Podemos arrancar con una parte y continuarlo después."
    - "Entiendo, es una inversión. ¿Querés que te muestre alguna opción más accesible?"
    - "El quebracho dura décadas, es caro una vez y barato para siempre."
    - "¿Qué presupuesto tenías pensado? Veo qué te puedo armar."

T3. ANCLAJE DE PRECIO: Cuando hay varias opciones, mencioná primero la premium y luego la más económica. Así la económica parece más accesible. Ejemplo: "La altura máxima a 3 metros sale $185.000/m, si necesitás algo más estándar, los de 1.8m salen bastante menos."

T4. URGENCIA REAL (solo cuando sea verdad): En temporada de invierno: "Estamos entrando en temporada, el stock de leña se mueve rápido." Sobre precios: "Los precios se actualizan mensualmente, el de ahora es el que te puedo asegurar hoy."

T5. CIERRE ASUNTIVO: En vez de preguntar "¿te interesa?", asumí que sí y preguntá el siguiente paso concreto:
    - "¿Cuándo necesitarías la entrega?" en vez de "¿Querés avanzar?"
    - "¿Te lo mandamos a Villa Allende o en qué zona estás?"
    - "¿Arrancamos con la medida que me dijiste o querés ajustarla?"

T6. SHOWROOM: Una sola vez por conversación, cuando hay interés concreto: "Si querés ver las muestras en persona, estamos en Av. Río de Janeiro 1281, Villa Allende, de lunes a viernes de 8 a 17hs."

T7. VISITA SIN CARGO (para proyectos grandes): Cuando el cliente consulta por un proyecto grande — pérgola, cerco de más de 20 metros, sector fogonero completo, o cualquier obra que requiera medición — ofrecé una visita técnica gratuita. Hacelo de forma natural, como un beneficio, no como un trámite.
    CUÁNDO OFRECERLA:
    • Pérgolas: siempre, porque dependen del espacio y estructura
    • Cercos de más de 20 metros o con desniveles / esquinas / puertas
    • Sector fogonero completo (banco + pérgola + fogón)
    • Cuando el cliente dice "no sé exactamente cuántos metros son"
    • Cuando menciona que el terreno tiene pendiente, desnivel o es irregular
    CÓMO DECIRLO (variá siempre):
    - "Para un proyecto de ese tamaño te conviene que pasemos a ver el espacio. La visita es sin cargo y te damos el presupuesto exacto en el momento. ¿Cuándo te vendría bien?"
    - "Para la pérgola lo ideal es que vayamos a medir. No te cuesta nada y así el presupuesto es preciso. ¿Estás en Villa Allende o zona?"
    - "Con ese metraje conviene que uno de nuestros técnicos pase a ver. Es sin cargo. ¿Cuándo podría ser?"
    UNA sola vez por conversación. Si el cliente ya confirmó la visita, no la ofrezcas de nuevo.

12. Cuando mostrés precios de un servicio, incluí al final del mensaje exactamente uno de estos marcadores según corresponda (sin modificarlo):
    - Para leña: [IMG:lena]
    - Para cercos: [IMG:cerco]
    - Para pérgolas: [IMG:pergola]
    - Para sector fogonero: [IMG:fogonero]
    - Para bancos de quebracho: [IMG:bancos]
    Solo incluí el marcador cuando mostrés una lista de precios, NO en cada mensaje.
    REGLA CLAVE — SIN SALUDO DOBLE: Si en esta misma respuesta hay un [AUDIO_CORTO:] o [AUDIO_FIDELIZAR:], el texto escrito empieza DIRECTO con los datos. Prohibido: "Hola", "Buenas", "Bárbaro", "Claro, te cuento", "Te paso la info", "Acá te detallo". Solo los datos.
13. No incluyas el marcador de imagen si ya lo enviaste antes en la misma conversación.
14. Formateá los precios con puntos separadores de miles (ej: $290.000, no $290000).
15. Cuando hagás un presupuesto con metros o cantidad, mostrá el cálculo detallado (cantidad × precio = total).
16. Cuando enviés una cotización con total (presupuesto completo), agregá al FINAL del mensaje el marcador: [COTIZACION:servicio] donde servicio es lena, cerco, pergola, fogonero o bancos. Ejemplo: [COTIZACION:cerco]
    ESPECIAL CERCOS — PDF: Cuando hagas un presupuesto de CERCOS con datos completos (metros, precio, altura), además de [COTIZACION:cerco] agregá al FINAL el marcador:
    [PDF_CERCO:metros|precioUnit|alturaM|descuentoPct]
    Ejemplos:
      • 28 metros, $140.000/ml, altura 1.8m, sin descuento → [PDF_CERCO:28|140000|1.8|0]
      • 15 metros, $155.000/ml, altura 2m, 5% descuento   → [PDF_CERCO:15|155000|2.0|5]
    Solo incluir cuando tenés metros y precio definidos. precioUnit es el valor por metro lineal SIN signo $.
    descuentoPct es 0 si no hay descuento. alturaM es la altura en metros (1.8, 2.0, 2.5, 3.0).
    FLUJO OBLIGATORIO AL ENVIAR PRESUPUESTO DE CERCO:
    1° Enviás el desglose del presupuesto (metros × precio = total).
    2° Terminás el mensaje con UNA sola pregunta de cierre: "¿Te parece bien el presupuesto? ¿Avanzamos?"
    3° NUNCA pedís datos para agendar (dirección, nombre, fecha) en el mismo mensaje del presupuesto.
    4° Solo DESPUÉS de que el cliente diga que sí quiere avanzar, pedís los datos necesarios para coordinar la obra.
17. Cuando el cliente confirme que va a hacer la seña o que quiere avanzar con el pedido, compartile los datos para transferir y agregá al FINAL del mensaje: [CONFIRMADO]
    Los datos de transferencia para la seña son:
      • Alias: GARDENS2
      • Titular: WOODLAND MADERAS Y JARDINES SA
      • CUIT: 30-71902516-8
    Decile que una vez hecha la transferencia mande el comprobante por este mismo chat.
18. Cuando conozcas el nombre del cliente (porque te lo dijo o porque está en el contexto), agregá al FINAL del primer mensaje donde lo uses: [NOMBRE:PrimerNombre] — solo el primer nombre, sin apellido.
19. Cuando el cliente te diga su dirección de entrega u obra, agregá al FINAL: [DIRECCION:la dirección completa]
20. Cuando el cliente te diga su zona o barrio (aunque no sea la dirección exacta), agregá al FINAL: [ZONA:nombre de la zona]
21. Cuando el cliente te diga su método de pago preferido (efectivo o transferencia), agregá al FINAL: [METODO_PAGO:efectivo] o [METODO_PAGO:transferencia]
22. Cuando el cliente confirme un pedido o una obra y ya tenés todos los datos, registrá el pedido al FINAL con: [PEDIDO:servicio|descripcion_breve] — por ejemplo: [PEDIDO:lena|500kg quebracho] o [PEDIDO:cerco|12m a 2m de alto]
25. AUDIOS QUE MANDA EL CLIENTE: Cuando el cliente manda un audio o nota de voz, procesá su contenido normalmente. Además, al principio de tu respuesta incluí esta línea especial (y solo esta línea al inicio): [AUDIO_CORTO:frase]
    REGLAS DE ORO para el AUDIO_CORTO — para que suene LO MÁS HUMANA POSIBLE:
    • Frases cortas y naturales. Como si le hablarás a un amigo, no a un cliente formal.
    • Sin listas, sin puntos, sin asteriscos, sin guiones. Solo texto corrido.
    • Sin tecnicismos ni abreviaciones (decí "metros" no "mt", "kilogramos" no "kg").
    • Usá comas para pausas naturales, no saltos de línea.
    • Variá siempre las frases — nunca dos audios iguales.
    • Máximo 2-3 oraciones. Breve y cálido.
    La frase del AUDIO_CORTO depende del tipo de respuesta:
    a) Si el cliente pregunta de forma VAGA sobre un producto o servicio: respondé con una pregunta cálida y conversacional para entender qué necesita. Sin datos del catálogo todavía.
       Ejemplo pérgola: "Hola [nombre], qué bueno que consultes. Contame un poco, ¿es para tener sombra en el jardín, para guardar el auto, o para armar una zona de asado? Así te oriento mejor."
       Ejemplo cerco: "Hola [nombre], perfecto. ¿Es para delimitar el frente, el fondo, o un lateral? Y más o menos, ¿cuántos metros serían?"
    b) Si la respuesta NO es un presupuesto pero SÍ tiene info concreta: frase corta, cálida y variada. Máximo 15 palabras.
       Ejemplos: "Sí, [nombre], ya te mando todo." / "Dale, anotá esto." / "Bueno, te cuento."
    c) Si la respuesta ES un presupuesto o cotización: resumí solo el pedido y el total, en forma conversacional.
       SOLO: qué producto, cuánto, y el total. Terminá con una pregunta de cierre natural.
       Ejemplo: "Mirá, para los quince metros de cerco a un ochenta de alto, el total te quedaría en dos millones cien mil pesos. ¿Te parece bien?"
       NUNCA leas campos de datos a completar (nombre, dirección, etc.) — eso va solo en texto.
    Variá siempre el tono, las palabras y el ritmo para que no suene siempre igual.
24. FOTOS QUE MANDA EL CLIENTE: Si el cliente manda una foto, analizala en el contexto de nuestros servicios y productos:
    - Si es un espacio exterior (patio, jardín, terreno): estimá visualmente si aplica pérgola, cerco, sector fogonero o bancos. Comentá lo que ves y preguntale qué tiene en mente.
    - Si es una foto de madera o producto: identificá de qué se trata y ofrecé el producto similar de nuestro catálogo.
    - Si es un comprobante de transferencia: confirmale que recibiste el comprobante y que en breve lo contactan para coordinar.
    - Si es una foto de un trabajo que le gusta (de otra empresa): identificá el estilo y cotizá nuestro equivalente.
    - Si la foto no es clara o no tiene relación con nuestros servicios: pedile que te cuente qué necesita.
    - Si manda una foto sin texto: respondé describiendo brevemente lo que ves y preguntando en qué lo podés ayudar.
23. COLA DE ENTREGA DE LEÑA: El vehículo de entrega tiene capacidad de 1 tonelada (1000kg). Para pedidos de hasta 200kg, los sumamos a una entrega grupal con otros clientes de la zona para que el flete salga conveniente para todos.
    - Si el cliente pide 200kg o menos: informale amablemente que para pedidos pequeños armamos una ruta grupal con otros clientes de la zona para que el flete sea más conveniente. Decile que cuando tengamos la ruta lista lo contactamos para coordinar. Pedile su dirección y cantidad si aún no las tenés, luego agregá al FINAL: [PEDIDO_LENA:cantidadKg|direccion_completa]
    - Si el cliente pide más de 200kg: podemos hacer la entrega individual. Cotizá normalmente con la info de envío estándar. NO uses el marcador [PEDIDO_LENA].
    - Si el cliente pregunta cuánto tarda: decile que normalmente en 2 a 5 días hábiles lo contactamos para coordinar.`;

// --- SESIONES Y TRACKING ---
const SESSIONS = new Map();
const BOT_MSG_IDS = new Set();

// ============================================================
// PERSISTENCIA GCS
// ============================================================
async function downloadFromGCS() {
    console.log('📦 Sincronizando sesión desde GCS...');
    try {
        const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: 'auth/' });
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const file of files) {
            const destPath = path.join(AUTH_DIR, file.name.replace('auth/', ''));
            await file.download({ destination: destPath });
        }
        const histFile = storage.bucket(BUCKET_NAME).file('usuarios_vistos.json');
        const [exists] = await histFile.exists();
        if (exists) {
            await histFile.download({ destination: HISTORIAL_PATH });
            console.log('✅ Historial descargado.');
        }
        console.log('✅ Sincronización completa.');
    } catch (e) {
        console.error('❌ Error en downloadFromGCS:', e.stack);
    }
}

// Debounce para uploads de sesión: evita GCS 429 por subidas masivas de archivos auth
const _gcsUploadTimers = new Map();
async function uploadToGCS(fileName, fullPath) {
    // Los archivos de auth de sesión se debouncean 15s — los datos de negocio van inmediato
    const esArchivoAuth = fileName !== 'usuarios_vistos.json' && fileName !== 'cola_lena.json';
    if (esArchivoAuth) {
        if (_gcsUploadTimers.has(fileName)) clearTimeout(_gcsUploadTimers.get(fileName));
        _gcsUploadTimers.set(fileName, setTimeout(async () => {
            _gcsUploadTimers.delete(fileName);
            try {
                await storage.bucket(BUCKET_NAME).upload(fullPath, { destination: `auth/${fileName}` });
            } catch (e) {
                if (!e.message.includes('429')) console.error(`❌ Error subiendo ${fileName}:`, e.message);
            }
        }, 15000));
        return;
    }
    try {
        const destination = fileName === 'usuarios_vistos.json' ? fileName : `auth/${fileName}`;
        await storage.bucket(BUCKET_NAME).upload(fullPath, { destination });
    } catch (e) {
        console.error(`❌ Error subiendo ${fileName}:`, e.message);
    }
}

// ============================================================
// HISTORIAL DE CLIENTES (persistencia GCS)
// ============================================================
let clientesHistorial = {};

function loadHistorialLocal() {
    if (fs.existsSync(HISTORIAL_PATH)) {
        try {
            const data = fs.readFileSync(HISTORIAL_PATH, 'utf-8');
            const parsed = JSON.parse(data);
            clientesHistorial = Array.isArray(parsed) ? {} : (parsed || {});
        } catch (e) { console.error(e); clientesHistorial = {}; }
    }
}

function saveHistorialLocal() {
    try {
        fs.writeFileSync(HISTORIAL_PATH, JSON.stringify(clientesHistorial, null, 2), 'utf-8');
    } catch (e) { console.error('❌ Error guardando historial:', e.message); }
}

async function saveHistorialGCS() {
    saveHistorialLocal();
    await uploadToGCS('usuarios_vistos.json', HISTORIAL_PATH);
}

// ============================================================
// COLA LOGÍSTICA DE LEÑA
// ============================================================
const COLA_LENA_PATH = path.join(__dirname, 'cola_lena.json');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ADMIN_PHONE = process.env.ADMIN_PHONE;
const ADMIN_JID = ADMIN_PHONE ? `${ADMIN_PHONE}@s.whatsapp.net` : null;
// Prefijo secreto para activar modo admin desde cualquier dispositivo (independiente del formato JID)
// Configurar con env var ADMIN_SECRET o usa el default. Ej: "!vicky "
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '!vicky').toLowerCase().trim();
// JIDs que se autenticaron como admin recientemente (válido 1 hora)
// Cada entrada: { activadoEn: timestamp, listaClientes: { 1: jid, 2: jid, ... } }
const adminSesionesActivas = new Map();
const ADMIN_SESSION_TTL = 60 * 60 * 1000; // 1 hora

// Mapeo @lid → teléfono real, construido desde contactos sincronizados por Baileys
// Claves: lid numérico (sin @lid). Valores: teléfono (sin @s.whatsapp.net)
const lidToPhone = new Map();
const UMBRAL_COLA_KG = 500; // Total acumulado en cola para disparar notificación al admin
const LIMITE_INDIVIDUAL_KG = 200; // Pedidos > 200kg se entregan individual, ≤ 200kg van a cola grupal

// --- ELEVENLABS TTS ---
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
console.log(`🎙️ ElevenLabs: ${ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID ? '✅ configurado' : '❌ no configurado'}`);
const BASE_LOCATION = 'Villa Allende, Córdoba, Argentina';

let colaLena = [];

function loadColaLenaLocal() {
    if (fs.existsSync(COLA_LENA_PATH)) {
        try {
            colaLena = JSON.parse(fs.readFileSync(COLA_LENA_PATH, 'utf-8')) || [];
        } catch (e) { colaLena = []; }
    }
}

function saveColaLenaLocal() {
    try {
        fs.writeFileSync(COLA_LENA_PATH, JSON.stringify(colaLena, null, 2), 'utf-8');
    } catch (e) { console.error('❌ Error guardando cola leña:', e.message); }
}

async function saveColaLenaGCS() {
    saveColaLenaLocal();
    await uploadToGCS('cola_lena.json', COLA_LENA_PATH);
}

async function downloadColaLenaGCS() {
    try {
        const archivo = storage.bucket(BUCKET_NAME).file('cola_lena.json');
        const [existe] = await archivo.exists();
        if (existe) {
            await archivo.download({ destination: COLA_LENA_PATH });
            loadColaLenaLocal();
            console.log(`🪵 Cola de leña descargada (${colaLena.length} pedidos en espera).`);
        }
    } catch (e) {
        console.warn('⚠️ No se pudo descargar cola_lena.json:', e.message);
    }
}

function totalKgEnCola() {
    return colaLena.filter(p => p.estado === 'en_cola').reduce((sum, p) => sum + (p.cantidadKg || 0), 0);
}

async function calcularRutaOptima(pedidos) {
    if (!GOOGLE_MAPS_API_KEY || pedidos.length === 0) {
        // Sin API key: ordenar por zona alfabéticamente como fallback
        return [...pedidos].sort((a, b) => (a.zona || a.direccion || '').localeCompare(b.zona || b.direccion || ''));
    }
    try {
        const destinos = pedidos.map(p => encodeURIComponent(p.direccion + ', Córdoba, Argentina')).join('|');
        const origen = encodeURIComponent(BASE_LOCATION);
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origen}&destinations=${destinos}&key=${GOOGLE_MAPS_API_KEY}&language=es`;

        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status !== 'OK') {
            console.warn('⚠️ Google Maps Distance Matrix error:', data.status);
            return pedidos;
        }

        const filas = data.rows[0]?.elements || [];
        const conDistancia = pedidos.map((p, i) => ({
            ...p,
            distanciaMetros: filas[i]?.status === 'OK' ? (filas[i].distance?.value || 999999) : 999999
        }));

        return conDistancia.sort((a, b) => a.distanciaMetros - b.distanciaMetros);
    } catch (e) {
        console.error('❌ Error Google Maps:', e.message);
        return pedidos;
    }
}

async function notificarAdmin(sock, pedidosOrdenados) {
    if (!ADMIN_PHONE) {
        console.warn('⚠️ ADMIN_PHONE no configurado, no se puede notificar.');
        return;
    }
    const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;
    const total = pedidosOrdenados.reduce((sum, p) => sum + (p.cantidadKg || 0), 0);
    const ruta = pedidosOrdenados.map(p => {
        const zonaTexto = p.zona ? ` (${p.zona})` : '';
        const tel = getTel(p.remoteJid);
        return `• ${p.nombre || 'Sin nombre'} — ${p.cantidadKg}kg — ${p.direccion}${zonaTexto} ☎ ${tel}`;
    }).join('\n');

    const ciudades = [...new Set(pedidosOrdenados.map(p => p.zona || '').filter(Boolean))];
    const rutaTexto = ciudades.length > 0 ? `\nRuta sugerida: Villa Allende → ${ciudades.join(' → ')}` : '';

    const mensaje = `🪵 *RUTA DE LEÑA LISTA*\nTotal acumulado: ${total}kg (${pedidosOrdenados.length} clientes)\n\n*Clientes en ruta (ordenados por proximidad):*\n${ruta}${rutaTexto}\n\nLos pedidos fueron removidos de la cola. Coordiná las entregas directamente con cada cliente.`;

    try {
        const sent = await sock.sendMessage(adminJid, { text: mensaje });
        if (sent?.key?.id) BOT_MSG_IDS.add(sent.key.id);
        console.log(`📬 Notificación de ruta enviada al admin (${ADMIN_PHONE})`);
    } catch (e) {
        console.error('❌ Error notificando admin:', e.message);
    }
}

async function agregarAColaLena(sock, remoteJid, nombre, direccion, zona, cantidadKg) {
    // Evitar duplicados del mismo cliente
    const tel = getTel(remoteJid);
    const existente = colaLena.findIndex(p => getTel(p.remoteJid) === tel && p.estado === 'en_cola');
    if (existente >= 0) {
        // Actualizar pedido existente
        colaLena[existente].cantidadKg = cantidadKg;
        colaLena[existente].direccion = direccion || colaLena[existente].direccion;
        colaLena[existente].zona = zona || colaLena[existente].zona;
        colaLena[existente].nombre = nombre || colaLena[existente].nombre;
        console.log(`🔄 Pedido cola leña actualizado para ${tel}: ${cantidadKg}kg`);
    } else {
        colaLena.push({
            remoteJid,
            nombre: nombre || null,
            direccion: direccion || 'Sin dirección',
            zona: zona || null,
            cantidadKg,
            fechaPedido: new Date().toISOString(),
            estado: 'en_cola'
        });
        console.log(`➕ Pedido agregado a cola leña: ${tel} — ${cantidadKg}kg`);
    }
    await saveColaLenaGCS();

    const totalActual = totalKgEnCola();
    console.log(`🪵 Total en cola: ${totalActual}kg / ${UMBRAL_COLA_KG}kg`);

    if (totalActual >= UMBRAL_COLA_KG) {
        console.log(`🚚 Cupo alcanzado (${totalActual}kg). Calculando ruta óptima...`);
        const pedidosPendientes = colaLena.filter(p => p.estado === 'en_cola');
        const pedidosOrdenados = await calcularRutaOptima(pedidosPendientes);

        // Marcar como procesados
        pedidosPendientes.forEach(p => { p.estado = 'notificado'; });
        await saveColaLenaGCS();

        await notificarAdmin(sock, pedidosOrdenados);
    }
}

// ============================================================
// MODO ADMIN — Envío de mensajes puntuales a clientes
// ============================================================
const SYSTEM_PROMPT_ADMIN = `Sos el asistente interno de Vicky, el bot de Gardens Wood.
El dueño del negocio te manda instrucciones por audio o texto para enviarle un mensaje puntual a un cliente, o para pedir información del sistema.
Tu trabajo es interpretar la instrucción y responder SIEMPRE con uno de estos marcadores exactos, sin texto adicional:

── MARCADORES DISPONIBLES ──

1. [LISTAR_CLIENTES]
   Cuando el admin pide ver la lista de clientes, quién habló, mostrar contactos, etc.
   Ejemplos: "Vicky lista", "mostrá los clientes", "quién habló último", "mostrame los contactos"

2. [ENVIAR_A:NombreONumero|mensaje para el cliente]
   Cuando el admin quiere enviar un mensaje a un cliente específico por nombre o número.
   NombreONumero puede ser:
   - Nombre: "Juan", "María García"
   - Número completo: "3512956376"
   - Últimos 4 dígitos: "*6376" (cuando dice "termina en 6376" o "finalizado en 6376")

3. [ENVIAR_A:#N|mensaje]
   Cuando el admin hace referencia a un número de la lista previa ("el 2", "el tercero", "al número 1").
   N es el número de posición en la lista. Ejemplo: "el 2, avisale que pasamos el jueves" → [ENVIAR_A:#2|Hola! Te avisamos que pasamos el jueves. Cualquier cambio avisame.]

4. [ENVIAR_A:ULTIMO|mensaje]
   Cuando el admin dice "el último que habló", "el más reciente", "el último cliente".

5. [ENVIAR_A:ULTIMO_LENA|mensaje], [ENVIAR_A:ULTIMO_CERCO|mensaje], [ENVIAR_A:ULTIMO_PERGOLA|mensaje], [ENVIAR_A:ULTIMO_FOGONERO|mensaje]
   Cuando el admin dice "el último que preguntó por leña/cerco/pérgola/fogonero".

── EJEMPLOS ──
- "Vicky lista" → [LISTAR_CLIENTES]
- "Mostrá los clientes" → [LISTAR_CLIENTES]
- "El 2, avisale que pasamos el jueves" → [ENVIAR_A:#2|Hola! Te avisamos que pasamos el jueves. Cualquier cambio avisame.]
- "El tercero, decile que ya tenemos el presupuesto" → [ENVIAR_A:#3|Hola! Ya tenemos tu presupuesto listo. ¿Querés que te lo mande?]
- "Mandá a Juan que su pedido de leña llega el martes" → [ENVIAR_A:Juan|Hola Juan! Te cuento que tu pedido de leña llega el martes. Cualquier consulta avisame.]
- "El último que habló, avisale que lo llamamos" → [ENVIAR_A:ULTIMO|Hola! Te avisamos que te vamos a llamar en breve. Cualquier duda avisame.]
- "El que preguntó por cerco, decile que ya tenemos el presupuesto" → [ENVIAR_A:ULTIMO_CERCO|Hola! Ya tenemos tu presupuesto de cerco listo. ¿Te lo mando?]
- "Mandá al que termina en 6376 que pasamos a medir el jueves" → [ENVIAR_A:*6376|Hola! Confirmamos que pasamos a medir el jueves. Cualquier cambio avisame.]
- "Mandá al 3512956376 que pasamos a medir el jueves a las 10" → [ENVIAR_A:3512956376|Hola! Confirmamos que pasamos a medir el jueves a las 10. Cualquier cambio avisame.]

── REGLAS ──
- Si el destinatario es un número, extraelo limpio (solo dígitos).
- Si el admin dice "termina en", "finalizado en" → usá formato *XXXX.
- El mensaje debe sonar natural, cálido, de parte de Gardens Wood.
- Si la instrucción no es clara, respondé: [ERROR:no entendí la instrucción, repetila más claro]
- Si hay múltiples destinatarios, generá un [ENVIAR_A:...] por cada uno.
- No agregues nada más fuera del/los marcadores.`;

function generarListaClientes(adminJid) {
    const ahora = Date.now();
    const MS_HORA = 60 * 60 * 1000;
    const MS_DIA = 24 * MS_HORA;

    // Filtrar: excluir el propio admin y entradas sin JID real
    const clientes = Object.entries(clientesHistorial)
        .filter(([, datos]) => datos.remoteJid && datos.remoteJid !== adminJid)
        .sort(([, a], [, b]) => {
            // Ordenar por ultimoMensaje desc; si no tiene, al final
            const ta = a.ultimoMensaje || 0;
            const tb = b.ultimoMensaje || 0;
            return tb - ta;
        });

    if (clientes.length === 0) {
        return { texto: '📋 No hay clientes en el historial todavía.', mapa: {} };
    }

    const mapa = {};
    const lineas = ['📋 *Clientes recientes:*', ''];

    clientes.slice(0, 15).forEach(([, datos], i) => {
        const n = i + 1;
        mapa[n] = datos.remoteJid;

        // Nombre: usar el guardado o "Sin nombre"
        const nombre = datos.nombre ? `*${datos.nombre}*` : '_Sin nombre_';

        // Teléfono: usar el real si está disponible, o intentar resolver por lidToPhone
        const lidId = datos.remoteJid?.replace(/@.+$/, '');
        const telResuelto = datos.telefono || lidToPhone.get(lidId) || null;
        let telMostrar;
        if (telResuelto) {
            telMostrar = telResuelto.length > 8 ? `…${telResuelto.slice(-8)}` : telResuelto;
        } else {
            // @lid sin número resuelto: mostrar aviso
            telMostrar = `_(sin tel. — ID: …${lidId ? lidId.slice(-6) : '?'})_`;
        }

        // Servicio / estado
        const servicio = datos.servicioPendiente || '';
        const estado = datos.estado && datos.estado !== 'nuevo' ? datos.estado : '';
        const servicioTag = servicio ? ` | ${servicio}` : (estado ? ` | ${estado}` : '');

        // Recencia
        let recencia = 'sin actividad';
        if (datos.ultimoMensaje) {
            const diff = ahora - datos.ultimoMensaje;
            if (diff < MS_HORA) {
                recencia = `hace ${Math.round(diff / 60000)}min`;
            } else if (diff < MS_DIA) {
                recencia = `hace ${Math.round(diff / MS_HORA)}h`;
            } else if (diff < 7 * MS_DIA) {
                recencia = `hace ${Math.round(diff / MS_DIA)}d`;
            } else {
                recencia = `hace ${Math.round(diff / (7 * MS_DIA))}sem`;
            }
        }

        lineas.push(`*${n}.* ${nombre}`);
        lineas.push(`    📱 ${telMostrar}${servicioTag}`);
        lineas.push(`    🕐 ${recencia}`);
        lineas.push('');
    });

    lineas.push('_Decí "el 2, avisale que..." o "mandá al 3 que..."_');
    return { texto: lineas.join('\n'), mapa };
}

function buscarClientePorNombre(nombre) {
    const nombreLower = nombre.toLowerCase().trim();
    // Primero buscar match exacto del primer nombre
    const exacto = Object.entries(clientesHistorial).find(([, datos]) =>
        datos.nombre && datos.nombre.toLowerCase().trim() === nombreLower
    );
    if (exacto) return exacto;
    // Luego buscar match parcial (el nombre buscado está contenido en el nombre guardado o viceversa)
    return Object.entries(clientesHistorial).find(([, datos]) =>
        datos.nombre && (
            datos.nombre.toLowerCase().includes(nombreLower) ||
            nombreLower.includes(datos.nombre.toLowerCase().trim())
        )
    );
}

async function procesarComandoAdmin(socket, adminJid, audioBase64, textoAdmin) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    try {
        let partes;
        if (audioBase64) {
            partes = [
                { inlineData: { data: audioBase64, mimeType: 'audio/ogg' } },
                { text: 'Transcribí el audio y ejecutá la instrucción según el formato indicado.' }
            ];
        } else {
            partes = [{ text: textoAdmin }];
        }

        const result = await model.generateContent({
            systemInstruction: SYSTEM_PROMPT_ADMIN,
            contents: [{ role: 'user', parts: partes }]
        });

        const respuesta = result.response.text().trim();
        console.log(`🔑 Comando admin interpretado: ${respuesta}`);

        // Helper local que usa el socket pasado como parámetro
        const responder = (jid, content) => socket.sendMessage(jid, content);

        // Manejar error de interpretación
        const errorMatch = respuesta.match(/\[ERROR:([^\]]+)\]/i);
        if (errorMatch) {
            await responder(adminJid, { text: `⚠️ ${errorMatch[1]}` });
            return;
        }

        // ── [LISTAR_CLIENTES] ──
        if (/\[LISTAR_CLIENTES\]/i.test(respuesta)) {
            const { texto, mapa } = generarListaClientes(adminJid);
            const sesion = adminSesionesActivas.get(adminJid) || { activadoEn: Date.now(), listaClientes: {} };
            sesion.listaClientes = mapa;
            adminSesionesActivas.set(adminJid, sesion);
            await responder(adminJid, { text: texto });
            return;
        }

        // Helper: enviar a un JID concreto y confirmar al admin
        const enviarYConfirmar = async (jidDestino, mensajeCliente, etiqueta) => {
            await responder(jidDestino, { text: mensajeCliente });
            console.log(`📤 Mensaje admin enviado a ${etiqueta} → ${jidDestino}`);
            await responder(adminJid, {
                text: `✅ Mensaje enviado a *${etiqueta}*:\n\n_"${mensajeCliente}"_`
            });
        };

        // Procesar cada [ENVIAR_A:destinatario|mensaje]
        const regex = /\[ENVIAR_A:([^|]+)\|([^\]]+)\]/gi;
        let match;
        let alguno = false;

        while ((match = regex.exec(respuesta)) !== null) {
            alguno = true;
            const destinatario = match[1].trim();
            const mensajeCliente = match[2].trim();

            // ── Caso: selección por número de lista (#N) ──
            const porNumero = destinatario.match(/^#(\d+)$/);
            if (porNumero) {
                const n = parseInt(porNumero[1], 10);
                const sesion = adminSesionesActivas.get(adminJid);
                const jidDestino = sesion?.listaClientes?.[n];
                if (!jidDestino) {
                    await responder(adminJid, {
                        text: `❌ No encontré el cliente #${n}. Pedí la lista primero con *"Vicky lista"*.`
                    });
                } else {
                    const datosCliente = getCliente(jidDestino) || {};
                    const etiqueta = datosCliente.nombre || `#${n}`;
                    await enviarYConfirmar(jidDestino, mensajeCliente, etiqueta);
                }
                continue;
            }

            // ── Caso: ULTIMO (el que habló más recientemente) ──
            const ultimoMatch = destinatario.match(/^ULTIMO(?:_(\w+))?$/i);
            if (ultimoMatch) {
                const servicioFiltro = ultimoMatch[1]?.toLowerCase() || null;
                const candidatos = Object.values(clientesHistorial)
                    .filter(d => d.remoteJid && d.remoteJid !== adminJid && d.ultimoMensaje)
                    .filter(d => {
                        if (!servicioFiltro) return true;
                        const sp = (d.servicioPendiente || '').toLowerCase();
                        return sp.includes(servicioFiltro) || servicioFiltro.includes(sp.split(' ')[0]);
                    })
                    .sort((a, b) => b.ultimoMensaje - a.ultimoMensaje);
                if (candidatos.length === 0) {
                    const tag = servicioFiltro ? ` con servicio *${servicioFiltro}*` : '';
                    await responder(adminJid, {
                        text: `❌ No encontré ningún cliente${tag} con historial reciente.`
                    });
                } else {
                    const d = candidatos[0];
                    await enviarYConfirmar(d.remoteJid, mensajeCliente, d.nombre || d.remoteJid);
                }
                continue;
            }

            // ── Caso 1: últimos 4 dígitos (*XXXX) ──
            const esUltimos4 = destinatario.startsWith('*') && /^\*\d{4}$/.test(destinatario);
            // ── Caso 2: número completo (8+ dígitos) ──
            const soloDigitos = destinatario.replace(/\D/g, '');
            const esNumeroCompleto = !esUltimos4 && soloDigitos.length >= 8;

            if (esUltimos4) {
                const sufijo = destinatario.slice(1);
                const resultado = Object.entries(clientesHistorial).find(([key, datos]) => {
                    const candidatos = [
                        key,
                        datos.telefono || '',
                        (datos.remoteJid || '').replace(/@.+$/, ''),
                        // También buscar en el teléfono real resuelto para @lid
                        lidToPhone.get(key) || '',
                        lidToPhone.get((datos.remoteJid || '').replace(/@.+$/, '')) || ''
                    ];
                    return candidatos.some(c => c.endsWith(sufijo));
                });
                if (resultado) {
                    const [, datosCliente] = resultado;
                    const nombreReal = datosCliente.nombre || `...${sufijo}`;
                    await enviarYConfirmar(datosCliente.remoteJid, mensajeCliente, `${nombreReal} (…${sufijo})`);
                } else {
                    // Fallback: mostrar la lista para que el admin elija por número
                    const { texto, mapa } = generarListaClientes(adminJid);
                    const sesion = adminSesionesActivas.get(adminJid) || { activadoEn: Date.now(), listaClientes: {} };
                    sesion.listaClientes = mapa;
                    adminSesionesActivas.set(adminJid, sesion);
                    await responder(adminJid, {
                        text: `❌ No encontré a nadie con número terminado en *${sufijo}*.\n\n_Los clientes con WhatsApp multi-dispositivo no tienen número buscable. Usá el número de la lista:_\n\n${texto}`
                    });
                }
            } else if (esNumeroCompleto) {
                let tel = soloDigitos;
                if (!tel.startsWith('54') && tel.length <= 12) tel = '54' + tel;
                let jidCliente = null;
                try {
                    const [info] = await socket.onWhatsApp(tel);
                    if (info?.exists) jidCliente = info.jid;
                } catch (e) {
                    console.warn(`⚠️ No se pudo verificar número ${tel}:`, e.message);
                }
                if (!jidCliente) {
                    await responder(adminJid, {
                        text: `❌ El número *${soloDigitos}* no está registrado en WhatsApp o no se pudo verificar.`
                    });
                } else {
                    await enviarYConfirmar(jidCliente, mensajeCliente, soloDigitos);
                }
            } else {
                // ── Buscar por nombre ──
                const resultado = buscarClientePorNombre(destinatario);
                if (resultado) {
                    const [, datosCliente] = resultado;
                    const nombreReal = datosCliente.nombre || destinatario;
                    await enviarYConfirmar(datosCliente.remoteJid, mensajeCliente, nombreReal);
                } else {
                    console.warn(`⚠️ Cliente "${destinatario}" no encontrado en historial`);
                    await responder(adminJid, {
                        text: `❌ No encontré a *${destinatario}* en el historial.\n\nPodés usar:\n• *"Vicky lista"* para ver los clientes numerados\n• *"el que termina en 6376"* si sabés los últimos 4 dígitos\n• El número completo`
                    });
                }
            }
        }

        if (!alguno) {
            await responder(adminJid, { text: '⚠️ No pude interpretar la instrucción. Repetila más claro.' });
        }

    } catch (err) {
        console.error('❌ Error en modo admin:', err.message);
        try { await socket.sendMessage(adminJid, { text: `❌ Error: ${err.message}` }); } catch (_) {}
    }
}

// ============================================================
// GENERADOR DE PRESUPUESTO PDF
// ============================================================
async function generarPresupuestoCercoPDF({ cliente, metros, precioUnit, alturaM, descuentoPct = 0 }) {
    try {
        const chromium = require('@sparticuz/chromium');
        const puppeteer = require('puppeteer-core');

        const fmt = (n) => '$' + Math.round(n).toLocaleString('es-AR');
        const subtotalBruto = metros * precioUnit;
        const descuentoMonto = descuentoPct > 0 ? Math.round(subtotalBruto * descuentoPct / 100) : 0;
        const subtotal = subtotalBruto - descuentoMonto;
        const ivaTexto = 'BONIFICADO';
        const total = subtotal;
        const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const descripcion = `Cerco de eucalipto impregnado - Altura ${alturaM} m`;

        const filaDescuento = descuentoPct > 0 ? `
            <tr class="descuento">
              <td><div class="item-desc"><h4>Descuento por volumen (${descuentoPct}%)</h4><p>Aplicado sobre ${fmt(subtotalBruto)}</p></div></td>
              <td>1 u</td>
              <td>${fmt(-descuentoMonto)}</td>
              <td>${fmt(-descuentoMonto)}</td>
            </tr>` : '';

        // Imágenes como base64
        const toBase64 = (filePath) => {
            if (fs.existsSync(filePath)) {
                const ext = path.extname(filePath).slice(1).replace('jpg', 'jpeg');
                return `data:image/${ext};base64,` + fs.readFileSync(filePath).toString('base64');
            }
            return '';
        };

        // Cargar imágenes dinámicamente desde images/Cercos/ — si cambiás las fotos, el PDF se actualiza solo
        const cercosDir = path.join(__dirname, 'images', 'Cercos');
        const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
        const cercosImgs = fs.existsSync(cercosDir)
            ? fs.readdirSync(cercosDir)
                .filter(f => imgExts.includes(path.extname(f).toLowerCase()))
                .map(f => path.join(cercosDir, f))
            : [];

        const getImg = (idx) => cercosImgs.length > 0
            ? toBase64(cercosImgs[idx % cercosImgs.length])
            : '';

        const imgCerco   = getImg(0);   // miniatura en tabla
        const imgPaso1   = getImg(0);   // foto paso 1 — cimentación
        const imgPaso2   = getImg(1);   // foto paso 2 — refuerzo (segunda foto si existe)
        const imgEstiloA = getImg(0);   // estilo irregular
        const imgEstiloB = getImg(Math.min(1, cercosImgs.length - 1)); // estilo lineal

        let html = fs.readFileSync(path.join(__dirname, 'presupuesto-template.html'), 'utf8');
        html = html
            .replace('{{FECHA}}', fecha)
            .replace('{{CLIENTE}}', cliente)
            .replace('{{DESCRIPCION}}', descripcion)
            .replace(/{{METROS}}/g, metros)
            .replace('{{PRECIO_UNIT_FMT}}', fmt(precioUnit))
            .replace(/{{SUBTOTAL_FMT}}/g, fmt(subtotal))
            .replace('{{FILA_DESCUENTO}}', filaDescuento)
            .replace('{{IVA_TEXTO}}', ivaTexto)
            .replace('{{TOTAL_FMT}}', fmt(total))
            .replace('{{IMG_CERCO}}', imgCerco)
            .replace('{{IMG_PASO1}}', imgPaso1)
            .replace('{{IMG_PASO2}}', imgPaso2)
            .replace('{{IMG_ESTILO_A}}', imgEstiloA)
            .replace('{{IMG_ESTILO_B}}', imgEstiloB);

        const execPath = await chromium.executablePath();
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
            ],
            defaultViewport: { width: 794, height: 1123 },
            executablePath: execPath,
            headless: true,
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 800));
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        const tmpPath = path.join(os.tmpdir(), `presupuesto-cerco-${Date.now()}.pdf`);
        fs.writeFileSync(tmpPath, pdfBuffer);
        console.log(`📄 Presupuesto PDF generado: ${tmpPath}`);
        return tmpPath;
    } catch (err) {
        console.error('❌ Error generando PDF:', err.message);
        return null;
    }
}

// ============================================================
// ELEVENLABS TTS — generar y enviar audio de voz
// ============================================================
function normalizarTextoParaAudio(texto) {
    return texto
        // Paso 1: quitar puntos separadores de miles en números grandes
        // Ej: 1.597.500 → 1597500 | 140.000 → 140000 | 2.100.000 → 2100000
        // NO toca decimales como 1.8 o 2.5 (solo 1 dígito tras el punto = decimal)
        .replace(/(\d{1,3}(?:\.\d{3})+)/g, m => m.replace(/\./g, ''))
        // Paso 1b: convertir saltos de línea en pausas naturales (coma o punto)
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, ', ')
        // Precios por unidad — ANTES de convertir $ genérico (orden importa)
        .replace(/\$\s*([\d.,]+)\s*\/\s*m²/gi, '$1 pesos por metro cuadrado')
        .replace(/\$\s*([\d.,]+)\s*\/\s*m2\b/gi, '$1 pesos por metro cuadrado')
        .replace(/\$\s*([\d.,]+)\s*\/\s*ml\b/gi, '$1 pesos por metro lineal')
        .replace(/\$\s*([\d.,]+)\s*\/\s*m\b/gi, '$1 pesos por metro')
        .replace(/\$\s*([\d.,]+)\s*\/\s*kg\b/gi, '$1 pesos por kilogramo')
        .replace(/\$\s*([\d.,]+)\s*\/\s*u\b/gi, '$1 pesos por unidad')
        // Operadores matemáticos
        .replace(/\s*[×xX]\s*/g, ' por ')             // × o x → "por"
        .replace(/\s*=\s*/g, ' igual a ')              // = → "igual a"
        .replace(/\s*\/\s*/g, ' dividido ')            // / suelto → "dividido"
        // Medidas con número adelante
        .replace(/(\d[\d.,]*)\s*kg\b/gi, '$1 kilogramos')
        .replace(/(\d[\d.,]*)\s*tn\b/gi, '$1 toneladas')
        .replace(/(\d[\d.,]*)\s*ton\b/gi, '$1 toneladas')
        .replace(/(\d[\d.,]*)\s*m²/gi, '$1 metros cuadrados')
        .replace(/(\d[\d.,]*)\s*m2\b/gi, '$1 metros cuadrados')
        .replace(/(\d[\d.,]*)\s*m³/gi, '$1 metros cúbicos')
        .replace(/(\d[\d.,]*)\s*m3\b/gi, '$1 metros cúbicos')
        .replace(/(\d[\d.,]*)\s*ml\b/gi, '$1 metros lineales')
        .replace(/(\d[\d.,]*)\s*mts?\b/gi, '$1 metros')
        .replace(/(\d[\d.,]*)\s*cm\b/gi, '$1 centímetros')
        .replace(/(\d[\d.,]*)\s*mm\b/gi, '$1 milímetros')
        .replace(/(\d[\d.,]*)\s*km\b/gi, '$1 kilómetros')
        .replace(/(\d[\d.,]*)\s*hs\b/gi, '$1 horas')
        .replace(/(\d[\d.,]*)\s*hrs?\b/gi, '$1 horas')
        // Precios — quitar $ y decir "pesos"
        .replace(/\$\s*([\d.,]+)/g, '$1 pesos')
        // Porcentaje
        .replace(/(\d[\d.,]*)\s*%/g, '$1 por ciento')
        // Abreviaciones sueltas (sin número)
        .replace(/\bkg\b/gi, 'kilogramos')
        .replace(/\bmt\b/gi, 'metros')
        .replace(/\bmts\b/gi, 'metros')
        .replace(/\bhs\b/gi, 'horas')
        .replace(/\betc\.\b/gi, 'etcétera')
        .replace(/\bL-V\b/g, 'lunes a viernes')
        .replace(/\bSáb\b/gi, 'sábado')
        // Símbolos de markdown que suenan raro al leerlos
        .replace(/^\s*[•\-\*]\s*/gm, '')          // bullets al inicio de línea
        .replace(/\*\*(.*?)\*\*/g, '$1')           // **negrita** → texto
        .replace(/\*(.*?)\*/g, '$1')               // *cursiva* → texto
        .replace(/_{1,2}(.*?)_{1,2}/g, '$1')       // _subrayado_ → texto
        .replace(/#+\s*/g, '')                     // # títulos → sin símbolo
        .replace(/`{1,3}[^`]*`{1,3}/g, '')        // `código` → vacío
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [texto](url) → texto
        .replace(/={3,}/g, '')                     // === separadores
        .replace(/\n{3,}/g, '\n\n')               // múltiples saltos → dos
        // Emojis y símbolos que no suenan bien
        .replace(/[😊😄🙏✅❌⚠️📦🎙️💬🖼️🎤🌿🪵]/g, '')
        .trim();
}

async function generarAudioElevenLabs(texto) {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;
    try {
        // Limpiar marcadores del texto antes de convertir a audio
        const textoLimpio = normalizarTextoParaAudio(
            texto
                .replace(/\[IMG:[^\]]+\]/gi, '')
                .replace(/\[COTIZACION:[^\]]+\]/gi, '')
                .replace(/\[CONFIRMADO\]/gi, '')
                .replace(/\[NOMBRE:[^\]]+\]/gi, '')
                .replace(/\[DIRECCION:[^\]]+\]/gi, '')
                .replace(/\[ZONA:[^\]]+\]/gi, '')
                .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO:[^\]]+\]/gi, '')
                .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
        ).trim();

        if (!textoLimpio) return null;

        const body = JSON.stringify({
            text: textoLimpio,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.35,
                similarity_boost: 0.75,
                style: 0.45,
                use_speaker_boost: true
            }
        });

        const resp = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body
            }
        );

        if (!resp.ok) {
            const err = await resp.text();
            console.error('❌ ElevenLabs error:', err);
            return null;
        }

        const arrayBuffer = await resp.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error('❌ Error generando audio ElevenLabs:', e.message);
        return null;
    }
}

async function enviarAudioElevenLabs(sendBotMessage, jid, texto) {
    const audioBuffer = await generarAudioElevenLabs(texto);
    if (!audioBuffer) return false;
    try {
        await sendBotMessage(jid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: false
        });
        console.log(`🎙️ Audio ElevenLabs enviado a ${jid}`);
        return true;
    } catch (e) {
        console.error('❌ Error enviando audio ElevenLabs:', e.message);
        return false;
    }
}

function getTel(remoteJid) {
    return remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
}

function getCliente(telefono) {
    return clientesHistorial[getTel(telefono)] || null;
}

function asegurarCliente(remoteJid) {
    const tel = getTel(remoteJid);
    if (!clientesHistorial[tel]) {
        clientesHistorial[tel] = {
            audioIntroEnviado: false,
            nombre: null,
            remoteJid,
            // Guardar teléfono legible si es @s.whatsapp.net, sino el ID @lid limpio
            telefono: remoteJid.includes('@s.whatsapp.net') ? tel : null,
            estado: 'nuevo',
            servicioPendiente: null,
            textoCotizacion: null,
            fechaCotizacion: null,
            seguimientoEnviado: false,
            direccion: null,
            zona: null,
            metodoPago: null,
            pedidosAnteriores: [],
            historial: []
        };
    } else {
        // Asegurar que tenga los campos nuevos si era un registro viejo
        if (!clientesHistorial[tel].remoteJid) clientesHistorial[tel].remoteJid = remoteJid;
        if (!clientesHistorial[tel].estado) clientesHistorial[tel].estado = 'nuevo';
        if (clientesHistorial[tel].seguimientoEnviado === undefined) clientesHistorial[tel].seguimientoEnviado = false;
        if (clientesHistorial[tel].direccion === undefined) clientesHistorial[tel].direccion = null;
        if (clientesHistorial[tel].zona === undefined) clientesHistorial[tel].zona = null;
        if (clientesHistorial[tel].metodoPago === undefined) clientesHistorial[tel].metodoPago = null;
        if (!clientesHistorial[tel].pedidosAnteriores) clientesHistorial[tel].pedidosAnteriores = [];
    }
    return clientesHistorial[tel];
}

function marcarAudioEnviado(remoteJid) {
    const cliente = asegurarCliente(remoteJid);
    cliente.audioIntroEnviado = true;
    saveHistorialGCS().catch(() => {});
}

function actualizarEstadoCliente(remoteJid, datos) {
    const cliente = asegurarCliente(remoteJid);
    if (datos.nombre) cliente.nombre = datos.nombre;
    if (datos.estado) cliente.estado = datos.estado;
    if (datos.servicioPendiente) cliente.servicioPendiente = datos.servicioPendiente;
    if (datos.textoCotizacion) cliente.textoCotizacion = datos.textoCotizacion;
    if (datos.fechaCotizacion) cliente.fechaCotizacion = datos.fechaCotizacion;
    if (datos.seguimientoEnviado !== undefined) cliente.seguimientoEnviado = datos.seguimientoEnviado;
    if (datos.direccion) cliente.direccion = datos.direccion;
    if (datos.zona) cliente.zona = datos.zona;
    if (datos.metodoPago) cliente.metodoPago = datos.metodoPago;
    if (datos.ultimoMensaje) cliente.ultimoMensaje = datos.ultimoMensaje;
    if (datos.pedido) {
        if (!cliente.pedidosAnteriores) cliente.pedidosAnteriores = [];
        cliente.pedidosAnteriores.push(datos.pedido);
    }
    saveHistorialGCS().catch(() => {});
}

// Construye el contexto previo para inyectar en Gemini cuando el cliente vuelve
function construirContextoPrevio(histCliente) {
    if (!histCliente || histCliente.estado === 'nuevo') return null;
    const ahora = Date.now();

    // Armar bloque de datos conocidos del cliente
    const datosConocidos = [];
    if (histCliente.nombre) datosConocidos.push(`- Nombre: ${histCliente.nombre}`);
    if (histCliente.direccion) datosConocidos.push(`- Dirección: ${histCliente.direccion}`);
    if (histCliente.zona) datosConocidos.push(`- Zona: ${histCliente.zona}`);
    if (histCliente.metodoPago) datosConocidos.push(`- Método de pago preferido: ${histCliente.metodoPago}`);

    // Historial de pedidos anteriores
    const pedidosPrevios = histCliente.pedidosAnteriores && histCliente.pedidosAnteriores.length > 0
        ? histCliente.pedidosAnteriores.map(p => {
            const fecha = p.fecha ? new Date(p.fecha).toLocaleDateString('es-AR') : 'fecha desconocida';
            return `  • ${p.servicio}: ${p.descripcion} (${fecha})`;
        }).join('\n')
        : null;

    const bloqueCliente = datosConocidos.length > 0
        ? `\nDatos conocidos del cliente:\n${datosConocidos.join('\n')}`
        : '';
    const bloquePedidos = pedidosPrevios
        ? `\nPedidos anteriores:\n${pedidosPrevios}`
        : '';
    const instruccion = `Si el cliente ya dio su dirección o método de pago, NO los vuelvas a pedir. Usá los datos que ya tenés.`;

    const servicio = histCliente.servicioPendiente || 'un servicio';

    // Descripción natural del historial de trabajos para usar en la conversación
    const resumenPedidos = pedidosPrevios
        ? `Este cliente ya compró o contrató:\n${pedidosPrevios}`
        : 'Este cliente ya tuvo interacción previa con Gardens Wood.';

    if (histCliente.estado === 'cotizacion_enviada' && histCliente.fechaCotizacion) {
        const horas = Math.round((ahora - new Date(histCliente.fechaCotizacion).getTime()) / 3600000);
        return `[CONTEXTO_SISTEMA] Este cliente ya fue atendido antes. Se le envió una cotización de ${servicio} hace aproximadamente ${horas} hora${horas !== 1 ? 's' : ''}. Aún no confirmó ni pagó la seña.
${bloqueCliente}${bloquePedidos}
${instruccion}
REGLAS DE CONTINUIDAD:
- Si el cliente hace una consulta CONCRETA (precio, producto, servicio), respondé directamente a eso. NO preguntes por la cotización pendiente.
- SOLO mencioná la cotización pendiente si el mensaje es un saludo ambiguo ("hola", "buenas", "cómo andás") sin ninguna consulta clara.
- Ejemplo correcto para saludo ambiguo: "Hola [nombre], ¿cómo estás? ¿Me escribís por la cotización de ${servicio} o tenés otra consulta?"
- Ejemplo correcto para consulta concreta de leña: respondé los precios de leña directamente, sin mencionar la cotización pendiente.`;
    }

    if (histCliente.estado === 'confirmado' || histCliente.estado === 'cliente') {
        const esCliente = histCliente.estado === 'cliente';
        return `[CONTEXTO_SISTEMA] CLIENTE CONOCIDO — ya tiene historial con Gardens Wood.
${resumenPedidos}
${bloqueCliente}
${instruccion}
REGLAS DE CONTINUIDAD CON CLIENTE CONOCIDO:
- Tratalo con familiaridad, como alguien que ya conocés. No te presentes ni expliques quién es Vicky.
- Si sabés su nombre, usalo naturalmente (solo el primer nombre, no el apellido).
- Si consulta por algo nuevo (leña, cerco, pérgola, etc.), respondé directamente sobre eso. No necesita que le expliques todo el catálogo desde cero.
- Podés hacer referencia natural al trabajo anterior si es relevante. Ejemplo: si hizo un cerco y ahora pide leña → "Dale, para la leña te cuento...". Si pregunta sobre pérgola → podés mencionar brevemente "como el cerco que te hicimos, usamos la misma calidad de madera".
- NO ofrezcas el catálogo completo ni te presentes. Ya sabe quiénes son.
- ${esCliente ? 'Ya realizó una compra o trabajo. Es un cliente fidelizado — tratalo como tal.' : 'Confirmó una compra pero puede estar en proceso. Ofrecele ayuda con lo que necesite.'}`;
    }

    return null;
}

// ============================================================
// FUNCIÓN PRINCIPAL
// ============================================================
async function connectToWhatsApp() {
    console.log('🔌 Iniciando conexión con WhatsApp...');
    await downloadFromGCS(); 
    loadHistorialLocal();
    await downloadColaLenaGCS();

    // Inicializar Firestore (Dashboard)
    await firestoreModule.initFirestore();
    // Migrar clientes existentes a Firestore (solo si hay datos locales y aún no se migraron)
    if (firestoreModule.isAvailable() && Object.keys(clientesHistorial).length > 0) {
        firestoreModule.migrarHistorialAFirestore(clientesHistorial).catch(console.warn);
    }

    // Leer system prompt desde Firestore (con fallback al hardcodeado)
    let SYSTEM_PROMPT_ACTIVO = await firestoreModule.getSystemPrompt(SYSTEM_PROMPT);

    // Leer config general desde Firestore
    const configGeneral = await firestoreModule.getConfigGeneral();
    const DELAY_MIN = (configGeneral.delayMinSeg || 10) * 1000;
    const DELAY_MAX = (configGeneral.delayMaxSeg || 15) * 1000;
    const MODELO_GEMINI = configGeneral.modeloGemini || 'gemini-2.5-flash';
    const FRECUENCIA_AUDIO = configGeneral.frecuenciaAudioFidelizacion || 4;
    const BOT_ACTIVO = configGeneral.botActivo !== false;

    // Inicializar Gemini
    let genAI = null;
    let geminiModel = null;
    if (GEMINI_API_KEY) {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({
            model: MODELO_GEMINI,
            systemInstruction: SYSTEM_PROMPT_ACTIVO
        });
        console.log(`🤖 Gemini AI inicializado (${MODELO_GEMINI}).`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Usando Baileys v${version.join('.')}`);

    const socket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome')
    });

    // --- Simular escritura humana (10-15 segundos) ---
    const simularEscritura = async (remoteJid) => {
        try {
            await socket.presenceSubscribe(remoteJid);
            await delay(500);
            await socket.sendPresenceUpdate('composing', remoteJid);
            await delay(10000 + Math.floor(Math.random() * 5000));
            await socket.sendPresenceUpdate('paused', remoteJid);
        } catch (e) { console.warn('⚠️ Error presencia:', e.message); }
    };

    // --- Enviar mensaje y registrar ID (para detección humano) ---
    const sendBotMessage = async (jid, content) => {
        const sent = await socket.sendMessage(jid, content);
        if (sent?.key?.id) BOT_MSG_IDS.add(sent.key.id);
        return sent;
    };

    // --- Enviar imagen del servicio si existe ---
    const enviarImagen = async (jid, servicioKey) => {
        const mediaPath = IMAGENES[servicioKey];
        if (mediaPath && fs.existsSync(mediaPath)) {
            try {
                const ext = path.extname(mediaPath).toLowerCase();
                const esVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
                if (esVideo) {
                    await sendBotMessage(jid, { video: fs.readFileSync(mediaPath), mimetype: 'video/mp4', caption: '' });
                } else {
                    await sendBotMessage(jid, { image: fs.readFileSync(mediaPath), caption: '' });
                }
            } catch (e) {
                console.warn(`⚠️ No se pudo enviar media de ${servicioKey}:`, e.message);
            }
        }
    };

    // Solo subir creds.json cuando cambian las credenciales — con debounce para no saturar GCS
    let credsUploadTimer = null;
    // Captura el mapeo @lid → teléfono real cuando WhatsApp sincroniza contactos
    // Baileys incluye el campo `lid` en los contactos @s.whatsapp.net cuando el usuario
    // tiene la identidad de dispositivo vinculado activa
    socket.ev.on('contacts.upsert', (contacts) => {
        let nuevos = 0;
        for (const contact of contacts) {
            // Caso A: contacto con JID de teléfono que también tiene lid
            if (contact.id?.endsWith('@s.whatsapp.net') && contact.lid) {
                const lidId = contact.lid.replace(/@lid$/, '');
                const phone = contact.id.replace(/@s\.whatsapp\.net$/, '');
                if (!lidToPhone.has(lidId)) {
                    lidToPhone.set(lidId, phone);
                    nuevos++;
                    // Actualizar historial si ya existe este @lid como cliente
                    const clienteLid = clientesHistorial[lidId];
                    if (clienteLid && !clienteLid.telefono) {
                        clienteLid.telefono = phone;
                        saveHistorialGCS().catch(() => {});
                    }
                }
            }
            // Caso B: contacto con JID @lid que trae su número en el campo lid (formato inverso)
            if (contact.id?.endsWith('@lid') && contact.lid?.endsWith('@s.whatsapp.net')) {
                const lidId = contact.id.replace(/@lid$/, '');
                const phone = contact.lid.replace(/@s\.whatsapp\.net$/, '');
                if (!lidToPhone.has(lidId)) {
                    lidToPhone.set(lidId, phone);
                    nuevos++;
                    const clienteLid = clientesHistorial[lidId];
                    if (clienteLid && !clienteLid.telefono) {
                        clienteLid.telefono = phone;
                        saveHistorialGCS().catch(() => {});
                    }
                }
            }
        }
        if (nuevos > 0) console.log(`📞 ${nuevos} nuevos mapeos @lid→teléfono registrados (total: ${lidToPhone.size})`);
    });

    socket.ev.on('creds.update', async () => {
        await saveCreds();
        if (credsUploadTimer) clearTimeout(credsUploadTimer);
        credsUploadTimer = setTimeout(async () => {
            credsUploadTimer = null;
            try {
                await storage.bucket(BUCKET_NAME).upload(
                    path.join(AUTH_DIR, 'creds.json'),
                    { destination: 'auth/creds.json' }
                );
            } catch (e) {
                if (!e.message?.includes('429')) console.error('❌ Error subiendo creds.json:', e.message);
            }
        }, 10000); // espera 10s antes de subir
    });
    // NO usar fs.watch para subir archivos de sesión — genera cientos de requests GCS por minuto

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !socket.authState.creds.registered) {
            console.log('\n📷 ESCANEA EL QR EN EL LOG O DESDE qr.png');
            qrTerminal.generate(qr, { small: true });
            qrImage.image(qr, { type: 'png', size: 4 }).pipe(fs.createWriteStream('qr.png'));
        }
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                console.log('🔌 Reconectando...');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ VINCULADO!');
        }
    });

    // ============================================================
    // HANDLER PRINCIPAL DE MENSAJES
    // ============================================================
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;

            const msg = messages[0];
            if (!msg?.message || !msg?.key) return;

            const remoteJid = msg.key.remoteJid;

            // --- IGNORAR GRUPOS Y ESTADOS DE WHATSAPP ---
            if (remoteJid.endsWith('@g.us')) return;
            if (remoteJid === 'status@broadcast') return;

            // --- MODO ADMIN: mensajes del dueño del negocio ---
            if (!msg.key.fromMe) {
                const textoRaw = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                const tieneAudioMsg = !!(msg.message?.audioMessage || msg.message?.pttMessage);
                const esJidAdmin = ADMIN_JID && remoteJid === ADMIN_JID;
                const esFraseAdmin = textoRaw.toLowerCase().trim().startsWith(ADMIN_SECRET);

                // Verificar si el JID ya tiene sesión admin activa (activada con !vicky en los últimos 60min)
                const sesionAdminData = adminSesionesActivas.get(remoteJid);
                const sesionAdminActiva = sesionAdminData &&
                    (Date.now() - sesionAdminData.activadoEn) < ADMIN_SESSION_TTL;

                if (esJidAdmin || esFraseAdmin || sesionAdminActiva) {
                    // Si llegó la frase secreta por texto, activar/renovar sesión admin para este JID
                    if (esFraseAdmin || esJidAdmin) {
                        const existing = adminSesionesActivas.get(remoteJid) || {};
                        adminSesionesActivas.set(remoteJid, {
                            activadoEn: Date.now(),
                            listaClientes: existing.listaClientes || {}
                        });
                        console.log(`🔑 Sesión admin activada para ${remoteJid} (válida 1 hora)`);
                    }

                    // Si es solo "!vicky" sin instrucción, confirmar activación y esperar el audio/texto
                    const instruccionTexto = esFraseAdmin
                        ? textoRaw.slice(ADMIN_SECRET.length).trim()
                        : textoRaw;

                    if (!tieneAudioMsg && !instruccionTexto) {
                        await sendBotMessage(remoteJid, {
                            text: '🔑 Sesión admin activada. Ahora mandá el audio o texto con la instrucción.'
                        });
                        return;
                    }

                    if (tieneAudioMsg || instruccionTexto) {
                        console.log(`🔑 Comando admin desde ${remoteJid} (${sesionAdminActiva ? 'sesión activa' : esFraseAdmin ? 'frase secreta' : 'JID'})`);
                        let audioAdminBase64 = null;
                        if (tieneAudioMsg) {
                            try {
                                const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                                    logger: pino({ level: 'silent' }),
                                    reuploadRequest: socket.updateMediaMessage
                                });
                                audioAdminBase64 = buf.toString('base64');
                            } catch (e) {
                                console.error('❌ Error descargando audio admin:', e.message);
                            }
                        }
                        if (audioAdminBase64 || instruccionTexto) {
                            await procesarComandoAdmin(socket, remoteJid, audioAdminBase64, instruccionTexto);
                        }
                        return;
                    }
                }
            }

            // --- INICIALIZAR SESIÓN ---
            if (!SESSIONS.has(remoteJid)) {
                const histCliente = getCliente(remoteJid);
                const chatHistory = [];

                // Inyectar contexto previo si el cliente ya tuvo interacciones
                const contextoPrevio = construirContextoPrevio(histCliente);
                if (contextoPrevio) {
                    chatHistory.push(
                        { role: 'user', parts: [{ text: contextoPrevio }] },
                        { role: 'model', parts: [{ text: 'Entendido, tengo el contexto del cliente.' }] }
                    );
                    console.log(`🔁 Contexto previo inyectado para ${remoteJid}: ${histCliente?.estado}`);
                }

                SESSIONS.set(remoteJid, {
                    audioIntroEnviado: histCliente?.audioIntroEnviado === true,
                    humanAtendiendo: false,
                    humanTimestamp: null,
                    chatHistory,
                    imagenEnviada: {},
                    ultimoMensajeCliente: null,
                    mensajesTexto: 0  // contador de mensajes de texto consecutivos para trigger de audio fidelización
                });
            }

            const session = SESSIONS.get(remoteJid);

            // --- DETECCIÓN DE HUMANO ATENDIENDO ---
            if (msg.key.fromMe) {
                if (!BOT_MSG_IDS.has(msg.key.id)) {
                    session.humanAtendiendo = true;
                    session.humanTimestamp = Date.now();
                    console.log(`👤 Humano respondió en ${remoteJid}. Bot silenciado 24hs.`);
                    firestoreModule.setHumanoAtendiendo(remoteJid, true).catch(() => {});
                }
                return;
            }

            const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
            if (session.humanAtendiendo) {
                if (Date.now() - session.humanTimestamp > TWENTY_FOUR_HOURS) {
                    session.humanAtendiendo = false;
                    session.humanTimestamp = null;
                } else {
                return;
                }
            }

            // --- EXTRAER TEXTO, IMAGEN Y AUDIO ---
            const text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ''
            ).trim();

            const tieneImagen = !!(msg.message.imageMessage);
            const tieneAudio = !!(msg.message.audioMessage || msg.message.pttMessage);

            // Ignorar si no hay texto, imagen ni audio
            if (!text && !tieneImagen && !tieneAudio) return;

            console.log(`📨 Mensaje de ${remoteJid}: "${text.substring(0, 80)}"${tieneImagen ? ' 📷 [imagen]' : ''}${tieneAudio ? ' 🎤 [audio]' : ''}`);

            // Log en Firestore (Dashboard)
            const telCliente = getTel(remoteJid);
            const histCl = getCliente(remoteJid);
            firestoreModule.logMensaje({
                jid: remoteJid,
                tipo: tieneImagen ? 'imagen' : tieneAudio ? 'audio' : 'texto',
                contenido: text || (tieneImagen ? '[imagen]' : tieneAudio ? '[audio de voz]' : ''),
                direccion: 'entrante',
                servicio: histCl?.servicioPendiente || null,
                clienteInfo: {
                    nombre: histCl?.nombre,
                    estado: histCl?.estado,
                    servicioPendiente: histCl?.servicioPendiente,
                    humanoAtendiendo: session.humanAtendiendo,
                },
            }).catch(() => {});

            // Registrar timestamp del último mensaje del cliente
            const ahora = Date.now();
            const minutosDesdeUltimoMensaje = session.ultimoMensajeCliente
                ? Math.round((ahora - session.ultimoMensajeCliente) / 60000)
                : null;
            session.ultimoMensajeCliente = ahora;
            // Persistir en historial GCS para poder ordenar lista de clientes por recencia
            actualizarEstadoCliente(remoteJid, { ultimoMensaje: ahora });

            // Contador de mensajes de texto consecutivos (reset si manda audio)
            if (tieneAudio) {
                session.mensajesTexto = 0;
            } else {
                session.mensajesTexto = (session.mensajesTexto || 0) + 1;
            }

            // Descargar imagen si la hay
            let imagenBase64 = null;
            let imagenMime = 'image/jpeg';
            if (tieneImagen) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    imagenBase64 = buffer.toString('base64');
                    imagenMime = msg.message.imageMessage.mimetype || 'image/jpeg';
                    console.log(`🖼️ Imagen descargada (${Math.round(buffer.length / 1024)}kb, ${imagenMime})`);
                } catch (errImg) {
                    console.error('❌ Error descargando imagen:', errImg.message);
                }
            }

            // Descargar audio si lo hay
            let audioClienteBase64 = null;
            let audioClienteMime = 'audio/ogg; codecs=opus';
            if (tieneAudio) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });
                    audioClienteBase64 = buffer.toString('base64');
                    // Forzar audio/ogg sin especificación de codec — Gemini no reconoce "audio/ogg; codecs=opus"
                    audioClienteMime = 'audio/ogg';
                    console.log(`🎤 Audio descargado (${Math.round(buffer.length / 1024)}kb, ${audioClienteMime})`);
                } catch (errAudio) {
                    console.error('❌ Error descargando audio:', errAudio.message);
                }
            }

            // --- AUDIO DE BIENVENIDA (solo la primera vez por cliente, para siempre) ---
            // primerMensajeConContenido: si el cliente ya incluyó info en su primer mensaje,
            // NO cortamos con return — dejamos que Gemini responda a lo que preguntó.
            const primerContacto = !session.audioIntroEnviado;
            if (primerContacto) {
                session.audioIntroEnviado = true;
                marcarAudioEnviado(remoteJid);

                console.log(`🎵 Enviando audio de bienvenida a ${remoteJid}`);
                if (AUDIO_INTRO_EXISTS) {
                    try {
                        await sendBotMessage(remoteJid, {
                            audio: fs.readFileSync(AUDIO_INTRO_PATH),
                            mimetype: 'audio/mpeg',
                            ptt: false
                        });
                        await delay(1500);
                    } catch (errAudio) {
                        console.error('❌ Error enviando audio:', errAudio.message);
                    }
                }

                // Si el primer mensaje solo es un saludo vacío (sin contenido relevante),
                // enviamos el mensaje de bienvenida y esperamos su respuesta.
                const esTextoVago = !text || /^(hola|buenas|buen[ao]s?\s*(días?|tardes?|noches?)?|hey|hi|hello|saludos?|buenas?|ey|q tal|como andas?)\s*[!?¡¿.]*$/i.test(text.trim());
                if (esTextoVago && !tieneImagen && !tieneAudio) {
                    await sendBotMessage(remoteJid, {
                        text: `Contame, ¿en qué te puedo ayudar? Escribime porfa que me es más fácil responder 😊`
                    });
                    return;
                }

                // Si el cliente ya trajo info en su primer mensaje (ej: "10mt de cerco cuánto cuesta"),
                // enviamos solo el mensaje invitándolo a escribir y luego dejamos que Gemini procese su consulta.
                await sendBotMessage(remoteJid, {
                    text: `Contame, ¿en qué te puedo ayudar? Escribime porfa que me es más fácil responder 😊`
                });
                await delay(1000);
                // Caemos al bloque de Gemini con contexto especial de que es el primer mensaje.
            }

            // --- CONSULTAR GEMINI ---
            if (!geminiModel) {
                await sendBotMessage(remoteJid, {
                    text: `Disculpá, estoy teniendo un problema técnico en este momento. Volvé a escribirme en unos minutos 🙏`
                });
                return;
            }

                await simularEscritura(remoteJid);

            try {
                // Crear chat con historial de la sesión
                const chat = geminiModel.startChat({
                    history: session.chatHistory
                });

                // Contexto de tiempo para que Gemini sepa si saludar o no
                let ctxSaludo;
                if (primerContacto) {
                    // El audio de bienvenida ya fue enviado junto con "Contame en qué te puedo ayudar".
                    // Gemini NO debe saludar de nuevo ni repetir esa frase. Debe responder directo al contenido.
                    ctxSaludo = `[CONTEXTO: El audio y el mensaje de bienvenida ya fueron enviados en este mismo instante. NO saludes, NO digas "Hola", "Buenas", "Contame" ni nada similar. El cliente te escribió con una consulta específica. Respondé DIRECTAMENTE a lo que preguntó, como si ya estuvieras en medio de la conversación.]`;
                } else if (minutosDesdeUltimoMensaje === null) {
                    ctxSaludo = '[CONTEXTO: Es el primer mensaje de esta sesión activa. Podés saludar.]';
                } else if (minutosDesdeUltimoMensaje >= 60) {
                    ctxSaludo = `[CONTEXTO: El cliente no escribía hace ${minutosDesdeUltimoMensaje} minutos. Podés saludar brevemente.]`;
                } else {
                    ctxSaludo = `[CONTEXTO: La charla es fluida, el último mensaje fue hace ${minutosDesdeUltimoMensaje} minutos. NO saludes de nuevo, continuá la conversación directamente.]`;
                }

                // Indicar si corresponde intercalar un audio de fidelización (cada 4 mensajes de texto)
                const mensajesTextoActual = session.mensajesTexto || 0;
                const ctxFidelizar = (!tieneAudio && mensajesTextoActual > 0 && mensajesTextoActual % 4 === 0)
                    ? `[CONTEXTO_AUDIO: Llevamos ${mensajesTextoActual} mensajes de texto seguidos. Es un buen momento para romper la frialdad del chat con un audio breve y cálido. Incluí al inicio de tu respuesta el marcador [AUDIO_FIDELIZAR:frase] con una frase corta, natural y cálida de máximo 12 palabras que refuerce la confianza. Ejemplo: "¡Me alegra que estés interesado! Cualquier duda me avisás." Variá la frase según el contexto de la conversación.]`
                    : '';

                const ctxTiempo = [ctxSaludo, ctxFidelizar].filter(Boolean).join('\n');

                // Armar contenido del mensaje (texto, imagen, audio o combinaciones)
                let contenidoMensaje;
                if (audioClienteBase64) {
                    const partes = [];
                    partes.push({ inlineData: { data: audioClienteBase64, mimeType: audioClienteMime } });
                    partes.push({ text: `${ctxTiempo}\nEl cliente envió este mensaje de voz. Transcribí internamente TODO lo que dice (de principio a fin, sin cortar) y respondé como Vicky según el contenido completo del audio.` });
                    contenidoMensaje = partes;
                } else if (imagenBase64) {
                    const partes = [];
                    partes.push({ inlineData: { data: imagenBase64, mimeType: imagenMime } });
                    partes.push({ text: `${ctxTiempo}\nEl cliente envió esta foto. Analizala en el contexto de los servicios y productos de Gardens Wood y respondé lo que corresponda.` });
                    contenidoMensaje = partes;
                } else {
                    contenidoMensaje = `${ctxTiempo}\n${text}`;
                }

                // Llamar a Gemini con reintentos ante error 429
                let result = null;
                const MAX_REINTENTOS = 3;
                const ESPERAS = [30000, 60000, 90000]; // 30s, 60s, 90s
                for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
                    try {
                        result = await chat.sendMessage(contenidoMensaje);
                        break; // éxito
                    } catch (errApi) {
                        const es429 = errApi.message && errApi.message.includes('429');
                        if (es429 && intento < MAX_REINTENTOS - 1) {
                            console.warn(`⚠️ Gemini 429, reintentando en ${ESPERAS[intento]/1000}s... (intento ${intento + 1})`);
                            await delay(ESPERAS[intento]);
                        } else {
                            throw errApi; // relanzo si no es 429 o agotamos reintentos
                        }
                    }
                }
                if (!result) throw new Error('Sin respuesta después de reintentos');

                let respuesta = result.response.text();

                // Guardar en historial de la sesión
                let userParts;
                if (audioClienteBase64) {
                    userParts = [{ inlineData: { data: audioClienteBase64, mimeType: audioClienteMime } }, { text: text || '[audio]' }];
                } else if (imagenBase64) {
                    userParts = [{ inlineData: { data: imagenBase64, mimeType: imagenMime } }, { text: text || '[imagen]' }];
                } else {
                    userParts = [{ text }];
                }
                session.chatHistory.push(
                    { role: 'user', parts: userParts },
                    { role: 'model', parts: [{ text: respuesta }] }
                );

                // Limitar historial a últimas 20 interacciones (10 turnos) para no sobrepasar tokens
                if (session.chatHistory.length > 20) {
                    session.chatHistory = session.chatHistory.slice(-20);
                }

                // --- Parsear marcadores especiales ---

                // [COTIZACION:servicio]
                const cotizMatch = respuesta.match(/\[COTIZACION:(lena|cerco|pergola|fogonero|bancos)\]/i);
                if (cotizMatch) {
                    const srv = cotizMatch[1].toLowerCase();
                    respuesta = respuesta.replace(/\[COTIZACION:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, {
                        estado: 'cotizacion_enviada',
                        servicioPendiente: srv,
                        textoCotizacion: text,
                        fechaCotizacion: new Date().toISOString(),
                        seguimientoEnviado: false
                    });
                    console.log(`📋 Cotización registrada para ${remoteJid} (${srv})`);
                    // El audio de cotización se maneja por [AUDIO_CORTO:] en Gemini (resumen verbal)
                    // No enviar aquí el texto completo — evita que ElevenLabs lea todos los números
                }

                // [PDF_CERCO:metros|precioUnit|alturaM|descuentoPct]
                const pdfCercoMatch = respuesta.match(/\[PDF_CERCO:([^\]]+)\]/i);
                if (pdfCercoMatch) {
                    respuesta = respuesta.replace(/\[PDF_CERCO:[^\]]+\]/gi, '').trim();
                    const partes = pdfCercoMatch[1].split('|');
                    const metros = parseFloat(partes[0]) || 0;
                    const precioUnit = parseFloat(partes[1]) || 0;
                    const alturaM = partes[2] || '1.8';
                    const descuentoPct = parseFloat(partes[3]) || 0;
                    const nombreCliente = clientesHistorial[remoteJid]?.nombre || 'Cliente';

                    if (metros > 0 && precioUnit > 0) {
                        generarPresupuestoCercoPDF({ cliente: nombreCliente, metros, precioUnit, alturaM, descuentoPct })
                            .then(async (pdfPath) => {
                                if (pdfPath) {
                                    try {
                                        await sendBotMessage(remoteJid, {
                                            document: fs.readFileSync(pdfPath),
                                            mimetype: 'application/pdf',
                                            fileName: `Presupuesto Cerco - ${nombreCliente}.pdf`
                                        });
                                        fs.unlinkSync(pdfPath);
                                        console.log(`📄 PDF cerco enviado a ${remoteJid}`);
                                    } catch (errPdf) {
                                        console.error('❌ Error enviando PDF:', errPdf.message);
                                    }
                                }
                            })
                            .catch(err => console.error('❌ Error generando PDF cerco:', err.message));
                    }
                }

                // [CONFIRMADO] — registrar estado, sin audio pregrabado
                if (/\[CONFIRMADO\]/i.test(respuesta)) {
                    respuesta = respuesta.replace(/\[CONFIRMADO\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { estado: 'confirmado' });
                    console.log(`✅ Cliente ${remoteJid} confirmó.`);
                }

                // [NOMBRE:X]
                const nombreMatch = respuesta.match(/\[NOMBRE:([^\]]+)\]/i);
                if (nombreMatch) {
                    const nombre = nombreMatch[1].trim();
                    respuesta = respuesta.replace(/\[NOMBRE:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { nombre });
                    console.log(`👤 Nombre registrado para ${remoteJid}: ${nombre}`);
                }

                // [DIRECCION:X]
                const dirMatch = respuesta.match(/\[DIRECCION:([^\]]+)\]/i);
                if (dirMatch) {
                    const direccion = dirMatch[1].trim();
                    respuesta = respuesta.replace(/\[DIRECCION:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { direccion });
                    console.log(`📍 Dirección registrada para ${remoteJid}: ${direccion}`);
                }

                // [ZONA:X]
                const zonaMatch = respuesta.match(/\[ZONA:([^\]]+)\]/i);
                if (zonaMatch) {
                    const zona = zonaMatch[1].trim();
                    respuesta = respuesta.replace(/\[ZONA:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { zona });
                    console.log(`🗺️ Zona registrada para ${remoteJid}: ${zona}`);
                }

                // [METODO_PAGO:X]
                const pagoMatch = respuesta.match(/\[METODO_PAGO:([^\]]+)\]/i);
                if (pagoMatch) {
                    const metodoPago = pagoMatch[1].trim();
                    respuesta = respuesta.replace(/\[METODO_PAGO:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { metodoPago });
                    console.log(`💳 Método de pago registrado para ${remoteJid}: ${metodoPago}`);
                }

                // [PEDIDO:servicio|descripcion]
                const pedidoMatch = respuesta.match(/\[PEDIDO:([^\]]+)\]/i);
                if (pedidoMatch) {
                    const partes = pedidoMatch[1].split('|');
                    const pedido = {
                        servicio: partes[0]?.trim(),
                        descripcion: partes[1]?.trim() || '',
                        fecha: new Date().toISOString()
                    };
                    respuesta = respuesta.replace(/\[PEDIDO:[^\]]+\]/gi, '').trim();
                    actualizarEstadoCliente(remoteJid, { pedido, estado: 'cliente' });
                    console.log(`📦 Pedido registrado para ${remoteJid}: ${pedido.servicio} - ${pedido.descripcion}`);
                }

                // [PEDIDO_LENA:cantidadKg|direccion] — cola logística para pedidos pequeños
                const pedidoLenaMatch = respuesta.match(/\[PEDIDO_LENA:([^\]]+)\]/i);
                if (pedidoLenaMatch) {
                    const partes = pedidoLenaMatch[1].split('|');
                    const cantidadKg = parseInt(partes[0]?.trim(), 10) || 0;
                    const direccionLena = partes[1]?.trim() || null;
                    respuesta = respuesta.replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '').trim();

                    const histCliente = getCliente(remoteJid);
                    const nombreCliente = histCliente?.nombre || null;
                    const zonaCliente = histCliente?.zona || null;
                    const dirFinal = direccionLena || histCliente?.direccion || 'Sin dirección';

                    if (cantidadKg > 0 && cantidadKg <= LIMITE_INDIVIDUAL_KG) {
                        // Guardar dirección si se capturó
                        if (direccionLena) actualizarEstadoCliente(remoteJid, { direccion: direccionLena });
                        await agregarAColaLena(socket, remoteJid, nombreCliente, dirFinal, zonaCliente, cantidadKg);
                    } else if (cantidadKg > LIMITE_INDIVIDUAL_KG) {
                        console.log(`🚚 Pedido de ${cantidadKg}kg → entrega individual, no va a cola`);
                    }
                }

                // No enviar audio ElevenLabs si el cliente ya confirmó (está en proceso de pago)
                const estadoCliente = getCliente(remoteJid)?.estado;
                const audioHabilitado = estadoCliente !== 'confirmado';

                // [AUDIO_FIDELIZAR:frase] — audio espontáneo para generar confianza en charlas de texto
                const fidelizarMatch = respuesta.match(/\[AUDIO_FIDELIZAR:([^\]]+)\]/i);
                if (fidelizarMatch && audioHabilitado) {
                    const fraseFidelizar = fidelizarMatch[1].trim();
                    respuesta = respuesta.replace(/\[AUDIO_FIDELIZAR:[^\]]+\]\s*/i, '').trim();
                    await enviarAudioElevenLabs(sendBotMessage, remoteJid, fraseFidelizar);
                    await delay(1000);
                    console.log(`🎙️ Audio fidelización enviado a ${remoteJid}`);
                } else if (fidelizarMatch) {
                    respuesta = respuesta.replace(/\[AUDIO_FIDELIZAR:[^\]]+\]\s*/i, '').trim();
                }

                // Limpiar siempre el marcador [AUDIO_CORTO] del texto antes de enviarlo
                // El marcador solo puede contener máximo ~20 palabras; si Gemini metió más, es el texto completo
                let fraseAudioCorto = null;
                const audioCortoMatch = respuesta.match(/\[AUDIO_CORTO:([^\]]+)\]/i);
                if (audioCortoMatch) {
                    const contenido = audioCortoMatch[1].trim();
                    const palabras = contenido.split(/\s+/).length;
                    if (palabras <= 25) {
                        // Uso normal: frase corta
                        fraseAudioCorto = contenido;
                        respuesta = respuesta.replace(/\[AUDIO_CORTO:[^\]]+\]\s*/i, '').trim();
                } else {
                        // Gemini metió todo adentro — ignorar el marcador, usar texto completo
                        respuesta = respuesta.replace(/\[AUDIO_CORTO:([^\]]+)\]/i, '$1').trim();
                        console.log(`⚠️ AUDIO_CORTO demasiado largo (${palabras} palabras), usando como texto`);
                    }
                }

                // Si el cliente mandó AUDIO → solo audio corto, sin texto después
                let audioEnviado = false;
                if (tieneAudio && audioHabilitado) {
                    const histCliente = getCliente(remoteJid);
                    const nombre = histCliente?.nombre;
                    if (fraseAudioCorto) {
                        audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, fraseAudioCorto);
                    } else {
                        const fallback = nombre ? `Dale ${nombre}, ya te mando la info.` : `Dale, ya te mando la info.`;
                        audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, fallback);
                    }
                    if (audioEnviado) await delay(800);
                }

                // [IMG:servicio] — enviar imagen del catálogo si corresponde
                const imgMatch = respuesta.match(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/i);
                if (imgMatch) {
                    respuesta = respuesta.replace(/\[IMG:(lena|cerco|pergola|fogonero|bancos)\]/gi, '').trim();
                }

                // Si el cliente mandó una IMAGEN → solo audio, sin texto después
                if (tieneImagen && audioHabilitado && !audioEnviado) {
                    const textoParaAudio = respuesta
                        .replace(/\[COTIZACION:[^\]]+\]/gi, '')
                        .replace(/\[CONFIRMADO\]/gi, '')
                        .replace(/\[NOMBRE:[^\]]+\]/gi, '')
                        .replace(/\[DIRECCION:[^\]]+\]/gi, '')
                        .replace(/\[ZONA:[^\]]+\]/gi, '')
                        .replace(/\[METODO_PAGO:[^\]]+\]/gi, '')
                        .replace(/\[PEDIDO:[^\]]+\]/gi, '')
                        .replace(/\[PEDIDO_LENA:[^\]]+\]/gi, '')
                        .trim();
                    audioEnviado = await enviarAudioElevenLabs(sendBotMessage, remoteJid, textoParaAudio);
                    if (audioEnviado) await delay(800);
                }

                // Enviar texto:
                // - Si NO se envió audio → siempre mandar texto
                // - Si se envió audio Y hay imagen → mandar texto (la imagen necesita datos de referencia)
                // - Si se envió audio Y NO hay imagen → no mandar texto (el audio lo cubrió todo)
                // Si se envió audio, eliminar saludo del inicio del texto por código (defensa extra)
                let textoSinSaludo = respuesta.trim();
                if (audioEnviado || fidelizarMatch) {
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
                const debeEnviarTexto = !audioEnviado || (audioEnviado && hayImagen);
                console.log(`📝 Texto (${textoFinal.length} chars, audio=${audioEnviado}, img=${hayImagen}, enviar=${debeEnviarTexto}): "${textoFinal.substring(0, 100)}"`);
                if (debeEnviarTexto && textoFinal.length > 0) {
                    await sendBotMessage(remoteJid, { text: textoFinal });
                    // Log respuesta saliente en Firestore
                    const histClienteActualizado = getCliente(remoteJid);
                    firestoreModule.logMensaje({
                        jid: remoteJid,
                        tipo: 'texto',
                        contenido: textoFinal,
                        direccion: 'saliente',
                        marcadores: [
                            ...(imgMatch ? [`IMG:${imgMatch[1]}`] : []),
                            ...(/\[COTIZACION:/i.test(respuesta) ? ['COTIZACION'] : []),
                            ...(/\[CONFIRMADO\]/i.test(respuesta) ? ['CONFIRMADO'] : []),
                        ],
                        servicio: histClienteActualizado?.servicioPendiente || null,
                        clienteInfo: {
                            nombre: histClienteActualizado?.nombre,
                            estado: histClienteActualizado?.estado,
                            servicioPendiente: histClienteActualizado?.servicioPendiente,
                        },
                    }).catch(() => {});
                    // Sync cliente actualizado a Firestore
                    const telSync = getTel(remoteJid);
                    const clienteSync = getCliente(remoteJid);
                    if (clienteSync) {
                        firestoreModule.syncCliente(telSync, {
                            remoteJid,
                            nombre: clienteSync.nombre || null,
                            direccion: clienteSync.direccion || null,
                            zona: clienteSync.zona || null,
                            metodoPago: clienteSync.metodoPago || null,
                            estado: clienteSync.estado || 'nuevo',
                            servicioPendiente: clienteSync.servicioPendiente || null,
                            audioIntroEnviado: clienteSync.audioIntroEnviado || false,
                            pedidosAnteriores: clienteSync.pedidosAnteriores || [],
                        }).catch(() => {});
                    }
                } else {
                    console.log(`⚠️ Texto vacío, no se envía`);
                }

                // Enviar imagen del catálogo si se detectó [IMG:]
                if (imgMatch) {
                    const servicioKey = imgMatch[1].toLowerCase();
                    if (!session.imagenEnviada[servicioKey]) {
                        session.imagenEnviada[servicioKey] = true;
                        await delay(800);
                        await enviarImagen(remoteJid, servicioKey);
                    }
                }

                console.log(`✅ Respuesta Gemini enviada a ${remoteJid} (${tieneAudio ? '🎙️+💬' : tieneImagen ? '🖼️🎙️+💬' : '💬'})`);

            } catch (geminiError) {
                console.error('❌ Error llamando a Gemini:', geminiError.message);
                await sendBotMessage(remoteJid, {
                    text: `Disculpá, tuve un problema para procesar tu consulta. ¿Podés escribirme de nuevo? 🙏`
                });
            }

        } catch (globalError) {
            console.error('❌ CRASH en messages.upsert:', globalError.stack);
        }
    });

    // ============================================================
    // SEGUIMIENTO AUTOMÁTICO A LAS 24HS
    // Revisa cada 30 min si hay cotizaciones sin respuesta
    // ============================================================
    const VEINTICUATRO_HORAS = 24 * 60 * 60 * 1000;
    const INTERVALO_REVISION = 30 * 60 * 1000; // cada 30 minutos

    const enviarSeguimientos = async () => {
        const ahora = Date.now();
        for (const [tel, cliente] of Object.entries(clientesHistorial)) {
            try {
                if (
                    cliente.estado === 'cotizacion_enviada' &&
                    !cliente.seguimientoEnviado &&
                    cliente.remoteJid &&
                    cliente.fechaCotizacion
                ) {
                    const tiempoTranscurrido = ahora - new Date(cliente.fechaCotizacion).getTime();
                    if (tiempoTranscurrido >= VEINTICUATRO_HORAS) {
                        const servicio = cliente.servicioPendiente || 'lo que te enviamos';
                        const esLena = servicio === 'lena';
                        const nombre = cliente.nombre ? `${cliente.nombre}` : '';
                        const saludo = nombre ? `Hola ${nombre}` : 'Hola';
                        const cuerpo = esLena
                            ? `${saludo}, soy Vicky 😊 Quería saber qué te había parecido la cotización de leña que te enviamos. ¿Pudiste definir cuándo necesitás el pedido? 🪵`
                            : `${saludo}, soy Vicky 😊 Quería saber qué te había parecido el presupuesto que te enviamos. ¿Pudiste avanzar con la seña para reservar la fecha? 🙌`;

                        // Intentar enviar como nota de voz ElevenLabs, si falla enviar texto
                        const audioEnviado = await enviarAudioElevenLabs(sendBotMessage, cliente.remoteJid, cuerpo);
                        if (!audioEnviado) {
                            await sendBotMessage(cliente.remoteJid, { text: cuerpo });
                        }
                        cliente.seguimientoEnviado = true;
                        await saveHistorialGCS();
                        console.log(`📬 Seguimiento 24hs enviado a ${cliente.remoteJid} (${audioEnviado ? 'audio' : 'texto'})`);
                    }
                }
            } catch (errSeg) {
                console.error(`❌ Error enviando seguimiento a ${tel}:`, errSeg.message);
            }
        }
    };

    // Primera revisión 5 minutos después de arrancar, luego cada 30 min
    setTimeout(enviarSeguimientos, 5 * 60 * 1000);
    setInterval(enviarSeguimientos, INTERVALO_REVISION);
    console.log('⏰ Timer de seguimiento 24hs activo.');
}

connectToWhatsApp();
