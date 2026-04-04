# Esquema Firestore — Vicky (webgardens-8655d)

Fuente de verdad para alinear bot, dashboard y archivos en [`firebase/`](../firebase/). El bot usa **Firebase Admin SDK** (no evalúa reglas de seguridad). El dashboard usa **Client SDK** (sí evalúa reglas).

## Colecciones

### `config` (documentos fijos)

| Documento | Campos principales | Escritura | Lectura bot |
|-----------|-------------------|-----------|-------------|
| `general` | `delayMinSeg`, `delayMaxSeg`, `modeloGemini`, `frecuenciaAudioFidelizacion`, `tiempoSilencioHumanoHoras`, `botActivo`, **`instagramDmActivo`**, `adminPhone`, **`datosEntregaNotifyPhone`**, horarios atención, `whatsappLabelIdContactarAsesor`, campañas (`campanaDelayMinSeg`, `campanaDelayMaxSeg`, `campanaMaxDestinatarios`, `campanaDescuentoPct`, `campanaRutaFechaTexto`, `campanaRutaPlantilla`), **`geocodeCronActivo`** (default true; si `false`, el POST cron geocode no escribe), **`geocodeCronMaxPorEjecucion`** (clientes por ejecución, default 30, tope servidor 80) | Panel → General | Cache 5 min al arranque; `#RUTA` y cron geocode leen flags con `bypassCache` donde aplica |
| `prompts` | `sistemaPrompt`, `mensajeBienvenidaTexto` | Panel → Instrucciones AI | Al arranque |

**Subcolección** `config/prompts/versiones/{id}` — historial de versiones del prompt (panel).

**Subcolección** `config/prompts/borradores/{borradorId}` — uso **histórico / panel**: el flujo actual de WhatsApp `#g` + *OK* **fusiona directo** en `config/prompts.sistemaPrompt` (sin pasar por esta subcolección). El panel puede seguir listando borradores viejos o crearlos por otras vías si aplica.

### `servicios/{servicioId}`

IDs alineados con el bot y el panel: `lena`, `cerco`, `pergola`, `fogonero`, `bancos`.

| Campo | Tipo | Uso |
|-------|------|-----|
| `nombre` | string | Etiqueta |
| `activo` | bool | Si `false`, el bloque inyectado indica no ofrecer |
| `tieneEnvio` | bool | Solo relevante típicamente para leña |
| `infoEnvio` | string | Texto de zonas/cargos |
| `precios` | array `{ descripcion, precio, unidad }` | Lista para el LLM |
| `marcador` | string | ej. `[IMG:lena]` |
| `ultimaActualizacion` | timestamp | Panel al guardar |

**Escritura:** panel Precios y servicios. **Lectura bot:** al arranque; se anexa al system prompt como `[DATOS_SERVICIOS_FIRESTORE]`. Tras cambiar precios, **redeploy o restart** de `vicky-bot` en Cloud Run.

### `chats/{jid}`

`jid` = JID de WhatsApp (ej. `549...@s.whatsapp.net`) **o** Instagram `ig:{scopedUserId}`.

| Campo | Notas |
|-------|--------|
| `ultimoMensaje`, `ultimoMensajeAt`, `mensajesCount`, `tel`, `nombre`, `estado`, `servicioPendiente`, `humanoAtendiendo`, `silenciadoHasta`, … | Bot + panel |
| `canal` | `instagram` cuando `jid` empieza con `ig:` (log al escribir mensajes) |

**Subcolección** `mensajes/{autoId}` — log de mensajes (contenido, tipo, dirección, timestamp, marcadores).

### `clientes/{tel}`

ID de documento: dígitos de línea WhatsApp (sin `@s.whatsapp.net`) **o** `ig:{scopedUserId}` para contactos Instagram. Sync desde bot + visualización/edición panel. Campos opcionales `canal` (`instagram`), `instagramUserId`, `remoteJid` (p. ej. `276…@lid` o `549…@s.whatsapp.net`).

