# Configuración del panel y el bot Vicky (alineación y recuperación)

El **dashboard** (Next.js) y el **bot** (`vicky-bot` en Cloud Run) comparten el mismo proyecto Firebase **`webgardens-8655d`**. La fuente de verdad operativa es **Firestore**; el bot la lee al arrancar y, en algunos campos, en cada mensaje.

## Mapa rápido: pantalla del panel → documento Firestore → cuándo lo ve el bot

| Panel (dashboard) | Firestore | Efecto en el bot |
|-------------------|-----------|------------------|
| **General** (`/config/general`) | `config/general` | Delays, `botActivo`, `modeloGemini`, campañas, tel. operación, grupo agenda, etc. Parte se lee **con caché ~5 min** en el proceso del bot; `botActivo` y algunos toggles críticos se releen **sin caché** en cada mensaje cliente. |
| **Instrucciones AI** (`/config/prompts`) | `config/prompts` | `sistemaPrompt`, `sistemaPromptAdmin`, bienvenida, cierre entrega. El bot arma Gemini **solo al arranque** (y al recargar tras `#g` + OK en admin). **Tras guardar aquí: redeploy de `vicky-bot`** para que producción use el texto nuevo. |
| **Precios y servicios** (`/config/precios`) | `servicios/{lena,cerco,...}` | Se anexa al system prompt como `[DATOS_SERVICIOS_FIRESTORE]` al **arranque**. **Redeploy** tras cambiar precios. |
| Chats, clientes, agenda, cola | `chats/*`, `clientes/*`, etc. | Según feature; muchos cambios se ven en caliente o en la siguiente interacción. |

## Cómo volver a dejar todo como antes (checklist)

1. **Entrá al dashboard** con el mismo proyecto Firebase (`webgardens-8655d`). Si no cargan datos, revisá login y reglas Firestore para usuarios admin.
2. **General:** confirmá **`botActivo`** encendido, **`modeloGemini`** acorde a lo que usás en Cloud Run (o dejá el default del panel), delays y teléfonos de operación si los usás.
3. **Instrucciones AI → Historial:** elegí una **versión anterior** de `sistemaPrompt`, **Restaurar**, luego **Guardar** (sin Guardar no se escribe en `config/prompts`).
4. **Precios y servicios:** verificá que `lena`, `cerco`, `pergola`, `fogonero`, `bancos` tengan los textos y precios esperados; **Guardar** si cambiás algo.
5. **Cloud Run:** después de cambiar **prompt** o **servicios**, ejecutá un **nuevo deploy** de `vicky-bot` (desde el repo: `npm run deploy` en `Bot_WhatsApp_Lena`). Sin redeploy, la revisión en marcha sigue con el prompt y servicios cargados al arranque anterior.
6. Opcional: en admin WhatsApp, **`#g`** + instructivo + **OK** aplica bloque a `sistemaPrompt` y recarga Gemini **solo en ese contenedor**; el panel y otras réplicas siguen alineándose con redeploy.

## Si no hay historial de prompts útil

- El bot tiene un **`SYSTEM_PROMPT` de respaldo** en `bot.js` si `config/prompts.sistemaPrompt` está vacío o falla la lectura.
- Podés pegar en el panel un instructivo correcto (o copiar desde el fallback del código con cuidado de mantener reglas de marcadores que usás en producción) y **Guardar** + **redeploy**.

## Referencia de esquema

Detalle de campos: [`FIRESTORE_SCHEMA.md`](./FIRESTORE_SCHEMA.md).
