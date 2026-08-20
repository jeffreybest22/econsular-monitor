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

// Tentative d'auto-réservation. Best-effort défensif : en cas de doute, N'AGIT PAS (repli manuel).
// Flux décrit : dropdowns date/heure → bouton "Prendre RDV" → modal confirmer → si indispo, réessayer sans refresh.
async function autoBook(page, svc) {
  const t0 = Date.now();
  const deadline = t0 + 90000; // borne 90s (timeout workflow = 4 min)
  let htmlSnapshot = ''; // capturé seulement en cas d'échec (ne pas retarder le 1er clic)
  log('[AUTOBOOK] Début (mode rapide, attentes événementielles)');

  const successRe = /agendado com sucesso|agendamento (realizado|confirmado)|est[áa] agendado para|sucesso/i;
  const unavailRe = /indispon|n[ãa]o (est[áa] )?dispon|hor[áa]rio.*(ocupad|indispon|n[ãa]o)|j[áa] (foi )?(reservad|agendad)|tente novamente/i;

  try {
    // 1) Récupérer les dropdowns (date, heure) présents sur la page
    const selects = await page.locator('select:visible').all();
    log(`[AUTOBOOK] ${selects.length} dropdown(s) trouvé(s)`);

    // Options non-placeholder de chaque select
    const optionsPerSelect = [];
    for (const sel of selects) {
      const opts = await sel.locator('option').all();
      const vals = [];
      for (const o of opts) {
        const val = await o.getAttribute('value');
        const txt = (await o.innerText().catch(() => '')).trim();
        // ignorer placeholder ("Selecione", vide)
        if (val && val !== '' && !/selecione|escolha|--/i.test(txt)) vals.push({ val, txt });
      }
      optionsPerSelect.push(vals);
    }

    // Bouton "Prendre rendez-vous" (par texte portugais)
    const bookBtn = page.locator('button, input[type=submit], a').filter({
      hasText: /agendar|marcar|confirmar agendamento|prender|reservar|selecionar hor/i,
    }).first();

    // Si aucun dropdown ET aucun bouton identifiable → on n'agit pas (sécurité)
    const hasBook = await bookBtn.count().catch(() => 0);
    if (selects.length === 0 && !hasBook) {
      log('[AUTOBOOK] Formulaire non reconnu — abandon (repli manuel)');
      htmlSnapshot = (await page.content().catch(() => '')).substring(0, 4000);
      return { booked: false, reason: 'form-not-recognized', htmlSnapshot };
    }

    // 2) Essayer chaque combinaison date×heure (bornée)
    // Cas simple fréquent : 1 select date + 1 select heure. Sinon on tente le 1er select seul.
    const dateOpts = optionsPerSelect[0] || [{ val: null, txt: '(défaut)' }];
    const timeOpts = optionsPerSelect[1] || [{ val: null, txt: '(défaut)' }];

    const modalSel = '[class*=modal]:visible, [role=dialog]:visible, .swal2-popup';

    for (const d of dateOpts) {
      if (Date.now() > deadline) break;
      if (d.val && selects[0]) {
        await selects[0].selectOption(d.val).catch(() => {});
        // attendre que le select heure se peuple (dépendant), max 1.5s
        if (selects[1]) await selects[1].locator('option').nth(1).waitFor({ timeout: 1500 }).catch(() => {});
      }

      // Recharger les options heure (peuvent dépendre de la date choisie)
      let currentTimeOpts = timeOpts;
      if (selects[1]) {
        const opts = await selects[1].locator('option').all();
        currentTimeOpts = [];
        for (const o of opts) {
          const val = await o.getAttribute('value');
          const txt = (await o.innerText().catch(() => '')).trim();
          if (val && val !== '' && !/selecione|escolha|--/i.test(txt)) currentTimeOpts.push({ val, txt });
        }
        if (currentTimeOpts.length === 0) currentTimeOpts = [{ val: null, txt: '(défaut)' }];
      }

      for (const t of currentTimeOpts) {
        if (Date.now() > deadline) break;
        if (t.val && selects[1]) await selects[1].selectOption(t.val).catch(() => {});

        log(`[AUTOBOOK] Tentative : date=${d.txt} heure=${t.txt} (+${Date.now() - t0}ms)`);
        // Cliquer "Prendre rendez-vous"
        if (hasBook) await bookBtn.click({ timeout: 4000 }).catch(() => {});

        // Attendre l'apparition du modal de confirmation (événementiel, ~200-500ms au lieu de 1.2s fixe)
        await page.locator(modalSel).first().waitFor({ timeout: 4000 }).catch(() => {});

        // Bouton confirmer dans le modal
        const confirmBtn = page.locator('[class*=modal] button, [role=dialog] button, .swal2-confirm, button').filter({
          hasText: /confirmar|sim|agendar|ok\b|prosseguir/i,
        }).first();
        if (await confirmBtn.count().catch(() => 0)) await confirmBtn.click({ timeout: 4000 }).catch(() => {});

        // Attendre le résultat (succès OU indispo) — événementiel, dès que le texte apparaît
        await page.waitForFunction(
          (re) => { const b = document.body.innerText;
            return new RegExp(re.s, 'i').test(b) || new RegExp(re.u, 'i').test(b); },
          { s: successRe.source, u: unavailRe.source }, { timeout: 5000 }
        ).catch(() => {});

        const bodyNow = await page.locator('body').innerText().catch(() => '');
        if (successRe.test(bodyNow)) {
          log(`[AUTOBOOK] ✅ RÉSERVÉ en ${Date.now() - t0}ms ! date=${d.txt} heure=${t.txt}`);
          return { booked: true, date: d.txt, time: t.txt };
        }
        if (unavailRe.test(bodyNow)) {
          log(`[AUTOBOOK] créneau ${t.txt} indispo — suivant (sans refresh)`);
          const closeBtn = page.locator('[class*=modal] button, .swal2-confirm, .swal2-cancel, button').filter({ hasText: /fechar|ok|voltar|cancelar/i }).first();
          if (await closeBtn.count().catch(() => 0)) { await closeBtn.click().catch(() => {}); await page.locator(modalSel).first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {}); }
          continue;
        }
        log(`[AUTOBOOK] résultat ambigu pour ${t.txt} — extrait: ${bodyNow.substring(0, 120).replace(/\n/g, ' ')}`);
      }
    }

    htmlSnapshot = (await page.content().catch(() => '')).substring(0, 4000);
    log(`[AUTOBOOK] Aucune combinaison réservée en ${Date.now() - t0}ms — repli manuel`);
    return { booked: false, reason: 'all-attempts-failed', htmlSnapshot };
  } catch (e) {
    log(`[AUTOBOOK] Erreur: ${e.message}`);
    return { booked: false, reason: 'error:' + e.message.substring(0, 80), htmlSnapshot };
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

          // 2) AUTO-RÉSERVATION (si activée) — page est déjà sur la page de RDV
          if (AUTO_BOOK) {
            bookResult = await autoBook(page, svc);
            log(`[AUTOBOOK] résultat: ${JSON.stringify({ booked: bookResult.booked, reason: bookResult.reason })}`);
            // Capturer le HTML du formulaire (1ère fois) pour affiner les sélecteurs
            if (bookResult.htmlSnapshot) log(`[AUTOBOOK] HTML(4k): ${bookResult.htmlSnapshot.replace(/\s+/g, ' ').substring(0, 1500)}`);
          }

          // 3) Notif résultat : succès = alarme victoire ; échec = rappel "réservez à la main"
          if (bookResult && bookResult.booked) {
            await sendNtfy(`✅ RDV RÉSERVÉ AUTO — ${svc.name}`,
              `Réservé automatiquement : ${bookResult.date || ''} ${bookResult.time || ''}. Vérifiez et confirmez sur le site.`, svc.url).catch(() => {});
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
                ? `<div style="background:#e8f5e9;padding:12px;border-left:4px solid #2e7d32;margin:12px 0"><strong>✅ Réservé automatiquement</strong> : ${bookResult.date || ''} ${bookResult.time || ''}<br>Vérifiez/confirmez sur le site.</div>`
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
          message: bookResult && bookResult.booked ? `RÉSERVÉ auto : ${bookResult.date || ''} ${bookResult.time || ''}` : `${slots.length || '?'} créneau(x)` });
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
