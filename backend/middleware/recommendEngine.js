/**
 * Food Spot AI — Recommendation Engine  (Single Source of Truth)
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY FILE THAT CALCULATES AI SCORES.
 * No other file, route, or frontend code should recalculate scores.
 *
 * Scoring formulas (per workflow spec):
 *
 * NEW USER:         rating*0.5  + popularity*0.2 + distance*0.2 + review*0.1
 * REGULAR:          prefMatch*0.4 + behavior*0.3  + rating*0.2  + distance*0.1
 * SURPRISE:         diversity*0.5 + trend*0.3     + rating*0.2
 * SELECT PREFS:     filterMatch*0.5 + history*0.2 + rating*0.3
 * GROUP:            avgPref*0.5 + leastSatisfied*0.2 + rating*0.2 + distance*0.1
 */

// ── Haversine distance ────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcDistanceScore(restaurant, userLocation) {
  if (!userLocation) return 0.5;
  const km = haversineKm(userLocation.lat, userLocation.lng, restaurant.lat, restaurant.lng);
  return km === null ? 0.5 : Math.max(0, 1 - km / 10);
}

// ── Hard filters ──────────────────────────────────────────────────────────────
function passesVegFilter(restaurant, vegPref) {
  if (!vegPref || vegPref === 'any') return true;
  const tags = (restaurant.tags || []).map(t => t.toLowerCase());
  if (vegPref === 'veg' && tags.includes('nonveg') && !tags.includes('veg')) return false;
  return true;
}

function passesBudgetFilter(restaurant, budget) {
  if (!budget) return true;
  return Math.abs((restaurant.priceLevel || 2) - budget) <= 1;
}

function passesCuisineFilter(restaurant, cuisines) {
  if (!cuisines || cuisines.length === 0) return true;
  const lower = cuisines.map(c => c.toLowerCase());
  return (restaurant.cuisines || []).some(c => lower.includes(c.toLowerCase()));
}

function applyHardFilters(restaurants, { cuisines, budget, vegPreference }) {
  return restaurants.filter(r =>
    passesCuisineFilter(r, cuisines) &&
    passesBudgetFilter(r, budget) &&
    passesVegFilter(r, vegPreference)
  );
}

// ── Component helpers (0–1) ───────────────────────────────────────────────────
function calcPreferenceMatch(restaurant, pref) {
  let score = 0, total = 0;
  const userCuisines = (pref.preferredCuisines || []).map(c => c.toLowerCase());
  const restCuisines = (restaurant.cuisines || []).map(c => c.toLowerCase());
  if (userCuisines.length > 0) {
    const hits = restCuisines.filter(c => userCuisines.includes(c)).length;
    score += Math.min(hits, 2) / 2; total++;
  }
  const budgetDiff = Math.abs((restaurant.priceLevel || 2) - (pref.budgetPreference || 2));
  score += Math.max(0, 1 - budgetDiff/2); total++;
  const spiceDiff = Math.abs((restaurant.spiceLevel || 3) - (pref.spicePreference || 3));
  score += Math.max(0, 1 - spiceDiff/3); total++;
  if (pref.vegPreference && pref.vegPreference !== 'any') {
    score += passesVegFilter(restaurant, pref.vegPreference) ? 1 : 0; total++;
  }
  return total === 0 ? 0.5 : score / total;
}

function calcBehaviorMatch(restaurant, pref) {
  const rid = String(restaurant._id || restaurant.id || '');
  const feedbackMap = pref.feedbackMap || {};
  const likedIds    = (pref.likedRestaurants    || []).map(r => String(r._id || r));
  const dislikedIds = (pref.dislikedRestaurants || []).map(r => String(r._id || r));
  const fb = feedbackMap[rid];
  if (fb) {
    const norm = (fb.rating - 1) / 4;
    if (fb.liked === true)  return 0.5 + norm * 0.5;
    if (fb.liked === false) return norm * 0.3;
    return 0.3 + norm * 0.4;
  }
  if (likedIds.includes(rid))    return 0.75;
  if (dislikedIds.includes(rid)) return 0.1;
  return 0.5;
}

