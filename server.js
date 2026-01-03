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
let downloadTracker = new Map();
let ipTracker = new Map();
let unlimitedAccessTracker = new Map();

// Clean up old entries daily
setInterval(() => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    // Clean download tracker (30 days)
    for (const [key, data] of downloadTracker.entries()) {
        if (now - data.lastCheck > (30 * oneDay)) {
            downloadTracker.delete(key);
        }
    }
    
    // Clean IP tracker (7 days)
    for (const [key, data] of ipTracker.entries()) {
        if (now - data.lastCheck > (7 * oneDay)) {
            ipTracker.delete(key);
        }
    }
    
    // Clean expired unlimited access
    for (const [key, data] of unlimitedAccessTracker.entries()) {
        if (data.expires && now > data.expires) {
            unlimitedAccessTracker.delete(key);
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
            downloadTracking: true,
            unlimitedAccess: true
        }
    });
});

// --- STRIPE CHECKOUT ---
app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    try {
        const { userId, email } = req.body;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Unlimited Gallery Access - 1 Year',
                        description: 'High-resolution downloads with no watermarks',
                    },
                    unit_amount: PRICE_AMOUNT_CENTS,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${SITE_BASE_URL}/index.html?payment=success&userId=${userId}&email=${encodeURIComponent(email || '')}`,
            cancel_url: `${SITE_BASE_URL}/index.html?payment=cancelled`,
            metadata: {
                userId: userId || 'unknown',
                email: email || 'unknown'
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
        const { userId, email } = req.body;
        
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
                description: 'Unlimited Gallery Access - 1 Year',
                custom_id: userId || 'unknown',
                invoice_id: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
            }],
            application_context: {
                brand_name: 'ARC-NATURE PHOTOGRAPHY',
                landing_page: 'BILLING',
                user_action: 'PAY_NOW',
                return_url: `${SITE_BASE_URL}/index.html?payment=success&method=paypal&userId=${userId}&email=${encodeURIComponent(email || '')}`,
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
        const { orderID, userId, email, machineId } = req.body;
        
        if (!orderID) {
            return res.status(400).json({ error: 'Missing orderID' });
        }

        console.log('Capturing order:', orderID);
        
        const paypal = require('@paypal/checkout-server-sdk');
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});

        const capture = await paypalClient.execute(request);
        console.log('✅ PayPal order captured:', capture.result.id);
        
        // Create activation data
        const activationCode = `UL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const expires = Date.now() + (365 * 24 * 60 * 60 * 1000); // 1 year
        
        const unlimitedData = {
            userId: userId || 'unknown',
            machineId: machineId || 'unknown',
            paymentId: orderID,
            paymentMethod: 'paypal',
            email: email || null,
            activationCode,
            unlimitedAccess: true,
            activated: Date.now(),
            expires: expires,
            devices: machineId ? [machineId] : [],
            features: [
                'unlimited_high_resolution_downloads',
                'no_watermarks',
                'commercial_license',
                'priority_support',
                'exclusive_photos',
                'early_access'
            ],
            downloadsCount: 0,
            lastDownload: null,
            downloadHistory: []
        };
        
        // Store unlimited access
        const userKey = `unlimited_user_${userId}`;
        const activationKey = `activation_${activationCode}`;
        const paymentKey = `payment_${orderID}`;
        
        unlimitedAccessTracker.set(userKey, unlimitedData);
        unlimitedAccessTracker.set(activationKey, unlimitedData);
        unlimitedAccessTracker.set(paymentKey, unlimitedData);
        
        if (machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedAccessTracker.set(machineKey, unlimitedData);
        }
        
        res.json({ 
            success: true,
            capture: capture.result,
            activationCode,
            expires,
            features: unlimitedData.features,
            message: 'Payment successful! Unlimited access activated.'
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
        
        // Check unlimited access first
        const userKey = `unlimited_user_${userId}`;
        let unlimitedData = unlimitedAccessTracker.get(userKey);
        
        if (!unlimitedData && machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedData = unlimitedAccessTracker.get(machineKey);
        }
        
        if (unlimitedData) {
            // Check if expired
            if (Date.now() > unlimitedData.expires) {
                return res.json({
                    canDownload: false,
                    remainingDownloads: 0,
                    unlimitedAccess: false,
                    message: 'Your unlimited access has expired'
                });
            }
            
            return res.json({
                canDownload: true,
                remainingDownloads: 'unlimited',
                unlimitedAccess: true,
                features: unlimitedData.features,
                downloadsCount: unlimitedData.downloadsCount || 0
            });
        }
        
        // Regular download tracking
        const userKeyRegular = `${userId}_${currentYear}`;
        const machineKey = machineId ? `machine_${machineId}_${currentYear}` : null;
        const ipKey = `ip_${ip}_${currentYear}`;
        
        let downloadsUsed = 0;
        
        // Check user tracking
        let userData = downloadTracker.get(userKeyRegular);
        if (userData) {
            downloadsUsed = Math.max(downloadsUsed, userData.downloadsUsed);
        }
        
        // Check machine tracking
        if (machineKey) {
            const machineData = downloadTracker.get(machineKey);
            if (machineData) {
                downloadsUsed = Math.max(downloadsUsed, machineData.downloadsUsed);
            }
        }
        
        // Check IP tracking
        const ipData = ipTracker.get(ipKey);
        if (ipData) {
            downloadsUsed = Math.max(downloadsUsed, ipData.downloadsUsed);
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
        
        // Check unlimited access first
        const userKey = `unlimited_user_${userId}`;
        let unlimitedData = unlimitedAccessTracker.get(userKey);
        
        if (!unlimitedData && machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedData = unlimitedAccessTracker.get(machineKey);
        }
        
        if (unlimitedData) {
            // Check if expired
            if (Date.now() > unlimitedData.expires) {
                return res.status(403).json({
                    success: false,
                    message: 'Your unlimited access has expired'
                });
            }
            
            // Track unlimited download
            unlimitedData.downloadsCount = (unlimitedData.downloadsCount || 0) + 1;
            unlimitedData.lastDownload = Date.now();
            
            if (!unlimitedData.downloadHistory) {
                unlimitedData.downloadHistory = [];
            }
            
            unlimitedData.downloadHistory.push({
                imageId,
                imageTitle,
                timestamp: Date.now(),
                noWatermark: true,
                highResolution: true
            });
            
            // Update stored data
            const activationKey = `activation_${unlimitedData.activationCode}`;
            unlimitedAccessTracker.set(userKey, unlimitedData);
            unlimitedAccessTracker.set(activationKey, unlimitedData);
            
            if (machineId) {
                const machineKey = `unlimited_machine_${machineId}`;
                unlimitedAccessTracker.set(machineKey, unlimitedData);
            }
            
            return res.json({
                success: true,
                unlimitedAccess: true,
                noWatermark: true,
                highResolution: true,
                commercialLicense: true,
                downloadsCount: unlimitedData.downloadsCount,
                expires: unlimitedData.expires,
                message: 'Unlimited download processed'
            });
        }
        
        // Regular download tracking
        const currentYear = new Date().getFullYear();
        const ip = req.ip;
        
        const userKeyRegular = `${userId}_${currentYear}`;
        const machineKey = machineId ? `machine_${machineId}_${currentYear}` : null;
        const ipKey = `ip_${ip}_${currentYear}`;
        
        let userData = downloadTracker.get(userKeyRegular);
        let machineData = machineKey ? downloadTracker.get(machineKey) : null;
        let ipData = ipTracker.get(ipKey);
        
        let downloadsUsed = 0;
        if (userData) downloadsUsed = Math.max(downloadsUsed, userData.downloadsUsed);
        if (machineData) downloadsUsed = Math.max(downloadsUsed, machineData.downloadsUsed);
        if (ipData) downloadsUsed = Math.max(downloadsUsed, ipData.downloadsUsed);
        
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
                    ip: ip,
                    watermarked: true
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
                ip: ip,
                watermarked: true
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
        
        downloadTracker.set(userKeyRegular, userData);
        ipTracker.set(ipKey, ipData);
        
        const remainingDownloads = 3 - (downloadsUsed + 1);
        
        res.json({
            success: true,
            remainingDownloads: remainingDownloads,
            downloadsUsed: downloadsUsed + 1,
            watermarked: true,
            message: remainingDownloads === 0 ? 'No downloads remaining!' : 
                    remainingDownloads === 1 ? 'Only 1 download remaining!' : null
        });
        
    } catch (error) {
        console.error('Register download error:', error);
        res.status(500).json({ error: 'Failed to register download' });
    }
});