| Campo CRM (opcional) | Tipo | Valores / notas |
|---------------------|------|-----------------|
| `telefono` | string (opcional) | Dígitos de la línea (suele coincidir con el id del doc cuando el chat es `@lid` mapeado). |
| `whatsappLid` | string (opcional) | Identificador LID sin `@lid`; enlaza la ficha `clientes/{tel}` con el hilo real del cliente. |
| `potencial` | string | `frío`, `tibio`, `caliente` |
| `statusCrm` | string | `pendiente_cotizacion`, `seguimiento`, `concreto`, `en_obra` |
| `urgencia` | string | `alta`, `media`, `baja` |
| `zona` | string | Texto libre; filtro campaña `#RUTA` |
| `interes` | array of string | ej. `pergolas`, `cercos`, `lena`, `mantenimiento`; `#RUTA` puede matchear servicio también por este array |
| `tipoLenaPreferido` | string (opcional) | `hogar`, `salamandra` o `parrilla`; el panel y filtros de logística; el bot puede actualizarlo al registrar `[PEDIDO_LENA:…\|tipo]` |
| `lat`, `lng` | number (opcional) | Coordenadas para mapa logístico y `#ruta_geo`; manual, **Guardar** desde pin ámbar en `/logistica-mapa`, o lote **`npm run geocode:clientes`** en el repo del bot (`scripts/geocodificar-clientes-direccion.js`). En la ficha **Cliente**, **Ver en mapa** abre **Logística — mapa** centrado (`/logistica-mapa?lat=…&lng=…&tel=…`). El mapa enlaza `tel` de la URL con el pin del CRM comparando **misma línea** (p. ej. `351…` en el query vs `549351…` en el id de Firestore: últimos 10 u 8 dígitos; Instagram `ig:` solo por id exacto). **Siempre dibuja el pin azul del cliente del enlace** aunque los filtros lo oculten. **Dedupe** por clave canónica (últimos 10 dígitos en WhatsApp) para un solo azul y sin ámbar/cola naranja encima. La cola y la búsqueda por tel resuelven con dígitos completos o clave corta. En esa pantalla, los pins **azul** (CRM) y **ámbar** (aprox. por dirección) se **arrastran**; los cambios quedan pendientes hasta **Guardar cambios** en la barra del mapa (o **Descartar movimientos** para volver a la última versión guardada). Recién entonces se escriben `lat`/`lng` en `clientes/{id}` y se **limpian** los parámetros `lat`/`lng`/`tel` de la URL (desaparece el refuerzo violeta si aún estaba). **Quitar pin:** botón rojo **Eliminar pin** en el **panel “Pin seleccionado”** (al hacer **clic** en un pin azul en `/logistica-mapa`). En Next.js no hay que poner `useSearchParams()` en las dependencias del efecto que redibuja Leaflet: reinstancia el objeto y dispara `clearLayers` en casi cada render (rompe arrastre, panel y popups). El mapa usa claves estables (`lat`/`lng`/`tel` como strings, `geocodeOkKey` solo para geocodificaciones OK) y `pendingByTel` solo por ref. |
| `direccion` | string (opcional) | Calle y número / dirección de entrega; `[DIRECCION:…]` o panel |
| `barrio` | string (opcional) | Barrio o sector; marcador `[BARRIO:…]` o panel |
| `localidad` | string (opcional) | Ciudad o localidad (ej. Villa Allende); `[LOCALIDAD:…]` o panel |
| `referencia` | string (opcional) | Entre calles, portón, lote; `[REFERENCIA:…]` o panel |
| `notasUbicacion` | string (opcional) | Otros datos para ubicar (acceso, horario en puerta); `[NOTAS_UBICACION:…]` o panel |

El geocodificador (cron / `npm run geocode:clientes`) arma la búsqueda con **dirección + barrio + localidad + zona + referencia + notas** (truncado) + Córdoba, Argentina.

El bot puede rellenar CRM con marcadores internos en Gemini: `[CRM:…]`, `[DIRECCION:…]`, `[ZONA:…]`, `[BARRIO:…]`, `[LOCALIDAD:…]`, `[REFERENCIA:…]`, `[NOTAS_UBICACION:…]` (se eliminan antes de enviar al cliente).

