/**
 * ROAM — Cloudflare Worker v1.0.0
 * API proxy for: Claude AI, Kiwi Tequila (flights), Airbnb (RapidAPI), Booking.com, Unsplash
 *
 * Environment variables to set in Cloudflare dashboard:
 *   ANTHROPIC_API_KEY     — from anthropic.com
 *   KIWI_API_KEY          — from tequila.kiwi.com
 *   RAPIDAPI_KEY          — from rapidapi.com (Airbnb API)
 *   BOOKING_AFFILIATE_ID  — from booking.com affiliate program
 *   UNSPLASH_ACCESS_KEY   — from unsplash.com/developers
 *   ALLOWED_ORIGIN        — your frontend URL e.g. https://roam.yourdomain.com
 */

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowed = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS(allowed) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── AI SEARCH ──────────────────────────────────────────────────
      if (path === '/api/ai' && request.method === 'POST') {
        const body = await request.json();
        const { query, type, homeAirport, adults, children } = body;

        const systemPrompt = `You are ROAM's travel AI assistant. The user's home airport is ${homeAirport}. Default travellers: ${adults} adults, ${children} children. 
        Help them find the best ${type === 'flights' ? 'flight' : 'accommodation'} deals. Be concise, specific, and actionable. 
        Suggest real destinations, realistic price ranges, and best timing. Format your response in plain text, no markdown.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: systemPrompt,
            messages: [{ role: 'user', content: query }],
          }),
        });

        const data = await response.json();
        const result = data.content?.[0]?.text || 'No response from AI.';
        return new Response(JSON.stringify({ result }), { headers: CORS(allowed) });
      }

      // ── FLIGHT SEARCH (Kiwi Tequila) ───────────────────────────────
      if (path === '/api/flights' && request.method === 'POST') {
        const body = await request.json();
        const { from, to, dateFrom, dateTo, adults = 2, children = 2 } = body;

        const params = new URLSearchParams({
          fly_from: from,
          fly_to: to || 'anywhere',
          date_from: dateFrom,
          date_to: dateTo,
          adults,
          children,
          curr: 'AUD',
          locale: 'en',
          limit: 10,
          sort: 'price',
          max_stopovers: 2,
        });

        const response = await fetch(`https://api.tequila.kiwi.com/v2/search?${params}`, {
          headers: { apikey: env.KIWI_API_KEY },
        });

        const data = await response.json();
        const flights = (data.data || []).map(f => ({
          id: f.id,
          from: f.flyFrom,
          to: f.flyTo,
          dest: f.cityTo,
          country: f.countryTo?.name,
          price: Math.round(f.price),
          airline: f.airlines?.[0] || 'Unknown',
          duration: formatDuration(f.duration?.total),
          stops: f.route?.length - 1 === 0 ? 'Direct' : `${f.route.length - 1} stop${f.route.length > 2 ? 's' : ''}`,
          depart: formatTime(f.dTime),
          url: f.deep_link,
          bookingToken: f.booking_token,
        }));

        return new Response(JSON.stringify({ flights }), { headers: CORS(allowed) });
      }

      // ── LAST MINUTE FLIGHTS (Kiwi) ─────────────────────────────────
      if (path === '/api/lastminute/flights' && request.method === 'GET') {
        const from = url.searchParams.get('from') || 'SYD';
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
        const fmt = d => d.toLocaleDateString('en-GB').split('/').reverse().join('/').replace(/\//g, '/');

        const params = new URLSearchParams({
          fly_from: from,
          fly_to: 'anywhere',
          date_from: fmt(new Date()),
          date_to: fmt(dayAfter),
          curr: 'AUD',
          limit: 8,
          sort: 'price',
          one_for_city: 1,
        });

        const response = await fetch(`https://api.tequila.kiwi.com/v2/search?${params}`, {
          headers: { apikey: env.KIWI_API_KEY },
        });

        const data = await response.json();
        return new Response(JSON.stringify({ flights: data.data || [] }), { headers: CORS(allowed) });
      }

      // ── STAYS SEARCH (Airbnb via RapidAPI) ─────────────────────────
      if (path === '/api/stays/airbnb' && request.method === 'POST') {
        const body = await request.json();
        const { location, checkin, checkout, adults = 2, children = 2, bedrooms = 2 } = body;

        const response = await fetch(
          `https://airbnb13.p.rapidapi.com/search-location?location=${encodeURIComponent(location)}&checkin=${checkin}&checkout=${checkout}&adults=${adults}&children=${children}&rooms=${bedrooms}&currency=AUD`,
          {
            headers: {
              'X-RapidAPI-Key': env.RAPIDAPI_KEY,
              'X-RapidAPI-Host': 'airbnb13.p.rapidapi.com',
            },
          }
        );

        const data = await response.json();
        const stays = (data.results || [])
          .filter(s => s.type !== 'PRIVATE_ROOM' && s.type !== 'SHARED_ROOM')
          .map(s => ({
            id: 'ab_' + s.id,
            title: s.name,
            dest: location,
            price: Math.round(s.price?.rate || 0),
            beds: s.bedrooms || bedrooms,
            guests: (s.persons || (adults + children)),
            rating: s.rating,
            img: s.images?.[0],
            url: `https://www.airbnb.com.au/rooms/${s.id}`,
            source: 'airbnb',
          }));

        return new Response(JSON.stringify({ stays }), { headers: CORS(allowed) });
      }

      // ── STAYS SEARCH (Booking.com Affiliate) ───────────────────────
      if (path === '/api/stays/booking' && request.method === 'POST') {
        const body = await request.json();
        const { location, checkin, checkout, adults = 2, children = 2, rooms = 1 } = body;

        // Booking.com affiliate search URL builder
        const params = new URLSearchParams({
          ss: location,
          checkin_year: checkin.split('-')[0],
          checkin_month: checkin.split('-')[1],
          checkin_monthday: checkin.split('-')[2],
          checkout_year: checkout.split('-')[0],
          checkout_month: checkout.split('-')[1],
          checkout_monthday: checkout.split('-')[2],
          group_adults: adults,
          group_children: children,
          no_rooms: rooms,
          selected_currency: 'AUD',
          aid: env.BOOKING_AFFILIATE_ID || '304142',
        });

        // Return search URL (affiliate link) — Booking.com API requires separate setup
        const searchUrl = `https://www.booking.com/searchresults.html?${params}`;
        return new Response(JSON.stringify({ searchUrl, note: 'Booking.com affiliate link' }), { headers: CORS(allowed) });
      }

      // ── DESTINATION PHOTO (Unsplash) ───────────────────────────────
      if (path === '/api/photo' && request.method === 'GET') {
        const query = url.searchParams.get('q') || 'travel';
        const response = await fetch(
          `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high`,
          { headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` } }
        );
        const data = await response.json();
        return new Response(JSON.stringify({
          url: data.urls?.regular,
          thumb: data.urls?.small,
          credit: data.user?.name,
          creditUrl: data.user?.links?.html,
        }), { headers: CORS(allowed) });
      }

      // ── INSPIRE (cheapest destinations from home) ──────────────────
      if (path === '/api/inspire' && request.method === 'GET') {
        const from = url.searchParams.get('from') || 'SYD';
        const period = url.searchParams.get('period') || 'weekend'; // weekend | month

        const today = new Date();
        let dateFrom, dateTo;
        if (period === 'weekend') {
          const fri = new Date(today); fri.setDate(today.getDate() + (5 - today.getDay() + 7) % 7 || 7);
          const sun = new Date(fri); sun.setDate(fri.getDate() + 2);
          dateFrom = fri.toLocaleDateString('en-GB').split('/').join('/');
          dateTo = sun.toLocaleDateString('en-GB').split('/').join('/');
        } else {
          const next = new Date(today); next.setDate(today.getDate() + 30);
          const end = new Date(today); end.setDate(today.getDate() + 60);
          dateFrom = next.toLocaleDateString('en-GB').split('/').join('/');
          dateTo = end.toLocaleDateString('en-GB').split('/').join('/');
        }

        const params = new URLSearchParams({
          fly_from: from,
          fly_to: 'anywhere',
          date_from: dateFrom,
          date_to: dateTo,
          curr: 'AUD',
          limit: 6,
          sort: 'price',
          one_for_city: 1,
          max_stopovers: 1,
        });

        const response = await fetch(`https://api.tequila.kiwi.com/v2/search?${params}`, {
          headers: { apikey: env.KIWI_API_KEY },
        });
        const data = await response.json();
        return new Response(JSON.stringify({ destinations: data.data || [] }), { headers: CORS(allowed) });
      }

      // ── HEALTH CHECK ────────────────────────────────────────────────
      if (path === '/api/health') {
        return new Response(JSON.stringify({ status: 'ok', version: '1.0.0', ts: Date.now() }), { headers: CORS(allowed) });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS(allowed) });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS(allowed) });
    }
  },
};

// ── HELPERS ─────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTime(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
}
