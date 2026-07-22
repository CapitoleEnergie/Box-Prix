'use strict';
/**
 * Génération PDF à partir de HTML via Chromium headless.
 *
 * Compatible :
 *   - Vercel / serverless : puppeteer-core + @sparticuz/chromium
 *     (chromium packagé pour AWS Lambda, chargé à la demande)
 *   - Dev local (Windows/Mac/Linux) :
 *       * Si PUPPETEER_EXECUTABLE_PATH est défini → l'utilise
 *       * Sinon, tente de trouver Chrome/Edge/Brave installé automatiquement
 *
 * Zéro dépendance à Python/Playwright.
 */
const fs = require('fs');
const path = require('path');

const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');

  if (IS_SERVERLESS) {
    const chromium = require('@sparticuz/chromium');
    // Recommandations @sparticuz/chromium sur Vercel : mode headless "shell" (plus léger)
    chromium.setHeadlessMode = true;
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    return puppeteer.launch({
      args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });
  }

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || findLocalChrome();
  if (!executablePath) {
    throw new Error(
      'Chrome/Edge introuvable. Installez Google Chrome ou définissez PUPPETEER_EXECUTABLE_PATH vers l\'exécutable.'
    );
  }
  return puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

function findLocalChrome() {
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(process.env['USERPROFILE'] || 'C:\\', 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function htmlToPdf(html) {
  const t0 = Date.now();
  const browser = await launchBrowser();
  console.log(`[pdf] browser ready in ${Date.now() - t0}ms`);
  try {
    const page = await browser.newPage();
    // networkidle0 attend indéfiniment si une requête (ex : Google Fonts) traîne
    // → networkidle2 + timeout 20s : plus fiable sur serverless.
    await page.setContent(html, { waitUntil: 'networkidle2', timeout: 20_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', right: '15mm', bottom: '20mm', left: '15mm' },
    });
    console.log(`[pdf] generated (${pdf.length} bytes) in ${Date.now() - t0}ms`);
    return pdf;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { htmlToPdf };
