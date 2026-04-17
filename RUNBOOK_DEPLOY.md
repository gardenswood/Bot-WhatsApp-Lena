# Runbook de Deploy y Verificación — Vicky Bot + Dashboard

## Objetivo
Checklist rápida para desplegar cambios sin romper:
- Bot WhatsApp (`vicky-bot` en Cloud Run)
- Dashboard (`vicky-dashboard` en Cloud Run)
- **Kontrolpro** (SPA Vite en el mismo proyecto GCP que Vicky; Supabase como base del ERP)
- Firestore (reglas, índices, datos: `config/*`, `servicios/*`, etc.)

### Kontrolpro + Vicky (`#kp`)
- **Directo:** en Cloud Run → `KONTROLPRO_SUPABASE_URL` y `KONTROLPRO_SUPABASE_SERVICE_ROLE_KEY` (no la `anon`).
- **Lovable Cloud / sin pegar service_role en el bot:** `KONTROLPRO_PROXY_URL` (POST a la Edge Function) + `KONTROLPRO_PROXY_SECRET` (= `EXTERNAL_API_KEY` en Lovable). Plantilla: `kontrolpro/plan-wizardry-forge-main/supabase/functions/kontrolpro-bridge-vicky/index.ts`. Guía: [docs/KONTROLPRO_LOVABLE_PROXY.md](docs/KONTROLPRO_LOVABLE_PROXY.md).
- Sin ninguna de las dos opciones, `#kp` indica que falta configuración.
- Tras cambios en `kontrolpro-bridge.js` / `kontrolpro-admin.js` / `bot.js`: **redeploy `vicky-bot`** e instalar dependencia `@supabase/supabase-js` (`npm install` en la raíz del repo antes del build Docker).
- En el front Kontrolpro: `VITE_VICKY_DASHBOARD_URL` = URL HTTPS del dashboard Firebase (build `.env`); el botón **Vicky booth** abre esa URL en pestaña nueva.
- **Contexto Kontrolpro en conversación cliente (Gemini):** con las mismas variables Supabase en `vicky-bot`, cada turno WhatsApp puede inyectar datos de **ventas / saldo / trabajo programado / entrega** si el `clients.phone` en Supabase coincide con el número del chat (y LID mapeado a tel). Solo lectura; desactivar con `VICKY_KONTROLPRO_CONTEXTO_CLIENTE=0`. Log: `VICKY_LOG_KONTROLPRO_CLIENTE=1`.

### Checklist definitivo (Kontrolpro + bot)

1. **Cloud Run → servicio `vicky-bot` (región `us-central1`)**  
   Tras `gcloud run deploy …` o `npm run deploy`, la URL pública suele ser `https://vicky-bot-<hash>.us-central1.run.app` (ver consola o salida del comando).  
   **Variables para `#kp` y contexto cliente** (elegí **directo** *o* **proxy**, no hace falta ambos):  
   | Variable | Uso |
   |----------|-----|
   | `KONTROLPRO_SUPABASE_URL` + `KONTROLPRO_SUPABASE_SERVICE_ROLE_KEY` | Conexión directa (URL + *service_role* del proyecto). |
   | `KONTROLPRO_PROXY_URL` + `KONTROLPRO_PROXY_SECRET` | Edge Function en Lovable/Supabase; el secreto = `EXTERNAL_API_KEY` en Lovable. Ver [docs/KONTROLPRO_LOVABLE_PROXY.md](docs/KONTROLPRO_LOVABLE_PROXY.md). |
   Opcionales: `VICKY_KONTROLPRO_CONTEXTO_CLIENTE=0` (apagar bloque Gemini cliente), `VICKY_LOG_KONTROLPRO_CLIENTE=1` (logs `[kontrolpro-cliente]`).  
   En consola: **Cloud Run** → `vicky-bot` → **Editar y desplegar nueva revisión** → **Variables y secretos** → añadir/editar → **Desplegar**. Si ya existían, un deploy por CLI **suele conservarlas**; igual conviene verificar tras cada despliegue.

2. **Kontrolpro (SPA)**  
   En `kontrolpro/plan-wizardry-forge-main/`: `.env` con `VITE_SUPABASE_*` (anon/public) según el proyecto Lovable, más **`VITE_VICKY_DASHBOARD_URL`** = URL HTTPS del panel Firebase (`vicky-dashboard`). Luego `npm run build` y publicar el contenido de **`dist/`** en el hosting que uses (Firebase Hosting, Cloud Run estático, Lovable, etc.). Sin ese build + deploy, el código nuevo del sidebar no llega a la URL pública.

3. **Dashboard Firebase (`vicky-dashboard`)**  
   Solo hace falta redeploy si cambiaste código en `dashboard/`; no es requisito para Kontrolpro en Supabase.

## Tabla maestra: campo → panel → bot → reinicio

