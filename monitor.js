const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const LOGIN_URL = 'https://ec-portoprincipe.itamaraty.gov.br/login';
const DASHBOARD_URL = 'https://ec-portoprincipe.itamaraty.gov.br/user-main';
const PROCESS_URL = 'https://ec-portoprincipe.itamaraty.gov.br/process?id=69a5a30b2cb1a60013b679f5';

const EC_EMAIL = process.env.EC_EMAIL;
const EC_PASSWORD = process.env.EC_PASSWORD;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || EC_EMAIL).split(',').map(e => e.trim());
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5') * 60 * 1000;

const NO_SLOTS_TEXT = 'Não há horários disponíveis no momento';
const SERVICE_NAME = 'Outras declarações e atestados';

let lastNotifiedAvailable = false;
let lastErrorNotifiedAt = 0;
let checkCount = 0;
const ERROR_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 heure entre chaque alerte erreur

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function sendEmail(subject, htmlBody) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    log('WARNING: RESEND_API_KEY not set — skipping email');
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'E-Consular Monitor <onboarding@resend.dev>',
      to: NOTIFY_EMAILS,
      subject,
      html: htmlBody,
    }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  log(`Email sent to: ${NOTIFY_EMAILS.join(', ')}`);
  return true;
}

async function login(page) {
  log('Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  // Fill email and password
  await page.fill('input[type="email"], input[name="email"], #email', EC_EMAIL);
  await page.fill('input[type="password"], input[name="password"], #password', EC_PASSWORD);
  await page.click('button[type="submit"], input[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL('**/user-main', { timeout: 20000 });
  log('Login successful');
}

async function ensureLoggedIn(page) {
  const url = page.url();
  if (url.includes('/login') || url === '') {
    await login(page);
  }
}

async function checkAvailability(page) {
  await page.goto(PROCESS_URL, { waitUntil: 'networkidle', timeout: 30000 });

  if (page.url().includes('/login')) {
    log('Session expired — re-logging in...');
    await login(page);
    await page.goto(PROCESS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  }

  const bodyText = await page.locator('body').innerText();

  if (bodyText.includes(NO_SLOTS_TEXT)) {
    return { available: false };
  }

  // Extract visible slot dates/times from the page
  let slots = [];

  // Try labeled slot elements first
  const slotEls = await page.locator('[class*="slot"], [class*="hora"], [class*="horario"], [class*="date"], [class*="data"]').allInnerTexts();
  slots = slotEls.map(t => t.trim()).filter(t => t.length > 2 && t.length < 80);

  // Fallback: extract date/time patterns from full body text
  if (slots.length === 0) {
    const dateMatches = bodyText.match(/\d{1,2}\/\d{1,2}\/\d{2,4}[^\n]*/g) || [];
    const timeMatches = bodyText.match(/\d{1,2}:\d{2}[^\n]*/g) || [];
    slots = [...new Set([...dateMatches, ...timeMatches])].map(s => s.trim()).slice(0, 10);
  }

  return { available: true, slots, slotCount: slots.length };
}

async function runCheck() {
  checkCount++;
  log(`--- Check #${checkCount} ---`);

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await login(page);
    const { available, slots = [], slotCount } = await checkAvailability(page);

    if (available) {
      log(`SLOTS AVAILABLE! (${slotCount || '?'} slot(s) detected)`);
      if (slots.length > 0) log(`Slots: ${slots.join(' | ')}`);

      if (!lastNotifiedAvailable) {
        lastNotifiedAvailable = true;

        const slotsHtml = slots.length > 0
          ? `<div style="background:#f0fff4;padding:15px;border-left:4px solid #1a7f3c;margin:15px 0">
              <strong>Créneaux disponibles :</strong>
              <ul style="margin:8px 0;padding-left:20px">
                ${slots.map(s => `<li style="margin:4px 0">${s}</li>`).join('')}
              </ul>
             </div>`
          : `<p style="color:#555">Connectez-vous pour voir les créneaux exacts.</p>`;

        await sendEmail(
          'RENDEZ-VOUS DISPONIBLE - Ambassade du Brésil Porto-Prince',
          `<div style="font-family:sans-serif;max-width:600px;margin:auto">
            <h2 style="color:#1a7f3c">Créneaux de rendez-vous disponibles!</h2>
            <p>Un ou plusieurs créneaux sont maintenant disponibles pour :</p>
            <div style="background:#f0f7ff;padding:15px;border-left:4px solid #0066cc;margin:15px 0">
              <strong>${SERVICE_NAME}</strong><br>
              <small>Embaixada do Brasil em Porto Príncipe</small>
            </div>
            ${slotsHtml}
            <p>
              <a href="${PROCESS_URL}" style="background:#1a7f3c;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">
                Prendre le rendez-vous maintenant
              </a>
            </p>
            <p><strong>Dépêchez-vous</strong> — les créneaux se remplissent rapidement!</p>
            <hr>
            <small style="color:#666">Détecté le ${new Date().toLocaleString('fr-FR')} | E-Consular Monitor</small>
          </div>`
        );
      } else {
        log('Notification already sent for this availability window — skipping duplicate');
      }
      return { ts: new Date().toISOString(), status: 'slots', message: `${slotCount || '?'} créneau(x) disponible(s)`, slots };
    } else {
      log('No slots available yet.');
      if (lastNotifiedAvailable) {
        log('Slots were available before but no longer — resetting notification flag');
        lastNotifiedAvailable = false;
      }
      return { ts: new Date().toISOString(), status: 'ok', message: 'Aucun créneau disponible' };
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);

    const now = Date.now();
    const isLoginError = err.message.includes('login') || err.message.includes('Login') || err.message.includes('user-main') || err.message.includes('password');
    const errorType = isLoginError ? 'Connexion impossible' : 'Vérification impossible';

    if (now - lastErrorNotifiedAt > ERROR_NOTIFY_COOLDOWN_MS) {
      lastErrorNotifiedAt = now;
      try {
        await sendEmail(
          `⚠️ ERREUR Monitor Ambassade du Brésil - ${errorType}`,
          `<div style="font-family:sans-serif;max-width:600px;margin:auto">
            <h2 style="color:#cc0000">⚠️ Problème détecté</h2>
            <p>Le moniteur n'a pas pu effectuer la vérification :</p>
            <div style="background:#fff3f3;padding:15px;border-left:4px solid #cc0000;margin:20px 0;font-family:monospace;font-size:13px">
              ${err.message.substring(0, 300)}
            </div>
            <p><strong>Type :</strong> ${errorType}</p>
            <p><strong>Heure :</strong> ${new Date().toLocaleString('fr-FR')}</p>
            <p>La surveillance continue — vous serez notifié si l'erreur persiste.</p>
            <hr>
            <small style="color:#666">E-Consular Monitor | Check #${checkCount}</small>
          </div>`
        );
        log('Error notification email sent');
      } catch (emailErr) {
        log(`Failed to send error email: ${emailErr.message}`);
      }
    } else {
      log('Error cooldown active — skipping duplicate error notification');
    }
    return { ts: new Date().toISOString(), status: 'error', message: err.message.substring(0, 200) };
  } finally {
    if (browser) await browser.close();
  }
}

async function testEmail() {
  log('Sending test email...');
  const ok = await sendEmail(
    '✅ Test - E-Consular Monitor configuré',
    `<p>Le moniteur e-consular est bien configuré.<br>
     Vous recevrez un email quand des créneaux seront disponibles pour:<br>
     <strong>${SERVICE_NAME}</strong></p>
     <p>Vérification toutes les ${CHECK_INTERVAL_MS / 60000} minutes.</p>`
  );
  if (ok) {
    log('Test email sent successfully!');
  } else {
    log('Test email FAILED — check GMAIL_APP_PASSWORD in .env');
  }
}

function writeStatusLog(logFile, entry) {
  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let data = { checks: [] };
    if (fs.existsSync(logFile)) {
      try { data = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
    }

    data.checks.unshift(entry);
    if (data.checks.length > 500) data.checks = data.checks.slice(0, 500);
    data.last_check = entry.ts;
    data.last_status = entry.status;

    fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
    log(`Status written to ${logFile}`);
  } catch (e) {
    log(`Failed to write status log: ${e.message}`);
  }
}

async function main() {
  if (!EC_EMAIL || !EC_PASSWORD) {
    console.error('ERROR: EC_EMAIL or EC_PASSWORD not set in .env');
    process.exit(1);
  }

  log('=== E-Consular Appointment Monitor ===');
  log(`Service: ${SERVICE_NAME}`);
  log(`Notifications → ${NOTIFY_EMAILS.join(', ')}`);

  const logFileIdx = process.argv.indexOf('--log-file');
  const logFile = logFileIdx !== -1 ? process.argv[logFileIdx + 1] : null;

  // --once : single check then exit (used by GitHub Actions)
  if (process.argv.includes('--once')) {
    const result = await runCheck();
    if (logFile && result) writeStatusLog(logFile, result);
    process.exit(0);
  }

  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);
  const r = await runCheck();
  if (logFile && r) writeStatusLog(logFile, r);

  setInterval(async () => {
    const r2 = await runCheck();
    if (logFile && r2) writeStatusLog(logFile, r2);
  }, CHECK_INTERVAL_MS);
  log(`Monitor running. Press Ctrl+C to stop.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
