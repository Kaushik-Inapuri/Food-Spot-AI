/**
 * routes/recommend.js
 * Implements the complete FoodSpot AI workflow:
 *   - New User (cold start)
 *   - Returning → Regular Choice
 *   - Returning → Try New → Surprise Me
 *   - Returning → Try New → Select Preferences
 * 
 * IMPORTANT: aiScore is computed ONCE here and passed to frontend.
 * Frontend and detail page MUST reuse this score — never recalculate.
 */
const express    = require('express');
const Restaurant = require('../models/Restaurant');
const Session    = require('../models/Session');
const Feedback   = require('../models/Feedback');
const { protect } = require('../middleware/auth');
const {
  calculateScore,
  applyHardFilters,
  buildFeedbackMap,
} = require('../middleware/recommendEngine');

const router = express.Router();

// ── Detect if user is first-time (no feedback, no selections) ────────────────
async function isNewUser(userId, user) {
  const hasFeedback    = (user.likedRestaurants || []).length > 0 ||
                         (user.dislikedRestaurants || []).length > 0;
  if (hasFeedback) return false;
  const hasSelection   = await Session.findOne({ userId, selectedRestaurant: { $ne: null } });
  return !hasSelection;
}

// ── Load feedback map for a user ─────────────────────────────────────────────
async function getUserFeedbackMap(userId) {
  try {
    return buildFeedbackMap(await Feedback.find({ userId }).lean());
  } catch (_) { return {}; }
}

// ── Load visited restaurant IDs ──────────────────────────────────────────────
async function getVisitedIds(userId) {
  try {
    const ids = await Session.find({ userId, selectedRestaurant: { $ne: null } }).distinct('selectedRestaurant');
    return ids.map(String);
  } catch (_) { return []; }
}

