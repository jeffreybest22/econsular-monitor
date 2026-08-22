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

// FOCUS : ne surveiller QUE les services dont le nom contient un de ces mots-clés.
// Les autres sont listés "en pause" (pas de vérif, pas d'alerte).
// Vide = surveiller tous les services. Modifiable via secret FOCUS_ONLY (mots séparés par virgule).
const FOCUS_ONLY = (process.env.FOCUS_ONLY || 'Visto de Visita')
  .split(',').map(s => s.trim()).filter(Boolean);

// FENÊTRE CHAUDE : heures (Haïti) où les créneaux tombent le plus → vérifs rapprochées.
// Intel Jeff : ~23h, minuit, 1h du matin. Pendant ces heures, plusieurs vérifs/run (~toutes les 20s).
const HOT_HOURS = (process.env.HOT_HOURS || '23,0,1').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

// AUTO-RÉSERVATION : tenter de réserver automatiquement le 1er créneau. Désactivable via secret AUTO_BOOK=false.
// L'alarme (appel+ntfy+email) part TOUJOURS en parallèle → repli manuel si l'auto échoue.
const AUTO_BOOK = (process.env.AUTO_BOOK || 'true').toLowerCase() !== 'false';

function currentHaitiHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Port-au-Prince', hour: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(new Date());
  return parseInt(parts.find(p => p.type === 'hour').value);
}
const inHotWindow = () => HOT_HOURS.includes(currentHaitiHour());

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

// Capture DURABLE de la vraie structure du formulaire (pour fiabiliser l'auto-réservation).
// Retourne selects+options, boutons+texte, modals, et le HTML de la zone principale (pas l'en-tête).
async function captureForm(page) {
  try {
    return await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const selects = [...document.querySelectorAll('select')].map(s => ({
        id: s.id, name: s.name, cls: s.className,
        options: [...s.options].map(o => ({ v: o.value, t: clean(o.textContent) })).slice(0, 15),
      }));
      const buttons = [...document.querySelectorAll('button, input[type=submit], a.btn, a[class*=btn], [role=button]')]
        .map(b => ({ tag: b.tagName, txt: clean(b.textContent || b.value).slice(0, 50), id: b.id, cls: b.className }))
        .filter(b => b.txt);
      const modals = [...document.querySelectorAll('[class*=modal], [role=dialog], [id*=modal], .swal2-popup')]
        .map(m => ({ id: m.id, cls: m.className, visible: m.offsetParent !== null, html: clean(m.outerHTML).slice(0, 1500) }));
      // Zone principale (le formulaire), pas le <head> ni la barre gov
      const main = document.querySelector('main, [role=main], .container-fluid, #content, .content');
      const mainHtml = main ? main.outerHTML : document.body.innerHTML;
      return { selects, buttons, modals, mainHtml: mainHtml.replace(/\s+/g, ' ').slice(0, 18000) };
    });
  } catch (e) { return { error: e.message }; }
}

