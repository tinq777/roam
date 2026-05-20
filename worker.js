/**
 * ROAM — Cloudflare Worker Backend
 * ═══════════════════════════════════════════════════════
 * Proxies all external API calls for the ROAM travel PWA.
 * API keys are stored as Cloudflare Worker Secrets (not in code).
 *
 * Endpoints:
 *   GET  /health             → Worker status
 *   GET  /api/flights        → Flight search (Kiwi Tequila)
 *   GET  /api/stays          → Stay search (Airbnb + Booking.com, merged)
 *   GET  /api/lastminute     → Deals departing within 24hrs
 *   GET  /api/inspire        → Cheapest destinations from home airport
 *   POST /api/ai             → Natural language search (Claude)
 *   GET  /api/photo          → Destination/property photos (Unsplash)
 *
 * Required Secrets (set via: wrangler secret put SECRET_NAME):
 *   KIWI_API_KEY
 *   AIRBNB_API_KEY       (RapidAPI key for Airbnb API)
 *   BOOKING_API_KEY      (RapidAPI key for Booking.com)
 *   UNSPLASH_ACCESS_KEY
 *   ANTHROPIC_API_KEY
 * ═══════════════════════════════════════════════════════
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ═══ RETRY FETCH ═══
async function fetchWithRetry(url, options = {}, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, options);
      if (r.ok) return r;
      if (i === retries) return r;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ═══ ROUTER ═══
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      if (path === '/health') return handleHealth();
      if (path === '/api/flights') return handleFlights(url, env);
      if (path === '/api/stays') return handleStays(url, env);
      if (path === '/api/lastminute') return handleLastMinute(url, env);
      if (path === '/api/inspire') return handleInspire(url, env);
      if (path === '/api/photo') return handlePhoto(url, env);
      if (path === '/api/ai' && request.method === 'POST') return handleAI(request, env);
      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err('Internal error: ' + e.message, 500);
    }
  },
};

// ═══════════════════════════════════════════════════════
// /health
// ═══════════════════════════════════════════════════════
function handleHealth() {
  return json({ status: 'ok', version: '1.0.0', app: 'ROAM' });
}

// ═══════════════════════════════════════════════════════
// /api/photo — Unsplash photo lookup with cache-friendly response
// ═══════════════════════════════════════════════════════
async function handlePhoto(url, env) {
  const q = url.searchParams.get('q') || 'travel destination';

  if (!env.UNSPLASH_ACCESS_KEY) {
    // Fallback: deterministic Picsum photo from query hash
    return json({ url: picsum(q), source: 'picsum' });
  }

  try {
    const r = await fetchWithRetry(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } }
    );
    if (r.ok) {
      const d = await r.json();
      const photoUrl = d.urls?.regular || d.urls?.full;
      if (photoUrl) {
        return json({
          url: photoUrl,
          source: 'unsplash',
          credit: d.user?.name,
          creditUrl: d.user?.links?.html,
        });
      }
    }
  } catch (e) {}

  // Fallback
  return json({ url: picsum(q), source: 'picsum' });
}

function picsum(query) {
  let hash = 0;
  for (let i = 0; i < query.length; i++) hash = (hash * 31 + query.charCodeAt(i)) & 0xffffffff;
  const seed = Math.abs(hash) % 1000;
  return `https://picsum.photos/seed/${seed}/800/500`;
}

// ═══════════════════════════════════════════════════════
// /api/flights — Kiwi Tequila API
// ═══════════════════════════════════════════════════════
async function handleFlights(url, env) {
  const p = url.searchParams;
  const from = p.get('from') || 'SYD';
  const to = p.get('to') || 'anywhere';
  const depart = p.get('depart') || tomorrow();
  const ret = p.get('ret') || addDays(depart, 7);
  const adults = parseInt(p.get('adults')) || 2;
  const children = parseInt(p.get('children')) || 2;
  const currency = p.get('currency') || 'AUD';
  const anywhere = to === 'anywhere';

  if (!env.KIWI_API_KEY) {
    return json({ flights: mockFlights(from, currency) });
  }

  const params = new URLSearchParams({
    fly_from: from,
    ...(anywhere ? {} : { fly_to: to }),
    date_from: formatDate(depart),
    date_to: formatDate(depart),
    return_from: formatDate(ret),
    return_to: formatDate(addDays(ret, 2)),
    adults,
    children,
    curr: currency,
    sort: 'price',
    limit: 10,
    vehicle_type: 'aircraft',
    partner: 'picky',
  });

  try {
    const r = await fetchWithRetry(
      `https://api.tequila.kiwi.com/v2/search?${params}`,
      { headers: { apikey: env.KIWI_API_KEY } }
    );
    if (!r.ok) return json({ flights: mockFlights(from, currency) });
    const d = await r.json();
    const flights = (d.data || []).slice(0, 8).map(f => ({
      id: f.id,
      from: f.flyFrom,
      to: f.flyTo,
      dest: f.cityTo,
      airline: f.airlines?.[0] || 'Airlines',
      price: Math.round(f.price),
      origPrice: Math.round(f.price * (1 + Math.random() * 0.3 + 0.05)),
      duration: formatDuration(f.duration?.total),
      stops: f.route?.length > 1 ? `${f.route.length - 1} stop` : 'Direct',
      depart: f.local_departure?.split('T')[0] || depart,
      url: f.deep_link || `https://www.kiwi.com`,
      photo: `${f.cityTo} ${countryFromCode(f.flyTo)} travel`,
    }));
    return json({ flights });
  } catch (e) {
    return json({ flights: mockFlights(from, currency) });
  }
}

// ═══════════════════════════════════════════════════════
// /api/stays — Airbnb + Booking.com in parallel
// ═══════════════════════════════════════════════════════
async function handleStays(url, env) {
  const p = url.searchParams;
  const dest = p.get('dest') || 'Bali';
  const checkin = p.get('checkin') || tomorrow();
  const checkout = p.get('checkout') || addDays(checkin, 7);
  const guests = parseInt(p.get('guests')) || 4;
  const bedrooms = parseInt(p.get('bedrooms')) || 2;
  const currency = p.get('currency') || 'AUD';

  const [airbnbResult, bookingResult] = await Promise.allSettled([
    fetchAirbnb(dest, checkin, checkout, guests, bedrooms, currency, env),
    fetchBooking(dest, checkin, checkout, guests, bedrooms, currency, env),
  ]);

  let stays = [];
  if (airbnbResult.status === 'fulfilled') stays = stays.concat(airbnbResult.value);
  if (bookingResult.status === 'fulfilled') stays = stays.concat(bookingResult.value);

  // Deduplicate and sort by price
  stays = stays
    .filter((s, i, a) => a.findIndex(x => x.name === s.name) === i)
    .sort((a, b) => a.price - b.price);

  if (!stays.length) stays = mockStays(dest, currency);

  return json({ stays });
}

async function fetchAirbnb(dest, checkin, checkout, guests, bedrooms, currency, env) {
  if (!env.AIRBNB_API_KEY) return mockStays(dest, currency, 'airbnb');
  try {
    const r = await fetchWithRetry(
      `https://airbnb13.p.rapidapi.com/search-location?location=${encodeURIComponent(dest)}&checkin=${checkin}&checkout=${checkout}&adults=${guests}&currency=${currency}&minBedrooms=${bedrooms}&propertyType=entire_home`,
      {
        headers: {
          'X-RapidAPI-Key': env.AIRBNB_API_KEY,
          'X-RapidAPI-Host': 'airbnb13.p.rapidapi.com',
        },
      }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).slice(0, 6).map(s => ({
      id: 'ab_' + s.id,
      name: s.name || s.title || 'Entire Home',
      location: dest,
      beds: s.bedrooms || bedrooms,
      guests: s.persons || guests,
      price: Math.round(s.price?.rate || s.price?.total || 150),
      origPrice: null,
      source: 'airbnb',
      url: `https://www.airbnb.com/rooms/${s.id}`,
      photo: `${dest} airbnb home interior`,
      rating: s.rating,
    }));
  } catch (e) {
    return [];
  }
}

async function fetchBooking(dest, checkin, checkout, guests, bedrooms, currency, env) {
  if (!env.BOOKING_API_KEY) return mockStays(dest, currency, 'booking');
  try {
    // Step 1: Search for destination ID
    const locR = await fetchWithRetry(
      `https://booking-com15.p.rapidapi.com/api/v1/hotels/searchDestination?query=${encodeURIComponent(dest)}`,
      { headers: { 'X-RapidAPI-Key': env.BOOKING_API_KEY, 'X-RapidAPI-Host': 'booking-com15.p.rapidapi.com' } }
    );
    if (!locR.ok) return [];
    const locD = await locR.json();
    const destId = locD.data?.[0]?.dest_id;
    const destType = locD.data?.[0]?.dest_type || 'city';
    if (!destId) return [];

    // Step 2: Search hotels (apartment type)
    const nights = daysBetween(checkin, checkout);
    const hotelR = await fetchWithRetry(
      `https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotels?dest_id=${destId}&search_type=${destType}&arrival_date=${checkin}&departure_date=${checkout}&adults=${guests}&room_qty=${Math.max(1, Math.ceil(bedrooms / 2))}&units=metric&temperature_unit=c&languagecode=en-us&currency_code=${currency}&categories_filter=class%3A%3A1%2Cclass%3A%3A2&property_type_filter=201`,
      { headers: { 'X-RapidAPI-Key': env.BOOKING_API_KEY, 'X-RapidAPI-Host': 'booking-com15.p.rapidapi.com' } }
    );
    if (!hotelR.ok) return [];
    const hotelD = await hotelR.json();
    return (hotelD.data?.hotels || []).slice(0, 5).map(h => ({
      id: 'bk_' + h.hotel_id,
      name: h.property?.name || 'Apartment',
      location: dest,
      beds: bedrooms,
      guests,
      price: Math.round((h.property?.priceBreakdown?.grossPrice?.value || 150) / Math.max(1, nights)),
      origPrice: null,
      source: 'booking',
      url: `https://www.booking.com/hotel/${h.property?.countryCode}/${h.property?.name?.toLowerCase().replace(/\s+/g, '-')}.html`,
      photo: `${dest} apartment accommodation`,
      rating: h.property?.reviewScore,
    }));
  } catch (e) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════
// /api/lastminute — Deals departing in the next 24 hours
// ═══════════════════════════════════════════════════════
async function handleLastMinute(url, env) {
  const p = url.searchParams;
  const from = p.get('from') || 'SYD';
  const type = p.get('type') || 'flights';
  const currency = p.get('currency') || 'AUD';

  if (type === 'stays') {
    // Last-minute stays: checking in tonight or tomorrow
    return json({ stays: mockLastMinuteStays(currency) });
  }

  if (!env.KIWI_API_KEY) {
    return json({ flights: mockLastMinuteFlights(from, currency) });
  }

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const params = new URLSearchParams({
    fly_from: from,
    date_from: todayStr,
    date_to: todayStr,
    curr: currency,
    sort: 'price',
    limit: 8,
    one_per_city: true,
    vehicle_type: 'aircraft',
    partner: 'picky',
  });

  try {
    const r = await fetchWithRetry(
      `https://api.tequila.kiwi.com/v2/search?${params}`,
      { headers: { apikey: env.KIWI_API_KEY } }
    );
    if (!r.ok) return json({ flights: mockLastMinuteFlights(from, currency) });
    const d = await r.json();
    const flights = (d.data || []).slice(0, 6).map(f => ({
      id: 'lm_' + f.id,
      from: f.flyFrom,
      to: f.flyTo,
      dest: f.cityTo,
      airline: f.airlines?.[0] || 'Airlines',
      price: Math.round(f.price),
      origPrice: Math.round(f.price * 1.35),
      duration: formatDuration(f.duration?.total),
      stops: f.route?.length > 1 ? `${f.route.length - 1} stop` : 'Direct',
      depart: f.local_departure || todayStr,
      url: f.deep_link || 'https://www.kiwi.com',
      photo: `${f.cityTo} ${countryFromCode(f.flyTo)} aerial travel`,
    }));
    return json({ flights });
  } catch (e) {
    return json({ flights: mockLastMinuteFlights(from, currency) });
  }
}

// ═══════════════════════════════════════════════════════
// /api/inspire — Cheapest destinations from home airport
// ═══════════════════════════════════════════════════════
async function handleInspire(url, env) {
  const p = url.searchParams;
  const from = p.get('from') || 'SYD';
  const period = p.get('period') || 'weekend';
  const currency = p.get('currency') || 'AUD';

  if (!env.KIWI_API_KEY) {
    return json({ destinations: mockInspire(currency) });
  }

  const dateRange = getPeriodDates(period);
  const params = new URLSearchParams({
    fly_from: from,
    date_from: dateRange.from,
    date_to: dateRange.to,
    return_from: dateRange.retFrom,
    return_to: dateRange.retTo,
    curr: currency,
    sort: 'price',
    limit: 12,
    one_per_city: true,
    vehicle_type: 'aircraft',
    partner: 'picky',
  });

  try {
    const r = await fetchWithRetry(
      `https://api.tequila.kiwi.com/v2/search?${params}`,
      { headers: { apikey: env.KIWI_API_KEY } }
    );
    if (!r.ok) return json({ destinations: mockInspire(currency) });
    const d = await r.json();
    const destinations = (d.data || []).slice(0, 10).map(f => ({
      dest: f.cityTo,
      code: f.flyTo,
      country: f.countryTo?.name || '',
      price: Math.round(f.price),
      period,
      photo: `${f.cityTo} ${f.countryTo?.name || ''} travel landmark`,
      url: f.deep_link || 'https://www.kiwi.com',
    }));
    return json({ destinations });
  } catch (e) {
    return json({ destinations: mockInspire(currency) });
  }
}

// ═══════════════════════════════════════════════════════
// /api/ai — Natural language search via Claude
// ═══════════════════════════════════════════════════════
async function handleAI(request, env) {
  const body = await request.json().catch(() => ({}));
  const { query, airport = 'SYD', adults = 2, children = 2 } = body;

  if (!query) return err('query required');

  // Use per-request key from app Settings, fall back to Cloudflare secret
  const apiKey = request.headers.get('X-Claude-Key') || env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // No key at all — simple keyword fallback
    return json(simpleAIParse(query, airport));
  }

  try {
    const r = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: `You are a travel search parser for ROAM, a travel deal hunting app.
The user is searching from ${airport} with ${adults} adults and ${children} children.
Parse the user's natural language query and return ONLY a JSON object with:
{
  "type": "flights" | "stays",
  "to": "IATA code or city name (for flights)",
  "dest": "city name (for stays)",
  "checkin": "YYYY-MM-DD (if mentioned)",
  "checkout": "YYYY-MM-DD (if mentioned)",
  "depart": "YYYY-MM-DD (if mentioned)",
  "return": "YYYY-MM-DD (if mentioned)"
}
Return ONLY valid JSON, no explanation.`,
        messages: [{ role: 'user', content: query }],
      }),
    });

    if (r.ok) {
      const d = await r.json();
      const text = d.content?.[0]?.text || '';
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return json(parsed);
      } catch (e) {
        return json(simpleAIParse(query, airport));
      }
    }
  } catch (e) {}

  return json(simpleAIParse(query, airport));
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function simpleAIParse(query, airport) {
  const q = query.toLowerCase();
  const stayKeywords = ['stay', 'hotel', 'airbnb', 'house', 'villa', 'apartment', 'cabin', 'accommodation'];
  const isStay = stayKeywords.some(k => q.includes(k));

  const destinations = {
    'bali': { to: 'DPS', dest: 'Bali' },
    'tokyo': { to: 'NRT', dest: 'Tokyo' },
    'bangkok': { to: 'BKK', dest: 'Bangkok' },
    'singapore': { to: 'SIN', dest: 'Singapore' },
    'london': { to: 'LHR', dest: 'London' },
    'new york': { to: 'JFK', dest: 'New York' },
    'paris': { to: 'CDG', dest: 'Paris' },
    'maldives': { to: 'MLE', dest: 'Maldives' },
    'phuket': { to: 'HKT', dest: 'Phuket' },
    'queenstown': { to: 'ZQN', dest: 'Queenstown' },
    'melbourne': { to: 'MEL', dest: 'Melbourne' },
    'fiji': { to: 'NAN', dest: 'Fiji' },
  };

  for (const [key, val] of Object.entries(destinations)) {
    if (q.includes(key)) {
      return { type: isStay ? 'stays' : 'flights', ...val };
    }
  }

  return { type: isStay ? 'stays' : 'flights', to: null, dest: null };
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  // Kiwi expects dd/mm/yyyy
  const [y, m, day] = dateStr.split('-');
  return `${day}/${m}/${y}`;
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function daysBetween(a, b) {
  return Math.max(1, (new Date(b) - new Date(a)) / 86400000);
}

function countryFromCode(iata) {
  const map = {
    NRT: 'Japan', HND: 'Japan', KIX: 'Japan',
    BKK: 'Thailand', HKT: 'Thailand', CNX: 'Thailand',
    DPS: 'Indonesia', CGK: 'Indonesia',
    SIN: 'Singapore',
    HKG: 'Hong Kong',
    LHR: 'England', LGW: 'England',
    CDG: 'France',
    JFK: 'USA', LAX: 'USA', SFO: 'USA',
    DXB: 'UAE',
    MLE: 'Maldives',
    ZQN: 'New Zealand', AKL: 'New Zealand',
    NAN: 'Fiji',
    KUL: 'Malaysia',
    ICN: 'Korea',
    PEK: 'China', PVG: 'China',
  };
  return map[iata] || '';
}

function getPeriodDates(period) {
  const today = new Date();
  const fri = new Date(today);
  fri.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7) || 7);
  const sun = new Date(fri);
  sun.setDate(fri.getDate() + 2);
  const mon = new Date(sun);
  mon.setDate(sun.getDate() + 1);

  if (period === 'weekend') {
    return {
      from: fri.toISOString().split('T')[0],
      to: fri.toISOString().split('T')[0],
      retFrom: sun.toISOString().split('T')[0],
      retTo: mon.toISOString().split('T')[0],
    };
  }
  // month / anytime
  const start = addDays(today.toISOString().split('T')[0], 7);
  const end = addDays(today.toISOString().split('T')[0], period === 'month' ? 35 : 90);
  return {
    from: formatDateISO(start),
    to: formatDateISO(addDays(start, 14)),
    retFrom: formatDateISO(addDays(start, 5)),
    retTo: formatDateISO(end),
  };
}

function formatDateISO(d) { return d; }

// ═══════════════════════════════════════════════════════
// MOCK DATA — used when API keys aren't configured
// ═══════════════════════════════════════════════════════

function mockFlights(from, currency) {
  const rate = currency === 'USD' ? 0.65 : currency === 'GBP' ? 0.51 : 1;
  return [
    { id: 'f1', from, to: 'NRT', dest: 'Tokyo', airline: 'Japan Airlines', price: Math.round(1240 * rate), origPrice: Math.round(1580 * rate), duration: '11h 40m', stops: 'Direct', depart: addDays(tomorrow(), 7), url: 'https://www.kiwi.com', photo: 'tokyo japan travel aerial' },
    { id: 'f2', from, to: 'BKK', dest: 'Bangkok', airline: 'Thai Airways', price: Math.round(892 * rate), origPrice: Math.round(1240 * rate), duration: '9h 15m', stops: 'Direct', depart: addDays(tomorrow(), 9), url: 'https://www.kiwi.com', photo: 'bangkok thailand city travel' },
    { id: 'f3', from, to: 'LHR', dest: 'London', airline: 'Qantas', price: Math.round(2140 * rate), origPrice: Math.round(2680 * rate), duration: '22h 0m', stops: '1 stop', depart: addDays(tomorrow(), 14), url: 'https://www.kiwi.com', photo: 'london england travel landmark' },
    { id: 'f4', from, to: 'DPS', dest: 'Bali', airline: 'Jetstar', price: Math.round(380 * rate), origPrice: Math.round(550 * rate), duration: '6h 0m', stops: 'Direct', depart: addDays(tomorrow(), 5), url: 'https://www.kiwi.com', photo: 'bali indonesia temple rice terraces' },
    { id: 'f5', from, to: 'SIN', dest: 'Singapore', airline: 'Singapore Airlines', price: Math.round(490 * rate), origPrice: Math.round(620 * rate), duration: '8h 5m', stops: 'Direct', depart: addDays(tomorrow(), 6), url: 'https://www.kiwi.com', photo: 'singapore marina bay sands skyline' },
  ];
}

function mockLastMinuteFlights(from, currency) {
  const rate = currency === 'USD' ? 0.65 : currency === 'GBP' ? 0.51 : 1;
  const today = new Date().toISOString().split('T')[0];
  return [
    { id: 'lm1', from, to: 'MEL', dest: 'Melbourne', airline: 'Qantas', price: Math.round(189 * rate), origPrice: Math.round(320 * rate), duration: '1h 25m', stops: 'Direct', depart: today, url: 'https://www.kiwi.com', photo: 'melbourne australia city yarra' },
    { id: 'lm2', from, to: 'DPS', dest: 'Bali', airline: 'AirAsia', price: Math.round(290 * rate), origPrice: Math.round(490 * rate), duration: '6h 0m', stops: 'Direct', depart: today, url: 'https://www.kiwi.com', photo: 'bali indonesia beach sunset' },
    { id: 'lm3', from, to: 'BNE', dest: 'Brisbane', airline: 'Virgin', price: Math.round(149 * rate), origPrice: Math.round(240 * rate), duration: '1h 20m', stops: 'Direct', depart: today, url: 'https://www.kiwi.com', photo: 'brisbane australia story bridge' },
  ];
}

function mockStays(dest, currency, source = null) {
  const rate = currency === 'USD' ? 0.65 : currency === 'GBP' ? 0.51 : 1;
  return [
    { id: 's1', name: `Beachfront Villa — ${dest}`, location: dest, beds: 2, guests: 4, price: Math.round(285 * rate), origPrice: Math.round(390 * rate), source: source || 'airbnb', url: 'https://www.airbnb.com', photo: `${dest} villa beach pool` },
    { id: 's2', name: `Stylish Apartment — ${dest}`, location: dest, beds: 2, guests: 4, price: Math.round(180 * rate), origPrice: Math.round(220 * rate), source: source || 'booking', url: 'https://www.booking.com', photo: `${dest} modern apartment interior` },
    { id: 's3', name: `Garden House — ${dest}`, location: dest, beds: 3, guests: 6, price: Math.round(310 * rate), origPrice: null, source: source || 'airbnb', url: 'https://www.airbnb.com', photo: `${dest} house garden tropical` },
  ];
}

function mockLastMinuteStays(currency) {
  return mockStays('Bali', currency).concat(mockStays('Byron Bay', currency, 'airbnb'));
}

function mockInspire(currency) {
  const rate = currency === 'USD' ? 0.65 : currency === 'GBP' ? 0.51 : 1;
  return [
    { dest: 'Bali', code: 'DPS', country: 'Indonesia', price: Math.round(380 * rate), period: 'weekend', photo: 'bali indonesia rice terraces temple', url: 'https://www.kiwi.com' },
    { dest: 'Singapore', code: 'SIN', country: 'Singapore', price: Math.round(490 * rate), period: 'weekend', photo: 'singapore marina bay gardens night', url: 'https://www.kiwi.com' },
    { dest: 'Tokyo', code: 'NRT', country: 'Japan', price: Math.round(1240 * rate), period: 'month', photo: 'tokyo japan shibuya crossing neon', url: 'https://www.kiwi.com' },
    { dest: 'Bangkok', code: 'BKK', country: 'Thailand', price: Math.round(892 * rate), period: 'month', photo: 'bangkok thailand grand palace temple', url: 'https://www.kiwi.com' },
    { dest: 'Maldives', code: 'MLE', country: 'Maldives', price: Math.round(1480 * rate), period: 'anytime', photo: 'maldives overwater bungalow turquoise ocean', url: 'https://www.kiwi.com' },
    { dest: 'New York', code: 'JFK', country: 'USA', price: Math.round(2280 * rate), period: 'anytime', photo: 'new york city manhattan skyline central park', url: 'https://www.kiwi.com' },
    { dest: 'Queenstown', code: 'ZQN', country: 'New Zealand', price: Math.round(420 * rate), period: 'weekend', photo: 'queenstown new zealand mountains lake wakatipu', url: 'https://www.kiwi.com' },
    { dest: 'Phuket', code: 'HKT', country: 'Thailand', price: Math.round(760 * rate), period: 'month', photo: 'phuket thailand beach emerald water longtail boat', url: 'https://www.kiwi.com' },
  ];
}
