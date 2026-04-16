// middleware/recommendEngine.js — SPEC-COMPLETE v2
// Changes from previous version:
//   1. Distance factor added to scoring (spec requirement)
//   2. Veg/Non-Veg preference added as a filter in scoring
//   3. Cold-start detection helper exported
//   4. All existing AI ranking, feedback learning, group scoring preserved

const MAX_SCORE_BASE = 2.5 * 2 + 1.5 * 2 + 1.2 * 3 + 5; // 16.6
// Distance adds up to 2.0 bonus pts when < 1 km, scales to 0 beyond 10 km
// Veg/non-veg match adds 1.5 pts when preference matches restaurant tag
const MAX_SCORE = MAX_SCORE_BASE + 2.0 + 1.5; // 20.1

// ── Haversine helper ──────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Distance score: 2.0 pts at 0 km → 0 pts at 10+ km ───
function distanceScore(restaurantLat, restaurantLng, userLat, userLng) {
  if (!userLat || !userLng || !restaurantLat || !restaurantLng) return 0;
  const km = haversine(userLat, userLng, restaurantLat, restaurantLng);
  if (km >= 10) return 0;
  return +(2.0 * (1 - km / 10)).toFixed(2);   // linear decay 2.0→0.0 over 10 km
}

// ── Veg / Non-Veg match: 1.5 pts when preference matches ─
function vegScore(restaurant, pref) {
  if (!pref.vegPreference || pref.vegPreference === 'any') return 0;
  const tags = (restaurant.tags || []).map(t => t.toLowerCase());
  if (pref.vegPreference === 'veg'    && tags.includes('veg'))    return 1.5;
  if (pref.vegPreference === 'nonveg' && tags.includes('nonveg')) return 1.5;
  // Hard filter: if user strictly wants veg and restaurant is nonveg-only, return negative so it ranks last
  if (pref.vegPreference === 'veg' && tags.includes('nonveg') && !tags.includes('veg')) return -5;
  return 0;
}

// ── Main scoring function ──────────────────────────────────
function scoreRestaurant(restaurant, pref, userLocation = null) {
  let s = 0;

  // 1. Cuisine match (up to 5.0 pts)
  const prefLower = (pref.preferredCuisines || []).map(c => c.toLowerCase());
  const cuisineMatches = (restaurant.cuisines || [])
    .filter(c => prefLower.includes(c.toLowerCase())).length;
  s += Math.min(cuisineMatches, 2) * 2.5;

  // 2. Budget closeness (up to 3.0 pts)
  s += Math.max(0, 2 - Math.abs(restaurant.priceLevel - (pref.budgetPreference || 2))) * 1.5;

  // 3. Spice closeness (up to 3.6 pts)
  s += Math.max(0, 3 - Math.abs(restaurant.spiceLevel - (pref.spicePreference || 3))) * 1.2;

  // 4. Restaurant rating (up to 5.0 pts)
  s += restaurant.rating || 0;

  // 5. Distance bonus (up to 2.0 pts) — NEW
  if (userLocation) {
    s += distanceScore(restaurant.lat, restaurant.lng, userLocation.lat, userLocation.lng);
  }

  // 6. Veg/Non-Veg preference match (up to 1.5 pts, -5 for hard mismatch) — NEW
  s += vegScore(restaurant, pref);

  return Math.round((Math.max(s, 0) / MAX_SCORE) * 100);
}

// ── Group scoring ─────────────────────────────────────────
function scoreForGroup(restaurant, members, userLocation = null) {
  const scores = members.map(m => scoreRestaurant(restaurant, m, userLocation));
  const avg    = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { avg, scores };
}

// ── Preference aggregation for groups ────────────────────
function aggregatePreferences(members) {
  const allCuisines = [...new Set(members.flatMap(m => m.preferredCuisines || []))];
  const avgBudget   = Math.round(members.reduce((s, m) => s + (m.budgetPreference || 2), 0) / members.length);
  const avgSpice    = Math.round(members.reduce((s, m) => s + (m.spicePreference  || 3), 0) / members.length);
  // For veg preference: 'veg' wins if ANY member is veg (they can't eat non-veg restaurants)
  const vegPref = members.some(m => m.vegPreference === 'veg') ? 'veg' : 'any';
  return { preferredCuisines: allCuisines, budgetPreference: avgBudget, spicePreference: avgSpice, vegPreference: vegPref };
}

