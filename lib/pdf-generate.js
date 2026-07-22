'use strict';

/**
 * Génération PDF à partir de HTML via Chromium headless.
 * Compatible Vercel/serverless et développement local.
 */

const fs = require('fs');
const path = require('path');

const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.NETLIFY
);

async function launchBrowser() {
  const puppeteer = require('puppeteer-core');

  if (IS_SERVERLESS) {
    const chromium = require('@sparticuz/chromium');

    chromium.setGraphicsMode = false;

    console.log('[pdf] Résolution du binaire Chromium', {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      vercel: Boolean(process.env.VERCEL),
    });

    const executablePath = await chromium.executablePath();

    if (!executablePath || !fs.existsSync(executablePath)) {
      throw new Error(
        `Binaire Chromium introuvable après extraction : ${executablePath || 'chemin vide'}`
      );
    }

    console.log('[pdf] Binaire Chromium prêt', { executablePath });

    return puppeteer.launch({
      executablePath,
      headless: 'shell',
      args: [
        ...chromium.args,
        '--hide-scrollbars',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      defaultViewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      },
    });
  }

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || findLocalChrome();

  if (!executablePath) {
    throw new Error(
      "Chrome/Edge introuvable. Installez Google Chrome ou définissez PUPPETEER_EXECUTABLE_PATH vers l'exécutable."
    );
  }

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
}

function findLocalChrome() {
  const candidates = [];

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local =
      process.env.LOCALAPPDATA ||
      path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');

    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge'
    );
  }

  return candidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

async function htmlToPdf(html) {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new TypeError('Le HTML à convertir en PDF est vide ou invalide.');
  }

  const startedAt = Date.now();
  let browser;

  try {
    console.log('[pdf] Début de génération', { htmlLength: html.length });

    browser = await launchBrowser();
    console.log(`[pdf] Navigateur prêt en ${Date.now() - startedAt} ms`);

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: 'networkidle2',
      timeout: 20_000,
    });

    await page.emulateMediaType('print');

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: '18mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
    });

    console.log('[pdf] PDF généré', {
      bytes: pdf.length,
      durationMs: Date.now() - startedAt,
    });

    return pdf;
  } catch (error) {
    console.error('[pdf] Erreur Chromium/PDF', {
      name: error && error.name,
      message: error && error.message,
      stack: error && error.stack,
      cause: error && error.cause,
    });
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(closeError => {
        console.error('[pdf] Erreur fermeture Chromium', closeError);
      });
    }
  }
}

module.exports = { htmlToPdf };
