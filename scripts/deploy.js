#!/usr/bin/env node
/**
 * deploy.js — Script de deploy automático para el bot Vicky
 *
 * Uso:
 *   node scripts/deploy.js           → Build y deploy a Cloud Run
 *   node scripts/deploy.js --watch   → Modo watch: despliega cuando cambia un archivo
 *   node scripts/deploy.js --dry-run → Muestra qué haría sin ejecutar
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const SERVICE = 'vicky-bot'
const REGION = 'us-central1'
const DRY_RUN = process.argv.includes('--dry-run')
const WATCH = process.argv.includes('--watch')

const WATCH_FILES = ['bot.js', 'firestore-module.js', 'package.json', 'Dockerfile']

function log(msg, color = '\x1b[36m') {
  const reset = '\x1b[0m'
  const time = new Date().toLocaleTimeString('es-AR')
  console.log(`${color}[${time}] ${msg}${reset}`)
}

function runDeploy() {
  log('🤖 Desplegando bot Vicky...', '\x1b[33m')

  if (DRY_RUN) {
    log(`(DRY RUN) gcloud run deploy ${SERVICE} --source . --region=${REGION}`, '\x1b[35m')
    return
  }

  try {
    const start = Date.now()
    log('📦 Construyendo en Cloud Build...')

    execSync(
      `gcloud run deploy ${SERVICE} --source . --region=${REGION} --platform=managed --port=8080`,
      { cwd: ROOT, stdio: 'inherit', timeout: 600_000 }
    )

    const elapsed = Math.round((Date.now() - start) / 1000)
    log(`✅ Bot desplegado en ${elapsed}s → https://vicky-bot-uh3qtftq3q-uc.a.run.app`, '\x1b[32m')
  } catch (err) {
    log('❌ Deploy falló', '\x1b[31m')
    process.exitCode = 1
  }
}

function watchAndDeploy() {
  log('👀 Modo watch activado para el bot', '\x1b[36m')
  log('   Archivos monitoreados: ' + WATCH_FILES.join(', '), '\x1b[90m')

  let debounceTimer = null
  let deploying = false
  const changedFiles = new Set()

  WATCH_FILES.forEach(file => {
    const filePath = path.join(ROOT, file)
    if (!fs.existsSync(filePath)) return
    fs.watch(filePath, () => {
      changedFiles.add(file)
      if (deploying) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const files = [...changedFiles].join(', ')
        changedFiles.clear()
        log(`📝 Cambio detectado en: ${files}`, '\x1b[33m')
        deploying = true
        runDeploy()
        deploying = false
      }, 3000)
    })
  })

  log('▶️  Deploy inicial...', '\x1b[33m')
  runDeploy()
}

if (WATCH) {
  watchAndDeploy()
} else {
  runDeploy()
}
