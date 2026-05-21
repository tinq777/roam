# ROAM — Deploy Guide
> Personal travel deal hunting PWA. Sydney-based. Photos powered by Unsplash.

---

## What you're building

```
iPhone / Browser
      │
      ▼
ROAM index.html  ──────►  Cloudflare Worker  ──────►  Ignav + SearchAPI (flights)
(your device)              (your-subdomain              Airbnb (stays)
                            .workers.dev)               Booking.com (stays)
                                                        Unsplash (photos)
                                                        Claude (AI search)
```

All API keys live **only in the Worker** — never in the HTML file you deploy.

---

## Step 1 — Get your API keys

| Service | Sign up | What it does | Cost |
|---------|---------|--------------|------|
| **Ignav** | [ignav.com](https://ignav.com) | Flight search | Free (1,000/mo)
| **SearchAPI** | [searchapi.io](https://searchapi.io) | Flight search fallback | Free (100/mo) |
| **Airbnb (RapidAPI)** | [rapidapi.com](https://rapidapi.com/3b-data-3b-data-default/api/airbnb13) → Search "airbnb13" | Stay search | 100 req/mo free |
| **Booking.com (RapidAPI)** | [rapidapi.com](https://rapidapi.com/DataCrawler/api/booking-com15) → Search "booking-com15" | Stay search | 500 req/mo free |
| **Unsplash** | [unsplash.com/developers](https://unsplash.com/developers) → New Application | Destination & property photos | 50 req/hr free |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) → API Keys | AI natural language search | ~$1–3/month |
| **Cloudflare** | [cloudflare.com](https://cloudflare.com) | Worker hosting | Free (100k req/day) |

> 💡 ROAM works without all keys — it falls back to rich demo data for any missing service.
> Start with Cloudflare + Ignav to get real flights immediately.

---

## Step 2 — Install Wrangler (Cloudflare CLI)

```bash
npm install -g wrangler
wrangler login
```

This opens a browser to authenticate with your Cloudflare account.

---

## Step 3 — Create your Worker project

```bash
mkdir roam-worker
cd roam-worker
```

Copy `worker.js` into this folder, then create `wrangler.toml`:

```toml
name = "roam-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
# Non-secret config (optional)
APP_NAME = "ROAM"
```

---

## Step 4 — Add your API keys as secrets

Run each command and paste your key when prompted:

```bash
wrangler secret put IGNAV_API_KEY
wrangler secret put SEARCHAPI_KEY
wrangler secret put AIRBNB_API_KEY
wrangler secret put BOOKING_API_KEY
wrangler secret put UNSPLASH_ACCESS_KEY
wrangler secret put ANTHROPIC_API_KEY
```

> ⚠️ Never put API keys directly in `wrangler.toml` or `worker.js` — secrets are encrypted.
> You can skip keys you don't have yet — ROAM will use mock data for those services.

---

## Step 5 — Deploy the Worker

```bash
wrangler deploy
```

You'll see output like:
```
✅ Deployed roam-worker to https://roam-worker.YOUR-SUBDOMAIN.workers.dev
```

Copy that URL — you'll need it in the next step.

---

## Step 6 — Update WORKER_URL in index.html

Open `index.html` and find line ~2026:

```javascript
const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev'; // ← UPDATE THIS
```

Replace with your actual Worker URL:

```javascript
const WORKER_URL = 'https://roam-worker.YOUR-SUBDOMAIN.workers.dev';
```

---

## Step 7 — Verify it's working

```bash
# Health check
curl https://roam-worker.YOUR-SUBDOMAIN.workers.dev/health
# Should return: {"status":"ok","version":"1.0.0","app":"ROAM"}

# Photo test
curl "https://roam-worker.YOUR-SUBDOMAIN.workers.dev/api/photo?q=bali+indonesia+travel"
# Should return: {"url":"https://images.unsplash.com/...","source":"unsplash"}

# Flight test
curl "https://roam-worker.YOUR-SUBDOMAIN.workers.dev/api/flights?from=SYD&currency=AUD"
# Should return: {"flights":[...]}
```

---

## Step 8 — Host index.html (Cloudflare Pages — recommended)

**Option A: Cloudflare Pages (free, fast)**
1. Go to [pages.cloudflare.com](https://pages.cloudflare.com)
2. Create a project → Upload assets
3. Upload `index.html`
4. Your app is live at `https://roam.pages.dev` (or custom domain)

**Option B: GitHub Pages (free)**
1. Create a repo, push `index.html` as the root file
2. Settings → Pages → Deploy from branch → main
3. Live at `https://yourusername.github.io/roam/`

**Option C: Just open the file locally**
Open `index.html` directly in Safari on your Mac — it works without hosting.
For iPhone, use Option A or B.

---

## Step 9 — Install on iPhone

1. Open your hosted URL in **Safari** (must be Safari)
2. Tap the **Share** button (box with arrow)
3. Scroll down → **Add to Home Screen**
4. Tap **Add**

ROAM now appears as a full-screen app on your home screen with no browser chrome.

---

## Photos — How They Work

```
When ROAM loads a card:
  1. Calls Worker → /api/photo?q=bali+indonesia+travel
  2. Worker calls Unsplash API with your key
  3. Returns a real, high-quality travel photo URL
  4. Photo is cached in memory (no repeat requests)

If Unsplash key not set OR rate limit hit:
  → Falls back to Picsum (beautiful random photos, always available)
  → Consistent per-destination (same seed = same photo every time)
```

**Unsplash rate limits:** 50 requests/hour on the free tier.
ROAM caches photos per session so you won't hit this in normal use.

For property-specific photos from Airbnb/Booking.com — those come directly
from the API responses as real listing images.

---

## localStorage Reference

| Key | Value | Default |
|-----|-------|---------|
| `roam_home_airport` | IATA code | `SYD` |
| `roam_home_airport_name` | Display name | `Sydney` |
| `roam_currency` | ISO currency | `AUD` |
| `roam_adults` | Number | `2` |
| `roam_children` | Number | `2` |
| `roam_bedrooms` | Number | `2` |
| `roam_radius_hrs` | Flight radius | `4` |
| `roam_stay_types` | JSON array | `["all"]` |
| `roam_theme` | `dark` / `light` | `dark` |
| `roam_watchlist` | JSON | `{"flights":[],"stays":[]}` |
| `roam_price_history` | JSON | `{}` |
| `roam_onboarded` | `"1"` | unset |

**Reset everything from browser console:**
```javascript
['roam_theme','roam_home_airport','roam_home_airport_name','roam_currency','roam_adults','roam_children','roam_bedrooms','roam_radius_hrs','roam_stay_types','roam_watchlist','roam_price_history','roam_onboarded'].forEach(k=>localStorage.removeItem(k));location.reload();
```

---

## Monthly Cost Estimate

| Service | Free Tier | Typical Usage | Cost |
|---------|-----------|---------------|------|
| Cloudflare Workers | 100k req/day | ~200 req/day | $0 |
| Ignav | 1,000 req/month | ~33/day | $0 |
| SearchAPI | 100 req/month | fallback | $0 |
| Airbnb (RapidAPI) | 100 req/month | ~50 req/month | $0 |
| Booking.com (RapidAPI) | 500 req/month | ~100 req/month | $0 |
| Unsplash | 50 req/hr | ~30 req/hr peak | $0 |
| Anthropic Claude | Pay per use | ~100 queries | ~$1–3 |
| **Total** | | | **~$1–3/month** |

---

## Troubleshooting

**"Showing demo data" banner appears**
→ Worker URL not set, or Worker not deployed yet. Check WORKER_URL in index.html.

**Photos not loading**
→ Check UNSPLASH_ACCESS_KEY is set correctly with `wrangler secret list`
→ Picsum fallback should always work — if even that fails, check network.

**No flights returned**

**CORS error in console**
→ Make sure you're calling the Worker URL (https://...) not localhost.

**wrangler: command not found**
→ Run `npm install -g wrangler` or use `npx wrangler`

---

## Files

```
roam/
├── index.html    ← The complete PWA (host this)
├── worker.js     ← Cloudflare Worker backend (deploy this)
└── deploy.md     ← This file
```

---

*ROAM v1.0.0 · MIT License · Built for personal family use*
