const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- CONFIGURATION ---
const SITE_BASE_URL = process.env.NODE_ENV === 'production' 
    ? process.env.SITE_URL || 'https://ermiasgelaye.github.io/Photography'
    : 'http://localhost:5500';

console.log('🚀 Starting server...');
console.log('🌐 Frontend URL:', SITE_BASE_URL);
console.log('🔧 Node version:', process.version);
console.log('📦 NODE_ENV:', process.env.NODE_ENV || 'development');

// --- CORS CONFIGURATION ---
const allowedOrigins = [
    'https://ermiasgelaye.github.io',
    'https://ermiasgelaye.github.io/Photography',
    'https://ermiasgelaye.github.io/Photography/', // Add trailing slash
    'https://ermiasgelaye.github.io/Photography/Home.html',
    'http://localhost:5500',
    'http://localhost:3000'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed))) {
            callback(null, true);
        } else {
            console.log('CORS blocked:', origin);
            // For now, allow all in dev
            if (process.env.NODE_ENV !== 'production') {
                callback(null, true);
            } else {
                callback(new Error('CORS not allowed'));
            }
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- MIDDLEWARE ---
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// --- PAYMENT SETUP ---
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
} else {
    console.warn('⚠️ Stripe not configured');
}

let paypalClient = null;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
    try {
        const paypal = require('@paypal/checkout-server-sdk');
        let environment;
        
        if (process.env.PAYPAL_ENVIRONMENT === 'production') {
            environment = new paypal.core.LiveEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
            console.log('✅ PayPal: LIVE mode');
        } else {
            environment = new paypal.core.SandboxEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
            console.log('🟡 PayPal: SANDBOX mode');
        }
        paypalClient = new paypal.core.PayPalHttpClient(environment);
    } catch (error) {
        console.error('PayPal init error:', error);
    }
} else {
    console.warn('⚠️ PayPal not configured');
}

// --- HEALTH CHECK ---
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK',
        service: 'Photo Gallery Backend',
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
        frontend: SITE_BASE_URL
    });
});

// --- STRIPE ENDPOINT ---
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ 
                error: 'Stripe not configured. Check server environment variables.' 
            });
        }
        
        const { imageId, userId } = req.body;
        
        if (!imageId) {
            return res.status(400).json({ error: 'imageId is required' });
        }
        
        const successUrl = `${SITE_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&payment=success`;
        const cancelUrl = `${SITE_BASE_URL}/Home.html?payment=cancelled`;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Unlimited Downloads Access',
                        description: 'One-time payment for unlimited photo downloads',
                    },
                    unit_amount: 999, // $9.99
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                userId: userId || 'anonymous',
                imageId: imageId
            }
        });
        
        console.log('Stripe session created:', session.id);
        res.json({ id: session.id });
        
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- PAYPAL ENDPOINTS ---
app.post('/api/create-paypal-order', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.status(503).json({ error: 'PayPal not configured' });
        }
        
        const { imageId } = req.body;
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCreateRequest();
        
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: '9.99'
                }
            }],
            application_context: {
                return_url: `${SITE_BASE_URL}/success.html`,
                cancel_url: `${SITE_BASE_URL}/Home.html`
            }
        });
        
        const order = await paypalClient.execute(request);
        res.json({ id: order.result.id });
        
    } catch (error) {
        console.error('PayPal create error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/capture-paypal-order', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.status(503).json({ error: 'PayPal not configured' });
        }
        
        const { orderID } = req.body;
        
        if (!orderID) {
            return res.status(400).json({ error: 'orderID is required' });
        }
        
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        
        const capture = await paypalClient.execute(request);
        
        if (capture.result.status === 'COMPLETED') {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Payment not completed' });
        }
        
    } catch (error) {
        console.error('PayPal capture error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- CATCH-ALL FOR VERCEL ---
app.get('*', (req, res) => {
    res.json({
        message: 'Photo Gallery Backend API',
        endpoints: [
            'GET  /api/health',
            'POST /api/create-checkout-session',
            'POST /api/create-paypal-order',
            'POST /api/capture-paypal-order'
        ],
        documentation: 'See GitHub for full API docs'
    });
});

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// --- EXPORT FOR VERCEL ---
module.exports = app;