# Genera un token para FIREBASE_TOKEN (GitHub Actions / CI).
# Debe ejecutarse en TU máquina, en PowerShell interactivo (no desde un agente sin consola).
# 1) Se abre el navegador o te da un enlace + código.
# 2) Al terminar, copiá el token y creá el secret FIREBASE_TOKEN en GitHub.

Write-Host "Firebase CLI: generando token CI..." -ForegroundColor Cyan
Write-Host "Si pedís URL/código, abrí el enlace, iniciá sesión con la cuenta del proyecto webgardens-8655d." -ForegroundColor Yellow
Write-Host ""

firebase login:ci --no-localhost

Write-Host ""
Write-Host "Siguiente paso: GitHub → repo → Settings → Secrets and variables → Actions → New secret" -ForegroundColor Green
Write-Host "Nombre: FIREBASE_TOKEN | Valor: el token que mostró arriba" -ForegroundColor Green
