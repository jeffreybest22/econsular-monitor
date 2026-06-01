const { chromium } = require('playwright');
require('dotenv').config();

const LOGIN_URL = 'https://ec-portoprince.itamaraty.gov.br/login';
const DASHBOARD_URL = 'https://ec-portoprince.itamaraty.gov.br/user-main';
const PROCESS_URL = 'https://ec-portoprince.itamaraty.gov.br/process?id=69a5a30b2cb1a60013b679f5';

const EC_EMAIL = process.env.EC_EMAIL;
const EC_PASSWORD = process.env.EC_PASSWORD;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || EC_EMAIL).split(',').map(e => e.trim());
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5') * 60 * 1000;

const NO_SLOTS_TEXT = 'Não há horários disponíveis no momento';
const SERVICE_NAME = 'Outras declarações e atestados';

let lastNotifiedAvailable = false;
let checkCount = 0;

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

  // Detect redirect to login (session expired)
  if (page.url().includes('/login')) {
    log('Session expired — re-logging in...');
    await login(page);
    await page.goto(PROCESS_URL, { waitUntil: 'networkidle', timeout: 30000 });
  }

  const bodyText = await page.locator('body').innerText();

  if (bodyText.includes(NO_SLOTS_TEXT)) {
    return { available: false, pageText: bodyText };
  }

  // Check if there are actual time slot elements
  const hasSlots = await page.locator('[class*="slot"], [class*="hora"], [class*="horario"], input[type="radio"]').count();
  return { available: true, pageText: bodyText, slotCount: hasSlots };
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
    const { available, slotCount } = await checkAvailability(page);

    if (available) {
      log(`SLOTS AVAILABLE! (${slotCount || '?'} slot(s) detected)`);

      if (!lastNotifiedAvailable) {
        lastNotifiedAvailable = true;
        await sendEmail(
          '🎉 RENDEZ-VOUS DISPONIBLE - Ambassade du Brésil Porto-Prince',
          `<div style="font-family:sans-serif;max-width:600px;margin:auto">
            <h2 style="color:#1a7f3c">✅ Créneaux de rendez-vous disponibles!</h2>
            <p>Un ou plusieurs créneaux sont maintenant disponibles pour votre demande:</p>
            <div style="background:#f0f7ff;padding:15px;border-left:4px solid #0066cc;margin:20px 0">
              <strong>${SERVICE_NAME}</strong><br>
              <small>Embaixada do Brasil em Porto Príncipe</small>
            </div>
            <p>
              <a href="${PROCESS_URL}" style="background:#1a7f3c;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">
                👉 Prendre le rendez-vous maintenant
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
    } else {
      log('No slots available yet.');
      if (lastNotifiedAvailable) {
        log('Slots were available before but no longer — resetting notification flag');
        lastNotifiedAvailable = false;
      }
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
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

async function main() {
  if (!EC_EMAIL || !EC_PASSWORD) {
    console.error('ERROR: EC_EMAIL or EC_PASSWORD not set in .env');
    process.exit(1);
  }

  log('=== E-Consular Appointment Monitor ===');
  log(`Service: ${SERVICE_NAME}`);
  log(`Notifications → ${NOTIFY_EMAILS.join(', ')}`);

  // --once : single check then exit (used by GitHub Actions)
  if (process.argv.includes('--once')) {
    await runCheck();
    process.exit(0);
  }

  log(`Check interval: ${CHECK_INTERVAL_MS / 60000} minutes`);
  await runCheck();
  setInterval(async () => { await runCheck(); }, CHECK_INTERVAL_MS);
  log(`Monitor running. Press Ctrl+C to stop.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