| Dónde en Firestore | Ruta en panel | Efecto en el bot | ¿Reinicio / redeploy? |
|--------------------|---------------|------------------|------------------------|
| `config/prompts` → `sistemaPrompt` | Instrucciones AI | Instrucción base de Vicky (tono, reglas). Al leer Firestore, `firestore-module.js` puede **omitir párrafos** (bloques separados por línea en blanco) que parezcan instructivo inmobiliario ajeno; revisá consola y el panel si ves avisos. Después: precios `servicios/*`, anexos **ubicación**, **nombre en saludo**, **cola leña** y **cierre exclusión inmobiliaria** (`SYSTEM_PROMPT_SUFIJO_EXCLUSION_INMO_OTROS` en `bot.js`). | Sí: redeploy `vicky-bot` si cambia el anexo en código |
| `config/prompts` → `mensajeBienvenidaTexto` | Instrucciones AI | Texto tras audio de bienvenida | Sí: redeploy bot |
| `config/prompts` → `mensajeClienteCierreEntregaHumano` | Instrucciones AI → **Cierre entrega** | WhatsApp al cliente cuando admin manda `#final_entrega` | Sí: redeploy bot si cambia código; el texto en Firestore se lee al ejecutar el comando |
| `config/prompts` → `instruccionCierreEntregaHumanoGemini` | Instrucciones AI → **Cierre entrega** | Bloque extra a Gemini mientras `chats/{jid}.cierreEntregaAsistido` | Igual; lectura por turno |
| `config/general` | General | Delays, modelo Gemini, audio fidelización, `botActivo`, **`instagramDmActivo`**, `whatsappLabelIdContactarAsesor`, campañas `#RUTA`, **cron geocode** (`geocodeCronActivo`, `geocodeCronMaxPorEjecucion`), **`whatsappGrupoJidAgendaEntregas`** + **`notificarAgendaEntregasGrupoActivo`** (aviso grupo WA por cada alta en `entregas_agenda`; caché ~5 min) | Sí: redeploy bot si cambia código; JID grupo / flags agenda suelen aplicar sin redeploy |
| `config/prompts/borradores/*` | Borradores prompt (legado) | WhatsApp `#g` + *OK* aplica **directo** a `sistemaPrompt` (bot + recarga Gemini en esa instancia). La subcolección puede quedar para borradores viejos o flujo panel | No |
| `mensajes_programados/*` | **Agenda de entregas** (`/agenda-entregas`) junto con `entregas_agenda` | Mensajes diferidos (`[AGENDAR:…]`); envío vía cron HTTP | No (bot + Scheduler) |
| `entregas_agenda/*` | **Agenda de entregas** (`/agenda-entregas`) | Vicky: `[ENTREGA:…]` → fila; panel: alta/edición; bot puede enviar resumen al grupo configurado en `config/general` | Sí: redeploy `vicky-bot` si cambia lógica de avisos/parser |
| `clientes/{tel}` campos CRM | Ficha cliente | `potencial`, `statusCrm`, `urgencia`, `interes[]`, `zona`, **`direccion`**, **`barrio`**, **`localidad`**, **`referencia`**, **`notasUbicacion`** (mapa + geocode Nominatim), **`lat`/`lng`**, **`tipoLenaPreferido`** (filtro `#RUTA` y mapa); el bot rellena ubicación con marcadores `[DIRECCION:…]`, `[ZONA:…]`, `[BARRIO:…]`, etc., y `[PEDIDO_LENA:…]` para dirección leña | No |
| — | **Mapa logística** (`/logistica-mapa` en dashboard) | Pins azules si hay `lat`/`lng` en ficha; opción **Ubicar por dirección** (geocodificación aproximada OpenStreetMap, pins ámbar, botón guardar en ficha); overlay `colaLena`; filtros por zona/servicio/tipo/estado. **No** se obtiene ubicación solo con el teléfono. | No |
| `rutas_logistica/{id}` | **Logística — ruta / campaña geo** (`/logistica-ruta`) | Polilínea + `bufferMetros`; preview de clientes en el corredor. WhatsApp admin: `#ruta_geo <idDoc> <producto>` (misma semántica de producto/tipo leña que `#ruta`). Misma plantilla/delays que `#RUTA`. | Sí: redeploy `vicky-bot` si cambia lógica; reglas Firestore si nueva colección |
| `servicios/*` | Precios y servicios | Precios y envío inyectados al prompt (`[DATOS_SERVICIOS_FIRESTORE]`) | Sí: redeploy bot tras cambiar precios |
| `chats/{jid}` (silencio) | Detalle de chat | Silenciar / reactivar bot (`jid` puede ser WhatsApp o `ig:{id}`); **`cierreEntregaAsistido`** por flujo `#final_entrega` | No (lectura en caliente + cache corto) |
| `colaLena/*` | Cola logística de leña | Espejo GCS ↔ Firestore: pedidos `[PEDIDO_LENA:…]` desde Vicky **o alta manual** WhatsApp admin `#cola_lena` + tel (nombre/dirección/zona/tipo desde CRM si hay; kg inferido del historial o **0** pendiente), o con puente `#c` → `#cola_lena` solo. Sin puente, `#cola_lena` solo = ayuda. `!!cola_lena` si falla el `#`. Cuando la suma de kg `en_cola` ≥ **`config/general.colaLenaUmbralDisparoRutaKg`** (default 1000, alineado a `colaLenaCapacidadCamionKg`), el bot arma **ruta optimizada** (Google **Directions** `optimize:true` si la API key tiene Directions habilitado; si no, vecino más cercano con `lat`/`lng` del CRM o matriz desde Villa Allende) y avisa al admin (`adminPhone` / `ADMIN_PHONE`). | Sí: **redeploy `vicky-bot`** si cambiás lógica de cola o `syncColaLena` |
| `tiempoSilencioHumanoHoras` | General | **No** cambia el silencio 24 h por mensaje humano desde teléfono (fijo en código); puede usarse como referencia futura | — |

**Visitas técnicas a domicilio:** el instructivo base en código (`bot.js`, regla **T7** del `SYSTEM_PROMPT` y la ancla `SYSTEM_PROMPT_ANCLA_IDENTIDAD`) indica que Vicky **no** debe ofrecer ni agendar idas a medir desde el chat. Si `config/prompts.sistemaPrompt` en Firestore tiene texto antiguo que contradice eso, alinearlo desde el panel **Instrucciones AI**; si no, Gemini puede priorizar el texto del panel.

Documento detallado: [docs/FIRESTORE_SCHEMA.md](docs/FIRESTORE_SCHEMA.md).

## Equipo stand WhatsApp Lena — Cursor (skill de flujos)
Para que Cursor sugiera buenas prácticas al **optimizar automatizaciones y flujos** (Vicky, handoff, delays, deploy):
1. Clonar o actualizar este repo (`Bot_WhatsApp_Lena`).
2. Abrir la **carpeta raíz del repo** en Cursor (Archivo → Abrir carpeta).
3. El skill del proyecto vive en `.cursor/skills/whatsapp-workflow-optimization/SKILL.md`; el agente lo usa cuando hablás de mejorar flujos, errores duplicados, silencio humano o cambios que afecten bot + panel.

**Requisito**: cada persona necesita Cursor instalado y acceso al repo (Git). No sustituye el panel admin para el día a día; sirve sobre todo cuando pedís ayuda al agente para cambios de código o diseño de flujo.

## 1) Cambios de configuración (sin tocar código)
### Prompts (comportamiento)
- Panel → `Instrucciones AI` (`/config/prompts`)
  - Editar `sistemaPrompt`
  - Editar `mensajeBienvenidaTexto` si aplica
  - Guardar (genera historial de versiones)

