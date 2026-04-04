# Reglas Vigentes — Vicky (WhatsApp) — Gardens Wood

Última actualización: 2026-04-02

## Objetivo del bot
- Filtrar consultas generales (curiosos) y guiar a un embudo de ventas.
- Armar cotizaciones cuando corresponda.
- **Hacer handoff a humano/asesor** cuando la cotización está lista (o cuando el operador lo decide en el panel).
- **No interferir** cuando hay un humano atendiendo.

## Principios de respuesta
- **Breve y directo**: responder lo mínimo necesario para avanzar al siguiente dato.
- **Emojis moderados**: 1–3 por mensaje como máximo (no en cada línea).
- **No duplicar saludos**: si la charla es fluida, seguir directo.
- **Ventana de saludo (6 h)**: si el cliente escribió hace **menos de 6 horas**, el contexto enviado a Gemini indica **no volver a saludar**; pasadas 6 horas sin mensaje, se permite un saludo breve.
- **No preguntar siempre “qué servicio”** si el cliente ya lo dijo o si el contexto lo indica.

## Comandos admin WhatsApp (`#silenciar` / `#silencio global`)
- Desde el **mismo número** Business, `#silenciar` y `#activar` deben reconocerse como comandos (no solo `#silencio global`). Si no hay confirmación del bot, revisá que el mensaje sea exactamente `#silenciar 549…` (número con país) o usá `!!silenciar` si WhatsApp altera el `#`.
- Tras *Vicky lista*, el destino puede ser `#12`, `12`, `el 12`, **`N12`**, **`n 12`**, **`nro 5`**, etc. (misma lógica para `#activar`, `#c`, etc.).
- **`#estado`** (o `!!estado`): resumen en WhatsApp de *bot* global (WhatsApp + Instagram DM) y lista de chats con silencio por contacto (Firestore: `humanoAtendiendo`, `silenciadoHasta`).

## Silencio / Intervención humana (regla operativa)
- Si `chats/{jid}.humanoAtendiendo == true` (o `silenciadoHasta` vigente), **Vicky no responde**.
- Si un humano responde desde el teléfono (mensaje `fromMe` que no es del bot), el bot se silencia **24 horas** en ese chat (fijo en código; el panel sigue pudiendo silenciar por `humanoAtendiendo` / `silenciadoHasta`). Los ecos recientes de mensajes **enviados por el bot** no deben marcar humano (ventana de gracia en código).
- El dashboard puede **silenciar/reactivar** el bot por chat.
- Mensaje **`adminoff`** (salir del modo admin por WhatsApp) **reactiva Vicky** en ese contacto: limpia silencio en Firestore y en memoria para el JID del chat y, si aplica, el `@s.whatsapp.net` asociado al mismo cliente (`@lid` / `telefono` en historial).

## Embudo: curioso vs interesado
### Curioso (consulta general)
Se considera “curioso” cuando:
- Pide precios en general sin medidas/cantidades/ubicación/uso, y sin intención de avanzar.

Regla:
- Responder con guía corta (precios/resumen) y pedir **1 dato clave** (medida/cantidad/zona/uso).
- **No** enviar cotización total ni marcadores de cotización.

### Interesado (intención)
Se considera “interesado” cuando:
- Menciona o implica: “presupuesto”, “cotización”, “avanzar”, “seña”, “reservar”, “hacerlo”, etc.

Regla:
- Si hay datos suficientes, enviar cotización completa con total.
- Al enviar cotización completa, disparar **handoff** para que siga un asesor.

## Reenvío a operación (datos de entrega en un mensaje)
- Cuando el cliente responde con **teléfono de contacto + dirección o zona + horario / franja** en **un solo mensaje**, Vicky debe agregar al final de su respuesta: **`[NOTIFICAR_DATOS_ENTREGA]`** (regla **21b** en `bot.js` → `SYSTEM_PROMPT`).
- El código quita el marcador al cliente y envía por WhatsApp al número **`config/general.datosEntregaNotifyPhone`** (o env `VICKY_DATOS_ENTREGA_NOTIFY_PHONE` / default). No aplica a Instagram DM.
- Si el instructivo operativo es solo Firestore `sistemaPrompt`, replicar esa regla ahí o el marcador no saldrá.

## Handoff a asesor (post-cotización)
- Marcador: `[HANDOFF_EXPERTO:razon]`
- Se usa **solo** cuando ya se envió cotización completa con total.
- Después del handoff, el bot queda silenciado en ese chat (`humanoAtendiendo = true`).
- Si en `config/general` está configurado `whatsappLabelIdContactarAsesor` (WhatsApp Business), el bot aplica esa etiqueta al chat (ej. “Contactar asesor”).

