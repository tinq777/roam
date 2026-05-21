/**
 * ROAM — Cloudflare Worker v2.0.0
 *
 * Cloudflare Secrets (set in dashboard → roam-worker → Settings → Variables):
 *   ROAM_SECRET_TOKEN     — any random string you choose, must match app Settings
 *   IGNAV_API_KEY         — from ignav.com
 *   SEARCHAPI_KEY         — from searchapi.io
 *   RAPIDAPI_KEY          — from rapidapi.com (Airbnb)
 *   BOOKING_AFFILIATE_ID  — from booking.com affiliate program
 *   UNSPLASH_ACCESS_KEY   — from unsplash.com/developers
 *   ANTHROPIC_API_KEY     — optional fallback if not set in app Settings
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Roam-Token, X-Claude-Key',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function isAuthorized(request, env) {
  // If no token is configured, allow all (backwards compat during setup)
  if (!env.ROAM_SECRET_TOKEN) return true;
  const token = request.headers.get('X-Roam-Token');
  return token === env.ROAM_SECRET_TOKEN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Debug — PUBLIC, no auth, no token needed
    // Visit: /api/debug?from=SYD&to=MEL&depart=2026-05-28
    if (path === '/api/debug') {
      const from = url.searchParams.get('from') || 'SYD';
      const to = url.searchParams.get('to') || 'MEL';
      const depart = url.searchParams.get('depart') || new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
      const results = {};

      // Test Ignav
      try {
        const r = await fetch('https://ignav.com/api/fares/one-way', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': env.IGNAV_API_KEY || 'NOT_SET' },
          body: JSON.stringify({ origin: from, destination: to, departure_date: depart }),
          signal: AbortSignal.timeout(8000)
        });
        const text = await r.text();
        results.ignav = { status: r.status, ok: r.ok, keySet: !!env.IGNAV_API_KEY, preview: text.slice(0, 400) };
      } catch(e) { results.ignav = { error: e.message, keySet: !!env.IGNAV_API_KEY }; }

      // Test SearchAPI
      try {
        const params = new URLSearchParams({ engine:'google_flights', departure_id:from, arrival_id:to, outbound_date:depart, flight_type:'one_way', adults:'1', currency:'AUD', api_key: env.SEARCHAPI_KEY || 'NOT_SET' });
        const r = await fetch(`https://www.searchapi.io/api/v1/search?${params}`, { signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        results.searchapi = { status: r.status, ok: r.ok, keySet: !!env.SEARCHAPI_KEY, preview: text.slice(0, 400) };
      } catch(e) { results.searchapi = { error: e.message, keySet: !!env.SEARCHAPI_KEY }; }

      // Test SerpApi
      try {
        const params = new URLSearchParams({ engine:'google_flights', departure_id:from, arrival_id:to, outbound_date:depart, type:'2', adults:'1', currency:'AUD', hl:'en', api_key: env.SERPAPI_KEY || 'NOT_SET' });
        const r = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        results.serpapi = { status: r.status, ok: r.ok, keySet: !!env.SERPAPI_KEY, preview: text.slice(0, 400) };
      } catch(e) { results.serpapi = { error: e.message, keySet: !!env.SERPAPI_KEY }; }

      return new Response(JSON.stringify({ debug: true, params: { from, to, depart }, results }, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check — no auth needed (used by Test button)
    if (path === '/health' || path === '/api/health') {
      return json({ status: 'ok', version: '2.0.0', app: 'ROAM' });
    }

    // Ping — GET request, requires token, used by Test button
    if (path === '/api/ping') {
      if (!isAuthorized(request, env)) return unauthorized();
      return json({ status: 'ok', auth: 'valid' });
    }

    // All other routes require token
    if (!isAuthorized(request, env)) {
      return unauthorized();
    }

    try {
      // ── FLIGHTS ── Ignav + SearchAPI in parallel ──────────────────────
      if (path === '/api/flights' && request.method === 'POST') {
        return handleFlights(request, env);
      }

      // ── LAST MINUTE FLIGHTS ──────────────────────────────────────────
      if (path === '/api/lastminute/flights') {
        return handleLastMinute(request, env, url);
      }

      // ── INSPIRE ──────────────────────────────────────────────────────
      if (path === '/api/inspire') {
        return handleInspire(request, env, url);
      }

      // ── STAYS — Airbnb + Booking in parallel ─────────────────────────
      if (path === '/api/stays' && request.method === 'POST') {
        return handleStays(request, env);
      }

      // ── PHOTO ────────────────────────────────────────────────────────
      if (path === '/api/photo') {
        return handlePhoto(request, env, url);
      }

      // ── AI ───────────────────────────────────────────────────────────
      if (path === '/api/ai' && request.method === 'POST') {
        return handleAI(request, env);
      }

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

// ════════════════════════════════════════════════════════════
// FLIGHTS — Ignav + SearchAPI + SerpApi in parallel, merged by price
// ════════════════════════════════════════════════════════════
// Build a Skyscanner deep link — reliable date pre-fill, works for AU
function buildBookingUrl(from, to, date, adults = 2, children = 2) {
  // Skyscanner format: YYMMDD
  let dateCode = '';
  try {
    const d = new Date(date);
    if (!isNaN(d)) {
      const yy = String(d.getFullYear()).slice(2);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dateCode = `${yy}${mm}${dd}`;
    }
  } catch(e) {}

  if (dateCode) {
    return `https://www.skyscanner.com.au/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${dateCode}/?adults=${adults}&children=${children}&currency=AUD`;
  }
  // Fallback to Google Flights generic search
  return `https://www.google.com/travel/flights?hl=en&gl=au&curr=AUD`;
}

function extractCode(val) {
  if (!val) return '';
  // Match 3-letter IATA code in brackets: "Sydney (SYD)" → "SYD"
  const m = val.match(/\(([A-Z]{3})\)/);
  if (m) return m[1];
  // Match standalone 3-letter code
  const m2 = val.match(/\b([A-Z]{3})\b/);
  if (m2) return m2[1];
  return val.trim().toUpperCase().slice(0, 3);
}

async function handleFlights(request, env) {
  const body = await request.json();
  const { from = 'SYD', to, depart, ret, adults = 2, children = 2 } = body;

  const fromCode = extractCode(from) || 'SYD';
  const toCode = extractCode(to) || '';

  console.log(`[ROAM] Flights: ${fromCode}→${toCode || 'ANY'} depart=${depart} ret=${ret} adults=${adults} children=${children}`);

  // SerpApi + SearchAPI need a destination — skip them if toCode is empty
  const tasks = [fetchIgnav(fromCode, toCode, depart, ret, adults, children, env)];
  if (toCode) {
    tasks.push(fetchSearchApi(fromCode, toCode, depart, ret, adults, children, env));
    tasks.push(fetchSerpApi(fromCode, toCode, depart, ret, adults, children, env));
  } else {
    console.log('[ROAM] No destination — skipping SearchAPI + SerpApi');
    tasks.push(Promise.resolve([]));
    tasks.push(Promise.resolve([]));
  }

  const [ignavResult, searchApiResult, serpApiResult] = await Promise.allSettled(tasks);

  console.log(`[ROAM] Ignav: ${ignavResult.status} count=${ignavResult.value?.length ?? 0} err=${ignavResult.reason?.message}`);
  console.log(`[ROAM] SearchAPI: ${searchApiResult.status} count=${searchApiResult.value?.length ?? 0} err=${searchApiResult.reason?.message}`);
  console.log(`[ROAM] SerpApi: ${serpApiResult.status} count=${serpApiResult.value?.length ?? 0} err=${serpApiResult.reason?.message}`);

  const ignavFlights  = ignavResult.status === 'fulfilled'     ? (ignavResult.value || [])     : [];
  const searchFlights = searchApiResult.status === 'fulfilled' ? (searchApiResult.value || []) : [];
  const serpFlights   = serpApiResult.status === 'fulfilled'   ? (serpApiResult.value || [])   : [];

  const seen = new Set();
  const merged = [...ignavFlights, ...searchFlights, ...serpFlights]
    .filter(f => {
      const key = `${f.from}-${f.to}-${f.airline}-${f.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.price - b.price);

  const source = [
    ignavFlights.length  ? `Ignav(${ignavFlights.length})`      : null,
    searchFlights.length ? `SearchAPI(${searchFlights.length})` : null,
    serpFlights.length   ? `SerpApi(${serpFlights.length})`     : null,
  ].filter(Boolean).join('+') || 'none';

  console.log(`[ROAM] Merged ${merged.length} flights, source=${source}`);
  return json({ flights: merged, source });
}

async function fetchIgnav(from, to, depart, ret, adults, children, env) {
  if (!env.IGNAV_API_KEY) { console.log('[ROAM] Ignav: no key'); return []; }
  try {
    const endpoint = ret ? 'round-trip' : 'one-way';
    const body = {
      origin: from,
      destination: to || 'anywhere',
      departure_date: depart,
      ...(ret ? { return_date: ret } : {}),
    };
    console.log(`[ROAM] Ignav request: ${JSON.stringify(body)}`);
    const r = await fetch(`https://ignav.com/api/fares/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': env.IGNAV_API_KEY },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log(`[ROAM] Ignav response ${r.status}: ${text.slice(0, 200)}`);
    if (!r.ok) return [];
    const data = JSON.parse(text);
    return (data.itineraries || []).map(f => {
      const fromAirport = f.outbound?.segments?.[0]?.departure_airport || from;
      const toAirport = f.outbound?.segments?.at(-1)?.arrival_airport || to;
      const departDate = (f.outbound?.segments?.[0]?.departure_time_local || depart || '').slice(0,10);
      const googleUrl = `https://www.google.com/travel/flights/search?tfs=&q=Flights+${fromAirport}+to+${toAirport}&hl=en`;
      return {
        id: 'ig_' + (f.ignav_id || Math.random().toString(36).slice(2)),
        from: fromAirport,
        to: toAirport,
        dest: toAirport,
        price: Math.round(f.price?.amount || 0),
        currency: f.price?.currency || 'USD',
        airline: f.outbound?.segments?.[0]?.operating_carrier_name || 'Unknown',
        duration: formatMins(f.outbound?.duration_minutes),
        stops: stopsLabel(f.outbound?.segments?.length),
        depart: (f.outbound?.segments?.[0]?.departure_time_local || depart || '').slice(0,16),
        bookUrl: buildBookingUrl(fromAirport, toAirport, departDate),
        source: 'ignav',
      };
    });
  } catch (e) { console.log(`[ROAM] Ignav error: ${e.message}`); return []; }
}

async function fetchSearchApi(from, to, depart, ret, adults, children, env) {
  if (!env.SEARCHAPI_KEY) { console.log('[ROAM] SearchAPI: no key'); return []; }
  try {
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: from,
      arrival_id: to || '',
      outbound_date: depart || '',
      flight_type: ret ? 'round_trip' : 'one_way',
      ...(ret ? { return_date: ret } : {}),
      adults: String(parseInt(adults) || 1),
      children: String(parseInt(children) || 0),
      currency: 'AUD',
      api_key: env.SEARCHAPI_KEY,
    });
    console.log(`[ROAM] SearchAPI: ${from}→${to} ${depart}`);
    const r = await fetch(`https://www.searchapi.io/api/v1/search?${params}`);
    const text = await r.text();
    console.log(`[ROAM] SearchAPI response ${r.status}: ${text.slice(0,300)}`);
    if (!r.ok) return [];
    const data = JSON.parse(text);
    const raw = [...(data.best_flights || []), ...(data.other_flights || [])];
    return raw.map((f, i) => {
      const fromCode = f.flights?.[0]?.departure_airport?.id || from;
      const toCode = f.flights?.at(-1)?.arrival_airport?.id || to;
      const departDate = (f.flights?.[0]?.departure_airport?.time || depart || '').slice(0, 10);
      return {
        id: 'sa_' + i,
        from: fromCode,
        to: toCode,
        dest: f.flights?.at(-1)?.arrival_airport?.name || to,
        price: Math.round(f.price || 0),
        airline: f.flights?.[0]?.airline || 'Unknown',
        airlineLogo: f.flights?.[0]?.airline_logo || '',
        duration: formatMins(f.total_duration),
        stops: stopsLabel(f.flights?.length),
        depart: f.flights?.[0]?.departure_airport?.time || depart,
        bookUrl: buildBookingUrl(fromCode, toCode, departDate),
        source: 'searchapi',
      };
    });
  } catch (e) { console.log(`[ROAM] SearchAPI error: ${e.message}`); return []; }
}

async function fetchSerpApi(from, to, depart, ret, adults, children, env) {
  if (!env.SERPAPI_KEY) { console.log('[ROAM] SerpApi: no key'); return []; }
  try {
    // SerpApi round trip requires a two-step process with departure_token
    // So we search one-way outbound only for simplicity
    const params = new URLSearchParams({
      engine: 'google_flights',
      departure_id: from,
      arrival_id: to || '',
      outbound_date: depart || '',
      type: '2', // one-way
      adults: String(parseInt(adults) || 1),
      children: String(parseInt(children) || 0),
      currency: 'AUD',
      hl: 'en',
      api_key: env.SERPAPI_KEY,
    });
    console.log(`[ROAM] SerpApi: ${from}→${to} ${depart}`);
    const r = await fetch(`https://serpapi.com/search?${params}`);
    const text = await r.text();
    console.log(`[ROAM] SerpApi response ${r.status}: ${text.slice(0,300)}`);
    if (!r.ok) return [];
    const data = JSON.parse(text);
    const raw = [...(data.best_flights || []), ...(data.other_flights || [])];
    // SerpApi provides a google_flights_url in search_metadata — use it as base
    const gfUrl = data.search_metadata?.google_flights_url;
    return raw.map((f, i) => {
      const totalMins = f.total_duration || f.flights?.reduce((s, fl) => s + (fl.duration || 0), 0) || 0;
      const fromCode = f.flights?.[0]?.departure_airport?.id || from;
      const toCode = f.flights?.at(-1)?.arrival_airport?.id || to;
      const departDate = (f.flights?.[0]?.departure_airport?.time || depart || '').slice(0, 10);
      return {
        id: 'sp_' + i,
        from: fromCode,
        to: toCode,
        dest: f.flights?.at(-1)?.arrival_airport?.name || to,
        price: Math.round(f.price || 0),
        airline: f.flights?.[0]?.airline || 'Unknown',
        airlineLogo: f.flights?.[0]?.airline_logo || '',
        duration: formatMins(totalMins),
        stops: stopsLabel(f.flights?.length),
        depart: f.flights?.[0]?.departure_airport?.time || depart,
        // Build Skyscanner URL with correct date — more reliable than google_flights_url
        bookUrl: buildBookingUrl(fromCode, toCode, departDate),
        source: 'serpapi',
      };
    });
  } catch (e) { console.log(`[ROAM] SerpApi error: ${e.message}`); return []; }
}
// Popular routes by home airport for last minute searches
const POPULAR_ROUTES = {
  SYD: ['MEL','BNE','PER','ADL','OOL','CNS','NRT','SIN','BKK','DPS'],
  MEL: ['SYD','BNE','PER','ADL','OOL','NRT','SIN','BKK','DPS','HKG'],
  BNE: ['SYD','MEL','PER','ADL','OOL','NRT','SIN','BKK','DPS','CNS'],
  PER: ['SYD','MEL','BNE','ADL','SIN','DPS','BKK','KUL','HKG','NRT'],
  ADL: ['SYD','MEL','BNE','PER','OOL','SIN','BKK','DPS','NRT','CNS'],
};

async function handleLastMinute(request, env, url) {
  const from = url.searchParams.get('from') || 'SYD';
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  // Get routes for this airport, fallback to SYD routes
  const routes = POPULAR_ROUTES[from] || POPULAR_ROUTES['SYD'];

  // Search today + tomorrow for each route, all in parallel
  // Batch into groups of 5 to avoid rate limits
  const dates = [today, tomorrow];
  const searches = [];
  for (const to of routes) {
    for (const date of dates) {
      searches.push({ to, date });
    }
  }

  // Run all searches in parallel with Promise.allSettled
  const results = await Promise.allSettled(
    searches.map(({ to, date }) =>
      fetchSerpApi(from, to, date, '', 2, 2, env)
        .catch(() => fetchSearchApi(from, to, date, '', 2, 2, env))
        .catch(() => fetchIgnav(from, to, date, '', 2, 2, env))
        .catch(() => [])
    )
  );

  // Merge all results
  const seen = new Set();
  const flights = results
    .flatMap(r => r.status === 'fulfilled' ? (r.value || []) : [])
    .filter(f => {
      if (!f.price || f.price <= 0) return false;
      const key = `${f.from}-${f.to}-${f.airline}-${f.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.price - b.price)
    .slice(0, 20); // top 20 cheapest

  return json({ flights, source: `${routes.length} routes × ${dates.length} dates` });
}

// ════════════════════════════════════════════════════════════
// INSPIRE — cheapest destinations from home airport
// ════════════════════════════════════════════════════════════
async function handleInspire(request, env, url) {
  const from = url.searchParams.get('from') || 'SYD';
  const period = url.searchParams.get('period') || 'weekend';

  const today = new Date();
  let depart, ret;
  if (period === 'weekend') {
    const daysUntilFri = (5 - today.getDay() + 7) % 7 || 7;
    const fri = new Date(today); fri.setDate(today.getDate() + daysUntilFri);
    const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
    depart = fri.toISOString().split('T')[0];
    ret = sun.toISOString().split('T')[0];
  } else {
    const d = new Date(today); d.setDate(today.getDate() + 30);
    const r = new Date(today); r.setDate(today.getDate() + 37);
    depart = d.toISOString().split('T')[0];
    ret = r.toISOString().split('T')[0];
  }

  const [r1, r2, r3] = await Promise.allSettled([
    fetchIgnav(from, '', depart, ret, 2, 2, env),
    fetchSearchApi(from, '', depart, ret, 2, 2, env),
    fetchSerpApi(from, '', depart, ret, 2, 2, env),
  ]);

  const seen = new Set();
  const destinations = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
  ].filter(f => {
    if (!f.to || seen.has(f.to)) return false;
    seen.add(f.to); return true;
  }).sort((a, b) => a.price - b.price).slice(0, 8);

  return json({ destinations });
}

// ════════════════════════════════════════════════════════════
// STAYS — Airbnb + Booking in parallel
// ════════════════════════════════════════════════════════════
async function handleStays(request, env) {
  const body = await request.json();
  const { location, checkin, checkout, adults = 2, children = 2, bedrooms = 2 } = body;

  const [airbnbResult, bookingResult] = await Promise.allSettled([
    fetchAirbnb(location, checkin, checkout, adults, children, bedrooms, env),
    fetchBooking(location, checkin, checkout, adults, children, bedrooms, env),
  ]);

  const airbnb  = airbnbResult.status === 'fulfilled'  ? airbnbResult.value  : [];
  const booking = bookingResult.status === 'fulfilled' ? bookingResult.value : [];

  const merged = [...airbnb, ...booking].sort((a, b) => a.price - b.price);
  return json({ stays: merged });
}

async function fetchAirbnb(location, checkin, checkout, adults, children, bedrooms, env) {
  if (!env.RAPIDAPI_KEY) return [];
  try {
    const r = await fetch(
      `https://airbnb13.p.rapidapi.com/search-location?location=${encodeURIComponent(location)}&checkin=${checkin}&checkout=${checkout}&adults=${adults}&children=${children}&rooms=${bedrooms}&currency=AUD`,
      { headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'airbnb13.p.rapidapi.com' } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || [])
      .filter(s => s.type !== 'PRIVATE_ROOM' && s.type !== 'SHARED_ROOM')
      .map(s => ({
        id: 'ab_' + s.id,
        title: s.name,
        dest: location,
        price: Math.round(s.price?.rate || 0),
        beds: s.bedrooms || bedrooms,
        guests: s.persons || (parseInt(adults) + parseInt(children)),
        rating: s.rating,
        img: s.images?.[0],
        url: `https://www.airbnb.com.au/rooms/${s.id}`,
        source: 'airbnb',
      }));
  } catch (e) { return []; }
}

async function fetchBooking(location, checkin, checkout, adults, children, bedrooms, env) {
  // Booking.com affiliate deep link
  const [cy, cm, cd] = checkin.split('-');
  const [oy, om, od] = checkout.split('-');
  const params = new URLSearchParams({
    ss: location,
    checkin_year: cy, checkin_month: cm, checkin_monthday: cd,
    checkout_year: oy, checkout_month: om, checkout_monthday: od,
    group_adults: adults,
    group_children: children,
    no_rooms: Math.max(1, Math.ceil(bedrooms / 2)),
    selected_currency: 'AUD',
    aid: env.BOOKING_AFFILIATE_ID || '304142',
    nflt: 'entire_place%3D1', // entire homes only
  });
  return [{
    id: 'bk_link',
    title: `Entire homes in ${location}`,
    dest: location,
    price: 0,
    isLink: true,
    url: `https://www.booking.com/searchresults.html?${params}`,
    source: 'booking',
  }];
}

// ════════════════════════════════════════════════════════════
// PHOTO — Unsplash
// ════════════════════════════════════════════════════════════
async function handlePhoto(request, env, url) {
  if (!env.UNSPLASH_ACCESS_KEY) return json({ url: null });
  const q = url.searchParams.get('q') || 'travel destination';
  try {
    const r = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } }
    );
    const data = await r.json();
    return json({ url: data.urls?.regular, thumb: data.urls?.small, credit: data.user?.name });
  } catch (e) { return json({ url: null }); }
}

// ════════════════════════════════════════════════════════════
// AI — Claude (key from app header or Cloudflare secret)
// ════════════════════════════════════════════════════════════
async function handleAI(request, env) {
  const body = await request.json();
  const { query, type, homeAirport, adults, children } = body;
  const apiKey = request.headers.get('X-Claude-Key') || env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'No Claude API key configured' }, 401);

  const system = `You are ROAM's travel AI. Home airport: ${homeAirport}. Party: ${adults} adults, ${children} children.
Help find ${type === 'flights' ? 'flight' : 'accommodation'} deals. Be concise and specific. Plain text only, no markdown.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, system, messages: [{ role: 'user', content: query }] }),
    });
    const data = await r.json();
    return json({ result: data.content?.[0]?.text || 'No response.' });
  } catch (e) { return json({ error: e.message }, 500); }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function formatMins(mins) {
  if (!mins) return '—';
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function stopsLabel(segments) {
  const n = (segments || 1) - 1;
  if (n <= 0) return 'Direct';
  return `${n} stop${n > 1 ? 's' : ''}`;
}
