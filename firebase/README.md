# Firestore en Git

- `firestore.rules` — seguridad para el **dashboard** (Client SDK). El bot usa Admin SDK y no evalúa estas reglas.
- `firestore.indexes.json` — índices para las consultas del panel (listados, métricas).

Antes del **primer** `firebase deploy --only firestore`, compará el contenido con lo que hay hoy en Firebase Console por si hubo reglas manuales distintas.

Desde la raíz del repo del bot:

```bash
firebase deploy --only firestore --project webgardens-8655d
```

En CI: secret `FIREBASE_TOKEN` y workflow `.github/workflows/firestore-deploy.yml`.