function calcDiversityScore(restaurant, pref) {
  const rid = String(restaurant._id || restaurant.id || '');
  const visitedIds   = (pref.visitedIds || []).map(String);
  const likedIds     = (pref.likedRestaurants || []).map(r => String(r._id || r));
  const userCuisines = (pref.preferredCuisines || []).map(c => c.toLowerCase());
  const restCuisines = (restaurant.cuisines || []).map(c => c.toLowerCase());
  let s = 0;
  if (!visitedIds.includes(rid)) s += 0.5;
  const overlap = restCuisines.filter(c => userCuisines.includes(c)).length;
  s += overlap === 0 ? 0.4 : (0.4 * (1 - Math.min(overlap, 2) / 2));
  if (!likedIds.includes(rid)) s += 0.1;
  return Math.min(s, 1.0);
}

function calcTrendScore(restaurant, pref) {
  const rid = String(restaurant._id || restaurant.id || '');
  const likedIds    = (pref.likedRestaurants    || []).map(r => String(r._id || r));
  const dislikedIds = (pref.dislikedRestaurants || []).map(r => String(r._id || r));
  const ratingNorm  = (restaurant.rating || 0) / 5;
  if (dislikedIds.includes(rid)) return 0;
  if (likedIds.includes(rid))    return ratingNorm * 0.6;
  return ratingNorm;
}

// ── Per-mode scoring functions ────────────────────────────────────────────────

function scoreNewUser(restaurant, userLocation) {
  const ratingNorm  = (restaurant.rating || 0) / 5;
  const popNorm     = Math.min((restaurant.rating || 0) / 5, 1);
  const distScore   = calcDistanceScore(restaurant, userLocation);
  const raw = (ratingNorm * 0.5) + (popNorm * 0.2) + (distScore * 0.2) + (ratingNorm * 0.1);
  return Math.round(Math.min(raw, 1) * 100);
}

function scoreRegular(restaurant, pref, userLocation) {
  const prefMatch  = calcPreferenceMatch(restaurant, pref);
  const behavMatch = calcBehaviorMatch(restaurant, pref);
  const ratingNorm = (restaurant.rating || 0) / 5;
  const distScore  = calcDistanceScore(restaurant, userLocation);
  const raw = (prefMatch * 0.4) + (behavMatch * 0.3) + (ratingNorm * 0.2) + (distScore * 0.1);
  return Math.round(Math.min(raw, 1) * 100);
}

function scoreSurprise(restaurant, pref) {
  const diversity  = calcDiversityScore(restaurant, pref);
  const trend      = calcTrendScore(restaurant, pref);
  const ratingNorm = (restaurant.rating || 0) / 5;
  const raw = (diversity * 0.5) + (trend * 0.3) + (ratingNorm * 0.2);
  return Math.round(Math.min(raw, 1) * 100);
}

function scoreSelectPreferences(restaurant, filters, pref) {
  const filterMatch = calcPreferenceMatch(restaurant, {
    preferredCuisines: filters.cuisines || [],
    budgetPreference:  filters.budget   || 2,
    spicePreference:   filters.spice    || 3,
    vegPreference:     filters.vegPreference || 'any',
  });
  const historyInfluence = calcBehaviorMatch(restaurant, pref);
  const ratingNorm       = (restaurant.rating || 0) / 5;
  const raw = (filterMatch * 0.5) + (historyInfluence * 0.2) + (ratingNorm * 0.3);
  return Math.round(Math.min(raw, 1) * 100);
}

function scoreGroup(restaurant, members, userLocation) {
  if (!members || members.length === 0) return 0;
  const memberScores = members.map(m => calcPreferenceMatch(restaurant, m));
  const avgMatch     = memberScores.reduce((a,b) => a+b, 0) / memberScores.length;
  const leastScore   = Math.min(...memberScores);
  const ratingNorm   = (restaurant.rating || 0) / 5;
  const distScore    = calcDistanceScore(restaurant, userLocation);
  const raw = (avgMatch * 0.5) + (leastScore * 0.2) + (ratingNorm * 0.2) + (distScore * 0.1);
  return Math.round(Math.min(raw, 1) * 100);
}