// ── Attach aiScore to each restaurant ────────────────────────────────────────
// This is the ONLY place aiScore is set on a restaurant object.
function attachScores(restaurants, mode, { pref, filters, members, userLocation } = {}) {
  return restaurants.map(r => ({
    ...r.toObject ? r.toObject() : r,
    aiScore: calculateScore(r, { mode, pref, filters, members, userLocation }),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/recommend/personal
// Body: { submode, cuisines, budget, spice, vegPreference, userLat, userLng }
//
// submode values:
//   'regular'            → Returning, Regular Choice
//   'surprise'           → Returning, Try New → Surprise Me
//   'select-preferences' → Returning, Try New → Select Preferences
//   (omitted / 'auto')  → system auto-detects new vs returning
// ─────────────────────────────────────────────────────────────────────────────
router.post('/personal', protect, async (req, res) => {
  try {
    const {
      submode,
      cuisines,
      budget,
      spice,
      vegPreference,
      userLat,
      userLng,
    } = req.body;

    const user         = req.user;
    const userLocation = (userLat && userLng)
      ? { lat: parseFloat(userLat), lng: parseFloat(userLng) }
      : null;

    const feedbackMap = await getUserFeedbackMap(user._id);
    const visitedIds  = await getVisitedIds(user._id);
    const newUser     = await isNewUser(user._id, user);

    // ── Build user preference profile ────────────────────────────────────────
    const pref = {
      preferredCuisines:   user.preferredCuisines    || [],
      budgetPreference:    user.budgetPreference      || 2,
      spicePreference:     user.spicePreference       || 3,
      vegPreference:       user.vegPreference         || 'any',
      likedRestaurants:    user.likedRestaurants      || [],
      dislikedRestaurants: user.dislikedRestaurants   || [],
      feedbackMap,
      visitedIds,
    };

    let restaurants = await Restaurant.find();
    let scored, mode, sessionMode;

    // ════════════════════════════════════════════════════════════════════════
    // PATH A — NEW USER (cold start)
    // ════════════════════════════════════════════════════════════════════════
    if (newUser || submode === 'new-user') {
      // Step 1: Collect filters from request
      const coldFilters = {
        cuisines:      cuisines    || [],
        budget:        budget      || null,
        vegPreference: vegPreference || 'any',
      };

      // Step 2: Apply hard filters
      const filtered = applyHardFilters(restaurants, coldFilters);

      // Step 3 & 4: Score and sort
      scored = attachScores(filtered, 'new-user', { userLocation })
        .sort((a, b) => b.aiScore - a.aiScore);

      mode        = 'new-user';
      sessionMode = 'first-time';
    }

    // ════════════════════════════════════════════════════════════════════════
    // PATH B — RETURNING → SURPRISE ME
    // ════════════════════════════════════════════════════════════════════════
    else if (submode === 'surprise') {
      // Ignore most past preferences — score by diversity + trend + rating
      // Exclude already-visited restaurants
      const pool = restaurants.filter(r => !visitedIds.includes(String(r._id)));

      scored = attachScores(pool.length ? pool : restaurants, 'surprise', { pref })
        .sort((a, b) => b.aiScore - a.aiScore);

      // Return only top 1 for the surprise card
      scored     = [scored[0]].filter(Boolean);
      mode       = 'surprise';
      sessionMode = 'surprise';
    }

    // ════════════════════════════════════════════════════════════════════════
    // PATH C — RETURNING → SELECT PREFERENCES
    // ════════════════════════════════════════════════════════════════════════
    else if (submode === 'select-preferences') {
      const filters = {
        cuisines:      cuisines      || [],
        budget:        budget        || pref.budgetPreference,
        spice:         spice         || pref.spicePreference,
        vegPreference: vegPreference || pref.vegPreference,
      };

      // Step 2: Hard filter
      const filtered = applyHardFilters(restaurants, filters);

      // Step 3 & 4: Score = filterMatch*0.5 + history*0.2 + rating*0.3
      scored = attachScores(filtered, 'select-preferences', { filters, pref, userLocation })
        .sort((a, b) => b.aiScore - a.aiScore);

      mode        = 'select-preferences';
      sessionMode = 'personalized';
    }

    // ════════════════════════════════════════════════════════════════════════
    // PATH D — RETURNING → REGULAR CHOICE (default)
    // ════════════════════════════════════════════════════════════════════════
    else {
      // Regular Choice: ask only budget — rest from stored profile
      const effectivePref = {
        ...pref,
        budgetPreference: budget || pref.budgetPreference,
      };

      // No hard cuisine filter for regular — just scoring
      // Score = prefMatch*0.4 + behavior*0.3 + rating*0.2 + distance*0.1
      scored = attachScores(restaurants, 'regular', { pref: effectivePref, userLocation })
        .sort((a, b) => {
          // Liked restaurants always surface first
          const aLiked = (pref.likedRestaurants || []).map(r => String(r._id||r)).includes(String(a._id)) ? 1 : 0;
          const bLiked = (pref.likedRestaurants || []).map(r => String(r._id||r)).includes(String(b._id)) ? 1 : 0;
          if (bLiked !== aLiked) return bLiked - aLiked;
          return b.aiScore - a.aiScore;
        });

      mode        = 'regular';
      sessionMode = 'personalized';
    }

    // ── Save session ─────────────────────────────────────────────────────────
    const session = await Session.create({
      userId: user._id,
      mode:   sessionMode,
      filters: {
        cuisines: cuisines || pref.preferredCuisines,
        budget:   budget   || pref.budgetPreference,
        spice:    spice    || pref.spicePreference,
        submode:  mode,
      },
      recommendedRestaurants: scored.map(r => r._id).filter(Boolean),
    });

    res.json({
      success: true,
      restaurants: scored,
      session,
      isNewUser: newUser,
      scoringMode: mode,
    });
  } catch (err) {
    console.error('recommend/personal error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/recommend/select ────────────────────────────────────────────────
router.post('/select', protect, async (req, res) => {
  try {
    const { sessionId, restaurantId } = req.body;
    if (!sessionId || !restaurantId)
      return res.status(400).json({ success: false, message: 'sessionId and restaurantId required.' });

    const session = await Session.findOneAndUpdate(
      { _id: sessionId, userId: req.user._id },
      { selectedRestaurant: restaurantId },
      { new: true }
    );
    if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });

    res.json({ success: true, session });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/recommend/history ────────────────────────────────────────────────
router.get('/history', protect, async (req, res) => {
  try {
    const sessions = await Session.find({ userId: req.user._id })
      .populate('selectedRestaurant', 'name address emoji cuisines rating')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/recommend/pending-feedback ──────────────────────────────────────
router.get('/pending-feedback', protect, async (req, res) => {
  try {
    const sessions = await Session.find({
      userId: req.user._id,
      selectedRestaurant: { $ne: null },
      feedbackGiven: false,
    }).populate('selectedRestaurant', 'name address emoji cuisines rating priceLevel spiceLevel menu');

    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;