// ── Feedback learning ─────────────────────────────────────
function applyFeedbackLearning(user, restaurant, liked, rating) {
  const cuisines = restaurant.cuisines || [];
  if (liked === true) {
    cuisines.forEach(c => { if (!user.preferredCuisines.includes(c)) user.preferredCuisines.push(c); });
    user.budgetPreference = Math.round((user.budgetPreference + restaurant.priceLevel) / 2);
    user.spicePreference  = Math.round((user.spicePreference  + restaurant.spiceLevel) / 2);
    const id = String(restaurant._id);
    if (!user.likedRestaurants.map(String).includes(id)) user.likedRestaurants.push(restaurant._id);
  } else if (liked === false) {
    if (rating <= 2) user.preferredCuisines = user.preferredCuisines.filter(c => !cuisines.includes(c));
    const id = String(restaurant._id);
    if (!user.dislikedRestaurants.map(String).includes(id)) user.dislikedRestaurants.push(restaurant._id);
  }
  return user;
}

// ── Cold-start detection ──────────────────────────────────
// Returns true if user has no meaningful preference data yet
function isFirstTimeUser(user) {
  return (
    (!user.preferredCuisines || user.preferredCuisines.length === 0) &&
    (!user.likedRestaurants  || user.likedRestaurants.length === 0) &&
    (!user.dislikedRestaurants || user.dislikedRestaurants.length === 0)
  );
}

// ── AI re-ranking via Claude API ──────────────────────────
async function aiRankRestaurants(restaurants, userContext, isGroup = false) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY || restaurants.length === 0) return null;

  try {
    const restSummaries = restaurants.map(r => ({
      id:            String(r._id),
      name:          r.name,
      cuisines:      r.cuisines,
      priceLevel:    r.priceLevel,
      spiceLevel:    r.spiceLevel,
      rating:        r.rating,
      tags:          r.tags,
      distanceKm:    r.distanceKm  || null,
      communityScore: r.communityScore || r.rating,
    }));

    const prompt = isGroup
      ? `You are a restaurant recommendation AI for FoodSpot AI.
Rank these restaurants for a GROUP of users to maximize overall satisfaction.

Group preferences:
${JSON.stringify(userContext, null, 2)}

Restaurants to rank:
${JSON.stringify(restSummaries, null, 2)}

Rules:
- Rank by best overall satisfaction across ALL group members
- If any member is vegetarian, never rank non-veg-only restaurants highly
- Penalize restaurants that any member strongly dislikes
- Consider distance: closer restaurants rank higher if scores are tied
- Higher community feedback score = better

Return ONLY a JSON array of restaurant IDs (best first):
["id1","id2","id3",...]`
      : `You are a restaurant recommendation AI for FoodSpot AI.
Rank these restaurants for a SINGLE user based on their preferences and past feedback.

User profile:
${JSON.stringify(userContext, null, 2)}

Restaurants to rank:
${JSON.stringify(restSummaries, null, 2)}

Rules:
- First: filters (cuisine, budget, spice, veg preference)
- Second: community feedback score
- Third: distance (nearer = better when scores are tied)
- Fourth: learned preferences from past feedback
- Never recommend restaurants user explicitly disliked

Return ONLY a JSON array of restaurant IDs (best first):
["id1","id2","id3",...]`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!resp.ok) return null;
    const data     = await resp.json();
    const text     = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const rankedIds = JSON.parse(text);
    if (!Array.isArray(rankedIds)) return null;

    const idOrder = rankedIds.map(String);
    return [...restaurants].sort((a, b) => {
      const ai = idOrder.indexOf(String(a._id));
      const bi = idOrder.indexOf(String(b._id));
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  } catch (e) {
    console.warn('AI ranking failed, using heuristic fallback:', e.message);
    return null;
  }
}

module.exports = {
  scoreRestaurant,
  scoreForGroup,
  aggregatePreferences,
  applyFeedbackLearning,
  aiRankRestaurants,
  isFirstTimeUser,
  distanceScore,
  vegScore,
  MAX_SCORE,
};
