---
name: whatsapp-workflow-optimization
description: Audits and improves WhatsApp automation for the Lena booth stack (Vicky bot, Firestore config, GCS session/history). Use when the booth team or devs optimize flows, fix duplicates, handoff humano, delays, audio bienvenida, deploy Cloud Run, or mention automatizaciones WhatsApp Lena, flujos Vicky, panel admin.
---

# Optimizar automatizaciones y flujos — Stand WhatsApp Lena

Skill **del proyecto**: quien abra esta carpeta en Cursor (`Bot_WhatsApp_Lena`) lo tiene disponible para el agente. Sirve para **mejorar flujos y operación del bot** (Vicky), no para enviar mensajes sueltos.

## Equipo stand Lena — contexto del repo

| Pieza | Dónde mirar |
|-------|-------------|
| Lógica del bot, servicios, delays, llamadas | `bot.js` |
| Firestore (chats, clientes, config, servicios) | `firestore-module.js` + `docs/FIRESTORE_SCHEMA.md` |
| Reglas e índices versionados | `firebase/firestore.rules`, `firebase/firestore.indexes.json` |
| Comportamiento acordado (audio bienvenida, grupos, silencio humano) | `.cursor/rules/vicky-bot-comportamiento.mdc` |
| Config dinámica | Firestore `config/general`, `config/prompts` (debe reflejarse en el **dashboard** carpeta hermana) |
| Deploy bot | Cloud Run `vicky-bot`, proyecto `webgardens-8655d` |
| Sesión / historial clientes | GCS (rutas en la regla de comportamiento) |

**Principio de este negocio**: cambios de comportamiento o tiempos deben poder gobernarse desde **panel admin** cuando ya exista el campo en Firestore; evitar “solo en código” sin reflejo en dashboard.

## Cuándo aplicar este skill

- Optimizar, acelerar, endurecer o simplificar flujos de WhatsApp en Lena.
- Duplicados, mensajes fuera de orden, choque bot vs humano en el teléfono.
- Ajustar bienvenida (audio/texto una sola vez), re-saludos, catálogos por servicio.
- Preparar cambios que impliquen **despliegue** y variables de entorno en Cloud Run.

## Principios (orden de impacto)

1. **Correctitud antes que velocidad**: idempotencia y trazas vencen a respuestas rápidas inconsistentes.
2. **Un solo dueño del turno**: bot vs humano; TTL de silencio claro (p. ej. 24 h desde teléfono).
3. **Estado persistente**: flags como `audioIntroEnviado`, historial por `tel`, no solo memoria del proceso.
4. **Ventana 24 h** si en el futuro se usa Cloud API masivamente; formato E.164 (Argentina +549… para móviles donde aplique).
5. **Logs útiles**: `jid`, `messageId`, `tel`, sin pegar secretos.

## Checklist de auditoría (copiar y marcar)

```
- [ ] Mapa: disparador → estado → salida (texto, audio, catálogo, presupuesto, llamada)
- [ ] Idempotencia: mismo evento dos veces no duplica acciones críticas
- [ ] Serialización por chat: orden de respuestas garantizado si hay cola/async
- [ ] Handoff humano: reglas y cómo vuelve el bot
- [ ] Backoff ante fallos (LLM, TTS, ElevenLabs llamadas, red)
- [ ] Media/audio: rutas, una sola vez por cliente donde corresponda
- [ ] Firestore `config/*` + pantallas en dashboard para lo que el booth debe tocar
- [ ] Deploy: revisión Cloud Run y env vars documentadas (RUNBOOK si existe)
```

## Patrones frecuentes en bots tipo Lena

| Síntoma | Dirección típica |
|--------|-------------------|
| Doble bienvenida o audio repetido | Flag persistente en historial cliente (GCS/Firestore según implementación actual) |
| Bot responde mientras atiende un humano | Respetar silenciamiento por `remoteJid` y TTL |
| Respuestas cruzadas | Cola o “versión de mensaje” por chat; invalidar generación si llegó input nuevo |
| Config que solo está en código | Mover a `config/prompts` o `config/general` y exponer en dashboard |
| Cambios sin efecto en prod | Verificar despliegue `vicky-bot` y que no haya caché de config obsoleto |

## WhatsApp Business API (futuro o paralelo)

- Skill personal **`whatsapp-automation`** (Rube MCP): envíos vía API oficial; siempre buscar tools actualizadas.
- Este skill del proyecto sigue siendo la guía de **flujo y operación Lena**.

## Entregables sugeridos

1. Diagrama corto: flujo actual vs propuesto.
2. Lista priorizada (impacto / esfuerzo / riesgo).
3. Parches en `bot.js`, `firestore-module.js` y UI del **dashboard** cuando la config deba ser editable.

## Idioma

Responder en **español** salvo que pidan otro. Nombres de API Meta/WhatsApp en inglés estándar.
