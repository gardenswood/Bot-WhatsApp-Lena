#!/usr/bin/env node
/**
 * generate-knowledge-pdfs.js
 *
 * Genera/reescribe PDFs de instrucciones y base de conocimiento a partir de
 * `docs/reglas_vicky_vigentes.md`.
 *
 * Nota: se usa puppeteer-core + @sparticuz/chromium (ya dependencias del repo).
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

function findChromeExecutableWin() {
  const prefixes = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ].filter(Boolean)

  const suffixes = [
    path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join('Chromium', 'Application', 'chrome.exe'),
    path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'), // fallback aceptable
  ]

  for (const p of prefixes) {
    for (const s of suffixes) {
      const full = path.join(p, s)
      if (fs.existsSync(full)) return full
    }
  }
  return null
}

async function resolveExecutablePath() {
  // En Windows local: usar Chrome/Edge instalado (sparticuz/chromium no trae binario para win)
  if (process.platform === 'win32') {
    const win = findChromeExecutableWin()
    if (win) return win
    throw new Error('No encontré Chrome/Edge instalado (chrome.exe/msedge.exe). Instalalo o indicá CHROME_PATH.')
  }

  // En Linux/Cloud Run: usar sparticuz/chromium
  const chromium = require('@sparticuz/chromium')
  return await chromium.executablePath()
}

async function main() {
  const puppeteer = require('puppeteer-core')

  const root = path.join(__dirname, '..')
  const mdPath = path.join(root, 'docs', 'reglas_vicky_vigentes.md')
  if (!fs.existsSync(mdPath)) {
    console.error('❌ No existe:', mdPath)
    process.exit(1)
  }

  const md = fs.readFileSync(mdPath, 'utf8')

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Reglas Vigentes — Vicky</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; margin: 32px; color: #0f172a; }
        h1,h2,h3 { margin: 0 0 10px 0; }
        h1 { font-size: 22px; }
        h2 { font-size: 16px; margin-top: 18px; }
        h3 { font-size: 13px; margin-top: 14px; }
        pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; line-height: 1.45; }
        .muted { color: #475569; font-size: 11px; }
        .box { border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Reglas Vigentes — Vicky (WhatsApp) — Gardens Wood</h1>
        <div class="muted">Documento generado automáticamente desde <b>docs/reglas_vicky_vigentes.md</b></div>
      </div>
      <h2 style="margin-top:16px">Contenido</h2>
      <pre>${escapeHtml(md)}</pre>
    </body>
  </html>`

  const execPath = process.env.CHROME_PATH || (await resolveExecutablePath())
  const chromiumArgs = process.platform === 'win32'
    ? ['--no-sandbox', '--disable-gpu']
    : (() => {
        const chromium = require('@sparticuz/chromium')
        return [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
      })()
  const browser = await puppeteer.launch({
    args: chromiumArgs,
    defaultViewport: { width: 794, height: 1123 },
    executablePath: execPath,
    headless: true,
  })

  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await new Promise((r) => setTimeout(r, 300))

  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true })
  await browser.close()

  const targets = [
    'Instrucciones de atencionOK.pdf',
    'base de datos leña.pdf',
    'Base de datos de cercos.pdf',
    'Base de datos Pergolas y Sector Fogonero .pdf',
  ].map((f) => path.join(root, f))

  for (const t of targets) {
    try {
      fs.writeFileSync(t, pdfBuffer)
      console.log('✅ PDF actualizado:', path.basename(t))
    } catch (e) {
      console.error('❌ No pude escribir PDF:', t, e.message)
    }
  }
}

main().catch((e) => {
  console.error('❌ Error generando PDFs:', e.message)
  process.exit(1)
})

