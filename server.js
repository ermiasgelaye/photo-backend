const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// --- 1. CONFIGURATION ---
// For Vercel deployment
const SITE_BASE_URL = process.env.NODE_ENV === 'production' 
    ? process.env.SITE_URL || 'https://ermiasgelaye.github.io/Photography'
    : 'http://localhost:5500';

console.log('🌐 SITE_BASE_URL:', SITE_BASE_URL);
console.log('🔧 Environment:', process.env.NODE_ENV || 'development');

// --- 2. CORS CONFIGURATION ---
const allowedOrigins = [
    'https://ermiasgelaye.github.io',
    'https://ermiasgelaye.github.io/Photography',
    'https://ermiasgelaye.github.io/Photography/',
    'http://localhost:5500',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // Check if origin is allowed
        const isAllowed = allowedOrigins.some(allowedOrigin => 
            origin === allowedOrigin || origin.startsWith(allowedOrigin)
        );
        
        if (isAllowed) {
            callback(null, true);
        } else {
            console.log('⚠️ CORS blocked origin:', origin);
            // For development, you might want to allow all
            // In production, be more restrictive
            if (process.env.NODE_ENV !== 'production') {
                callback(null, true); // Allow in dev
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Handle preflight requests
app.options('*', cors());

// --- 3. MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    console.log('Origin:', req.headers.origin);
    console.log('Body:', req.body);
    next();
});

// --- 4. PAYMENT PROVIDER SETUP ---
// Initialize Stripe
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
} else {
    console.error('❌ STRIPE_SECRET_KEY not found');
    stripe = null;
}

// Initialize PayPal
let paypalClient = null;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
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
} else {
    console.warn('⚠️ PayPal credentials not configured');
}

// --- 5. HEALTH & TEST ENDPOINTS ---
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        environment: process.env.NODE_ENV || 'development',
        backend: 'Vercel',
        frontend: SITE_BASE_URL,
        timestamp: new Date().toISOString(),
        services: {
            stripe: !!stripe,
            paypal: !!paypalClient
        }
    });
});

app.get('/api/test', (req, res) => {
    res.json({ 
        message: 'Server is working!',
        baseUrl: SITE_BASE_URL,
        backendUrl: 'https://ermiasgelaye-github-io.vercel.app',
        test: 'Try /api/create-checkout-session or /api/create-paypal-order'
    });
});

// Simple test for CORS
app.post('/api/test-post', (req, res) => {
    res.json({ 
        success: true,
        message: 'POST request successful',
        data: req.body,
        timestamp: new Date().toISOString()
    });
});

// --- 6. STRIPE CHECKOUT ---
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({ 
                error: 'Stripe not configured. Check server logs.' 
            });
        }
        
        const { imageId, userId } = req.body;
        
        // Validate required fields
        if (!imageId) {
            return res.status(400).json({ 
                error: 'Missing required field: imageId' 
            });
        }
        
        // Define redirect URLs
        const successUrl = `${SITE_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&payment=success&imageId=${encodeURIComponent(imageId)}`;
        const cancelUrl = `${SITE_BASE_URL}/Home.html?payment=cancelled`;

        console.log('Creating Stripe session for image:', imageId);
        console.log('Success URL:', successUrl);
        console.log('Cancel URL:', cancelUrl);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Unlimited Downloads Access',
                        description: 'One-time payment for unlimited photo downloads',
                        images: imageId ? [imageId] : []
                    },
                    unit_amount: 999, // $9.99 USD
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                userId: userId || 'anonymous',
                imageId: imageId,
                timestamp: new Date().toISOString()
            }
        });

        console.log('✅ Stripe session created:', session.id);
        
        res.json({ 
            success: true,
            id: session.id,
            url: session.url
        });
        
    } catch (error) {
        console.error('❌ Stripe Error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message,
            code: error.code || 'stripe_error'
        });
    }
});

