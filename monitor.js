const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BASE_URL    = 'https://ec-portoprincipe.itamaraty.gov.br';
const LOGIN_URL   = `${BASE_URL}/login`;
const DASH_URL    = `${BASE_URL}/user-main`;
const NO_SLOTS_TEXT = 'Não há horários disponíveis no momento';

const EC_EMAIL    = process.env.EC_EMAIL;
const EC_PASSWORD = process.env.EC_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || EC_EMAIL).split(',').map(e => e.trim());
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MINUTES || '5') * 60 * 1000;

// Per-service notification state  { [serviceId]: boolean }
const notifiedSlots = {};
let lastErrorNotifiedAt = 0;
let checkCount = 0;
const ERROR_COOLDOWN_MS = 60 * 60 * 1000;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function sendEmail(subject, htmlBody) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { log('WARNING: RESEND_API_KEY not set'); return false; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'E-Consular Monitor <onboarding@resend.dev>', to: NOTIFY_EMAILS, subject, html: htmlBody }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  log(`Email sent → ${NOTIFY_EMAILS.join(', ')}`);
  return true;
}

// ntfy.sh push notification — alarme sonore haute priorité qui bypasse le mode silencieux
// IMPORTANT: on envoie via corps JSON (UTF-8) — les en-têtes HTTP ne supportent pas
// les emoji/accents (erreur ByteString). Le format JSON gère l'UTF-8 sans problème.
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'econsular-jeff-a7f3k9x2';
async function sendNtfy(title, message, url, priority = 'urgent') {
  const loginUrl = 'https://ec-portoprincipe.itamaraty.gov.br/login';
  // Pour une alerte créneau (urgent), on répète 3× espacées pour être sûr de réveiller
  const repeats = priority === 'urgent' ? 3 : 1;
  let okCount = 0;

  for (let i = 0; i < repeats; i++) {
    try {
      const payload = {
        topic: NTFY_TOPIC,
        title: repeats > 1 ? `${title} (${i + 1}/${repeats})` : title,
        message,
        priority: priority === 'urgent' ? 5 : 3, // 5 = max (alarme + bypass silencieux)
        tags: priority === 'urgent' ? ['rotating_light', 'calendar'] : ['warning'],
        click: loginUrl,
        actions: [{ action: 'view', label: 'Réserver maintenant', url: url || loginUrl, clear: true }],
      };
      const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) { okCount++; log(`ntfy push ${i + 1}/${repeats} sent → ${NTFY_TOPIC}`); }
      else { log(`ntfy ${i + 1}/${repeats} failed ${res.status}: ${await res.text()}`); }
    } catch (e) {
      log(`ntfy ${i + 1}/${repeats} error: ${e.message}`);
    }
    if (i < repeats - 1) await new Promise(r => setTimeout(r, 20000)); // 20s entre les rappels
  }
  return okCount > 0;
}

// CallMeBot — appel vocal Telegram (gratuit) qui sonne et lit le message à voix haute
// Username dans le secret CALLMEBOT_USER (repo public — ne pas mettre en clair)
const CALLMEBOT_USER = process.env.CALLMEBOT_USER || '';
async function makeCall(text) {
  if (!CALLMEBOT_USER) { log('CALLMEBOT_USER not set — skipping call'); return false; }
  try {
    const url = `https://api.callmebot.com/start.php?user=${encodeURIComponent(CALLMEBOT_USER)}`
      + `&text=${encodeURIComponent(text)}&lang=fr-FR-Standard-A&rpt=2`;
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) { log(`CallMeBot failed ${res.status}: ${body.substring(0, 120)}`); return false; }
    log(`Phone call triggered → ${CALLMEBOT_USER}`);
    return true;
  } catch (e) {
    log(`CallMeBot error: ${e.message}`);
    return false;
  }
}

async function login(page) {
  log('Logging in...');
  // domcontentloaded au lieu de networkidle (site gouv a des connexions permanentes)
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 20000 });
  await page.fill('input[type="email"], input[name="email"], #email', EC_EMAIL);
  await page.fill('input[type="password"], input[name="password"], #password', EC_PASSWORD);
  await page.click('button[type="submit"], input[type="submit"]');
  await page.waitForURL('**/user-main', { timeout: 30000 });
  log('Login successful');
}

// Scrape all services from user-main dashboard
async function fetchServices(page) {
  await page.goto(DASH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('a[href*="/process"], table tr', { timeout: 15000 }).catch(() => {});
  if (page.url().includes('/login')) { await login(page); await page.goto(DASH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); }

  const rows = await page.locator('table tr, [class*="service"], [class*="processo"]').all();
  const services = [];

  for (const row of rows) {
    const text = (await row.innerText().catch(() => '')).trim();
    if (!text || text.length < 5) continue;

    // Look for a "Continuar" button with a link containing process ID
    const links = await row.locator('a[href*="/process"], a[href*="/agendamento"]').all();
    for (const link of links) {
      const href = await link.getAttribute('href').catch(() => '');
      const idMatch = href && href.match(/[?&]id=([a-f0-9]+)/i);
      if (idMatch) {
        // Get service name: first cell of the row, stop before person name / status
        let rawName = text.split('\n')[0].trim();
        // Remove known status phrases and anything after them
        rawName = rawName.replace(/\s*(Necessita|Validado|Em análise|Aguardando|Concluído|Apagar|Continuar).*/i, '').trim();
        // If still too long, try to get the first <td> text directly
        if (rawName.length > 80) {
          const firstCell = await row.locator('td').first().innerText().catch(() => '');
          if (firstCell.trim().length > 5) rawName = firstCell.trim().split('\n')[0];
        }
        const name = rawName.substring(0, 70).trim() || 'Service';
        if (!services.find(s => s.id === idMatch[1])) {
          services.push({
            id: idMatch[1],
            name,
            url: `${BASE_URL}${href.startsWith('/') ? href : '/' + href}`,
          });
        }
      }
    }
  }

  // Fallback: try to find process links anywhere on page
  if (services.length === 0) {
    const allLinks = await page.locator('a[href*="/process?id="]').all();
    for (const link of allLinks) {
      const href  = await link.getAttribute('href').catch(() => '');
      const label = (await link.innerText().catch(() => '')).trim() || 'Service';
      const idMatch = href && href.match(/id=([a-f0-9]+)/i);
      if (idMatch && !services.find(s => s.id === idMatch[1])) {
        services.push({ id: idMatch[1], name: label, url: `${BASE_URL}${href}` });
      }
    }
  }

  log(`Found ${services.length} service(s): ${services.map(s => s.name).join(' | ')}`);
  return services;
}

async function checkOneService(page, service) {
  const url = service.url || `${BASE_URL}/process?id=${service.id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  if (page.url().includes('/login')) {
    await login(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  // Attendre que le contenu de la page de RDV soit chargé
  await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500); // laisser le JS rendre les créneaux

  const bodyText = await page.locator('body').innerText();

  // Déjà réservé : la page de confirmation contient "está agendado para".
  // Ne PAS alerter — sinon la date du RDV pris est prise pour un créneau libre.
  const alreadyBooked = /est[áa]\s+agendado\s+para|servi[çc]o\s+consular\s+est[áa]\s+agendado/i.test(bodyText);
  if (alreadyBooked) {
    log(`  → "${service.name}" déjà réservé (RDV pris) — pas d'alerte`);
    return { available: false, slots: [], booked: true };
  }

  // Must be a scheduling page (contains "Agendamento" header)
  const isSchedulingPage = bodyText.includes('Agendamento') || bodyText.includes('Escolha um dia');
  if (!isSchedulingPage) {
    log(`  → Not a scheduling page (form/other step) — skipping`);
    return { available: false, slots: [], skipped: true };
  }

  // La page de RDV doit avoir l'invitation à choisir un créneau
  const isSlotChooser = bodyText.includes('Escolha um dia') || bodyText.includes('horário');
  if (!isSlotChooser) {
    log(`  → "${service.name}" page Agendamento sans sélecteur de créneau — skip`);
    return { available: false, slots: [], skipped: true };
  }

  if (bodyText.includes(NO_SLOTS_TEXT)) {
    return { available: false, slots: [] };
  }

  let slots = [];
  const slotEls = await page.locator('[class*="slot"],[class*="hora"],[class*="horario"],[class*="date"],[class*="data"]').allInnerTexts();
  slots = slotEls.map(t => t.trim()).filter(t => t.length > 2 && t.length < 80);

  if (slots.length === 0) {
    const dm = bodyText.match(/\d{1,2}\/\d{1,2}\/\d{2,4}[^\n]*/g) || [];
    const tm = bodyText.match(/\d{2}:\d{2}[^\n]*/g) || [];
    slots = [...new Set([...dm, ...tm])].map(s => s.trim()).slice(0, 10);
  }

  return { available: true, slots };
}