**Chats `@lid`:** el id interno del chat no es el celular. El bot carga `lid_mapeo/*` al arranque, aprende LID→tel desde `contacts.upsert` de Baileys, y escribe la ficha en `clientes/{dígitos línea}`. Asociación manual admin: WhatsApp `!vicky #p lidmap LID_DIGITS TEL_DOC` (ej. `543516170743`) o `npm run seed:lid-mapeo -- LID TEL` en el repo del bot.

### `lid_mapeo/{lid}`

Mapeo persistente **LID de WhatsApp** (solo dígitos, sin `@lid`) → **teléfono** usado como id de `clientes/{tel}`.

| Campo | Tipo | Notas |
|-------|------|--------|
| `telefono` | string | Dígitos (ej. criterio operativo `543516170743`). |
| `actualizadoEn` | Timestamp | Auditoría. |

### `datos_entrega_cliente/{id}`

Registro cuando el cliente envía en un mensaje teléfono + dirección + franja y el bot notifica operación (`[NOTIFICAR_DATOS_ENTREGA]` o heurística). Lista en el panel **Agenda de entregas**. No sustituye `entregas_agenda` (día en calendario): Vicky debe emitir `[ENTREGA:…]` cuando haya fecha cerrada (regla 21c en fallback `bot.js`).

| Campo | Tipo | Notas |
|-------|------|--------|
| `jid` | string | JID del chat (p. ej. `…@lid`). |
| `telefonoLinea` | string (opcional) | Dígitos resueltos para CRM. |
| `nombre` | string (opcional) | Si constaba en contexto. |
| `mensajeCliente` | string | Texto entrante (truncado servidor). |
| `origen` | string | `gemini_marcador` \| `heuristica`. |
| `estado` | string | ej. `recibido`. |
| `creadoEn` | Timestamp | |

### `rutas_logistica/{rutaId}`

Polilínea de reparto / corredor para campaña **geo** (`#ruta_geo` en WhatsApp admin). El panel crea y edita; el bot lee con Admin SDK.

| Campo | Tipo | Notas |
|-------|------|--------|
| `nombre` | string | Etiqueta humana (aparece en plantilla `{zona}` al enviar campaña geo). |
| `polyline` | array `{ lat, lng }` | Mínimo **2** puntos; orden = trazo de la ruta. |
| `bufferMetros` | number | Distancia máxima (metros) del cliente a la polilínea para incluirlo en la campaña. |
| `activa` | bool (opcional) | Referencia operativa; el filtro usa siempre el doc solicitado por id. |
| `creadoEn` | Timestamp (opcional) | Auditoría. |
| `creadoPorUid` | string (opcional) | Firebase Auth uid del admin. |
| `notas` | string (opcional) | Texto libre. |

**Campaña:** solo entran clientes con `lat`/`lng` válidos en `clientes/*` y dentro del corredor; mismos filtros de servicio/tipo leña y silencios que `#RUTA` por zona. Ver **Logística — ruta / campaña geo** en el dashboard.

### `mensajes_programados/{id}`

Mensajes a enviar en una fecha/hora (`runAt`), creados por lógica del bot (p. ej. marcador `[AGENDAR:…]`). Campos típicos: `jid`, `texto` o prompt, `runAt`, `estado` (`pendiente` \| `enviado` \| `error`), `creadoEn`, `origen`. El cron HTTP del servicio Cloud Run procesa pendientes y actualiza estado.

### `entregas_agenda/{id}`

Eventos de **entrega u obra con día concreto** para el calendario del panel (**Agenda de entregas**, `/agenda-entregas`). El bot puede crear filas con el marcador interno **`[ENTREGA:YYYY-MM-DD|HH:mm o --|título]`** (ver `vicky-gemini-turn.js` + regla en `bot.js`). **Modo admin WhatsApp:** **`#entrega YYYY-MM-DD HH:mm|-- título`** con **puente `#c`** al cliente (mismo chat objetivo) o, sin puente, empezando el título con el **JID** (`…@s.whatsapp.net` o `…@lid`) y un espacio antes del título; **`#entrega`** + **solo 10–15 dígitos** de teléfono (sin guiones) → el bot resuelve cliente (WhatsApp + `clientes/…`), lee últimos mensajes en Firestore + CRM y **Gemini** infiere `fechaDia` / hora / título (`origen`: `whatsapp_admin_entrega_gemini`); si no hay fecha clara, responde aviso y conviene carga manual. **Listado por WhatsApp:** **`#entrega lista`** — próximos eventos con `fechaDia` ≥ hoy (zona **America/Argentina/Cordoba**), sin canceladas; **`#entrega lista todas`** incluye canceladas. **Menú admin** (frase secreta sola → opción *3*): asistente por pasos (tel → línea `YYYY-MM-DD …` → *OK*) con `origen` **`whatsapp_admin_menu_entrega`**. Alias **`!!entrega`** si `#` lo altera WhatsApp. No confundir con **`#g`** (solo instructivo Gemini). El panel puede dar de alta manualmente o marcar **`hecha`** / **`cancelada`**.