// Auto-réservation — VRAIS sélecteurs (capturés le 22/08 sur une occurrence réelle) :
//   date  = <select name="date">        heure = <select name="time"> (options 10h00/11h00/14h00)
//   bouton = <button class="btn btn-outline-success">Agendar</button>
//   modal  = #confirm-modal-XXXX (.modal.fade) → bouton "Sim" (.btn-danger) confirme
//   Succès = après confirmation, la page process affiche "está agendado para".
async function autoBook(page, svc) {
  const t0 = Date.now();
  const deadline = t0 + 80000;
  const tried = new Set();

  const readOpts = async (sel) => {
    const opts = await sel.locator('option').all();
    const out = [];
    for (const o of opts) {
      const v = await o.getAttribute('value');
      const t = (await o.innerText().catch(() => '')).trim();
      if (v && v !== '' && !/selecione|escolha|--/i.test(t)) out.push({ v, t });
    }
    return out;
  };

  try {
    for (let iter = 0; iter < 12 && Date.now() < deadline; iter++) {
      // (Re)charger la page de RDV — sert aussi à CONFIRMER une réservation faite au tour précédent
      await page.goto(svc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(700);
      const body = await page.locator('body').innerText().catch(() => '');

      if (/est[áa]\s+agendado\s+para/i.test(body)) {
        const m = body.match(/agendado para\s+([^.\n]+)/i);
        log(`[AUTOBOOK] ✅ RÉSERVÉ confirmé en ${Date.now() - t0}ms — ${m ? m[1].trim() : ''}`);
        return { booked: true, when: m ? m[1].trim().substring(0, 80) : '' };
      }
      if (body.includes(NO_SLOTS_TEXT)) {
        log('[AUTOBOOK] créneau disparu (plus de dispo)');
        return { booked: false, reason: 'slot-gone' };
      }

      const dateSel = page.locator('select[name=date]');
      const timeSel = page.locator('select[name=time]');
      if (!(await dateSel.count()) || !(await timeSel.count())) {
        log('[AUTOBOOK] selects date/time absents — repli manuel');
        return { booked: false, reason: 'form-not-recognized', htmlSnapshot: (await page.content().catch(() => '')).slice(0, 4000) };
      }

      const dOpts = await readOpts(dateSel);
      if (!dOpts.length) { log('[AUTOBOOK] pas de date'); return { booked: false, reason: 'no-date' }; }
      const d = dOpts[0];
      await dateSel.selectOption(d.v).catch(() => {});
      await page.waitForTimeout(250); // le select heure peut dépendre de la date

      const tOpts = await readOpts(timeSel);
      const pick = tOpts.find(o => !tried.has(`${d.v}|${o.v}`));
      if (!pick) { log('[AUTOBOOK] toutes combinaisons essayées'); return { booked: false, reason: 'all-tried' }; }
      tried.add(`${d.v}|${pick.v}`);
      await timeSel.selectOption(pick.v).catch(() => {});

      log(`[AUTOBOOK] Tentative date=${d.t} heure=${pick.t} (+${Date.now() - t0}ms)`);

      // Cliquer "Agendar" (bouton vert principal)
      await page.locator('button.btn-outline-success').first().click({ timeout: 4000 }).catch(() => {});

      // Attendre le modal de confirmation
      const modal = page.locator('[id^=confirm-modal], .modal.fade').first();
      await modal.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});

      // Confirmer : bouton "Sim" (rouge) DANS le modal — scoping crucial pour ne pas recliquer "Agendar"
      const sim = page.locator('[id^=confirm-modal] button.btn-danger, .modal.show button.btn-danger').first();
      if (await sim.count().catch(() => 0)) {
        await sim.click({ timeout: 4000 }).catch(() => {});
      } else {
        // fallback : bouton du modal contenant "Sim"
        await page.locator('.modal.show button, [id^=confirm-modal] button').filter({ hasText: /^\s*sim\s*$/i }).first().click({ timeout: 3000 }).catch(() => {});
      }

      // Laisser la requête de réservation partir ; le prochain tour rechargera et confirmera via "está agendado"
      await page.waitForTimeout(1500);
    }
    log(`[AUTOBOOK] non abouti en ${Date.now() - t0}ms`);
    return { booked: false, reason: 'exhausted' };
  } catch (e) {
    log(`[AUTOBOOK] Erreur: ${e.message}`);
    return { booked: false, reason: 'error:' + e.message.substring(0, 80) };
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

  const rows = await page.locator('table tbody tr, table tr').all();
  const services = [];

  for (const row of rows) {
    const cells = await row.locator('td').all();
    if (cells.length < 2) continue; // header row or empty

    // Cellule 1 = nom du service, cellule 3 (souvent) = statut
    let name = (await cells[0].innerText().catch(() => '')).trim().split('\n')[0].trim();
    name = name.replace(/\s*(Necessita|Validado|Em análise|Aguardando|Concluído|Apagar|Continuar).*/i, '').trim();
    if (!name || name.length < 4) continue;

    // Statut = avant-dernière cellule texte (la dernière = Ações/boutons)
    let statusText = '';
    for (let i = cells.length - 1; i >= 1; i--) {
      const t = (await cells[i].innerText().catch(() => '')).trim();
      if (t && !/Continuar|Apagar|Imprimir|Ver instru/i.test(t)) { statusText = t.replace(/\n+/g, ' ').trim(); break; }
    }

    // Lien de prise de RDV éventuel
    const link = row.locator('a[href*="/process"], a[href*="/agendamento"]').first();
    const href = await link.getAttribute('href').catch(() => null);
    const idMatch = href && href.match(/[?&]id=([a-f0-9]+)/i);

    const id  = idMatch ? idMatch[1] : `noid-${name.substring(0, 20)}`;
    const url = idMatch ? `${BASE_URL}${href.startsWith('/') ? href : '/' + href}` : null;

    if (!services.find(s => s.id === id)) {
      services.push({ id, name: name.substring(0, 70), url, dashStatus: statusText, monitorable: !!url });
    }
  }

  log(`Found ${services.length} service(s): ${services.map(s => `${s.name}${s.monitorable ? '' : ' [non-surveillable]'}`).join(' | ')}`);
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

async function runCheck(opts = {}) {
  checkCount++;
  const { sharedPage = null, cachedServices = null } = opts;
  log(`--- Check #${checkCount}${sharedPage ? ' (session réutilisée)' : ''} ---`);

  let browser = null;
  try {
    let page;
    if (sharedPage) {
      page = sharedPage; // session déjà connectée (rafale) — pas de launch ni login
    } else {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
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
    }

    // Découverte des services (ou réutilisation du cache pendant la rafale)
    let services = cachedServices;
    if (!services) {
      services = await fetchServices(page);
      for (const s of services) {
        if (/Outras declaraç/i.test(s.name)) s.name = 'Outras declarações e atestados';
        if (/Visto de Visita/i.test(s.name))  s.name = 'Visto de Visita - VIVIS';
      }
      if (services.length === 0) {
        log('No services scraped — using hardcoded default');
        services = [{ id: '69a5a30b2cb1a60013b679f5', name: 'Outras declarações e atestados', url: `${BASE_URL}/process?id=69a5a30b2cb1a60013b679f5` }];
      }
    }

    const results = [];
    for (const svc of services) {
      // FOCUS : si une liste est définie et que ce service n'y correspond pas → en pause
      if (FOCUS_ONLY.length > 0 && !FOCUS_ONLY.some(kw => svc.name.toLowerCase().includes(kw.toLowerCase()))) {
        log(`  → "${svc.name}" EN PAUSE (hors focus)`);
        results.push({ id: svc.id, name: svc.name, status: 'paused', slots: [], message: 'En pause (surveillance désactivée)' });
        continue;
      }

      // Service sans étape RDV (ex: "Em validação, aguarde e-mail") : on le liste avec son statut, sans visiter de page
      if (svc.monitorable === false) {
        log(`  → "${svc.name}" non-surveillable (${svc.dashStatus || 'statut inconnu'})`);
        results.push({ id: svc.id, name: svc.name, status: 'ok', slots: [], message: svc.dashStatus || 'En cours (pas d\'étape rendez-vous)' });
        continue;
      }

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

        let bookResult = null;
        if (!notifiedSlots[svc.id]) {
          notifiedSlots[svc.id] = true;

          // 1) ALARME IMMÉDIATE (fire-and-forget) — réveiller Jeff SANS attendre l'auto-réservation
          sendNtfy(`🚨 RDV DISPONIBLE — ${svc.name}`,
            slots.length > 0 ? `${slots.length} créneau(x) : ${slots.slice(0, 3).join(', ')}` : 'Un créneau vient de s\'ouvrir !',
            svc.url).catch(e => log(`ntfy failed: ${e.message}`));
          makeCall(`Alerte rendez-vous disponible pour ${svc.name} à l'ambassade du Brésil. Connectez-vous immédiatement.`)
            .catch(e => log(`Call failed: ${e.message}`));

          // 1bis) CAPTURE DURABLE du vrai formulaire (avant toute action) → docs/last_form.json (poussé)
          try {
            const formCapture = await captureForm(page);
            fs.writeFileSync('docs/last_form.json', JSON.stringify({
              ts: new Date().toISOString(), service: svc.name, url: svc.url, slots, capture: formCapture,
            }, null, 2));
            log(`[CAPTURE] formulaire sauvé → docs/last_form.json (${(formCapture.mainHtml || '').length} car., ${(formCapture.selects || []).length} selects, ${(formCapture.buttons || []).length} boutons)`);
          } catch (e) { log(`[CAPTURE] échec: ${e.message}`); }

          // 2) AUTO-RÉSERVATION (si activée) — page est déjà sur la page de RDV
          if (AUTO_BOOK) {
            bookResult = await autoBook(page, svc);
            log(`[AUTOBOOK] résultat: ${JSON.stringify({ booked: bookResult.booked, reason: bookResult.reason })}`);
          }

          // 3) Notif résultat : succès = alarme victoire ; échec = rappel "réservez à la main"
          if (bookResult && bookResult.booked) {
            await sendNtfy(`✅ RDV RÉSERVÉ AUTO — ${svc.name}`,
              `Réservé automatiquement : ${bookResult.when || ''}. Vérifiez et confirmez sur le site.`, svc.url).catch(() => {});
            makeCall(`Bonne nouvelle. Un rendez-vous a été réservé automatiquement pour ${svc.name}. Vérifiez le site pour confirmer.`).catch(() => {});
          } else if (AUTO_BOOK) {
            await sendNtfy(`⚠️ Créneau détecté — À RÉSERVER À LA MAIN — ${svc.name}`,
              'L\'auto-réservation n\'a pas abouti. Ouvrez le site MAINTENANT pour réserver vous-même.', svc.url).catch(() => {});
          }

          // 4) Email récapitulatif avec le résultat
          const slotsHtml = slots.length > 0
            ? `<ul style="padding-left:20px">${slots.map(s => `<li>${s}</li>`).join('')}</ul>`
            : `<p>Connectez-vous pour voir les créneaux exacts.</p>`;
          const bookHtml = bookResult
            ? (bookResult.booked
                ? `<div style="background:#e8f5e9;padding:12px;border-left:4px solid #2e7d32;margin:12px 0"><strong>✅ Réservé automatiquement</strong> : ${bookResult.when || ''}<br>Vérifiez/confirmez sur le site.</div>`
                : `<div style="background:#fff3f3;padding:12px;border-left:4px solid #c00;margin:12px 0"><strong>⚠️ Auto-réservation non aboutie</strong> (${bookResult.reason || '?'}). Réservez à la main tout de suite.</div>`)
            : '';
          await sendEmail(
            `${bookResult && bookResult.booked ? '✅ RDV RÉSERVÉ' : 'RENDEZ-VOUS DISPONIBLE'} — ${svc.name}`,
            `<div style="font-family:sans-serif;max-width:600px;margin:auto">
              <h2 style="color:#1a7f3c">Créneaux disponibles !</h2>
              <div style="background:#f0f7ff;padding:15px;border-left:4px solid #0066cc;margin:15px 0">
                <strong>${svc.name}</strong><br><small>Embaixada do Brasil em Porto Príncipe</small>
              </div>
              ${bookHtml}
              ${slotsHtml}
              <p><a href="${svc.url}" style="background:#1a7f3c;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Ouvrir le site</a></p>
              <hr><small>Détecté le ${new Date().toLocaleString('fr-FR')} | E-Consular Monitor</small>
            </div>`
          ).catch(e => log(`Email failed (non-fatal): ${e.message}`));
        } else {
          log(`Notification already sent for "${svc.name}" — skipping duplicate`);
        }
        results.push({ id: svc.id, name: svc.name, status: 'slots', slots,
          message: bookResult && bookResult.booked ? `RÉSERVÉ auto : ${bookResult.when || ''}` : `${slots.length || '?'} créneau(x)` });
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
    // Fenêtre chaude (23h/00h/01h Haïti) : SESSION RÉUTILISÉE (1 seul login) + vérifs directes ~toutes les 3s.
    // Bien plus rapide : plus de re-login ni re-scrape user-main entre les vérifs.
    if (inHotWindow()) {
      log(`🔥 FENÊTRE CHAUDE (${currentHaitiHour()}h Haïti) — session réutilisée, vérifs ~3s`);
      let browser = null;
      try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.setDefaultTimeout(45000);
        // Login UNE fois
        let ok = false;
        for (let a = 1; a <= 2 && !ok; a++) {
          try { await login(page); ok = true; }
          catch (e) { log(`Login ${a} échec: ${e.message}`); if (a < 2) await page.waitForTimeout(3000); else throw e; }
        }
        // Découvrir les services UNE fois (URLs mises en cache pour la rafale)
        let services = await fetchServices(page);
        for (const s of services) {
          if (/Outras declaraç/i.test(s.name)) s.name = 'Outras declarações e atestados';
          if (/Visto de Visita/i.test(s.name))  s.name = 'Visto de Visita - VIVIS';
        }
        if (services.length === 0) services = [{ id: '69a5a30b2cb1a60013b679f5', name: 'Outras declarações e atestados', url: `${BASE_URL}/process?id=69a5a30b2cb1a60013b679f5` }];

        const end = Date.now() + 50000;
        let n = 0;
        do {
          n++;
          const result = await runCheck({ sharedPage: page, cachedServices: services });
          if (logFile && result) writeStatusLog(logFile, result);
          if (result && result.status === 'slots') { log('Créneau trouvé — fin de rafale'); break; }
          if (Date.now() < end) await new Promise(r => setTimeout(r, 3000));
        } while (Date.now() < end);
        log(`Rafale terminée (${n} vérif(s) sur 1 session)`);
      } catch (e) {
        log(`Rafale erreur: ${e.message}`);
      } finally {
        if (browser) await browser.close();
      }
      process.exit(0);
    }

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