// --- 7. PAYPAL CREATE ORDER ---
app.post('/api/create-paypal-order', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.status(503).json({ 
                success: false,
                error: 'PayPal service is not configured' 
            });
        }
        
        const { imageId } = req.body;
        
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: '9.99'
                },
                description: 'Unlimited Downloads Access - Photography Gallery',
                custom_id: imageId || 'unknown'
            }],
            application_context: {
                brand_name: 'ARC Nature Photography',
                landing_page: 'BILLING',
                user_action: 'PAY_NOW',
                return_url: `${SITE_BASE_URL}/success.html?payment=paypal&imageId=${encodeURIComponent(imageId || '')}`,
                cancel_url: `${SITE_BASE_URL}/Home.html?payment=cancelled`
            }
        });

        console.log('Creating PayPal order...');
        const order = await paypalClient.execute(request);
        console.log('✅ PayPal order created:', order.result.id);
        
        res.json({ 
            success: true,
            id: order.result.id,
            status: order.result.status 
        });
        
    } catch (error) {
        console.error('❌ PayPal Create Error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message,
            details: error.details || 'Unknown PayPal error'
        });
    }
});

// --- 8. PAYPAL CAPTURE ORDER ---
app.post('/api/capture-paypal-order', async (req, res) => {
    try {
        if (!paypalClient) {
            return res.status(503).json({ 
                success: false,
                error: 'PayPal service is not configured' 
            });
        }
        
        const { orderID } = req.body;
        
        if (!orderID) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing orderID' 
            });
        }

        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});

        console.log('Capturing PayPal order:', orderID);
        const capture = await paypalClient.execute(request);
        
        console.log('PayPal capture status:', capture.result.status);
        
        // Check for success status
        if (capture.result.status === 'COMPLETED' || capture.result.status === 'APPROVED') {
            res.json({ 
                success: true, 
                transactionId: capture.result.id,
                status: capture.result.status,
                message: 'Payment successful! Downloads unlocked.'
            });
        } else {
            res.status(500).json({ 
                success: false, 
                status: capture.result.status,
                details: 'Payment not completed'
            });
        }
    } catch (error) {
        console.error('❌ PayPal Capture Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// --- 9. PAYMENT VERIFICATION ---
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { paymentMethod, paymentId } = req.body;
        
        if (!paymentMethod || !paymentId) {
            return res.status(400).json({ 
                verified: false,
                error: 'Missing payment method or payment ID' 
            });
        }
        
        let verified = false;
        let details = {};
        
        if (paymentMethod === 'stripe' && stripe) {
            const session = await stripe.checkout.sessions.retrieve(paymentId);
            verified = session.payment_status === 'paid';
            details = {
                payment_status: session.payment_status,
                amount_total: session.amount_total,
                currency: session.currency,
                customer_email: session.customer_email
            };
        } else if (paymentMethod === 'paypal' && paypalClient) {
            // For PayPal, we assume if capture succeeded, payment is verified
            verified = true;
            details = { message: 'PayPal payment verified' };
        }
        
        res.json({ 
            verified,
            paymentId,
            paymentMethod,
            details
        });
        
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ 
            verified: false,
            error: error.message 
        });
    }
});

// --- 10. SUCCESS & CANCEL PAGES ---
app.get('/success', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Successful</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                h1 { color: #28a745; }
                .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎉 Payment Successful!</h1>
                <p>Thank you for your purchase. Your downloads have been unlocked.</p>
                <p>You can now close this window and return to the gallery.</p>
                <a href="${SITE_BASE_URL}/Home.html" class="btn">Return to Gallery</a>
            </div>
        </body>
        </html>
    `);
});

app.get('/cancel', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Payment Cancelled</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
                .container { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
                h1 { color: #dc3545; }
                .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>⚠️ Payment Cancelled</h1>
                <p>Your payment was cancelled. No charges were made.</p>
                <a href="${SITE_BASE_URL}/Home.html" class="btn">Return to Gallery</a>
            </div>
        </body>
        </html>
    `);
});

// --- 11. CATCH-ALL FOR VERCEL ---
// Vercel needs a default export for serverless functions
if (process.env.NODE_ENV === 'production') {
    // For Vercel serverless
    module.exports = app;
} else {
    // For local development
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Local server running on port ${PORT}`);
        console.log(`📡 API Base: http://localhost:${PORT}`);
        console.log(`🌍 Frontend: ${SITE_BASE_URL}`);
        console.log(`📋 Test endpoints:`);
        console.log(`   GET  http://localhost:${PORT}/api/health`);
        console.log(`   GET  http://localhost:${PORT}/api/test`);
        console.log(`   POST http://localhost:${PORT}/api/test-post`);
    });
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        success: false,
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET /api/health',
            'GET /api/test',
            'POST /api/test-post',
            'POST /api/create-checkout-session',
            'POST /api/create-paypal-order',
            'POST /api/capture-paypal-order',
            'POST /api/verify-payment'
        ]
    });
});