### Config general
- Guía panel ↔ Firestore ↔ bot (recuperación, historial de prompts, redeploy): [`docs/CONFIGURACION_PANEL_Y_BOT.md`](docs/CONFIGURACION_PANEL_Y_BOT.md).
- Panel → `General` (`/config/general`)
  - `delayMinSeg`, `delayMaxSeg`
  - **`debounceChatSeg`**, **`debounceChatMaxMensajes`** — varios textos seguidos del cliente en WhatsApp se fusionan en un solo turno Gemini (default ~3 s y 3 mensajes). `debounceChatSeg: 0` apaga. Env en Cloud Run: **`VICKY_CHAT_DEBOUNCE_MS`**, **`VICKY_CHAT_DEBOUNCE_MAX_PARTES`** (pisan Firestore si están definidos).
  - `modeloGemini` — id en Gemini API (default en código: `gemini-3.1-flash-lite-preview`). Opcional en Cloud Run: **`GEMINI_MODEL`** pisa Firestore/panel si necesitás forzar otro id sin editar `config/general`.
  - `tiempoSilencioHumanoHoras`
  - `botActivo`
  - **DMs Instagram:** `instagramDmActivo` — si está en *false*, Vicky no responde por Instagram (WhatsApp sigue gobernado por `botActivo`). Requiere variables de entorno del webhook en Cloud Run (ver §2d). **`instagramDmSoloEnlaceWhatsapp`** (default *true*): solo responde con texto + `https://wa.me/…` (sin Gemini); desactivar para volver a IA. **`whatsappAtencionCliente`** (dígitos) o env **`VICKY_WHATSAPP_LINK_DIGITS`** definen el enlace.
  - **Etiqueta WhatsApp Business — “Contactar asesor”:** campo `whatsappLabelIdContactarAsesor` (ID interno de la etiqueta que creás en la app Business). Al handoff (`[HANDOFF_EXPERTO]`), el bot llama `addChatLabel` en ese chat. Para descubrir el `id`: **con el bot apagado**, `npm run labels:discover` (fuerza `resyncAppState` y escucha ~90 s; lista `id="…" name="…"`); o arrancá el bot con `VICKY_LOG_LABELS=1`: al abrir WA hace **resync de app state** (~2,5 s) y luego deberían verse líneas `[VICKY_LOG_LABELS] etiqueta → …` (el bot usa historial sync desactivado y sin eso Baileys a veces no traía etiquetas). Requiere cuenta **WhatsApp Business** vinculada al bot.
  - **Campañas (#RUTA):** delay mín/máx entre mensajes Baileys, tope de destinatarios y % de descuento en el texto. Twilio masivo (plantilla) es opcional vía variables de entorno en Cloud Run (ver `.env.example`).
  - **WhatsApp operación — datos de entrega:** `datosEntregaNotifyPhone` (dígitos, ej. `5493512956376`). Cuando el cliente manda en un solo mensaje teléfono de contacto + dirección/zona + franja horaria, Vicky (vía regla del system prompt) agrega `[NOTIFICAR_DATOS_ENTREGA]` y el bot reenvía **el texto del cliente** a ese WhatsApp. Vacío en panel → usa `VICKY_DATOS_ENTREGA_NOTIFY_PHONE` en Cloud Run o el default del código. **Redeploy** `vicky-bot` tras cambiar el campo. Si `config/prompts.sistemaPrompt` en Firestore **reemplaza** el prompt completo, hay que **añadir la misma regla** allí (ver `bot.js` regla **21b**) o el modelo no emitirá el marcador.
  - **Grupo WhatsApp — agenda de entregas:** `whatsappGrupoJidAgendaEntregas` puede ser **JID** `…@g.us`, **enlace** `https://chat.whatsapp.com/…` o **código** de invitación (el bot resuelve a JID al avisar). Toggle `notificarAgendaEntregasGrupoActivo` (default true). Cada **alta** en `entregas_agenda` (panel, `[ENTREGA:…]`, `#entrega` admin) dispara un mensaje resumen en ese grupo; la sesión del bot debe ser miembro del grupo. Fallback env: `WHATSAPP_GRUPO_JID_AGENDA_ENTREGAS`. El JID y el toggle de avisos se leen **sin el caché de 5 min** en cada envío al grupo (el resto de `config/general` sigue con caché). El texto del aviso **prioriza 📞** (`telefonoContacto` + tel en `clientes/*` vía JID) y **no muestra la línea 💬 Chat** si ya hay tel o si el JID es `@lid` sin número claro (indica revisar panel/CRM). **Diagnóstico:** en logs de Cloud Run buscá `[agenda-grupo]` (falta JID, toggle off, `groupMetadata` o error de envío) y `sendBotMessage … (grupo …)`. **Cómo obtener el JID del grupo:** con el bot apagado y sesión en `auth_info_baileys`, `npm run wa:grupo-jid -- --list` o `npm run wa:grupo-jid -- --invite CODIGO` (código del enlace `chat.whatsapp.com/…`); ver `scripts/whatsapp-grupo-jid.js` y `docs/FIRESTORE_SCHEMA.md`.
  - Guardar

**Nota**: el bot aplica la config al arrancar. **Silencio por humano desde el teléfono**: siempre **24 h** en código (no depende de `tiempoSilencioHumanoHoras`). Cada mensaje saliente **desde la cuenta del negocio** que **no** es el eco de un envío de Vicky (mismo criterio: id en `BOT_MSG_IDS`) marca `humanoAtendiendo` en Firestore y silencia; **no** hay ventana de gracia por tiempo (así también silencia si el humano escribe poco después de un mensaje del bot). El panel sigue pudiendo silenciar con `humanoAtendiendo` / `silenciadoHasta`. Tras **`#activo global`** o reactivar en panel, Firestore queda bien; el código **alinea la sesión en RAM** con `getChatSilenceState` en cada mensaje entrante para que un flag `humanoAtendiendo` viejo en memoria no bloquee si `chats/{jid}` ya está limpio (Cloud Run, réplicas o estado previo). **Instructivo en Firestore:** si `config/prompts.sistemaPrompt` quedó con texto de otro negocio (p. ej. inmobiliaria), revisalo en el panel (o historial de versiones); el código **anteponde** «IDENTIDAD GARDENS WOOD», **filtra** párrafos inmobiliarios obvios al cargar y **cierra** con un bloque fijo que prohíbe mezclar ese rubro. Igual conviene dejar el doc del panel limpio.

**Cliente vs admin:** los mensajes entrantes pasan primero por el filtro admin; el texto **normal** del cliente debe continuar al flujo Vicky (Gemini). Si el admin responde pero el cliente no, revisá `botActivo`, silencio en `chats/*` y logs (`VICKY_LOG_INCOMING=1`).

### Geocodificar `lat`/`lng` en lote (CLI, dirección + zona en CRM)

Para no ir cliente por cliente en el mapa del panel, podés rellenar coordenadas desde **`direccion`** (y `zona` si existe) con Nominatim (~1 solicitud/seg):

```powershell
cd "Bot_WhatsApp_Lena"
gcloud auth application-default login
npm run geocode:clientes
```

Opciones: `--max=50` (tope por corrida), `--dry-run` (no escribe Firestore), `--force-regeocode` (aunque ya tengan coords). Script: [`scripts/geocodificar-clientes-direccion.js`](scripts/geocodificar-clientes-direccion.js). Alternativa: credenciales `FIREBASE_ADMIN_*` como en el seed del dashboard.

**Automático en la nube (recomendado):** Cloud Scheduler → `POST` a `https://<URL_vicky-bot>/internal/cron/geocode-clientes` con la misma cabecera `Authorization: Bearer <VICKY_CRON_SECRET>` que los otros crons. Panel → **General**: **`geocodeCronActivo`** (activar/desactivar) y **`geocodeCronMaxPorEjecucion`** (cuántos clientes sin coords procesar por ejecución, máx. 80 en servidor). Sin Scheduler configurado, la ruta no se ejecuta sola. Tras **cambiar código** del endpoint, redeploy `vicky-bot`.

**Delays**: el estado “escribiendo…” dura al menos **~26 s** (el bot no aplica valores más bajos aunque el doc de Firestore diga 5–10). Valores sugeridos en `config/general`: `delayMinSeg` 26, `delayMaxSeg` 34 (~30 s de promedio).

**Audio de fidelización**: desactivado por defecto (`0` o ausente). Solo se activa si ponés **≥ 18** en `frecuenciaAudioFidelizacion` (cada N mensajes de texto, hasta 99). Valores viejos del panel menores a 18 **no** disparan audio.

**Flujo**: primero termina el delay de escritura, **después** se llama a Gemini (la respuesta tarda más en llegar, se siente más humano).

### Precios y servicios (sin tocar código)
- Panel → **Precios y servicios** (`/config/precios`): editá montos, unidades, texto de envío, servicio activo/inactivo.
- Guardá con **Guardar todos**.
- **Redeploy** de `vicky-bot` en Cloud Run para que cargue los precios nuevos (se leen al arranque).

## 1b) Firestore: reglas e índices (Git → nube)

En el repo del bot están versionados:
- [`firebase/firestore.rules`](firebase/firestore.rules)
- [`firebase/firestore.indexes.json`](firebase/firestore.indexes.json)
- [`firebase.json`](firebase.json) y [`.firebaserc`](.firebaserc)

**Primer uso / si la consola tenía reglas distintas:** compará con lo que hay en Firebase Console antes de sobrescribir.

**Local (con Firebase CLI y proyecto ya vinculado):**

```powershell
cd "Bot_WhatsApp_Lena"
firebase deploy --only firestore --project webgardens-8655d
```

**GitHub Actions:** workflow `Deploy Firestore (reglas e índices)` al pushear cambios bajo `firebase/`. Requiere el secret **`FIREBASE_TOKEN`**.

- **Generar el token (solo en tu PC, con consola interactiva):** desde la raíz del repo del bot:
  ```powershell
  .\scripts\generar-firebase-token-ci.ps1
  ```
  O manualmente: `firebase login:ci --no-localhost` (abrís el enlace, iniciás sesión; el token lo pegás en GitHub → Settings → Secrets → `FIREBASE_TOKEN`).
- **No se puede generar desde un agente automático:** Firebase exige tu login en el navegador.

Los índices nuevos pueden tardar en construirse en la consola.

## 2) Cambios de base de conocimiento / PDFs
Fuente de verdad:
- `docs/reglas_vicky_vigentes.md`

Regenerar PDFs (Windows / local):

```powershell
cd "Bot_WhatsApp_Lena"
npm run docs:pdf
```

Actualiza:
- `Instrucciones de atencionOK.pdf`
- `base de datos leña.pdf`
- `Base de datos de cercos.pdf`
- `Base de datos Pergolas y Sector Fogonero .pdf`

## 2b) Vincular WhatsApp (QR o código numérico)

El **código de 8 caracteres no sale del archivo `qr.png`**: WhatsApp lo genera en el momento con Baileys.

**Opción A — Código numérico** (recomendado si el QR marca “inválido”):

1. En la PC donde corrés el bot, definí tu número **solo dígitos**, con código de país. Argentina móvil: `54` + `9` + código de área + número (ej. `5493512345678`).
2. Borrá o renombrá la sesión local rota si hace falta (`auth_info_baileys/` o bajá limpio desde GCS según tu procedimiento).
3. Definí el número: copiá `.env.example` a **`.env`** y poné `WHATSAPP_PAIRING_PHONE=...` (solo dígitos), **o** en PowerShell: `$env:WHATSAPP_PAIRING_PHONE = "549..."`. El bot carga `.env` al arrancar si existe.
4. Ejecutá:
   ```powershell
   cd "Bot_WhatsApp_Lena"
   node bot.js
   ```
5. En la consola aparece `CÓDIGO DE VINCULACIÓN (8 caracteres): XXXXXXXX`. En el celu: **Dispositivos vinculados → Vincular con número de teléfono** e ingresá ese código.
6. Cuando veas `VINCULADO!`, esperá a que suba `creds.json` a GCS y recién ahí redeploy de Cloud Run si usás el bot en la nube.

**Opción B — QR:** no definas `WHATSAPP_PAIRING_PHONE`; escaneá el QR de la consola o `qr.png`.

**Reconexiones:** si el socket de WhatsApp se cae y vuelve, el bot ya **no** reinicializa Firestore/Gemini ni duplica el timer de seguimiento 24 h; en consola verás sobre todo `Reconexión WhatsApp…` y `WhatsApp reconectado.` Los mensajes que llegan en cola **offline** también se procesan (tipo `append` en Baileys).

**Reporte clientes/pedidos (admin WhatsApp):** `#reporte` incluye **mensajes entrantes del día** (hora Córdoba) agrupados por `servicio` del log, además del CRM. `detalle mensajes hoy` / `#d mensajes hoy` lista los chats con más mensajes entrantes hoy. También podés pedir por voz/texto en modo admin que Gemini devuelva `[REPORTE_MENSAJES_HOY]`. Incluye cuántos tienen historial de pedido (`pedidosAnteriores`, cuando Vicky cerró con `[PEDIDO:servicio|descripción]`). Después: `detalle pedidos` o `#d pedidos` lista esos contactos (último pedido, zona, dirección si hay). Si Vicky no puso el marcador: **panel** → ficha **Cliente** → **Registrar pedido manual**, o por WhatsApp admin: `#pedido lista` *destino* (numerados); `#pedido` *destino* `|` *servicio* `|` *descripción* (agregar); `#pedido del` *destino* `|` *n* o `último` (borrar). Ej. `#pedido 5493512345678 | lena | 300kg`, `#pedido del 5493512345678 | 2`. Complemento: **Clientes** (CSV) y **Cola leña** ≤200kg.

**Cola de leña — alta manual (`#cola_lena`):** sesión admin. Solo `#cola_lena` (sin más texto) muestra el formato. Con datos: `#cola_lena` + tel (549… o `+54 9 …`), o `#n`/nombre como en `#c`, + **kg** + opcional `hogar`/`salamandra`/`parrilla` + opcional `| dirección`. Con **puente** `#c` al cliente: `#cola_lena 100` o `#cola_lena 100 hogar | …`. Misma persistencia que `[PEDIDO_LENA:…]` (GCS + Firestore `colaLena/*`). `!!cola_lena` si WhatsApp altera el `#`.

**Pedidos admin cortos (*#p*):** `#p lista` muestra teléfono **legible** desde el campo `telefono` del cliente en Firestore o JID `@s.whatsapp.net` coherente; si el id interno de WA no es el celular, verás *sin celular en ficha* → completá en **panel Cliente** o esperá el próximo `sync` del bot. `#p+` / `#p-` / `#p N` como arriba.

**Cierre entrega tras humano (`#final_entrega`):** con sesión admin, `#c` al cliente y luego `#final_entrega` *solo*, o **`#final_entrega` + nombre/tel/`#n` en el mismo mensaje** (tiene **prioridad** sobre el puente). El número puede ir pegado al comando (`#final_entrega5493517…`). Resolución de tel: primero **Firestore `clientes/*`** (misma lógica que agenda), luego variantes AR con `onWhatsApp`. La confirmación al admin muestra el **JID/número de envío** para verificar. `!!final_entrega` si WhatsApp altera el `#`. Solo **quita** `humanoAtendiendo` en `chats/{jid}` (no borra `silenciadoHasta` del panel), marca `cierreEntregaAsistido`, envía al cliente el texto de `config/prompts.mensajeClienteCierreEntregaHumano` (panel **Instrucciones AI** → pestaña **Cierre entrega**) y Vicky recibe `instruccionCierreEntregaHumanoGemini` hasta que persista `[ENTREGA:…]` en agenda; entonces se limpia el flag. Solo WhatsApp (no `ig:`). **Redeploy** `vicky-bot` y `vicky-dashboard` si cambiás código o UI del panel.

**Modo admin por WhatsApp:** el dueño entra con el prefijo `ADMIN_SECRET` en `.env` (Cloud Run / local). **Salir:** mensaje exacto `ADMIN_EXIT_COMMAND` (default `adminoff`) o `#salir` / `#SALIR`. Eso también **reactiva Vicky** en ese chat: borra `humanoAtendiendo` y `silenciadoHasta` en Firestore (y el silencio local 24 h), y limpia el doc del JID actual y, si aplica, el del número `@s.whatsapp.net` vinculado al mismo contacto (`@lid` / historial). Con sesión admin: `#c` / `#C` + nombre o número → **modo puente**; `#g` / `#G` + texto → **borrador** en Firestore (panel **Borradores prompt**); `#reporte` → resumen; `#ruta ZONA PRODUCTO` → campaña con delay; `#ruta_geo ID_DOC PRODUCTO` → campaña por polilínea en `rutas_logistica`; `#enviar clientes TEXTO` o `#enviar leña TEXTO` (y *cerco* / *pergola* / *fogonero*) → aviso masivo por WhatsApp a fichas en Firestore con `remoteJid` (mismo tope y delay anti-spam que `#ruta`, configurable en **General** del panel). **Silencio:** `#silencio global` o `#silencio todos` apaga Vicky para *todos* (`config/general.botActivo`, mismo interruptor que el panel); `#activo global` o `#vicky activa` la enciende y también **reactiva el chat desde el que enviás ese comando** (quita silencio solo-contacto en ese JID: `humanoAtendiendo` / `silenciadoHasta`), para poder probar al toque desde tu celular; el resto de los contactos silenciados siguen igual hasta `#activar` + criterio o el panel. **Por chat:** `#silenciar` + criterio (nombre, número, *último*, *#N* como en puente) marca `humanoAtendiendo` en Firestore; `#activar` + criterio reactiva ese chat. **Ambos** comandos actualizan, cuando aplica, **los dos** documentos `chats/*` del mismo contacto (`…@lid` y `549…@s.whatsapp.net`), para que no quede silencio “colgado” en un JID y el cliente escriba por el otro. Si hay sesión admin y mandás texto que **no** parece comando interno (lista, `#3`, tel largo, “decile…”, etc.), el bot **cierra la sesión admin** y trata el mensaje como cliente. **`#reporte` / `#g` / `#ruta` / `#c` sin abrir sesión:** solo si el chat es del número configurado como admin — en panel **General** → `adminPhone`, y/o variable `ADMIN_PHONE` en `.env` / Cloud Run (mismos dígitos que el celular desde el que escribís, se tolera `549…` vs sin prefijo). Si no coincide, usá primero la frase secreta o el bot responderá como a un cliente. `ADMIN_PHONE` / `adminPhone` también se usan para **avisos** (cola leña, ventas, clima, reportes).

### Si el teléfono dice “No se pudo vincular el dispositivo”

1. **Mismo número que el perfil de WhatsApp**  
   `WHATSAPP_PAIRING_PHONE` tiene que ser **exactamente** el número de la cuenta donde ingresás el código (WhatsApp → Ajustes → tu nombre/foto → teléfono). Solo dígitos, con código de país. **Argentina celular:** `549` + código de área + número (el `9` va después del `54`; sin `+`, sin espacios).  
   *Ejemplo:* si en el celular ves algo como `351 557-6639`, **no** alcanza con poner `3515576639` solo: en `.env` va `5493515576639`. (O poné `3515576639` y `WHATSAPP_PAIRING_AUTO_PREFIX_549=1` para que el bot agregue `549`.)

2. **Código al toque**  
   El código de 8 caracteres caduca rápido; si pasó tiempo, cerrá el bot y volvé a ejecutar `node bot.js` para generar otro.

3. **Sesión mezclada con GCS**  
   Si antes hubo intentos fallidos o bajás `auth/` del bucket con estado “a medias”, WhatsApp a veces rechaza. En `.env` poné **`WHATSAPP_PAIRING_SKIP_GCS_AUTH=1`** (o `true`), guardá, borrá el bot (`Ctrl+C`) y volvé a arrancar: el bot **no** descargará `auth/` desde GCS mientras la sesión local no esté registrada y usará claves nuevas. **Solo en el primer arranque del proceso** se borra la carpeta local `auth_info_baileys`; en reconexiones posteriores **no** se vuelve a borrar (así no desaparece `creds.json` ni se duplica el QR). Para forzar otra limpieza total: cerrá Node y volvé a ejecutar `node bot.js`, o borrá la carpeta `auth_info_baileys` a mano. Cuando veas `VINCULADO!`, **quitá** esa variable del `.env` en el día a día para que la próxima vez vuelva a sincronizar sesión desde GCS con normalidad.

4. **Límite de dispositivos**  
   En el celu, revisá **Dispositivos vinculados** y desvinculá sesiones viejas (“Chrome”, “Escritorio”, etc.) si llegaste al máximo.

5. **Alternativa**  
   Sacá `WHATSAPP_PAIRING_PHONE` del `.env` y usá **QR** (Opción B).

6. **Consola dice “VINCULADO” pero el teléfono mostró error y el bot no contesta**  
   Eso suele ser **sesión rota** (el programa cree que hay sesión; WhatsApp en el celular no). Pará el bot, **borrá la carpeta** `auth_info_baileys`, mantené `WHATSAPP_PAIRING_SKIP_GCS_AUTH=1` un arranque o borrá también `auth/*` en el bucket si hace falta, y volvé a vincular **por QR**. Para ver si llegan mensajes al proceso: en `.env` poné `VICKY_LOG_INCOMING=1` y mirá la consola al escribir desde **otro** número al WhatsApp del negocio.

**Nota:** Al vincular en local con sesión limpia, al guardarse credenciales nuevas en GCS puede **reemplazar** la sesión que usaba Cloud Run con la misma cuenta. Coordiná con un solo entorno activo o re-vinculá el bot en la nube después.

### Desarrollo local: credenciales Google (GCS + Firestore)

Si ves `Could not load the default credentials`:

1. Instalá [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) y en PowerShell:
   ```powershell
   gcloud auth application-default login
   ```
   (Cuenta con acceso al proyecto `webgardens-8655d`, bucket `webgardens-8655d_whatsapp_session` y Firestore.)

2. **O** descargá un JSON de cuenta de servicio y en `.env`:
   `GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\completa\al-archivo.json`

3. Para que Vicky responda con IA, en `.env`: `GEMINI_API_KEY=...` (la misma variable que en Cloud Run).

---

## 2c) Cron en Cloud Run (mensajes programados + clima jueves + geocode CRM)

El servicio `vicky-bot` expone rutas HTTP internas (mismo puerto que el healthcheck). Protegelas con un secreto compartido.

**Variables de entorno (Cloud Run → `vicky-bot`):**

| Variable | Uso |
|----------|-----|
| `VICKY_CRON_SECRET` | Token largo aleatorio. Las peticiones deben enviar cabecera `Authorization: Bearer <mismo valor>` (sin espacios de más; el bot recorta el valor de la variable). Si en Scheduler usás **autenticación OIDC** de Google y eso pisa `Authorization`, agregá además cabecera **`X-Vicky-Cron-Secret`** con el mismo secreto (solo el token, sin `Bearer`). |
| `GEOCODE_NOMINATIM_UA` | Opcional. User-Agent en solicitudes a Nominatim (política OSM); si no se define, el cron usa un valor por defecto identificable. |
| `VICKY_LOG_CRON_AUTH` | Opcional. Si es `1`, ante 401 en `/internal/cron/*` el bot escribe en consola más pistas (método, URL; **no** imprime secretos). El 401 ya registra `secretLen`, `authHdrLen` y `xVickyLen` (longitud de `X-Vicky-Cron-Secret` normalizada). |
| `VICKY_CRON_ALLOW_BODY_SECRET` | Opcional. Si es `1`, además de cabeceras acepta el secreto en JSON: `{"cronSecret":"<mismo que VICKY_CRON_SECRET>"}` (útil si algo elimina `Authorization`). |
| `OPENWEATHER_API_KEY` | Opcional pero necesaria para el job de clima (Córdoba). Sin clave, el endpoint de clima no hace nada útil. |
| `CAMPANA_USE_TWILIO`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_CAMPANA_CONTENT_SID` | Opcional: enviar campaña `#RUTA` por plantilla Twilio en lugar de solo Baileys. Ver `.env.example`. |

**Programados (≈09:00 diario):** en Google Cloud Console → Cloud Scheduler → crear job HTTP:

- URL: `https://<URL_DEL_SERVICIO_vicky-bot>/internal/cron/programados`
- Método: `POST`
- Cabecera: `Authorization: Bearer <VICKY_CRON_SECRET>`
- Programación cron: por ejemplo `0 9 * * *` (09:00 America/Argentina según zona del job; ajustá timezone del scheduler a `America/Argentina/Buenos_Aires` si está disponible).

**Clima (jueves, sugerencia campaña leña):** segundo job:

- URL: `https://<URL>/internal/cron/weather`
- Mismo header `Authorization`.
- Cron: `0 9 * * 4` (jueves 09:00; ajustá hora/zona).

**Geocode CRM (lat/lng desde `direccion` + `zona`):** tercer job:

- En **Autenticación** del job: preferí **ninguna** (sin cuenta OIDC de Google). Si activás OIDC, Google suele enviar su propio `Authorization: Bearer <JWT>` y tu token de Vicky puede no usarse; en ese caso agregá cabecera **`X-Vicky-Cron-Secret`** con el mismo valor que `VICKY_CRON_SECRET`.
- URL: `https://<URL>/internal/cron/geocode-clientes`
- Método: `POST`, cabecera `Authorization: Bearer <VICKY_CRON_SECRET>`.
- Cuerpo opcional JSON: `{ "max": 25, "dryRun": false, "forceRegeocode": false }` (si omitís `max`, usa `config/general.geocodeCronMaxPorEjecucion`).
- Query opcional: `?max=10&dryRun=1` para pruebas.
- Frecuencia (cron): según volumen. Ejemplos: `*/20 * * * *` (cada 20 minutos); `30 3 * * *` (03:30 diario, hora baja). Timezone típica: `America/Buenos_Aires`.
- Si en panel **General** está **`geocodeCronActivo: false`**, la respuesta será `skipped: true` (no escribe Firestore).

**401 en logs (`⚠️ Cron 401 … secretLen=64 authHdrLen=14`):** el valor de `Authorization` que llega al bot **no coincide en longitud ni en bytes** con `VICKY_CRON_SECRET` en Cloud Run (ej. Scheduler con token corto, placeholder, o secreto viejo tras rotación). Copiá el secreto actual desde Cloud Run → `vicky-bot` → Variables y pegalo entero en el job (cabecera `Authorization: Bearer …` o, si usás OIDC, **`X-Vicky-Cron-Secret`** con el mismo valor completo). Tras un deploy, el log incluye `xVickyLen=` (longitud de esa cabecera) para comparar con `secretLen=` sin exponer el token.

Tras definir secretos, **nueva revisión** de Cloud Run no es obligatoria solo por crear jobs; sí hace falta redeploy si cambiás código o variables.

## 2d) Instagram DM (webhook público en `vicky-bot`)

El mismo servicio Cloud Run que atiende WhatsApp expone **`GET` y `POST /webhooks/instagram`** (sin Bearer: la autenticación es el *verify token* en el GET de suscripción y la firma **`X-Hub-Signature-256`** en el POST con el **App Secret** de Meta).

**URL de callback en Meta:** `https://<URL_DEL_SERVICIO_vicky-bot>/webhooks/instagram`  
(Ej.: la URL que muestra Cloud Run para `vicky-bot` en `us-central1`, sin path extra.)

**Variables de entorno (Cloud Run → `vicky-bot`):**

| Variable | Uso |
|----------|-----|
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | Mismo string que configurás en Meta al suscribir el webhook (GET `hub.verify_token`). |
| `META_APP_SECRET` | Secreto de la app en Meta; valida la firma del cuerpo POST. **Definilo en producción**; sin esto el código no puede comprobar la firma de forma fiable. |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | Token de página (larga duración) con permisos para enviar mensajes. Alias aceptado: `FACEBOOK_PAGE_ACCESS_TOKEN`. |
| `META_GRAPH_VERSION` | Opcional, default `v21.0`. |
| `VICKY_INSTAGRAM_DM` | Opcional. `0`, `false`, `no` u `off` → **no** responde por Instagram (prioridad sobre `instagramDmActivo` del panel). Vacío = según panel/Firestore. |

**Si Vicky no responde Instagram:** en Cloud Run → `vicky-bot` → **Variables y secretos** deben figurar **las tres** (`INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `INSTAGRAM_PAGE_ACCESS_TOKEN`). Si no están definidas, Meta no puede completar el webhook con firma válida o el bot no puede enviar el DM. Revisá también en **Logging** que existan `POST` a `/webhooks/instagram` tras un mensaje de prueba.

**Panel:** en **General** podés desactivar solo Instagram con **`instagramDmActivo: false`** sin apagar WhatsApp.

**Notas:** Instagram usa el mismo **delay** que WhatsApp (`config/general` → `delayMinSeg` / `delayMaxSeg`) y la misma cadena de **silencio** (Firestore sin caché + revalidación tras la espera, y antes de Gemini). Recibe **texto** (sin audio de bienvenida ni adjuntos binarios como en WhatsApp); el hilo en Firestore usa `chats/ig:{senderId}` y `clientes/ig:{senderId}` con `canal: instagram`. Silenciar chat desde el dashboard usa el mismo doc `chats/ig:…` si abrís ese chat.

### Política de privacidad (Meta App Review)

El servicio `vicky-bot` sirve una página HTML pública:

**`GET /legal/politica-privacidad`**

URL completa para pegar en Meta (reemplazá por tu host real de Cloud Run):

`https://<URL_DEL_SERVICIO_vicky-bot>/legal/politica-privacidad`

Contenido editable en el repo: `legal/politica-privacidad.html`. Tras cambiar el texto, redeploy del bot.

## 3) Deploy del bot (Cloud Run)
**Importante (WhatsApp / Baileys):** una sola cuenta = **una sola conexión WebSocket**. En Cloud Run debés usar **`--max-instances=1`** (si hay 2+ contenedores, cada uno intenta abrir sesión con las mismas credenciales: los mensajes “no llegan” a la instancia que mirás o WhatsApp desconecta sesiones). **`--min-instances=1`** evita apagar el proceso y perder el socket cuando no hay HTTP entrante.

**Crítico — CPU en Cloud Run:** con el valor por defecto, la CPU puede **reducirse cuando no hay peticiones HTTP**. El socket de WhatsApp sigue “abierto” pero el proceso **no procesa** bien los mensajes entrantes. Usá **`--no-cpu-throttling`** (CPU asignada mientras el contenedor vive). El bot en Cloud Run (`K_SERVICE`) además hace **auto-ping** a `GET /health` cada ~40s como red de seguridad; desactivar: `VICKY_SELF_PING=0`.

Desde repo del bot:

```powershell
cd "Bot_WhatsApp_Lena"
gcloud run deploy vicky-bot --source . --region=us-central1 --platform=managed --port=8080 --min-instances=1 --max-instances=1 --no-cpu-throttling --timeout=3600 --memory=1Gi
```

Tras el deploy, en **Cloud Run → `vicky-bot` → Editar y desplegar nueva revisión** cargá también las variables de §2d si usás Instagram. La ruta `/webhooks/instagram` debe ser alcanzable públicamente (Cloud Run “Allow unauthenticated” en el servicio, como suele ser el healthcheck).

**Audio de bienvenida (primer contacto WhatsApp):** los archivos `ElevenLabs_*.mp3` no van en Git (`.gitignore`), así que en Cloud Run el contenedor puede arrancar sin ellos. El bot, **después de** sincronizar `auth/` desde GCS, intenta bajar desde el **mismo bucket** (`VICKY_GCS_BUCKET` o default) los objetos:

- `bot_media/ElevenLabs_2026-03-21T11_41_40_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3`
- `bot_media/ElevenLabs_2026-03-21T12_03_41_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3`

**Si no están en GCS:** con **`ELEVENLABS_API_KEY`** y **`ELEVENLABS_VOICE_ID`** en Cloud Run (ya usados para notas de voz), el bot **genera** esos MP3 por TTS al conectar WhatsApp, los guarda en `/app/` y los **sube** a `bot_media/` para el próximo arranque. Textos: env opcional **`VICKY_AUDIO_INTRO_TTS`** / **`VICKY_AUDIO_CONFIRMADO_TTS`** (frase completa); desactivar recreación: **`VICKY_DISABLE_TTS_AUDIO_BOOTSTRAP=1`**.

Subida manual opcional (misma voz que exportaste en el panel), ajustando bucket si usás otro:

```powershell
gsutil cp "ElevenLabs_2026-03-21T11_41_40_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3" "gs://webgardens-8655d_whatsapp_session/bot_media/"
gsutil cp "ElevenLabs_2026-03-21T12_03_41_Melisa_pvc_sp110_s91_sb75_se0_b_m2.mp3" "gs://webgardens-8655d_whatsapp_session/bot_media/"
```

Prefijo distinto: variable **`VICKY_GCS_BOT_MEDIA_PREFIX`** (ej. `media/vicky`, sin slashes al inicio/fin). Para no intentar bajar desde GCS: **`VICKY_DISABLE_GCS_BOT_MEDIA=1`**. Rutas locales alternativas: **`VICKY_AUDIO_INTRO_PATH`** / **`VICKY_AUDIO_CONFIRMADO_PATH`** (absolutas o relativas al directorio del `bot.js`). En logs: `🎵 Audio intro (tras sync GCS)` o **`tras recreación ElevenLabs`**.

Alternativa (script):

```powershell
cd "Bot_WhatsApp_Lena"
npm run deploy
```

## 4) Deploy del dashboard (Cloud Run)

```powershell
cd "..\dashboard"
gcloud builds submit --config=cloudbuild.yaml --project=webgardens-8655d
```
*(Desde la carpeta hermana `dashboard` dentro de `Garden Compositor`.)*

## 5) Verificación mínima (post-deploy)
### WhatsApp no recibe “hola” (diagnóstico rápido)
- **`GET /health`** solo confirma que el proceso HTTP está arriba.
- **`GET /health/whatsapp`** (JSON en el mismo servicio) indica si **Baileys** tiene `connection: "open"`, si la sesión está `registered`, y cuántos eventos **`messagesUpsertSeen`** vio **esa instancia** desde el último arranque. Incluye **`runtime.hostname`**: si al refrescar varias veces cambia el hostname, tenías **varias réplicas** y el tráfico HTTP podía pegarle a un contenedor **sin** WhatsApp abierto (corregir con **`max-instances=1`**).
- Si mandás “hola” y el contador **no sube**: **mínimo de instancias 0**, **más de una instancia (máximo mal configurado)**, instancia equivocada, o sesión desvinculada.
- Variable opcional **`VICKY_LOG_WA_UPSERT=1`**: loguea cada `messages.upsert` (tipo + JID) antes de filtros; útil junto con **`VICKY_LOG_INCOMING=1`** para ver el flujo completo.
- **`VICKY_LOG_MSG_DROP=1`**: si el mensaje llega a Baileys pero se descarta (sin texto/imagen/audio reconocible tras desenvolver ephemeral/plantillas), verás `🗑️ [VICKY_LOG_MSG_DROP]` con las claves del payload.

### Silencio humano (panel)
- Abrir un chat en dashboard → toggle “Silenciar bot”
- Cliente manda mensaje → **bot NO responde**
- Toggle “Reactivar bot” → cliente manda mensaje → bot responde normal

### Embudo + handoff
- Caso “curioso”: “¿Cuánto sale el cerco?” → guía + 1 dato (medidas/zona). **Sin** `[COTIZACION:*]`.
- Caso “interesado”: “Tengo 12m y quiero avanzar” → cotización completa **con** `[COTIZACION:*]` y luego handoff **con** `[HANDOFF_EXPERTO:*]`.
- Después del handoff, el cliente manda “Dale” → **bot NO responde** (chat queda para humano).

### No duplicación
- Enviar el mismo mensaje 2 veces rápido (o por mala red) → el bot debería responder 1 sola vez por `msg.key.id` (dedupe) y no repetir saludos.

### Precios desde panel
- Cambiar un precio en **Precios y servicios** → redeploy `vicky-bot` → mensaje de prueba en WhatsApp con el monto nuevo.

### Borradores de prompt (#G)
- Desde WhatsApp en modo admin: `#G …` crea un borrador en `config/prompts/borradores`.
- Panel → **Configuración → Borradores prompt (#G)** → revisar y **Aplicar al system prompt** (requiere índice compuesto desplegado en Firestore si la consola lo pidió).

### CRM y `#RUTA`
- En ficha **Cliente**: zona, `servicioPendiente`, array `interes`, `tipoLenaPreferido`, `lat`/`lng` (mapa en **Mapa logística**). Comando: `#ruta ZONA PRODUCTO` con token opcional final `hogar` / `salamandra` / `parrilla` para filtrar tipo de leña. Texto del mensaje: **General** → `campanaRutaPlantilla` y `campanaRutaFechaTexto`.
- **Campaña por corredor:** panel **Ruta / campaña geo** (`/logistica-ruta`) guarda `rutas_logistica` (polilínea + `bufferMetros`). WhatsApp admin: `#ruta_geo ID_DOC_FIRESTORE PRODUCTO` (ej. `#ruta_geo AbCdEfGh lena hogar`). Solo clientes con `lat`/`lng` dentro del buffer; mismos silencios y plantilla que `#ruta`.
- **No** se envía a chats con `chats/{jid}.humanoAtendiendo` o `silenciadoHasta` vigente (misma lógica que el bot al responder). Índice Firestore: la consulta por `silenciadoHasta` > ahora puede pedir índice simple en `chats`; si la consola lo sugiere, agregalo a `firebase/firestore.indexes.json`.

### Reglas / índices desde Git
- Cambiar `firebase/firestore.rules` en Git → push a `main`/`master` (o workflow manual) → en Firebase Console verificar reglas actualizadas.
- Si el dashboard pide crear un índice compuesto, añadilo a `firebase/firestore.indexes.json` y volvé a desplegar Firestore.
