# Déploiement via Dashboard Cloudflare (sans CLI)

> wrangler ne s'installe pas sur Windows ARM64 — on passe par le dashboard.

---

## Étape 1 — Créer le compte Resend (email)

1. Aller sur **https://resend.com** → créer compte gratuit
2. Dashboard → **API Keys** → **Create API Key** → copier la clé (`re_xxxxx`)
3. Free tier: 3000 emails/mois — largement suffisant

---

## Étape 2 — Créer le namespace KV dans Cloudflare

1. Aller sur **https://dash.cloudflare.com**
2. Menu gauche → **Workers & Pages** → **KV**
3. Cliquer **Create a namespace**
4. Nom: `econsular-kv` → **Add**
5. **Copier l'ID** qui s'affiche (ex: `abc123def456...`) — on en aura besoin

---

## Étape 3 — Créer le Worker

1. Dans Cloudflare dashboard → **Workers & Pages** → **Create**
2. Choisir **"Create Worker"** (pas Pages)
3. Nom: `econsular-monitor` → **Deploy**
4. Cliquer **"Edit code"**
5. **Effacer tout** le code par défaut
6. **Copier-coller** le contenu du fichier `src/worker.js`
7. Cliquer **Deploy**

---

## Étape 4 — Configurer les secrets (Variables d'environnement)

Dans le Worker → onglet **Settings** → **Variables and Secrets** :

| Variable | Valeur |
|----------|--------|
| `EC_EMAIL` | `jeffreybest2@gmail.com` |
| `EC_PASSWORD` | `BN@8AFwjyxSg.D` |
| `RESEND_API_KEY` | `re_votre_cle_resend` |
| `NOTIFY_EMAILS` | `jeffreybest2@gmail.com,info@jbjproductionhaiti.com` |

> ⚠️ Choisir **"Encrypt"** pour EC_PASSWORD et RESEND_API_KEY

---

## Étape 5 — Lier le KV au Worker

Dans le Worker → **Settings** → **Bindings** → **Add** → **KV Namespace**:
- Variable name: `KV`
- KV namespace: `econsular-kv` (celui créé à l'étape 2)

---

## Étape 6 — Activer le Cron Trigger

Dans le Worker → **Settings** → **Triggers** → **Add Cron Trigger**:
- Cron expression: `*/5 * * * *`  ← toutes les 5 minutes

Cliquer **Add Trigger**.

---

## Tester manuellement

Aller sur l'URL du Worker:
```
https://econsular-monitor.<votre-subdomain>.workers.dev/check
```

Réponse attendue (pas de créneaux):
```json
{"available": false, "ts": "2026-06-01T20:30:00.000Z"}
```

Réponse si créneaux disponibles:
```json
{"available": true, "notified": true, "ts": "..."}
```

---

## Voir les logs

Workers → votre worker → onglet **Logs** → **Begin log stream**

---

## En cas de problème de login

Si `{"error": "Login failed — check EC_EMAIL / EC_PASSWORD secrets"}`:
- Vérifier les secrets dans Settings → Variables
- Tester en allant manuellement sur https://ec-portoprince.itamaraty.gov.br/login

Si `{"error": "Session invalid — redirected to login"}`:
- Le site a peut-être une protection anti-bot → utiliser la version locale Node.js à la place
