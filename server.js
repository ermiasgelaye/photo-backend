// Minimal server.js for Vercel
const express = require('express');
const cors = require('cors');

const app = express();

// Enable CORS
app.use(cors({
  origin: ['https://ermiasgelaye.github.io'],
  credentials: true
}));

app.use(express.json());

// Test endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is working!',
    timestamp: new Date().toISOString()
  });
});

// Test endpoint for Vercel
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Vercel deployment successful!',
    url: 'https://ermiasgelaye-github-io.vercel.app'
  });
});

// Catch-all for Vercel
app.get('*', (req, res) => {
  res.json({ 
    message: 'Photo Gallery Backend API',
    endpoints: [
      'GET /api/health',
      'GET /api/test'
    ],
    note: 'Add your payment endpoints here'
  });
});

// Vercel requires this export
module.exports = app;