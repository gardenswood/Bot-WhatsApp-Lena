# Plan de optimización — Vicky (alto impacto + medio plazo)

Objetivo: aplicar las mejoras acordadas sin romper el stand ni el panel. Ejecutar por **fases**; cada fase puede desplegarse y verificarse sola.

---

## Fase A — Alto impacto (prioridad 1)

### A1. Respetar `botActivo` en el bot

**Problema:** [`bot.js`](../bot.js) asigna `BOT_ACTIVO` desde Firestore pero no lo usa; el panel “apagar bot” no tiene efecto.

**Cambios:**
- Tras leer `configGeneral`, si `botActivo === false`:
  - En el handler `messages.upsert`, antes de procesar respuesta al cliente (después de dedupe/silencio si querés seguir logueando), hacer `return` o enviar un mensaje fijo tipo “momentáneamente fuera de servicio” (decidir una sola política).
  - **Excepción recomendada:** no bloquear flujo **admin** (`!vicky` / JID admin) para poder operar en emergencia.
- Opcional: log claro `🛑 botActivo=false, ignorando mensaje de cliente`.

**Archivos:** [`bot.js`](../bot.js), [`RUNBOOK_DEPLOY.md`](../RUNBOOK_DEPLOY.md) (nota: apagar bot no requiere redeploy si en el futuro refrescás config en caliente; **hoy** con cache 5 min + solo arranque para parte del flujo, documentar “redeploy o esperar TTL” hasta A6).

**Criterio de hecho:** con `botActivo: false` en `config/general`, un cliente normal no recibe respuesta de Vicky; con `true`, sí.

---

### A2. Una sola instancia de Cloud Run para `vicky-bot`

**Problema:** Baileys + sesión en GCS asume un solo proceso que mantiene el socket; varias réplicas pueden duplicar envíos o romper sesión.

**Cambios:**
- En el deploy de Cloud Run (donde lo definan hoy: `gcloud run deploy ...`, [`cloudbuild.yaml`](../cloudbuild.yaml), o YAML de servicio), fijar:
  - `--max-instances=1` (obligatorio para este diseño).
  - `--min-instances=0` o `1` según cold start aceptable (0 ahorra; 1 evita arranque lento).
- Documentar en [`RUNBOOK_DEPLOY.md`](../RUNBOOK_DEPLOY.md) que **no** subir `max-instances` sin rediseño (cola, lock, etc.).

**Criterio de hecho:** en consola GCP, servicio `vicky-bot` con máximo 1 instancia.

---

### A3. Alinear `tiempoSilencioHumanoHoras` con el comportamiento real

**Problema:** El panel muestra el campo; el bot usa **24 h fijas** para silencio por mensaje humano desde el teléfono.

**Opciones (elegir una):**

| Opción | Acción |
|--------|--------|
| **A — Cablear** | En [`bot.js`](../bot.js), reemplazar constante 24 h por `configGeneral.tiempoSilencioHumanoHoras` (con mínimo/máximo razonables). |
| **B — Honestidad UI** | En dashboard [`config/general/page.tsx`](../../dashboard/src/app/(dashboard)/config/general/page.tsx), texto de ayuda: “Solo panel / futuro” o renombrar a “Referencia (silencio desde teléfono fijo 24 h en bot)”. |

**Recomendación:** **A** si querés control total desde panel; **B** si preferís no tocar lógica. Tras elegir, actualizar [`.cursor/rules/vicky-bot-comportamiento.mdc`](../.cursor/rules/vicky-bot-comportamiento.mdc) y [`RUNBOOK_DEPLOY.md`](../RUNBOOK_DEPLOY.md).

**Criterio de hecho:** panel y documentación no contradicen el código.

---

### A4. Endurecer reglas Firestore (faseada)

**Problema:** [`firebase/firestore.rules`](../firebase/firestore.rules) permite read/write a cualquier usuario autenticado.

**Cambios (fase 1 suave):**
- Mantener auth obligatoria; añadir comentario y tarea: “próximo paso custom claim `admin`”.
**Fase 2:**
- En Firebase Auth / Cloud Functions o script admin, asignar `admin: true` en custom claims a cuentas del equipo.
- Reglas: `function isAdmin() { return request.auth != null && request.auth.token.admin == true; }` y aplicar a `config`, `servicios`, `usuarios`.
- Lectura de `chats` / `clientes`: decidir si solo `admin` o rol “operador”.

**Archivos:** [`firebase/firestore.rules`](../firebase/firestore.rules), dashboard login/creación de usuarios si hace falta, [`docs/FIRESTORE_SCHEMA.md`](FIRESTORE_SCHEMA.md).

**Criterio de hecho:** cuenta sin claim no escribe en `config` (o política acordada documentada).

---

## Fase B — Medio plazo (prioridad 2)

### B1. Reducir duplicación en el `SYSTEM_PROMPT` de [`bot.js`](../bot.js)

**Problema:** Fallback enorme con precios que ya vienen de `servicios/*` vía `buildServiciosPromptSuffix`.

**Cambios:**
- Por PRs pequeños: quitar bloques de precios redundantes del string `SYSTEM_PROMPT`, dejando reglas de tono, marcadores `[COTIZACION:*]`, handoff, imágenes, embudo.
- Mantener un párrafo: “precios concretos en bloque Firestore al final”.
- Regenerar PDFs / [`docs/reglas_vicky_vigentes.md`](reglas_vicky_vigentes.md) si el texto de negocio deja de vivir solo en código.

**Criterio de hecho:** tamaño del fallback baja de forma medible; respuestas siguen coherentes con panel.

---

### B2. Refrescar config/precios sin redeploy (opcional)

**Problema:** Cambios en `servicios` exigen redeploy de `vicky-bot` para nuevo `systemInstruction`.

**Opciones:**
- **B2a:** Timer cada N minutos: `getServicios()` + reconstruir modelo Gemini si cambió hash del JSON (más simple que por mensaje).
- **B2b:** HTTPS endpoint interno (Cloud Run) “reload-config” protegido con secret, invocado desde el dashboard al guardar precios (requiere cambios en dashboard).

**Criterio de hecho:** cambio de precio en panel se refleja en ≤ N minutos sin redeploy manual (definir N).

---

### B3. Tests mínimos

**Cambios:**
- Añadir `npm test` (Vitest o Node `node:test`) en el repo del bot.
- Casos: `buildServiciosPromptSuffix` (mapa vacío, servicio inactivo, precios), y función pura de dedupe si se extrae.

**Criterio de hecho:** CI (GitHub Actions) ejecuta tests en push.

---

### B4. Dashboard y defaults del panel

**Cambios:**
- Alinear [`DEFAULT_CONFIG`](../../dashboard/src/app/(dashboard)/config/general/page.tsx) con [`firestore-module.js`](../firestore-module.js) (delays 26–34, `frecuenciaAudioFidelizacion: 0`, etc.) para que pantallas nuevas no muestren valores obsoletos.
- Deploy de `vicky-dashboard` tras cambios.

**Criterio de hecho:** panel nuevo/refresco muestra defaults coherentes con RUNBOOK.

---

### B5. Observabilidad ligera

**Cambios:**
- Logs estructurados con `jid` / `tel` en errores Gemini y Firestore.
- Alerta en Cloud Logging (tasa de errores o “Gemini 429”) — cuando el volumen lo justifique.

---

## Orden sugerido de implementación

1. **A2** (rápido, evita incidentes de escala).  
2. **A1** (funcionalidad prometida en panel).  
3. **A3** (elección A o B + docs).  
4. **B4** (bajo riesgo, mejora percepción).  
5. **B1** (incremental, varios PRs).  
6. **B3** + CI.  
7. **A4** (cuando tengan lista de admins).  
8. **B2** si el redeploy molesta al operador.  
9. **B5** cuando crezca el tráfico.

---

## Verificación por fase

- Tras A1/A2/A3: prueba manual WhatsApp + panel según [`RUNBOOK_DEPLOY.md`](../RUNBOOK_DEPLOY.md).  
- Tras A4: prueba con cuenta sin admin.  
- Tras B1/B2: prueba de cotización leña/cerco con precio editado en panel.

---

*Documento vivo: actualizar fechas y estado (pendiente / hecho) al cerrar cada fase.*
