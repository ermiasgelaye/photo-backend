const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SITE_BASE_URL = process.env.SITE_URL || 'https://photo-backend-ten.vercel.app'; 

console.log('🚀 Starting server...');
console.log('🌐 Target Frontend URL:', SITE_BASE_URL);

// --- CORS CONFIGURATION ---
const allowedOrigins = [
    'https://ermiasgelaye.github.io',
    'https://ermiasgelaye.github.io/Photography',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3000',
    'https://ermiasgelaye.github.io/Photography/Home.html',
    'https://photo-backend-ten.vercel.app/'
    
    
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
            callback(null, true);
        } else {
            console.log('Blocked by CORS:', origin);
            callback(null, true); // Temporarily allow all
        }
    },
    credentials: true
}));

app.use(express.json());

// --- PAYMENT CONFIG ---
const PRICE_AMOUNT_CENTS = 3000; // $30.00
const PRICE_AMOUNT_STRING = '30.00';

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
        
        // Determine environment based on client ID
        let environment;
        if (process.env.PAYPAL_CLIENT_ID.startsWith('A')) {
            // Live environment - production client IDs start with 'A'
            console.log('🟢 Using PayPal LIVE environment');
            environment = new paypal.core.LiveEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
        } else {
            // Sandbox environment
            console.log('🟡 Using PayPal SANDBOX environment');
            environment = new paypal.core.SandboxEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
        }
        
        paypalClient = new paypal.core.PayPalHttpClient(environment);
        console.log('✅ PayPal client initialized successfully');
    } catch (e) {
        console.error('❌ PayPal init failed:', e.message);
    }
}

// --- ROUTES ---

app.get('/', (req, res) => {
    res.send('Photography Backend API is Running. Use /api/health to check status.');
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date(),
        services: {
            stripe: !!stripe,
            paypal: !!paypalClient,
            price: `$${PRICE_AMOUNT_STRING}`
        }
    });
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
                    unit_amount: PRICE_AMOUNT_CENTS,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${SITE_BASE_URL}/index.html?payment=success`,
            cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled`,
        });

        res.json({ id: session.id });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- PAYPAL ORDER CREATE ---
app.post('/api/create-paypal-order', async (req, res) => {
    console.log('📝 Creating PayPal order...');
    
    if (!paypalClient) {
        console.error('PayPal client not configured');
        return res.status(500).json({ error: 'PayPal not configured on server' });
    }

    try {
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: PRICE_AMOUNT_STRING
                },
                description: 'Unlimited Gallery Access'
            }],
            application_context: {
                brand_name: 'ARC-NATURE PHOTOGRAPHY',
                landing_page: 'BILLING',
                user_action: 'PAY_NOW',
                return_url: `${SITE_BASE_URL}/index.html?payment=success&method=paypal`,
                cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled&method=paypal`
            }
        });

        console.log('Sending PayPal order request...');
        const order = await paypalClient.execute(request);
        console.log('✅ PayPal order created:', order.result.id);
        
        // Return the order ID
        res.json({ 
            success: true,
            id: order.result.id,
            status: order.result.status 
        });
        
    } catch (error) {
        console.error('❌ PayPal order creation failed:', error);
        
        // Log detailed error
        if (error.statusCode) {
            console.error('Status:', error.statusCode);
            console.error('Headers:', error.headers);
            if (error.message) {
                console.error('Message:', error.message);
            }
        }
        
        res.status(500).json({ 
            error: 'Failed to create PayPal order',
            details: error.message || 'Unknown error'
        });
    }
});

// --- PAYPAL ORDER CAPTURE ---
app.post('/api/capture-paypal-order', async (req, res) => {
    console.log('💰 Capturing PayPal order...');
    
    if (!paypalClient) {
        return res.status(500).json({ error: 'PayPal not configured' });
    }

    try {
        const { orderID } = req.body;
        
        if (!orderID) {
            return res.status(400).json({ error: 'Missing orderID' });
        }

        console.log('Capturing order:', orderID);
        
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});

        const capture = await paypalClient.execute(request);
        console.log('✅ PayPal order captured:', capture.result.id);
        console.log('Status:', capture.result.status);
        
        // Return success with capture details
        res.json({ 
            success: true,
            capture: capture.result,
            message: 'Payment successful!'
        });
        
    } catch (error) {
        console.error('❌ PayPal capture failed:', error);
        
        // Log PayPal API error details
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Headers:', error.headers);
            console.error('Details:', error.message);
        }
        
        res.status(500).json({ 
            error: 'Failed to capture PayPal payment',
            details: error.message || 'Unknown error'
        });
    }
});

// --- TEST PAYPAL ENDPOINT ---
app.get('/api/test-paypal', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.json({ 
                configured: false,
                message: 'PayPal not configured. Check PAYPAL_CLIENT_ID and PAYPAL_SECRET env vars.'
            });
        }
        
        // Try to get a token to test connection
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCreateRequest();
        
        return res.json({
            configured: true,
            clientId: process.env.PAYPAL_CLIENT_ID ? 'Set' : 'Missing',
            secret: process.env.PAYPAL_SECRET ? 'Set' : 'Missing',
            environment: process.env.PAYPAL_CLIENT_ID?.startsWith('A') ? 'Live' : 'Sandbox',
            message: 'PayPal SDK is configured'
        });
        
    } catch (error) {
        res.json({
            configured: false,
            error: error.message
        });
    }
});

// Start server (for local dev)
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

// Export for Vercel
module.exports = app;