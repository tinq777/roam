# ROAM — Deployment Guide
Version 1.0.0

---

## What You're Deploying

```
index.html    — The complete ROAM PWA (runs in any browser)
manifest.json — PWA install configuration
sw.js         — Service worker (offline support)
worker.js     — Cloudflare Worker (API proxy backend)
icons/        — App icons (generate these — see step 3)
```

---

## Step 1 — Get Your API Keys

### 1a. Anthropic (Claude AI)
1. Go to https://anthropic.com → Sign up
2. API → API Keys → Create Key
3. Copy and save as: `ANTHROPIC_API_KEY`
4. Cost: ~$1–3/month for personal use

### 1b. Kiwi Tequila (Flights)
1. Go to https://tequila.kiwi.com
2. Sign up for a free account
3. Go to API → My API Keys
4. Copy and save as: `KIWI_API_KEY`
5. Cost: Free for personal/dev use

### 1c. RapidAPI — Airbnb (Stays)
1. Go to https://rapidapi.com
2. Search for "Airbnb API" (look for airbnb13)
3. Subscribe to the free tier
4. Copy your RapidAPI key as: `RAPIDAPI_KEY`
5. Cost: Free tier ~100 requests/month

### 1d. Booking.com Affiliate (Stays)
1. Go to https://www.booking.com/affiliate-program
2. Apply and get approved (usually 1–2 days)
3. Get your Affiliate ID
4. Save as: `BOOKING_AFFILIATE_ID`
5. Cost: Free — you earn commission on bookings

### 1e. Unsplash (Destination Photos)
1. Go to https://unsplash.com/developers
2. Create a new application
3. Copy your Access Key as: `UNSPLASH_ACCESS_KEY`
4. Cost: Free — 50 requests/hour

---

## Step 2 — Deploy the Cloudflare Worker

### 2a. Create a Cloudflare account
1. Go to https://cloudflare.com → Sign up (free)
2. Go to Workers & Pages → Create Worker
3. Name it: `roam-api`

### 2b. Deploy worker.js
**Option A — Cloudflare Dashboard (easiest)**
1. Open your Worker in the dashboard
2. Click "Edit Code"
3. Paste the contents of worker.js
4. Click "Save and Deploy"

**Option B — Wrangler CLI**
```bash
npm install -g wrangler
wrangler login
wrangler deploy worker.js --name roam-api
```

### 2c. Set Environment Variables
In the Cloudflare Worker dashboard:
1. Go to Settings → Variables
2. Add each secret (use "Encrypt" toggle):

```
ANTHROPIC_API_KEY     = your-anthropic-key
KIWI_API_KEY          = your-kiwi-key
RAPIDAPI_KEY          = your-rapidapi-key
BOOKING_AFFILIATE_ID  = your-booking-id
UNSPLASH_ACCESS_KEY   = your-unsplash-key
ALLOWED_ORIGIN        = https://yourdomain.com
```

### 2d. Note your Worker URL
It will look like:
`https://roam-api.your-subdomain.workers.dev`

---

## Step 3 — Generate App Icons

You need two PNG icons for the PWA:
- `icons/icon-192.png` (192×192px)
- `icons/icon-512.png` (512×512px)

**Quickest option:**
1. Go to https://favicon.io or https://realfavicongenerator.net
2. Upload a simple "R" or crosshair logo on a #04080f background
3. Download and place in the `icons/` folder

---

## Step 4 — Update index.html

Open index.html and update line near the top:

```javascript
const WORKER_URL = 'https://roam-api.your-subdomain.workers.dev';
```

Also add the service worker registration and manifest link.
Add this inside `<head>`:
```html
<link rel="manifest" href="/manifest.json">
```

Add this before `</body>`:
```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
</script>
```

---

## Step 5 — Host the Frontend

### Option A — Cloudflare Pages (recommended, free)
1. In Cloudflare dashboard → Pages → Create project
2. Upload your folder (index.html, manifest.json, sw.js, icons/)
3. Your app URL: `https://roam.pages.dev` (or custom domain)

### Option B — GitHub Pages (free)
1. Create a repo on github.com
2. Push your files
3. Settings → Pages → Deploy from main branch
4. URL: `https://yourusername.github.io/roam`

### Option C — Any static host
Netlify, Vercel, or any web server that serves static files.
No server-side processing needed — it's all static.

---

## Step 6 — Test It

1. Open your hosted URL in Safari on iPhone
2. Tap Share → Add to Home Screen
3. The app installs as a PWA
4. Test the AI search (requires Worker to be live)
5. Test a flight search
6. Save a deal to Watch and check price history

---

## CORS Configuration

If you get CORS errors, update `ALLOWED_ORIGIN` in your Worker to match your exact frontend URL:
```
ALLOWED_ORIGIN = https://your-roam-url.pages.dev
```

---

## Troubleshooting

**AI search not working**
→ Check ANTHROPIC_API_KEY is set correctly in Worker
→ Check WORKER_URL in index.html points to your Worker

**No flights showing**
→ Check KIWI_API_KEY is valid
→ Test: https://your-worker.workers.dev/api/health

**Photos not loading**
→ Check UNSPLASH_ACCESS_KEY
→ Photos fall back gracefully if key is missing

**App not installing as PWA**
→ Must be served over HTTPS
→ manifest.json must be accessible
→ sw.js must be in root directory

---

## Monthly Cost Estimate (Personal Use)

```
Cloudflare Workers    $0   (100k requests/day free)
Kiwi Tequila          $0   (free tier)
RapidAPI Airbnb       $0   (free tier)
Booking.com           $0   (affiliate — earn commission)
Unsplash              $0   (50 req/hr free)
Anthropic Claude      ~$1–3 (pay per AI search query)
─────────────────────────────
Total:               ~$1–3/month
```

---

## Support & Updates

ROAM is open source under the MIT License.
Star the repo: https://github.com/roamapp/roam

Built for travellers who hate paying full price.
