/**
 * Cloudflare Worker — E-Consular Appointment Monitor
 * Runs every 5 minutes via Cron Trigger.
 * Sends email via Resend API when slots become available.
 */

const LOGIN_URL = 'https://ec-portoprince.itamaraty.gov.br/login';
const PROCESS_URL = 'https://ec-portoprince.itamaraty.gov.br/process?id=69a5a30b2cb1a60013b679f5';
const SERVICE_LABEL = 'Outras declarações e atestados';
const NO_SLOTS_TEXT = 'Não há horários disponíveis no momento';

// KV key for cooldown (prevent duplicate emails within 30 min)
const KV_COOLDOWN_KEY = 'notified_available_ts';
const COOLDOWN_SECONDS = 30 * 60; // 30 minutes

// ──────────────────────────────────────────────
// Entry points
// ──────────────────────────────────────────────

export default {
  // Cron trigger: runs on schedule defined in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  // HTTP: manual trigger via /check  (useful for debugging)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/check') {
      const result = await runMonitor(env);
      return Response.json(result);
    }

    if (url.pathname === '/reset-cooldown') {
      await env.KV.delete(KV_COOLDOWN_KEY);
      return Response.json({ ok: true, message: 'Cooldown reset' });
    }

    return new Response('E-Consular Monitor is running ✅\n\nGET /check to trigger manually.', {
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};

// ──────────────────────────────────────────────
// Core monitor logic
// ──────────────────────────────────────────────

async function runMonitor(env) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Starting availability check...`);

  try {
    const { cookies, csrfToken } = await getLoginPage();
    console.log(`[${ts}] Got login page (csrf: ${csrfToken ? 'yes' : 'no'})`);

    const sessionCookies = await doLogin(env.EC_EMAIL, env.EC_PASSWORD, csrfToken, cookies);
    console.log(`[${ts}] Login successful`);

    const { available, excerpt } = await checkAppointmentPage(sessionCookies);
    console.log(`[${ts}] Availability: ${available ? 'YES ✅' : 'No ❌'}`);

    if (available) {
      const alreadyNotified = await isCooldownActive(env);
      if (!alreadyNotified) {
        await sendEmailResend(env, excerpt);
        await setCooldown(env);
        console.log(`[${ts}] Notification sent!`);
        return { available: true, notified: true, ts };
      } else {
        console.log(`[${ts}] Cooldown active — skipping duplicate email`);
        return { available: true, notified: false, reason: 'cooldown', ts };
      }
    }

    return { available: false, ts };
  } catch (err) {
    console.error(`[${ts}] ERROR: ${err.message}`);
    // Optionally notify about errors too (uncomment below)
    // await sendErrorEmail(env, err.message);
    return { error: err.message, ts };
  }
}

// ──────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────

async function getLoginPage() {
  const res = await fetch(LOGIN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`Login page fetch failed: ${res.status}`);

  const html = await res.text();
  const cookies = parseCookies(res.headers.get('set-cookie') || '');

  // Laravel uses a hidden _token input for CSRF
  const csrfMatch = html.match(/name=['"_]token['"]\s+value=["']([^"']+)["']/i)
    || html.match(/name="csrf-token"\s+content="([^"]+)"/i)
    || html.match(/<meta[^>]+csrf-token[^>]+content="([^"]+)"/i);

  const csrfToken = csrfMatch ? csrfMatch[1] : null;
  return { cookies, csrfToken };
}

async function doLogin(email, password, csrfToken, existingCookies) {
  const body = new URLSearchParams({ email, password });
  if (csrfToken) body.set('_token', csrfToken);

  const cookieHeader = cookiesToHeader(existingCookies);

  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
      'Referer': LOGIN_URL,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: body.toString(),
    redirect: 'manual', // Don't follow — capture the Set-Cookie from redirect
  });

  // Laravel login redirects (302) with new session cookie on success
  if (res.status === 302 || res.status === 200) {
    const newCookies = parseCookies(res.headers.get('set-cookie') || '');
    const merged = { ...existingCookies, ...newCookies };

    // Validate: if redirected to login page again → wrong password
    const location = res.headers.get('location') || '';
    if (location.includes('/login')) {
      throw new Error('Login failed — check EC_EMAIL / EC_PASSWORD secrets');
    }

    return merged;
  }

  throw new Error(`Unexpected login response status: ${res.status}`);
}

async function checkAppointmentPage(sessionCookies) {
  const cookieHeader = cookiesToHeader(sessionCookies);

  const res = await fetch(PROCESS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
      'Referer': 'https://ec-portoprince.itamaraty.gov.br/user-main',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`Process page fetch failed: ${res.status}`);

  const html = await res.text();

  // If we got redirected to login, session is invalid
  if (res.url.includes('/login')) {
    throw new Error('Session invalid — redirected to login during process page fetch');
  }

  const available = !html.includes(NO_SLOTS_TEXT);

  // Extract a short excerpt around any slot elements for the email body
  const excerpt = available
    ? extractSlotExcerpt(html)
    : null;

  return { available, excerpt };
}

// ──────────────────────────────────────────────
// Cookie utilities
// ──────────────────────────────────────────────

function parseCookies(setCookieHeader) {
  const cookies = {};
  if (!setCookieHeader) return cookies;

  // set-cookie can be multi-value via comma (Cloudflare merges them)
  const entries = setCookieHeader.split(/,(?=[^ ])/);
  for (const entry of entries) {
    const parts = entry.split(';')[0].trim();
    const eq = parts.indexOf('=');
    if (eq > 0) {
      const name = parts.substring(0, eq).trim();
      const value = parts.substring(eq + 1).trim();
      cookies[name] = value;
    }
  }
  return cookies;
}

function cookiesToHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ──────────────────────────────────────────────
// KV cooldown (avoid spam emails)
// ──────────────────────────────────────────────

async function isCooldownActive(env) {
  if (!env.KV) return false;
  const val = await env.KV.get(KV_COOLDOWN_KEY);
  return val !== null;
}

async function setCooldown(env) {
  if (!env.KV) return;
  await env.KV.put(KV_COOLDOWN_KEY, Date.now().toString(), {
    expirationTtl: COOLDOWN_SECONDS,
  });
}

// ──────────────────────────────────────────────
// Email via Resend
// ──────────────────────────────────────────────

async function sendEmailResend(env, excerpt) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY secret not set');

  const to = (env.NOTIFY_EMAILS || env.EC_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:20px">
      <h2 style="color:#1a7f3c">✅ Rendez-vous disponible!</h2>
      <p>Des créneaux de rendez-vous sont maintenant disponibles pour:</p>
      <div style="background:#f0f7ff;padding:15px;border-left:4px solid #0066cc;margin:20px 0;border-radius:4px">
        <strong>${SERVICE_LABEL}</strong><br>
        <small style="color:#555">Embaixada do Brasil em Porto Príncipe</small>
      </div>
      ${excerpt ? `<p style="font-size:13px;color:#555;background:#fafafa;padding:10px;border-radius:4px">${excerpt}</p>` : ''}
      <p>
        <a href="${PROCESS_URL}"
           style="background:#1a7f3c;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold">
          👉 Prendre le rendez-vous maintenant
        </a>
      </p>
      <p style="color:#e00"><strong>Dépêchez-vous</strong> — les créneaux se remplissent rapidement!</p>
      <hr style="margin:30px 0;border:none;border-top:1px solid #eee">
      <small style="color:#999">
        Détecté le ${new Date().toLocaleString('fr-FR')} UTC<br>
        E-Consular Monitor — Cloudflare Worker
      </small>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'E-Consular Monitor <monitor@resend.dev>',
      to,
      subject: '🎉 RENDEZ-VOUS DISPONIBLE - Ambassade du Brésil Porto-Prince',
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error ${res.status}: ${err}`);
  }

  return await res.json();
}

// ──────────────────────────────────────────────
// HTML excerpt helper
// ──────────────────────────────────────────────

function extractSlotExcerpt(html) {
  // Try to find visible text near date/time patterns
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const match = stripped.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}[^.]{0,200})/);
  return match ? match[1].trim().substring(0, 300) : '';
}
