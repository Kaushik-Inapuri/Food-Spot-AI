// routes/nlp.js — NLP Natural Language Search
// Uses Groq API (llama-3.3-70b-versatile) to parse user queries into structured filters
// Add to server.js: app.use('/api/nlp', require('./routes/nlp'));
//
// Add to Render environment variables:
//   GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
//   Get a free key at https://console.groq.com

const express    = require('express');
const Restaurant = require('../models/Restaurant');

const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Haversine distance ──────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R   = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceLabel(km) {
  if (km == null) return null;
  return km < 1 ? Math.round(km * 1000) + ' m away' : km.toFixed(1) + ' km away';
}

// ── Parse natural language with Groq ───────────────────────
async function parseWithGroq(query) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set in environment variables. Get a free key at https://console.groq.com');

  const systemPrompt = `You are a restaurant search assistant for an Indian food app.
Extract search filters from the user's natural language query and return ONLY a JSON object with these fields:
{
  "keywords": ["string"],        // restaurant names or food item names to search for
  "cuisines": ["string"],        // e.g. ["Indian", "Chinese", "South Indian", "Andhra", "Italian", "Thai", "Continental"]
  "maxBudget": number|null,      // 1=cheap, 2=medium, 3=expensive — interpret "cheap","affordable","budget" as 1; "moderate" as 2; "expensive","premium" as 3
  "minRating": number|null,      // 1-5 star minimum (e.g. "highly rated"=4, "best"=4.5)
  "maxSpice": number|null,       // 1-5 max spice level (e.g. "mild"=2, "not too spicy"=2)
  "minSpice": number|null,       // 1-5 min spice level (e.g. "spicy"=3, "very spicy"=4)
  "tags": ["string"],            // e.g. ["veg", "nonveg", "budget"]
  "maxDistanceKm": number|null,  // e.g. "nearby"=2, "close"=3, "within 5km"=5
  "sortBy": "distance"|"rating"|"match"|null
}
Return ONLY the JSON object, no explanation, no markdown, no code fences.`;

  const resp = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  300,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: query },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Groq API error: ' + err);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Apply filters to restaurant list ───────────────────────
function applyFilters(restaurants, filters, userLat, userLng) {
  return restaurants
    .map(r => {
      const dist = (userLat != null && userLng != null && r.lat && r.lng)
        ? haversine(userLat, userLng, r.lat, r.lng)
        : null;
      return {
        ...r.toObject ? r.toObject() : r,
        distanceKm:    dist != null ? +dist.toFixed(2) : null,
        distanceLabel: distanceLabel(dist),
      };
    })
    .filter(r => {
      // Keywords — match restaurant name OR any menu item name/description
      if (filters.keywords?.length) {
        const kws = filters.keywords.map(k => k.toLowerCase());
        const searchable = [
          r.name,
          ...(r.cuisines || []),
          ...(r.tags || []),
          ...(r.menu || []).flatMap(s =>
            (s.items || []).map(i => i.name + ' ' + (i.description || ''))
          ),
        ].join(' ').toLowerCase();
        if (!kws.some(kw => searchable.includes(kw))) return false;
      }
      // Cuisines
      if (filters.cuisines?.length) {
        const overlap = (r.cuisines || []).some(c =>
          filters.cuisines.some(fc => c.toLowerCase().includes(fc.toLowerCase()))
        );
        if (!overlap) return false;
      }
      // Budget
      if (filters.maxBudget != null && r.priceLevel > filters.maxBudget) return false;
      // Rating
      if (filters.minRating != null && r.rating < filters.minRating) return false;
      // Spice
      if (filters.maxSpice != null && r.spiceLevel > filters.maxSpice) return false;
      if (filters.minSpice != null && r.spiceLevel < filters.minSpice) return false;
      // Tags
      if (filters.tags?.length) {
        if (!filters.tags.some(t => (r.tags || []).includes(t))) return false;
      }
      // Distance
      if (filters.maxDistanceKm != null && r.distanceKm != null) {
        if (r.distanceKm > filters.maxDistanceKm) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const sort = filters.sortBy || 'rating';
      if (sort === 'distance') return (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
      if (sort === 'rating')   return b.rating - a.rating;
      return b.rating - a.rating;
    });
}

// ── POST /api/nlp/search ────────────────────────────────────
// Body: { query: "spicy Indian food under ₹200", lat, lng }
router.post('/search', async (req, res) => {
  try {
    const { query, lat, lng } = req.body;
    if (!query?.trim()) {
      return res.status(400).json({ success: false, message: 'query is required.' });
    }

    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    let filters  = {};
    let nlpUsed  = true;

    try {
      filters = await parseWithGroq(query);
    } catch (e) {
      console.warn('Groq parse failed, falling back to keyword search:', e.message);
      filters = { keywords: query.split(/\s+/).filter(Boolean) };
      nlpUsed = false;
    }

    const all     = await Restaurant.find();
    const results = applyFilters(all, filters, userLat, userLng);

    res.json({
      success: true,
      query,
      nlpUsed,
      parsedFilters: filters,
      count: results.length,
      restaurants: results,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/nlp/search?q=biryani&lat=16.51&lng=80.63 ──────
// Simple keyword search (no NLP)
router.get('/search', async (req, res) => {
  try {
    const { q, lat, lng } = req.query;
    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    const all = await Restaurant.find();

    const results = all
      .map(r => {
        const dist = (userLat != null && userLng != null && r.lat && r.lng)
          ? haversine(userLat, userLng, r.lat, r.lng)
          : null;

        const matchedItems = q
          ? (r.menu || []).flatMap(s =>
              (s.items || []).filter(i =>
                i.name.toLowerCase().includes(q.toLowerCase()) ||
                (i.description || '').toLowerCase().includes(q.toLowerCase())
              ).map(i => ({ category: s.category, name: i.name, price: i.price }))
            )
          : [];

        return {
          ...r.toObject(),
          distanceKm:    dist != null ? +dist.toFixed(2) : null,
          distanceLabel: distanceLabel(dist),
          matchedItems,
        };
      })
      .filter(r => {
        if (!q) return true;
        const ql = q.toLowerCase();
        return (
          r.name.toLowerCase().includes(ql) ||
          (r.cuisines || []).some(c => c.toLowerCase().includes(ql)) ||
          (r.tags || []).some(t => t.toLowerCase().includes(ql)) ||
          r.matchedItems.length > 0
        );
      })
      .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));

    res.json({ success: true, query: q, count: results.length, restaurants: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;