| Campo | Tipo | Notas |
|-------|------|--------|
| `fechaDia` | string | `YYYY-MM-DD` (clave para consultas por mes). |
| `horaTexto` | string (opcional) | Texto libre corto, ej. `09:00`; vacío o `--` = día sin hora fija. |
| `titulo` | string | Resumen visible en el calendario. |
| `notas` | string (opcional) | Detalle interno. |
| `telefonoContacto` | string (opcional) | Teléfono en puerta si difiere del WhatsApp; el panel **Agenda** lo guarda al crear evento. |
| `direccion` | string (opcional) | Dirección operativa del día (copia; la ficha **Cliente** sigue siendo fuente CRM principal). |
| `producto` | string (opcional) | Producto y características a entregar (texto libre). |
| `jid` | string (opcional) | JID WhatsApp / `ig:…` para enlace al chat en el panel. |
| `kg` | number (opcional) | Kg si aplica. |
| `origen` | string | ej. `panel`, `gemini_entrega`, `whatsapp_admin_entrega`, `whatsapp_admin_entrega_gemini` (#entrega + solo tel → Gemini infiere fecha desde hilo), `whatsapp_admin_menu_entrega` (menú admin opción 3). |
| `estado` | string | `pendiente` \| `hecha` \| `cancelada`. |
| `creadoEn`, `actualizadoEn` | Timestamp | Auditoría. |

Verificación en consola o local: `npm run verify:cliente-agenda -- <dígitos>` (script en `scripts/verificar-cliente-agenda.js`) imprime `clientes/*` y filas de `entregas_agenda` con el mismo JID.

**No reemplaza** la cola grupal de leña (`colaLena`): pedidos ≤200 kg siguen en **Cola de leña** hasta que operativamente asignes un día (manual o con `[ENTREGA:…]`).

Si en **Instrucciones AI** reemplazás el `sistemaPrompt` completo en Firestore, copiá también la línea del marcador **`[ENTREGA:…]`** desde el fallback en `bot.js` (misma redacción que en producción), si no Gemini no lo emitirá.

La **regla 17b** del fallback en `bot.js` (comprobantes de transferencia: no pedirlos salvo cliente con al menos una transferencia previa documentada) forma parte del comportamiento operativo; si tu `sistemaPrompt` en Firestore **reemplaza** todo el texto, incorporá esa regla o redeploy solo alinea el arranque desde el archivo.

### `colaLena/{pedidoId}`

Pedidos pequeños de leña (≤200 kg por marcador); **fuente operativa del bot** sigue siendo `cola_lena.json` en GCS + RAM. Firestore es **espejo** para el panel **Cola logística de leña** y para marcar estados operativos.

| Campo | Tipo | Notas |
|-------|------|--------|
| `id` (doc) | string | Estable: `cola_{dígitosWhatsApp}` (mismo criterio que el tel en JID, sin `@s.whatsapp.net`). |
| `remoteJid` | string | JID WhatsApp del cliente. |
| `nombre`, `direccion`, `zona` | string | CRM / cola. |
| `cantidadKg` | number | Kg del pedido en cola. |
| `tipoLena` | string (opcional) | `hogar`, `salamandra` o `parrilla` si Gemini emitió `[PEDIDO_LENA:kg\|dir\|tipo]`. |
| `tel` | string (opcional) | Dígitos para búsqueda y display en panel. |
| `fechaPedido` | Timestamp | En Firestore; en GCS el JSON puede llevar ISO string. |
| `estado` | string | `en_cola` → `notificado` → `entregado` (panel puede actualizar estado). |
| `ordenRuta` | number (opcional) | 1…N cuando el bot alcanzó el umbral de kg y calculó la ruta; **no** aplica en `en_cola` (el sync del bot borra estos campos en Firestore para ítems en cola). |
| `rutaGrupoId` | string (opcional) | Identificador del lote al disparar la ruta (ej. `rg_{timestamp}`). |

**Escritura bot:** `syncColaLena` en lotes (≤400 docs por tanda), `merge: true`. No borra documentos de clientes que ya no están en el array en memoria (solo actualiza el snapshot enviado). Tras cada cambio de cola: GCS + sync; al conectar/reconectar WhatsApp, si hay pedidos, se vuelve a sincronizar.

### `adminWaSesion/{docId}`

Sesión del **modo admin por WhatsApp** (frase secreta, `#g`, puente `#c`, borrador Gemini, etc.) para que funcione con **varias réplicas** de Cloud Run: el estado no queda solo en memoria del contenedor.

| Campo | Notas |
|-------|--------|
| `remoteJid` | JID del chat donde se activó la sesión (ej. mismo número Business / “guardados” / admin). |
| `activadoEn` | `number` (ms) o Timestamp; validez **1 h** en código (`ADMIN_SESSION_TTL`). |
| `listaClientes` | mapa `{ "1": "jid", … }` para atajos numéricos. |
| `destinatarioPendiente` | `null` o `{ jid, etiqueta }` (flujo dos pasos). |
| `modoBridge`, `bridgeTarget`, `esperandoSelectorPuente` | Estado puente / lista (sí se replica). |
| `ultimoReporteIndice`, `ultimoReporteAt` | Tras *#reporte*: agregados para interpretar *detalle caliente*, *detalle estado X*, *detalle servicio Y*, *detalle log*. |
| `pListaIndex` | Cache de ítems para *#p lista* (sí se replica). |
| `esperandoMenuPrincipal` | Tras la frase secreta **sin** texto cola: menú numerado hasta elegir 1–4 o un comando con *#*. |
| `wizard` | Asistente por pasos (ej. `tipo: agenda_entrega`, `paso: tel \| detalle \| confirmar`, `jid`, fechas); se replica entre réplicas. |
| `esperandoInstructivoGemini`, `borradorGeminiPreview` | **No** se guardan en este doc (solo RAM del contenedor). Con *OK*, el bot escribe en `config/prompts.sistemaPrompt` y recarga Gemini en ese proceso. |

**Escritura:** solo el bot (Admin SDK). El panel no lee esta colección. Las reglas de cliente pueden denegar acceso; el Admin SDK no las aplica.

### `mensajes_log/{autoId}`

Log agregado para métricas (dashboard home). Campos: `jid`, `tipo`, `dirección`, `servicio`, `timestamp`.

### `usuarios/{uid}`

Gestión de usuarios del panel (Firebase Auth uid).

## Índices versionados

Archivo [`firebase/firestore.indexes.json`](../firebase/firestore.indexes.json) incluye compuestos necesarios para:

- `mensajes_programados`: consulta por `estado` + `runAt` (cron de envíos).
- `config/prompts/borradores`: `estado` + `creadoEn` descendente (panel).

Si la consola sugiere otro índice compuesto, agregalo ahí y volvé a `firebase deploy --only firestore`.

Si al desplegar aparece que hay índices en la nube que no están en el archivo, es opcional alinearlos con `firebase deploy --only firestore --force` (borra índices extra en el proyecto; usalo solo si sabés qué se elimina).

## Reglas de seguridad

[`firebase/firestore.rules`](../firebase/firestore.rules): lectura/escritura para `request.auth != null` en colecciones del panel; reglas específicas para `borradores` y `mensajes_programados` según el archivo. Endurecer con custom claims si abrís registro público.

## Despliegue desde Git

Ver [RUNBOOK_DEPLOY.md](../RUNBOOK_DEPLOY.md) — sección Firestore, cron y workflow GitHub.
