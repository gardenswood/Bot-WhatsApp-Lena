# Re-vincular Vicky (WhatsApp Business Gardens)

Hacelo **solo** desde el repo **`Bot_WhatsApp_Lena`**, con la cuenta de WhatsApp **Business de Gardens Wood** (no otra línea o cuenta del negocio).

## Antes (celular)

1. WhatsApp Business → **Ajustes → Dispositivos vinculados**.
2. Cerrá sesión en dispositivos viejos que ya no usen (opcional pero recomendable).

## En tu PC

### 1) Credenciales Google (subir sesión a GCS)

- `gcloud auth application-default login`  
  **o** `GOOGLE_APPLICATION_CREDENTIALS` apuntando a una cuenta de servicio con permiso en el bucket **`webgardens-8655d_whatsapp_session`**.

### 2) `.env` en `Bot_WhatsApp_Lena`

- **`GEMINI_API_KEY`** (la de Vicky en producción).
- **`VICKY_GCS_BUCKET=webgardens-8655d_whatsapp_session`** (explícito; es el bucket de sesión de Vicky).
- **`WHATSAPP_PAIRING_PHONE=549…`** — **exactamente** el número que muestra el perfil de esa cuenta Business (solo dígitos; Argentina móvil = `549` + área + número).

Si la sesión anterior está rota o mezclada:

- **`WHATSAPP_PAIRING_SKIP_GCS_AUTH=1`** solo para **esta** vinculación (evita bajar `auth/` viejo del bucket al arrancar).  
- **Después** de `VINCULADO!`, **sacá** esa línea del `.env` para el día a día.

### 3) Carpeta local limpia (si hace falta)

- Pará el bot si estaba corriendo.
- Renombrá o borrá **`auth_info_baileys`** (o dejá que el primer arranque con `WHATSAPP_PAIRING_SKIP_GCS_AUTH=1` la limpie según RUNBOOK).

### 4) Arrancar

```powershell
cd "C:\Users\IK\Desktop\ALE\Garden Compositor\Bot_WhatsApp_Lena"
node bot.js
```

- **Código:** en consola aparece `CÓDIGO DE VINCULACIÓN (8 caracteres)`. En el celu: **Vincular con número de teléfono** y pegalo **al toque** (expira rápido).
- **QR:** si **no** definiste `WHATSAPP_PAIRING_PHONE`, escaneá consola o `qr.png`.

### 5) Cuando veas `VINCULADO!`

- Esperá ~10–20 s a que suba **`auth/creds.json`** (y resto de `auth/`) a  
  `gs://webgardens-8655d_whatsapp_session/auth/`.
- Quitá **`WHATSAPP_PAIRING_SKIP_GCS_AUTH`** del `.env` si la habías puesto.
- **Cloud Run:** desplegá una **nueva revisión** de **`vicky-bot`** (o reiniciá el servicio) para que la nube baje la sesión nueva.

### 6) Probar

- `GET https://<URL-vicky-bot>/health/whatsapp` → `connection: "open"`, `registered: true`.
- Mandá un mensaje de prueba al número de Gardens.

## Si el celular dice “No se pudo vincular”

Ver **RUNBOOK_DEPLOY.md** §2b y § “Si el teléfono dice…”: número exacto `549…`, código rápido, y `WHATSAPP_PAIRING_SKIP_GCS_AUTH` + reinicio limpio.
