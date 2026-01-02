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

// --- DOWNLOAD TRACKING SETUP ---
// In-memory store (use a database like MongoDB or PostgreSQL in production)
let downloadTracker = new Map();
let ipTracker = new Map();

// Clean up old entries daily
setInterval(() => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    // Clean download tracker
    for (const [key, data] of downloadTracker.entries()) {
        if (now - data.lastCheck > (30 * oneDay)) { // 30 days
            downloadTracker.delete(key);
        }
    }
    
    // Clean IP tracker
    for (const [key, data] of ipTracker.entries()) {
        if (now - data.lastCheck > (7 * oneDay)) { // 7 days
            ipTracker.delete(key);
        }
    }
}, 24 * 60 * 60 * 1000);

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
            price: `$${PRICE_AMOUNT_STRING}`,
            downloadTracking: true
        }
    });
});

// --- STRIPE CHECKOUT ---
app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    try {
        const { userId } = req.body;
        
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
            success_url: `${SITE_BASE_URL}/index.html?payment=success&userId=${userId}`,
            cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled`,
            metadata: {
                userId: userId || 'unknown'
            }
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
        
        res.json({ 
            success: true,
            id: order.result.id,
            status: order.result.status 
        });
        
    } catch (error) {
        console.error('❌ PayPal order creation failed:', error);
        
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
        
        res.json({ 
            success: true,
            capture: capture.result,
            message: 'Payment successful!'
        });
        
    } catch (error) {
        console.error('❌ PayPal capture failed:', error);
        
        res.status(500).json({ 
            error: 'Failed to capture PayPal payment',
            details: error.message || 'Unknown error'
        });
    }
});

// --- DOWNLOAD TRACKING API ---

// 1. Check if user can download
app.post('/api/check-download-allowance', (req, res) => {
    try {
        const { userId, userFingerprint, machineId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user identification' });
        }
        
        const currentYear = new Date().getFullYear();
        const ip = req.ip;
        
        // Create keys for different tracking methods
        const userKey = `${userId}_${currentYear}`;
        const machineKey = machineId ? `machine_${machineId}_${currentYear}` : null;
        const ipKey = `ip_${ip}_${currentYear}`;
        
        let downloadsUsed = 0;
        let unlimitedAccess = false;
        
        // Check user tracking
        let userData = downloadTracker.get(userKey);
        if (userData) {
            downloadsUsed = Math.max(downloadsUsed, userData.downloadsUsed);
            unlimitedAccess = userData.unlimitedAccess || false;
        }
        
        // Check machine tracking
        if (machineKey) {
            const machineData = downloadTracker.get(machineKey);
            if (machineData) {
                downloadsUsed = Math.max(downloadsUsed, machineData.downloadsUsed);
                unlimitedAccess = unlimitedAccess || machineData.unlimitedAccess || false;
            }
        }
        
        // Check IP tracking
        const ipData = ipTracker.get(ipKey);
        if (ipData) {
            downloadsUsed = Math.max(downloadsUsed, ipData.downloadsUsed);
        }
        
        if (unlimitedAccess) {
            return res.json({
                canDownload: true,
                remainingDownloads: 'unlimited',
                unlimitedAccess: true,
                downloadsUsed: downloadsUsed
            });
        }
        
        // Check download limit
        if (downloadsUsed >= 3) {
            return res.json({
                canDownload: false,
                remainingDownloads: 0,
                downloadsUsed: downloadsUsed,
                message: 'You have used all free downloads for this year'
            });
        }
        
        res.json({
            canDownload: true,
            remainingDownloads: 3 - downloadsUsed,
            unlimitedAccess: false,
            downloadsUsed: downloadsUsed
        });
        
    } catch (error) {
        console.error('Download check error:', error);
        res.status(500).json({ error: 'Failed to check download allowance' });
    }
});

// 2. Register a download
app.post('/api/register-download', (req, res) => {
    try {
        const { userId, userFingerprint, machineId, imageId, imageTitle } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user identification' });
        }
        
        const currentYear = new Date().getFullYear();
        const ip = req.ip;
        
        // Create keys
        const userKey = `${userId}_${currentYear}`;
        const machineKey = machineId ? `machine_${machineId}_${currentYear}` : null;
        const ipKey = `ip_${ip}_${currentYear}`;
        
        // Get existing data
        let userData = downloadTracker.get(userKey);
        let machineData = machineKey ? downloadTracker.get(machineKey) : null;
        let ipData = ipTracker.get(ipKey);
        
        // Calculate current downloads used
        let downloadsUsed = 0;
        if (userData) downloadsUsed = Math.max(downloadsUsed, userData.downloadsUsed);
        if (machineData) downloadsUsed = Math.max(downloadsUsed, machineData.downloadsUsed);
        if (ipData) downloadsUsed = Math.max(downloadsUsed, ipData.downloadsUsed);
        
        // Check for unlimited access
        let unlimitedAccess = false;
        if (userData && userData.unlimitedAccess) unlimitedAccess = true;
        if (machineData && machineData.unlimitedAccess) unlimitedAccess = true;
        
        if (unlimitedAccess) {
            // Log download but don't count against limit
            if (!userData) {
                userData = {
                    userId,
                    userFingerprint,
                    machineId,
                    downloadsUsed: 0,
                    unlimitedAccess: true,
                    unlimitedActivated: Date.now(),
                    downloadHistory: [],
                    firstDownload: Date.now(),
                    lastDownload: Date.now(),
                    lastCheck: Date.now()
                };
            }
            
            userData.downloadHistory.push({
                imageId,
                imageTitle,
                timestamp: Date.now(),
                ip: ip
            });
            userData.lastDownload = Date.now();
            downloadTracker.set(userKey, userData);
            
            return res.json({
                success: true,
                remainingDownloads: 'unlimited',
                unlimitedAccess: true,
                downloadsUsed: downloadsUsed
            });
        }
        
        // Check if already downloaded 3 times
        if (downloadsUsed >= 3) {
            return res.status(403).json({
                success: false,
                message: 'Download limit reached for this device. Please purchase unlimited access.',
                remainingDownloads: 0,
                downloadsUsed: downloadsUsed
            });
        }
        
        // Register download for user
        if (!userData) {
            userData = {
                userId,
                userFingerprint,
                machineId,
                downloadsUsed: downloadsUsed + 1,
                unlimitedAccess: false,
                downloadHistory: [{
                    imageId,
                    imageTitle,
                    timestamp: Date.now(),
                    ip: ip
                }],
                firstDownload: Date.now(),
                lastDownload: Date.now(),
                lastCheck: Date.now()
            };
        } else {
            userData.downloadsUsed = downloadsUsed + 1;
            userData.downloadHistory.push({
                imageId,
                imageTitle,
                timestamp: Date.now(),
                ip: ip
            });
            userData.lastDownload = Date.now();
            userData.lastCheck = Date.now();
        }
        
        // Register download for machine
        if (machineKey) {
            if (!machineData) {
                machineData = {
                    machineId,
                    downloadsUsed: downloadsUsed + 1,
                    userIds: [userId],
                    firstDownload: Date.now(),
                    lastDownload: Date.now(),
                    lastCheck: Date.now()
                };
            } else {
                machineData.downloadsUsed = downloadsUsed + 1;
                machineData.lastDownload = Date.now();
                machineData.lastCheck = Date.now();
                if (!machineData.userIds.includes(userId)) {
                    machineData.userIds.push(userId);
                }
            }
            downloadTracker.set(machineKey, machineData);
        }
        
        // Register download for IP
        if (!ipData) {
            ipData = {
                ip,
                downloadsUsed: downloadsUsed + 1,
                userIds: [userId],
                firstDownload: Date.now(),
                lastDownload: Date.now(),
                lastCheck: Date.now()
            };
        } else {
            ipData.downloadsUsed = downloadsUsed + 1;
            ipData.lastDownload = Date.now();
            ipData.lastCheck = Date.now();
            if (!ipData.userIds.includes(userId)) {
                ipData.userIds.push(userId);
            }
        }
        
        downloadTracker.set(userKey, userData);
        ipTracker.set(ipKey, ipData);
        
        const remainingDownloads = 3 - (downloadsUsed + 1);
        
        res.json({
            success: true,
            remainingDownloads: remainingDownloads,
            downloadsUsed: downloadsUsed + 1,
            message: remainingDownloads === 0 ? 'No downloads remaining!' : 
                    remainingDownloads === 1 ? 'Only 1 download remaining!' : null
        });
        
    } catch (error) {
        console.error('Register download error:', error);
        res.status(500).json({ error: 'Failed to register download' });
    }
});

// 3. Activate unlimited access (called after successful payment)
app.post('/api/activate-unlimited', (req, res) => {
    try {
        const { userId, paymentId, paymentMethod, machineId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }
        
        const currentYear = new Date().getFullYear();
        const userKey = `${userId}_${currentYear}`;
        const machineKey = machineId ? `machine_${machineId}_${currentYear}` : null;
        
        let userData = downloadTracker.get(userKey);
        
        if (!userData) {
            userData = {
                userId,
                downloadsUsed: 0,
                unlimitedAccess: true,
                unlimitedActivated: Date.now(),
                paymentId,
                paymentMethod,
                downloadHistory: [],
                firstDownload: Date.now(),
                lastDownload: null,
                lastCheck: Date.now()
            };
        } else {
            userData.unlimitedAccess = true;
            userData.unlimitedActivated = Date.now();
            userData.paymentId = paymentId;
            userData.paymentMethod = paymentMethod;
            userData.lastCheck = Date.now();
        }
        
        downloadTracker.set(userKey, userData);
        
        // Also activate for machine if provided
        if (machineKey) {
            let machineData = downloadTracker.get(machineKey);
            if (!machineData) {
                machineData = {
                    machineId,
                    downloadsUsed: 0,
                    unlimitedAccess: true,
                    unlimitedActivated: Date.now(),
                    userIds: [userId],
                    firstDownload: Date.now(),
                    lastDownload: null,
                    lastCheck: Date.now()
                };
            } else {
                machineData.unlimitedAccess = true;
                machineData.unlimitedActivated = Date.now();
                machineData.lastCheck = Date.now();
                if (!machineData.userIds.includes(userId)) {
                    machineData.userIds.push(userId);
                }
            }
            downloadTracker.set(machineKey, machineData);
        }
        
        res.json({
            success: true,
            unlimitedAccess: true,
            activated: Date.now(),
            expires: Date.now() + (365 * 24 * 60 * 60 * 1000), // 1 year
            message: 'Unlimited downloads activated for 1 year'
        });
        
    } catch (error) {
        console.error('Activate unlimited error:', error);
        res.status(500).json({ error: 'Failed to activate unlimited access' });
    }
});

// 4. Get user download history
app.get('/api/user-downloads/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const currentYear = new Date().getFullYear();
        const userKey = `${userId}_${currentYear}`;
        
        const userData = downloadTracker.get(userKey);
        
        if (!userData) {
            return res.json({
                downloadsUsed: 0,
                remainingDownloads: 3,
                unlimitedAccess: false,
                downloadHistory: [],
                firstDownload: null,
                lastDownload: null
            });
        }
        
        // Don't expose sensitive data
        res.json({
            downloadsUsed: userData.downloadsUsed,
            remainingDownloads: userData.unlimitedAccess ? 'unlimited' : (3 - userData.downloadsUsed),
            unlimitedAccess: userData.unlimitedAccess || false,
            downloadHistory: userData.downloadHistory || [],
            firstDownload: userData.firstDownload || null,
            lastDownload: userData.lastDownload || null,
            unlimitedActivated: userData.unlimitedActivated || null
        });
        
    } catch (error) {
        console.error('Get user downloads error:', error);
        res.status(500).json({ error: 'Failed to get download history' });
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