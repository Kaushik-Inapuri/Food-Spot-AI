// routes/recommend.js — SPEC-COMPLETE v2
// New spec implementations:
//   1. Cold-start path: detected via isFirstTimeUser(), returns top-rated filtered by veg pref
//   2. Regular Choice: returning users only see budget selector (cuisine+spice already known)
//   3. Veg/Non-Veg filter applied in scoring
//   4. Distance factored into score when userLocation provided
//   5. Community score (avg feedback) still applied

const express    = require('express');
const Restaurant = require('../models/Restaurant');
const Session    = require('../models/Session');
const Feedback   = require('../models/Feedback');
const { protect } = require('../middleware/auth');
const {
  scoreRestaurant,
  scoreForGroup,
  aggregatePreferences,
  aiRankRestaurants,
  isFirstTimeUser,
} = require('../middleware/recommendEngine');

const router = express.Router();

// ── Attach community scores ────────────────────────────────
async function attachCommunityScores(restaurants) {
  const ids = restaurants.map(r => r._id);
  const feedbacks = await Feedback.find({ restaurantId: { $in: ids } });
  const totals = {}, counts = {};
  feedbacks.forEach(fb => {
    const id = String(fb.restaurantId);
    totals[id] = (totals[id] || 0) + fb.rating;
    counts[id] = (counts[id] || 0) + 1;
  });
  return restaurants.map(r => {
    const id = String(r._id || r.id);
    const communityScore = counts[id] ? +(totals[id] / counts[id]).toFixed(1) : null;
    return { ...r.toObject ? r.toObject() : r, communityScore, feedbackCount: counts[id] || 0 };
  });
}