/**
 * calculateScore — THE ONLY ENTRY POINT for computing aiScore.
 * Call this function everywhere. Never call the individual score* functions from routes.
 */
function calculateScore(restaurant, { mode, pref, filters, members, userLocation } = {}) {
  switch (mode) {
    case 'new-user':           return scoreNewUser(restaurant, userLocation);
    case 'regular':            return scoreRegular(restaurant, pref, userLocation);
    case 'surprise':           return scoreSurprise(restaurant, pref);
    case 'select-preferences': return scoreSelectPreferences(restaurant, filters || {}, pref || {});
    case 'group':              return scoreGroup(restaurant, members, userLocation);
    default:                   return scoreRegular(restaurant, pref || {}, userLocation);
  }
}

// ── Group preference merging ──────────────────────────────────────────────────
function aggregatePreferences(members) {
  const budgets = members.map(m => m.budgetPreference || 2);
  const budget  = Math.round((Math.min(...budgets) + Math.max(...budgets)) / 2);
  const spices  = [...members.map(m => m.spicePreference || 3)].sort((a,b) => a-b);
  const spice   = spices[Math.floor(spices.length / 2)];
  let cuisines  = members[0]?.preferredCuisines || [];
  for (const m of members.slice(1)) {
    const inter = cuisines.filter(c => (m.preferredCuisines||[]).includes(c));
    cuisines = inter.length > 0 ? inter : cuisines;
  }
  if (cuisines.length === 0) cuisines = [...new Set(members.flatMap(m => m.preferredCuisines||[]))];
  const vegPreference = members.some(m => m.vegPreference === 'veg') ? 'veg' : 'any';
  return { preferredCuisines: cuisines, budgetPreference: budget, spicePreference: spice, vegPreference };
}

// ── Feedback learning ─────────────────────────────────────────────────────────
function applyFeedbackLearning(user, restaurant, liked, rating) {
  const cuisines = restaurant.cuisines || [];
  if (liked && rating >= 4) {
    cuisines.forEach(c => { if (!user.preferredCuisines.includes(c)) user.preferredCuisines.push(c); });
    user.budgetPreference = Math.round(user.budgetPreference * 0.7 + restaurant.priceLevel * 0.3);
    user.spicePreference  = Math.round(user.spicePreference  * 0.7 + restaurant.spiceLevel * 0.3);
    if (!user.likedRestaurants.map(String).includes(String(restaurant._id))) user.likedRestaurants.push(restaurant._id);
    user.dislikedRestaurants = user.dislikedRestaurants.filter(id => String(id) !== String(restaurant._id));
  } else if (liked && rating === 3) {
    cuisines.forEach(c => { if (!user.preferredCuisines.includes(c)) user.preferredCuisines.push(c); });
    if (!user.likedRestaurants.map(String).includes(String(restaurant._id))) user.likedRestaurants.push(restaurant._id);
  } else if (!liked || rating <= 2) {
    if (rating <= 2) user.preferredCuisines = user.preferredCuisines.filter(c => !cuisines.includes(c));
    if (!user.dislikedRestaurants.map(String).includes(String(restaurant._id))) user.dislikedRestaurants.push(restaurant._id);
    user.likedRestaurants = user.likedRestaurants.filter(id => String(id) !== String(restaurant._id));
  }
  user.budgetPreference = Math.max(1, Math.min(3, user.budgetPreference));
  user.spicePreference  = Math.max(1, Math.min(5, user.spicePreference));
  return user;
}

function buildFeedbackMap(feedbacks) {
  const map = {};
  for (const fb of feedbacks) {
    const rid = String(fb.restaurantId?._id || fb.restaurantId);
    if (!map[rid] || new Date(fb.createdAt) > new Date(map[rid].createdAt)) {
      map[rid] = { rating: fb.rating, liked: fb.liked, createdAt: fb.createdAt };
    }
  }
  return map;
}

module.exports = {
  calculateScore,        // ← USE THIS EVERYWHERE
  applyHardFilters,
  aggregatePreferences,
  applyFeedbackLearning,
  buildFeedbackMap,
  passesVegFilter,
  scoreGroup,            // used by group.js directly
};