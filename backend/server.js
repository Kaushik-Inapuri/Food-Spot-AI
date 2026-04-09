require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mongoose = require('mongoose');

const authRoutes       = require('./routes/auth');
const restaurantRoutes = require('./routes/restaurants');
const recommendRoutes  = require('./routes/recommend');
const feedbackRoutes   = require('./routes/feedback');
const groupRoutes      = require('./routes/group');
const locationRoutes   = require('./routes/location');
const nlpRoutes        = require('./routes/nlp');
const groqRoutes       = require('./routes/groq');

const app = express();

// Middleware
app.use(cors({
  origin:      process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());

// Routes
app.use('/api/auth',        authRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/recommend',   recommendRoutes);
app.use('/api/feedback',    feedbackRoutes);
app.use('/api/group',       groupRoutes);
app.use('/api/location',    locationRoutes);
app.use('/api/nlp',         nlpRoutes);
app.use('/api/groq',        groqRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status:  'ok',
    message: 'Food Spot AI API running',
    ai:      process.env.GROQ_API_KEY ? 'Groq connected' : 'Groq key missing',
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => {
      console.log(`Food Spot AI API running on port ${PORT}`);
      if (!process.env.GROQ_API_KEY) {
        console.warn('⚠️  GROQ_API_KEY not set — AI features (NLP search, smart recommendations) will not work.');
        console.warn('   Get a free key at https://console.groq.com');
      } else {
        console.log('✅ Groq AI ready');
      }
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });