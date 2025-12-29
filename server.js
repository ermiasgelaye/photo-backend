const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- CONFIGURATION ---
// If hosting on Vercel, this is handled automatically, but we set defaults
const PORT = process.env.PORT || 3000;
const SITE_BASE_URL = process.env.SITE_URL || 'https://ermiasgelaye.github.io/Photography'; 

console.log('🚀 Starting server...');
console.log('🌐 Target Frontend URL:', SITE_BASE_URL);

// --- CORS CONFIGURATION ---
// We allow your GitHub pages and local testing
const allowedOrigins = [
    'https://ermiasgelaye.github.io',
    'https://ermiasgelaye.github.io/Photography',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3000'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Check if origin matches allowed list
        if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
            callback(null, true);
        } else {
            console.log('Blocked by CORS:', origin);
            // In production, you might want to block this. For now, we log it.
            // callback(new Error('Not allowed by CORS')); 
            callback(null, true); // Temporarily allow all to prevent frontend errors during dev
        }
    },
    credentials: true
}));

app.use(express.json());

// --- PAYMENT CONFIG ---
const PRICE_AMOUNT_CENTS = 500; // $5.00
const PRICE_AMOUNT_STRING = '5.00';

// --- STRIPE SETUP ---
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
}

// --- PAYPAL SETUP ---
let paypalClient = null;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
    try {
        const paypal = require('@paypal/checkout-server-sdk');
        let environment = new paypal.core.SandboxEnvironment(
            process.env.PAYPAL_CLIENT_ID,
            process.env.PAYPAL_SECRET
        );
        // Uncomment for production:
        // if (process.env.NODE_ENV === 'production') {
        //    environment = new paypal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_SECRET);
        // }
        paypalClient = new paypal.core.PayPalHttpClient(environment);
        console.log('✅ PayPal initialized');
    } catch (e) {
        console.error('PayPal init failed', e);
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    res.send('Photography Backend API is Running. Use /api/health to check status.');
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date() });
});

// --- STRIPE CHECKOUT ---
app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Unlimited Gallery Access',
                        description: 'High-resolution downloads for all photos',
                    },
                    unit_amount: PRICE_AMOUNT_CENTS, // $5.00
                },
                quantity: 1,
            }],
            mode: 'payment',
            // IMPORTANT: Redirect back to index.html with query param
            success_url: `${SITE_BASE_URL}/index.html?payment=success`,
            cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled`,
        });

        res.json({ id: session.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- PAYPAL ORDER CREATE ---
app.post('/api/create-paypal-order', async (req, res) => {
    if (!paypalClient) return res.status(500).json({ error: 'PayPal not configured' });

    try {
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: PRICE_AMOUNT_STRING // '5.00'
                }
            }],
            application_context: {
                // Redirect back to main page
                return_url: `${SITE_BASE_URL}/index.html?payment=success`,
                cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled`
            }
        });

        const order = await paypalClient.execute(request);
        res.json({ id: order.result.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// --- PAYPAL ORDER CAPTURE ---
app.post('/api/capture-paypal-order', async (req, res) => {
    if (!paypalClient) return res.status(500).json({ error: 'PayPal not configured' });

    try {
        const { orderID } = req.body;
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});

        const capture = await paypalClient.execute(request);
        res.json({ capture: capture.result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start server (for local dev)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export for Vercel
module.exports = app;