## Seña / datos bancarios (Vicky no los envía)
- Cuando el cliente confirma seña o avance, Vicky **no** debe pasar alias, CBU, titular ni CUIT por el chat.
- Debe indicar que ya tiene lo necesario y que **en breve un asesor se comunica** para ultimar detalles (pago incluido). Marcador interno: `[CONFIRMADO]` (igual que antes para estado en CRM).
- Texto base en código: `bot.js` → `SYSTEM_PROMPT` regla **17**. Si en Firestore `config/prompts.sistemaPrompt` reemplaza el prompt completo, hay que **replicar** esa regla ahí o volver a pegar el instructivo actualizado desde el panel.
- **Comprobantes de transferencia (regla 17b en `bot.js`):** Vicky **no** debe pedir foto/PDF del comprobante salvo que sea **cliente** con historial claro **y** **al menos una transferencia previa** constatada en contexto/CRM. Si el cliente manda comprobante por iniciativa propia, se agradece sin convertirlo en política de “siempre mandá comprobante”.

Excepción a “siempre cerrar con pregunta”:
- Si el mensaje incluye `[HANDOFF_EXPERTO:...]`, **no es obligatorio** cerrar con pregunta.

## Reporte de pedidos (operación)
- **Cuándo Vicky “es” pedido:** no hay un detector automático aparte del modelo. El instructivo (`sistemaPrompt` / regla 22 en código) pide que, cuando el cliente **confirmó** pedido u obra y ya hay datos, al **final** del mensaje agregue **`[PEDIDO:servicio|descripcion_breve]`**. El código (`vicky-gemini-turn.js`) parsea ese marcador, lo quita del texto al cliente y hace **`push`** en **`pedidosAnteriores`**. Para leña ≤200 kg con dirección existe además **`[PEDIDO_LENA:kg|dirección]`** (cola grupal; no reemplaza `[PEDIDO:…]` para el historial de pedido genérico salvo que también se use el flujo de cola). **`[CONFIRMADO]`** (regla 17) es cierre comercial con asesor; puede ir **sin** `[PEDIDO:…]` si el modelo no cerró con pedido explícito.
- Cuando Vicky incluye **`[PEDIDO:servicio|descripción]`**, el pedido se agrega a **`pedidosAnteriores`** (GCS + sync a Firestore `clientes/{id}`). Si Vicky no lo marcó: **panel** → **Registrar pedido manual** (`origenPanel`), o **WhatsApp admin**: comandos cortos **`#p lista`** (lista global numerada), **`#p+`tel** (alta inferida del hilo `chats/{jid}/mensajes` + Gemini), **`#p-`tel** (baja último pedido de ese cliente), **`#p N`** (baja ítem N de la última lista); o formato largo **`#pedido`** / **`#pedido del`**. El sync del bot **fusiona** `pedidosAnteriores` en Firestore al escribir desde el bot.
- **WhatsApp admin:** `#reporte` muestra el conteo con pedido en historial; **`detalle pedidos`** (o `#d pedidos`) lista contactos con último pedido. En **`#p lista`**, el número mostrado sale del campo **`telefono`** del cliente en Firestore o del JID si es un `@s.whatsapp.net` reconocible como celular; el id de doc puede ser un userId interno de WhatsApp (no es el celular) — entonces hace falta **teléfono en ficha** (panel o próximo sync del bot).
- **Panel:** **Clientes** → export CSV y columna de pedidos; ficha por teléfono con lista **Pedidos anteriores**. **Cola leña** para entregas grupales ≤200kg.

## No duplicación (garantía lógica)
- Dedupe por `msg.key.id` para evitar doble procesamiento por reintentos/reconexiones.
- Dedupe + silencio Firestore evita “dobles respuestas” cuando un operador toma el chat.

## Plantillas / fuentes de datos
- **Tono y reglas de conversación:** `config/prompts` → `sistemaPrompt` (panel Instrucciones AI).
- **Precios operativos:** colección Firestore `servicios/*`, editada en el panel **Precios y servicios**. El bot anexa esos datos al system prompt al arranque (`[DATOS_SERVICIOS_FIRESTORE]`); tras cambiar precios hay que **redeploy** de `vicky-bot`.
- Los PDFs y este documento son guía humana; si un número del PDF difiere de Firestore, **prevalece Firestore** en runtime.
- **Instagram (@gardens.wood):** mismo criterio que WhatsApp (precios, envíos, tono), sin decir que “solo” se atiende por otro canal.

