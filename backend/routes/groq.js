// routes/groq.js — Groq AI-powered recommendations
// Uses llama-3.3-70b-versatile for smart, context-aware suggestions
// Add to server.js: app.use('/api/groq', require('./routes/groq'));
//
// Add to Render environment variables:
//   GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
//   Get a free key at https://console.groq.com

const express    = require('express');
const Restaurant = require('../models/Restaurant');
const { protect } = require('../middleware/auth');

const router = express.Router();

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── Groq chat helper ────────────────────────────────────────
async function groqChat(systemPrompt, userMessage, maxTokens = 800) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set. Get a free key at https://console.groq.com');

  const resp = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      max_tokens:  maxTokens,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Groq API error (' + resp.status + '): ' + err);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── POST /api/groq/recommend ────────────────────────────────
// AI-powered personal recommendations with natural language reasoning
// Body: { message: "I want something spicy and cheap for dinner" }
router.post('/recommend', protect, async (req, res) => {
  try {
    const { message } = req.body;
    const user = req.user;

    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message is required.' });
    }

    const restaurants = await Restaurant.find();

    const restaurantList = restaurants.map(r => ({
      id:         r._id,
      name:       r.name,
      cuisines:   r.cuisines,
      rating:     r.rating,
      priceLevel: r.priceLevel,
      spiceLevel: r.spiceLevel,
      tags:       r.tags,
      address:    r.address,
      emoji:      r.emoji,
      topItems:   (r.menu || []).flatMap(s => (s.items || []).slice(0, 2).map(i => i.name)).slice(0, 4),
    }));

    const userProfile = {
      preferredCuisines: user.preferredCuisines || [],
      budgetPreference:  user.budgetPreference  || 2,
      spicePreference:   user.spicePreference   || 3,
      likedRestaurants:  (user.likedRestaurants || []).map(r => String(r._id || r)),
    };

    const systemPrompt = `You are a smart restaurant recommendation assistant for Food Spot AI, an app in Vijayawada, India.
You have access to a list of restaurants and a user's preferences.
Based on the user's message and their profile, recommend the top 3 most suitable restaurants.

Return ONLY a valid JSON array with exactly this structure (no explanation, no markdown):
[
  {
    "id": "restaurant_id_here",
    "reason": "One sentence why this matches perfectly",
    "score": 95
  }
]

Rules:
- score is 0-100 based on how well it matches the request
- reason must be specific and mention the actual dish/cuisine/feature
- Only include restaurants from the provided list
- Consider the user's past preferences and liked restaurants
- Return ONLY the JSON array, nothing else`;

    const userMessage = `User profile:
- Preferred cuisines: ${userProfile.preferredCuisines.join(', ') || 'no preference'}
- Budget: ${['', 'budget-friendly (₹)', 'moderate (₹₹)', 'premium (₹₹₹)'][userProfile.budgetPreference]}
- Spice tolerance: ${userProfile.spicePreference}/5

User's request: "${message}"

Available restaurants:
${JSON.stringify(restaurantList, null, 2)}`;

    const aiResponse = await groqChat(systemPrompt, userMessage, 600);

    // Parse AI response
    const clean = aiResponse.replace(/```json|```/g, '').trim();
    const recommendations = JSON.parse(clean);

    // Map back to full restaurant objects
    const enriched = recommendations
      .map(rec => {
        const rest = restaurants.find(r => String(r._id) === String(rec.id));
        if (!rest) return null;
        return {
          ...rest.toObject(),
          matchScore: rec.score,
          aiReason:   rec.reason,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

    res.json({
      success:    true,
      message,
      restaurants: enriched,
      aiPowered:  true,
    });

  } catch (err) {
    console.error('Groq recommend error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/groq/group-recommend ─────────────────────────
// AI picks the single best restaurant for a group based on all members' preferences
// Body: { members: [{ name, preferredCuisines, budgetPreference, spicePreference }] }
router.post('/group-recommend', protect, async (req, res) => {
  try {
    const { members } = req.body;

    if (!members?.length) {
      return res.status(400).json({ success: false, message: 'members array is required.' });
    }

    const restaurants = await Restaurant.find();

    const restaurantList = restaurants.map(r => ({
      id:         r._id,
      name:       r.name,
      cuisines:   r.cuisines,
      rating:     r.rating,
      priceLevel: r.priceLevel,
      spiceLevel: r.spiceLevel,
      tags:       r.tags,
      address:    r.address,
      emoji:      r.emoji,
    }));

    const systemPrompt = `You are a group dining recommendation assistant for Food Spot AI in Vijayawada, India.
Given a group of people with different food preferences, find the best restaurant that satisfies everyone.

Return ONLY a valid JSON array of top 5 restaurants ranked by group compatibility (no explanation, no markdown):
[
  {
    "id": "restaurant_id",
    "groupScore": 88,
    "reason": "Why this works for the whole group",
    "compromise": "What each person might need to compromise on (or 'Perfect for everyone')"
  }
]

Rules:
- groupScore = average satisfaction across all members (0-100)
- Favor restaurants that work for everyone over ones that are perfect for one person
- Consider dietary restrictions (veg members need veg options)
- Return ONLY the JSON array`;

    const userMessage = `Group members:
${members.map((m, i) => `Member ${i+1} (${m.name}):
  - Preferred cuisines: ${(m.preferredCuisines || []).join(', ') || 'no preference'}
  - Budget: ${['', '₹', '₹₹', '₹₹₹'][m.budgetPreference || 2]}
  - Spice tolerance: ${m.spicePreference || 3}/5`).join('\n')}

Available restaurants:
${JSON.stringify(restaurantList, null, 2)}`;

    const aiResponse = await groqChat(systemPrompt, userMessage, 800);
    const clean      = aiResponse.replace(/```json|```/g, '').trim();
    const picks      = JSON.parse(clean);

    const enriched = picks
      .map(rec => {
        const rest = restaurants.find(r => String(r._id) === String(rec.id));
        if (!rest) return null;
        return {
          ...rest.toObject(),
          matchScore:    rec.groupScore,
          aiReason:      rec.reason,
          aiCompromise:  rec.compromise,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchScore - a.matchScore);

    res.json({
      success:     true,
      restaurants: enriched,
      aiPowered:   true,
    });

  } catch (err) {
    console.error('Groq group-recommend error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/groq/chat ─────────────────────────────────────
// General food/restaurant assistant chat
// Body: { message: "What's good for a first date?" }
router.post('/chat', protect, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ success: false, message: 'message is required.' });
    }

    const restaurants = await Restaurant.find().select('name cuisines rating priceLevel spiceLevel tags address emoji');

    const systemPrompt = `You are a friendly and knowledgeable food assistant for Food Spot AI, a restaurant recommender app in Vijayawada, India.
You help users find the perfect restaurant or food based on their mood, occasion, or craving.
You know about these restaurants: ${JSON.stringify(restaurants.map(r => ({ name: r.name, cuisines: r.cuisines, rating: r.rating, emoji: r.emoji })))}.
Keep responses concise (2-3 sentences max), friendly, and always end with a specific restaurant suggestion from the list if relevant.`;

    const reply = await groqChat(systemPrompt, message, 300);

    res.json({ success: true, reply });

  } catch (err) {
    console.error('Groq chat error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