async function runCheck() {
  checkCount++;
  log(`--- Check #${checkCount} ---`);

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(45000);

    // Login avec retry (2 tentatives) — résiste aux blips réseau et lenteurs du site
    let loginOk = false;
    for (let attempt = 1; attempt <= 2 && !loginOk; attempt++) {
      try {
        await login(page);
        loginOk = true;
      } catch (e) {
        log(`Login attempt ${attempt} failed: ${e.message}`);
        if (attempt < 2) { await page.waitForTimeout(3000); }
        else throw e;
      }
    }

    // Discover all services
    let services = await fetchServices(page);

    // Normalize known service names
    for (const s of services) {
      if (/Outras declaraç/i.test(s.name)) s.name = 'Outras declarações e atestados';
      if (/Visto de Visita/i.test(s.name))  s.name = 'Visto de Visita - VIVIS';
    }

    // Fallback: if scraping found nothing, use the hardcoded default
    if (services.length === 0) {
      log('No services scraped — using hardcoded default');
      services = [{ id: '69a5a30b2cb1a60013b679f5', name: 'Outras declarações e atestados', url: `${BASE_URL}/process?id=69a5a30b2cb1a60013b679f5` }];
    }

    const results = [];
    for (const svc of services) {
      log(`Checking: ${svc.name}`);
      const { available, slots, skipped, booked } = await checkOneService(page, svc);

      if (booked) {
        notifiedSlots[svc.id] = false;
        results.push({ id: svc.id, name: svc.name, status: 'booked', slots: [], message: 'Rendez-vous déjà réservé' });
        continue;
      }

      if (skipped) {
        log(`  → "${svc.name}" skipped (not a scheduling page)`);
        results.push({ id: svc.id, name: svc.name, status: 'ok', slots: [], message: 'Pas encore à l\'étape rendez-vous' });
        continue;
      }

      if (available) {
        log(`SLOTS AVAILABLE for "${svc.name}"! (${slots.length} slot(s))`);
        if (slots.length > 0) log(`  → ${slots.join(' | ')}`);

        if (!notifiedSlots[svc.id]) {
          notifiedSlots[svc.id] = true;
          const slotsHtml = slots.length > 0
            ? `<ul style="padding-left:20px">${slots.map(s => `<li>${s}</li>`).join('')}</ul>`
            : `<p>Connectez-vous pour voir les créneaux exacts.</p>`;
          await sendEmail(
            `RENDEZ-VOUS DISPONIBLE — ${svc.name}`,
            `<div style="font-family:sans-serif;max-width:600px;margin:auto">
              <h2 style="color:#1a7f3c">Créneaux disponibles !</h2>
              <div style="background:#f0f7ff;padding:15px;border-left:4px solid #0066cc;margin:15px 0">
                <strong>${svc.name}</strong><br><small>Embaixada do Brasil em Porto Príncipe</small>
              </div>
              ${slotsHtml}
              <p><a href="${svc.url}" style="background:#1a7f3c;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Réserver maintenant</a></p>
              <p><strong>Dépêchez-vous !</strong></p>
              <hr><small>Détecté le ${new Date().toLocaleString('fr-FR')} | E-Consular Monitor</small>
            </div>`
          ).catch(e => log(`Email failed (non-fatal): ${e.message}`));

          // Push ntfy.sh — alarme sonore sur le téléphone
          const ntfyMsg = slots.length > 0
            ? `${slots.length} créneau(x) : ${slots.slice(0, 3).join(', ')}`
            : 'Un créneau vient de s\'ouvrir — réservez vite !';
          await sendNtfy(`🚨 RDV DISPONIBLE — ${svc.name}`, ntfyMsg, svc.url);

          // Appel téléphonique Telegram (CallMeBot) — sonne et lit le message
          await makeCall(`Alerte rendez-vous. Un créneau est disponible pour ${svc.name} à l'ambassade du Brésil. Connectez-vous immédiatement pour réserver.`)
            .catch(e => log(`Call failed (non-fatal): ${e.message}`));
        } else {
          log(`Notification already sent for "${svc.name}" — skipping duplicate`);
        }
        results.push({ id: svc.id, name: svc.name, status: 'slots', slots, message: `${slots.length || '?'} créneau(x)` });
      } else {
        if (notifiedSlots[svc.id]) { notifiedSlots[svc.id] = false; }
        log(`No slots for "${svc.name}"`);
        results.push({ id: svc.id, name: svc.name, status: 'ok', slots: [], message: 'Aucun créneau disponible' });
      }
    }

    const overallStatus = results.some(r => r.status === 'slots') ? 'slots' : 'ok';
    const overallMsg    = results.some(r => r.status === 'slots')
      ? results.filter(r => r.status === 'slots').map(r => r.name).join(', ')
      : 'Aucun créneau disponible';

    return { ts: new Date().toISOString(), status: overallStatus, message: overallMsg, services: results };

  } catch (err) {
    log(`ERROR: ${err.message}`);
    const now = Date.now();
    if (now - lastErrorNotifiedAt > ERROR_COOLDOWN_MS) {
      lastErrorNotifiedAt = now;
      const isLogin = /login|user-main|password/i.test(err.message);
      await sendEmail(
        `⚠️ ERREUR Monitor — ${isLogin ? 'Connexion impossible' : 'Vérification impossible'}`,
        `<div style="font-family:sans-serif">
          <h2 style="color:#cc0000">⚠️ Problème détecté</h2>
          <pre style="background:#fff3f3;padding:15px;border-left:4px solid #c00">${err.message.substring(0, 300)}</pre>
          <p>Heure : ${new Date().toLocaleString('fr-FR')}</p>
        </div>`
      ).catch(() => {});
      // ntfy priorité 'default' (notif normale, pas alarme) pour signaler un souci sans réveiller
      await sendNtfy(
        `⚠️ Monitor en erreur`,
        `Le moniteur n'a pas pu vérifier : ${err.message.substring(0, 120)}`,
        'https://jeffreybest22.github.io/econsular-monitor',
        'default'
      ).catch(() => {});
    }
    return { ts: new Date().toISOString(), status: 'error', message: err.message.substring(0, 200), services: [] };
  } finally {
    if (browser) await browser.close();
  }
}