// 3. Register device for unlimited access
app.post('/api/register-device', (req, res) => {
    try {
        const { userId, machineId, paymentId, paymentMethod, email } = req.body;
        
        if (!userId || !paymentId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const activationCode = `UL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const expires = Date.now() + (365 * 24 * 60 * 60 * 1000); // 1 year
        
        const unlimitedData = {
            userId,
            machineId: machineId || 'unknown',
            paymentId,
            paymentMethod: paymentMethod || 'unknown',
            email: email || null,
            activationCode,
            unlimitedAccess: true,
            activated: Date.now(),
            expires: expires,
            devices: machineId ? [machineId] : [],
            features: [
                'unlimited_high_resolution_downloads',
                'no_watermarks',
                'commercial_license',
                'priority_support',
                'exclusive_photos',
                'early_access'
            ],
            downloadsCount: 0,
            lastDownload: null,
            downloadHistory: []
        };
        
        // Store in multiple keys for different lookups
        const userKey = `unlimited_user_${userId}`;
        const paymentKey = `payment_${paymentId}`;
        const activationKey = `activation_${activationCode}`;
        
        unlimitedAccessTracker.set(userKey, unlimitedData);
        unlimitedAccessTracker.set(paymentKey, unlimitedData);
        unlimitedAccessTracker.set(activationKey, unlimitedData);
        
        if (machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedAccessTracker.set(machineKey, unlimitedData);
        }
        
        res.json({
            success: true,
            activationCode,
            activated: Date.now(),
            expires: expires,
            features: unlimitedData.features,
            message: 'Device registered for unlimited access'
        });
        
    } catch (error) {
        console.error('Device registration error:', error);
        res.status(500).json({ error: 'Failed to register device' });
    }
});

// 4. Verify unlimited access
app.post('/api/verify-unlimited', (req, res) => {
    try {
        const { userId, machineId, activationCode } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }
        
        // Try different lookup methods
        let unlimitedData = null;
        
        // Try activation code first
        if (activationCode) {
            const activationKey = `activation_${activationCode}`;
            unlimitedData = unlimitedAccessTracker.get(activationKey);
        }
        
        // Try user ID
        if (!unlimitedData) {
            const userKey = `unlimited_user_${userId}`;
            unlimitedData = unlimitedAccessTracker.get(userKey);
        }
        
        // Try machine ID
        if (!unlimitedData && machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedData = unlimitedAccessTracker.get(machineKey);
        }
        
        if (!unlimitedData) {
            return res.json({
                hasUnlimited: false,
                message: 'No unlimited access found'
            });
        }
        
        // Check if expired
        if (Date.now() > unlimitedData.expires) {
            return res.json({
                hasUnlimited: false,
                message: 'Unlimited access has expired'
            });
        }
        
        res.json({
            hasUnlimited: true,
            activated: unlimitedData.activated,
            expires: unlimitedData.expires,
            features: unlimitedData.features,
            downloadsCount: unlimitedData.downloadsCount || 0,
            activationCode: unlimitedData.activationCode
        });
        
    } catch (error) {
        console.error('Verify unlimited error:', error);
        res.status(500).json({ error: 'Failed to verify unlimited access' });
    }
});

// 5. Download with unlimited access
app.post('/api/download-unlimited', (req, res) => {
    try {
        const { userId, machineId, activationCode, imageId, imageTitle } = req.body;
        
        if (!userId || !imageId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Verify unlimited access
        let unlimitedData = null;
        
        if (activationCode) {
            const activationKey = `activation_${activationCode}`;
            unlimitedData = unlimitedAccessTracker.get(activationKey);
        }
        
        if (!unlimitedData) {
            const userKey = `unlimited_user_${userId}`;
            unlimitedData = unlimitedAccessTracker.get(userKey);
        }
        
        if (!unlimitedData && machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedData = unlimitedAccessTracker.get(machineKey);
        }
        
        if (!unlimitedData) {
            return res.status(403).json({
                success: false,
                message: 'No unlimited access found'
            });
        }
        
        // Check expiration
        if (Date.now() > unlimitedData.expires) {
            return res.status(403).json({
                success: false,
                message: 'Your unlimited access has expired'
            });
        }
        
        // Track download
        unlimitedData.downloadsCount = (unlimitedData.downloadsCount || 0) + 1;
        unlimitedData.lastDownload = Date.now();
        
        // Store download history
        if (!unlimitedData.downloadHistory) {
            unlimitedData.downloadHistory = [];
        }
        
        unlimitedData.downloadHistory.push({
            imageId,
            imageTitle,
            timestamp: Date.now(),
            noWatermark: true,
            highResolution: true
        });
        
        // Update all stored references
        const userKey = `unlimited_user_${userId}`;
        const activationKey = `activation_${unlimitedData.activationCode}`;
        
        unlimitedAccessTracker.set(userKey, unlimitedData);
        unlimitedAccessTracker.set(activationKey, unlimitedData);
        
        if (machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedAccessTracker.set(machineKey, unlimitedData);
        }
        
        res.json({
            success: true,
            noWatermark: true,
            highResolution: true,
            commercialLicense: true,
            downloadsCount: unlimitedData.downloadsCount,
            expires: unlimitedData.expires,
            imageUrl: imageId, // Return the original image URL (no watermark)
            message: 'Unlimited download granted'
        });
        
    } catch (error) {
        console.error('Unlimited download error:', error);
        res.status(500).json({ error: 'Failed to process unlimited download' });
    }
});

// 6. Activate unlimited access (legacy endpoint)
app.post('/api/activate-unlimited', (req, res) => {
    try {
        const { userId, paymentId, paymentMethod, machineId, email } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing user ID' });
        }
        
        const activationCode = `UL-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        const expires = Date.now() + (365 * 24 * 60 * 60 * 1000); // 1 year
        
        const unlimitedData = {
            userId,
            machineId: machineId || 'unknown',
            paymentId: paymentId || `payment_${Date.now()}`,
            paymentMethod: paymentMethod || 'unknown',
            email: email || null,
            activationCode,
            unlimitedAccess: true,
            activated: Date.now(),
            expires: expires,
            devices: machineId ? [machineId] : [],
            features: [
                'unlimited_high_resolution_downloads',
                'no_watermarks',
                'commercial_license',
                'priority_support',
                'exclusive_photos',
                'early_access'
            ],
            downloadsCount: 0,
            lastDownload: null,
            downloadHistory: []
        };
        
        const userKey = `unlimited_user_${userId}`;
        const activationKey = `activation_${activationCode}`;
        
        unlimitedAccessTracker.set(userKey, unlimitedData);
        unlimitedAccessTracker.set(activationKey, unlimitedData);
        
        if (machineId) {
            const machineKey = `unlimited_machine_${machineId}`;
            unlimitedAccessTracker.set(machineKey, unlimitedData);
        }
        
        res.json({
            success: true,
            unlimitedAccess: true,
            activationCode,
            activated: Date.now(),
            expires: expires,
            features: unlimitedData.features,
            message: 'Unlimited downloads activated for 1 year'
        });
        
    } catch (error) {
        console.error('Activate unlimited error:', error);
        res.status(500).json({ error: 'Failed to activate unlimited access' });
    }
});

// 7. Get user download history
app.get('/api/user-downloads/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        
        // Check for unlimited access first
        const userKey = `unlimited_user_${userId}`;
        const unlimitedData = unlimitedAccessTracker.get(userKey);
        
        if (unlimitedData) {
            return res.json({
                unlimitedAccess: true,
                downloadsCount: unlimitedData.downloadsCount || 0,
                downloadsUsed: 0,
                remainingDownloads: 'unlimited',
                downloadHistory: unlimitedData.downloadHistory || [],
                firstDownload: unlimitedData.activated || null,
                lastDownload: unlimitedData.lastDownload || null,
                activated: unlimitedData.activated,
                expires: unlimitedData.expires,
                features: unlimitedData.features
            });
        }
        
        // Check regular downloads
        const currentYear = new Date().getFullYear();
        const userKeyRegular = `${userId}_${currentYear}`;
        
        const userData = downloadTracker.get(userKeyRegular);
        
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
        
        res.json({
            downloadsUsed: userData.downloadsUsed,
            remainingDownloads: 3 - userData.downloadsUsed,
            unlimitedAccess: false,
            downloadHistory: userData.downloadHistory || [],
            firstDownload: userData.firstDownload || null,
            lastDownload: userData.lastDownload || null
        });
        
    } catch (error) {
        console.error('Get user downloads error:', error);
        res.status(500).json({ error: 'Failed to get download history' });
    }
});

// 8. Get unlimited access info
app.get('/api/unlimited-info/:userId', (req, res) => {
    try {
        const { userId } = req.params;
        const userKey = `unlimited_user_${userId}`;
        
        const unlimitedData = unlimitedAccessTracker.get(userKey);
        
        if (!unlimitedData) {
            return res.json({
                hasUnlimited: false,
                message: 'No unlimited access found'
            });
        }
        
        const expiryDate = new Date(unlimitedData.expires);
        const daysRemaining = Math.ceil((unlimitedData.expires - Date.now()) / (1000 * 60 * 60 * 24));
        
        res.json({
            hasUnlimited: true,
            activationCode: unlimitedData.activationCode,
            activated: unlimitedData.activated,
            expires: unlimitedData.expires,
            expiryDate: expiryDate.toISOString(),
            daysRemaining: daysRemaining,
            downloadsCount: unlimitedData.downloadsCount || 0,
            features: unlimitedData.features,
            email: unlimitedData.email,
            paymentMethod: unlimitedData.paymentMethod
        });
        
    } catch (error) {
        console.error('Get unlimited info error:', error);
        res.status(500).json({ error: 'Failed to get unlimited access info' });
    }
});

// --- TEST ENDPOINT ---
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