// ═══════════════════════════════════════════════════════════
// POST /api/recommend/personal
// Body: {
//   cuisines[], budget, spice, vegPreference, submode,
//   userLat, userLng        ← NEW: for distance scoring
// }
// Returns extra flag: { isColdStart } so frontend knows which UI to show
// ═══════════════════════════════════════════════════════════
router.post('/personal', protect, async (req, res) => {
  try {
    const { cuisines, budget, spice, vegPreference, submode = 'regular', userLat, userLng } = req.body;
    const user = req.user;

    const userLocation = (userLat && userLng) ? { lat: parseFloat(userLat), lng: parseFloat(userLng) } : null;

    // ── Cold-start detection ──────────────────────────────
    const coldStart = isFirstTimeUser(user);

    const pref = {
      preferredCuisines: cuisines?.length ? cuisines : user.preferredCuisines,
      budgetPreference:  budget         || user.budgetPreference,
      spicePreference:   spice          || user.spicePreference,
      // Spec: veg preference is first-class — use request param or user's saved pref
      vegPreference:     vegPreference  || user.vegPreference || 'any',
    };

    let restaurants = await Restaurant.find();
    const dislikedIds = (user.dislikedRestaurants || []).map(String);

    if (submode === 'new') {
      const visitedIds = (await Session.find({ userId: user._id, selectedRestaurant: { $ne: null } })
        .distinct('selectedRestaurant')).map(String);
      restaurants = restaurants.filter(r => !visitedIds.includes(String(r._id)));
    }

    if (submode === 'surprise') {
      const pool   = restaurants.filter(r => r.rating >= 4.0 && !dislikedIds.includes(String(r._id)));
      const source = pool.length ? pool : restaurants;
      const picked = source[Math.floor(Math.random() * source.length)];
      if (!picked) return res.json({ success: true, restaurants: [], session: null, isColdStart: coldStart });
      const [withScore] = await attachCommunityScores([picked]);
      const session = await Session.create({
        userId: user._id, mode: 'surprise',
        filters: { cuisines: pref.preferredCuisines, budget: pref.budgetPreference, spice: pref.spicePreference, submode },
        recommendedRestaurants: [picked._id],
      });
      return res.json({
        success: true,
        restaurants: [{ ...withScore, matchScore: scoreRestaurant(picked, pref, userLocation) }],
        session, isColdStart: coldStart, aiUsed: false,
      });
    }

    // ── Attach community scores ───────────────────────────
    const withCommunity = await attachCommunityScores(restaurants);

    // ── Score all restaurants ─────────────────────────────
    let scored = withCommunity
      .filter(r => !dislikedIds.includes(String(r._id)))
      .map(r => ({ ...r, matchScore: scoreRestaurant(r, pref, userLocation) }));

    // ── Cold-start: skip AI, just sort by community rating ─
    if (coldStart) {
      scored.sort((a, b) => {
        // Veg hard filter first
        if (pref.vegPreference === 'veg') {
          const aTags = (a.tags || []).map(t => t.toLowerCase());
          const bTags = (b.tags || []).map(t => t.toLowerCase());
          const aVeg  = aTags.includes('veg');
          const bVeg  = bTags.includes('veg');
          if (aVeg && !bVeg) return -1;
          if (!aVeg && bVeg) return 1;
        }
        // Then community score, then raw rating
        return (b.communityScore || b.rating) - (a.communityScore || a.rating);
      });
    } else {
      // ── Returning user: filter-first then community score ─
      scored.sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return (b.communityScore || b.rating) - (a.communityScore || a.rating);
      });

      // ── AI re-ranking for returning users ─────────────────
      const userFeedbacks = await Feedback.find({ userId: user._id })
        .populate('restaurantId', 'name cuisines priceLevel spiceLevel')
        .sort({ createdAt: -1 }).limit(20);

      const userContext = {
        preferredCuisines:    pref.preferredCuisines,
        budgetPreference:     pref.budgetPreference,
        spicePreference:      pref.spicePreference,
        vegPreference:        pref.vegPreference,
        userLocation,
        likedRestaurantIds:   (user.likedRestaurants || []).map(String),
        dislikedRestaurantIds: dislikedIds,
        recentFeedback: userFeedbacks.map(fb => ({
          restaurant: fb.restaurantId?.name,
          cuisines:   fb.restaurantId?.cuisines,
          rating:     fb.rating,
          liked:      fb.liked,
        })).filter(f => f.restaurant),
      };

      const aiRanked = await aiRankRestaurants(scored, userContext, false);
      if (aiRanked) scored = aiRanked;
    }

    const session = await Session.create({
      userId: user._id, mode: coldStart ? 'first-time' : 'personalized',
      filters: { cuisines: pref.preferredCuisines, budget: pref.budgetPreference, spice: pref.spicePreference, submode },
      recommendedRestaurants: scored.map(r => r._id),
    });

    res.json({ success: true, restaurants: scored, session, isColdStart: coldStart, aiUsed: !coldStart });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/recommend/select ────────────────────────────
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

// ── GET /api/recommend/history ────────────────────────────
router.get('/history', protect, async (req, res) => {
  try {
    const sessions = await Session.find({ userId: req.user._id })
      .populate('selectedRestaurant', 'name address emoji cuisines rating priceLevel')
      .sort({ createdAt: -1 }).limit(30);
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/recommend/pending-feedback ───────────────────
router.get('/pending-feedback', protect, async (req, res) => {
  try {
    const sessions = await Session.find({
      userId: req.user._id, selectedRestaurant: { $ne: null }, feedbackGiven: false,
    }).populate('selectedRestaurant', 'name address emoji cuisines rating priceLevel spiceLevel menu');
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/recommend/group ─────────────────────────────
router.post('/group', protect, async (req, res) => {
  try {
    const { code } = req.body;
    const GroupRoom = require('../models/GroupRoom');
    const room = await GroupRoom.findOne({ code: code.toUpperCase(), active: true });
    if (!room) return res.status(404).json({ success: false, message: 'Room not found or expired.' });

    const members = room.members.map(m => ({
      preferredCuisines: m.preferredCuisines,
      budgetPreference:  m.budgetPreference,
      spicePreference:   m.spicePreference,
      vegPreference:     m.vegPreference || 'any',
    }));

    const restaurants    = await Restaurant.find();
    const withCommunity  = await attachCommunityScores(restaurants);
    const aggPref        = aggregatePreferences(members);

    let scored = withCommunity.map(r => {
      const { avg, scores } = scoreForGroup(r, members);
      return { ...r, matchScore: avg, memberScores: scores };
    }).sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return (b.communityScore || b.rating) - (a.communityScore || a.rating);
    });

    const groupContext = {
      members: room.members.map(m => ({
        name:              m.name,
        preferredCuisines: m.preferredCuisines,
        budgetPreference:  m.budgetPreference,
        spicePreference:   m.spicePreference,
        vegPreference:     m.vegPreference || 'any',
      })),
      aggregated: aggPref,
    };

    let aiUsed = false;
    const aiRanked = await aiRankRestaurants(scored, groupContext, true);
    if (aiRanked) { scored = aiRanked; aiUsed = true; }

    await Promise.all(room.members.map(m =>
      Session.create({
        userId: m.userId, mode: 'group',
        groupRoomCode: room.code, groupMembers: room.members.map(x => x.userId),
        filters: { cuisines: aggPref.preferredCuisines, budget: aggPref.budgetPreference, spice: aggPref.spicePreference },
        recommendedRestaurants: scored.map(r => r._id),
      })
    ));

    res.json({ success: true, restaurants: scored, room, aiUsed });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