function writeStatusLog(logFile, entry) {
  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data = { checks: [] };
    if (fs.existsSync(logFile)) { try { data = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {} }
    data.checks.unshift(entry);
    if (data.checks.length > 300) data.checks = data.checks.slice(0, 300);
    data.last_check  = entry.ts;
    data.last_status = entry.status;
    fs.writeFileSync(logFile, JSON.stringify(data, null, 2));
    log(`Status written to ${logFile}`);
  } catch (e) { log(`Failed to write log: ${e.message}`); }
}

async function main() {
  log('=== E-Consular Monitor ===');

  // Test ntfy alarm without logging in
  if (process.argv.includes('--test-ntfy')) {
    log(`Sending test alarm to topic: ${NTFY_TOPIC}`);
    await sendNtfy('🚨 TEST — E-Consular Monitor', 'Ceci est un test. Si vous entendez l\'alarme, tout fonctionne !', 'https://jeffreybest22.github.io/econsular-monitor');
    process.exit(0);
  }

  // Test phone call without logging in
  if (process.argv.includes('--test-call')) {
    log(`Triggering test call to: ${CALLMEBOT_USER}`);
    await makeCall('Ceci est un test du moniteur de rendez-vous de l\'ambassade du Brésil. Si vous entendez ce message, les appels fonctionnent.');
    process.exit(0);
  }

  if (!EC_EMAIL || !EC_PASSWORD) { console.error('ERROR: EC_EMAIL or EC_PASSWORD not set'); process.exit(1); }
  log(`Notifications → ${NOTIFY_EMAILS.join(', ')} | ntfy: ${NTFY_TOPIC}`);

  const logFileIdx = process.argv.indexOf('--log-file');
  const logFile    = logFileIdx !== -1 ? process.argv[logFileIdx + 1] : null;

  if (process.argv.includes('--once')) {
    const result = await runCheck();
    if (logFile && result) writeStatusLog(logFile, result);
    process.exit(0);
  }

  log(`Interval: ${CHECK_INTERVAL_MS / 60000} min`);
  const r = await runCheck();
  if (logFile && r) writeStatusLog(logFile, r);
  setInterval(async () => { const r2 = await runCheck(); if (logFile && r2) writeStatusLog(logFile, r2); }, CHECK_INTERVAL_MS);
  log('Monitor running. Ctrl+C to stop.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
