# ROAM — Mobile Setup Guide

Everything done from your phone. No terminal required after initial push.

---

## What's in this zip

```
index.html                      ← The ROAM PWA
worker.js                       ← Cloudflare Worker (API proxy)
wrangler.toml                   ← Worker config
.github/workflows/deploy.yml    ← Auto-deploys on every push
SETUP.md                        ← This file
```

---

## Step 1 — Push to GitHub

Use your zip-push app to push this folder to a new GitHub repo.
Recommended repo name: `roam`

Make sure the repo is **public** (required for free GitHub Pages).

---

## Step 2 — Enable GitHub Pages

In your GitHub repo → **Settings → Pages**
- Source: **GitHub Actions**
- Save

---

## Step 3 — Cloudflare Account

1. Go to **cloudflare.com** → sign up free
2. Note your **Account ID** — found in the right sidebar of the Workers dashboard

---

## Step 4 — Cloudflare API Token

1. Go to **dash.cloudflare.com/profile/api-tokens**
2. Tap **Create Token**
3. Use template: **Edit Cloudflare Workers**
4. Create token → copy it

---

## Step 5 — GitHub Secrets

In your GitHub repo → **Settings → Secrets and variables → Actions**

Add these two secrets:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Your token from Step 4 |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID from Step 3 |

---

## Step 6 — API Keys as Cloudflare Worker Secrets

In **dash.cloudflare.com → Workers & Pages → roam → Settings → Variables**

Add each as an **encrypted secret**:

| Variable name | Where to get it |
|---|---|
| `ROAM_SECRET_TOKEN` | Make it up — any random string e.g. `roam-abc123-xyz789` |
| `IGNAV_API_KEY` | ignav.com → sign up → API Keys |
| `SEARCHAPI_KEY` | searchapi.io → sign up → key |
| `RAPIDAPI_KEY` | rapidapi.com → sign up → key |
| `BOOKING_AFFILIATE_ID` | booking.com/affiliate-program → your affiliate ID |
| `UNSPLASH_ACCESS_KEY` | unsplash.com/developers → Access Key |

---

## Step 7 — Trigger First Deploy

Push any small change to your repo.
GitHub Actions will automatically:
1. Deploy `worker.js` → Cloudflare Workers
2. Deploy `index.html` → GitHub Pages

Watch it run under **GitHub → Actions tab**.

---

## Step 8 — Get Your URLs

**Worker URL:**
`https://roam.YOUR-SUBDOMAIN.workers.dev`
→ Cloudflare → Workers & Pages → roam

**App URL:**
`https://YOUR-USERNAME.github.io/roam`

---

## Step 9 — Configure ROAM

1. Open your GitHub Pages URL in Safari
2. Go to **Settings → Cloudflare Worker → Worker URL**
3. Paste your `workers.dev` URL
4. ROAM tests the connection → shows **Connected ✓**

---

## Step 10 — Install on iPhone

1. Safari → your GitHub Pages URL
2. Share button → **Add to Home Screen**
3. Name it **ROAM** → Add

---

## Future Updates

Push updated files via your zip app.
GitHub Actions redeploys Worker + Pages automatically.

---

## Costs

```
GitHub Pages          Free
Cloudflare Workers    Free  (100k req/day)
GitHub Actions        Free  (2000 min/month)
Kiwi Tequila          Free
RapidAPI Airbnb       Free  (100 req/month)
Booking.com           Free  (affiliate)
Unsplash              Free  (50 req/hour)
Anthropic Claude      ~$1–3/month
```

---

ROAM v1.0.0 · MIT License
