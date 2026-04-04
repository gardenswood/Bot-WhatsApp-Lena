# Mapa logística — retomar ~21:00 hoy

**No ejecutar antes:** el usuario pidió guardar el plan y retomar a las **21:00**.

## Síntoma

En `/logistica-mapa`: pins que no se mueven bien, panel/borrar que no responde, datos del cliente que solo aparecen entrando por ficha → “Ver en mapa”.

## Qué ya se hizo en código (dashboard)

Archivo principal: `Garden Compositor/dashboard/src/components/logistica/LogisticaMapaClient.tsx`.

1. **Evitar `clearLayers` constante**  
   - `pendingByTel` fuera de deps del efecto del mapa + `pendingByTelRef`.  
   - `searchParams` no como dependencia del efecto; primitivos `latQ`, `lngQ`, etc.  
   - Firmas estables: `clientesMapSig`, `colaOverlaySig`, `geocodeOkKey`, `queryFocusKey`, `filtrosSig`.  
   - Dentro del efecto: `filtradosLocal`, `conCoordsParaMapaLocal`, `colaOverlayLocal` con refs (`clientesRef`, `colaRef`, `geocodeByTelRef`, `filtrosRef`).  
   - **Motivo:** cada snapshot de `colaLena` y re-renders de Next con `useSearchParams` disparaban el efecto y destruían los marcadores.

2. **Panel + eliminar pin**  
   - Estado `mapSelection`, botón rojo en panel, `eliminarCoordsCliente` + lista de chips **“Clientes con pin en el mapa”** (Abrir panel / Quitar pin) por si Leaflet no recibe el clic.

3. **Docs**  
   - `docs/FIRESTORE_SCHEMA.md` (bot + espejo en `dashboard/docs/`).

## Si “sigue sin funcionar” a las 21:00

### 1. Confirmar que producción tiene el build nuevo

- Deploy de **`vicky-dashboard`** (Cloud Run) después del último commit con estos cambios.  
- Hard refresh / ventana privada para descartar caché.

### 2. Probar primero la lista de chips

- Si **Abrir panel** / **Quitar pin** en la tarjeta gris funciona → Firestore y reglas OK; el fallo es **Leaflet / DOM / tile layer**.  
- Si **tampoco** funciona → revisar **reglas Firestore** `clientes` (update `lat`/`lng` y `deleteField`), consola del navegador (errores rojos), y que el usuario del panel esté logueado.

### 3. Consola del navegador (F12)

- Errores de **CORS**, **Leaflet**, **Firebase permission-denied**, **chunk load failed**.

### 4. Siguientes cambios técnicos (si hace falta código)

- Sustituir **DivIcon** por `L.icon` con PNG/base64 por si el hit-area del pin falla.  
- **`react-leaflet`** o capa de marcadores **sin** `clearLayers` en cada cambio (solo add/remove/update por `tel`).  
- Quitar **`dynamic` + `Suspense`** en `logistica-mapa/page.tsx` y cargar el mapa de otra forma para descartar remounts.  
- Comprobar **CSS global** (`pointer-events`, `z-index`) sobre `.leaflet-container`.

## Comandos útiles (ajustar rutas)

```powershell
cd "c:\Users\IK\Desktop\ALE\Garden Compositor\dashboard"
npm run build
# Luego deploy según tu flujo (gcloud run deploy vicky-dashboard, GitHub Actions, etc.)
```

## Archivos tocados en sesiones anteriores

- `dashboard/src/components/logistica/LogisticaMapaClient.tsx`  
- `dashboard/src/app/(dashboard)/logistica-mapa/page.tsx` (dynamic + Suspense)  
- `Bot_WhatsApp_Lena/docs/FIRESTORE_SCHEMA.md`  
- `dashboard/docs/FIRESTORE_SCHEMA.md`  

---

*Creado para ejecución/revisión programada ~21:00 del mismo día.*
