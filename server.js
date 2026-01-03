const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const paypal = require('@paypal/checkout-server-sdk');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SITE_BASE_URL = process.env.SITE_URL || 'https://arc-nature-photography.com';

console.log('🚀 Starting Enhanced Photography Gallery Server...');

// --- SECURITY MIDDLEWARE ---
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            scriptSrc: ["'self'", "https://js.stripe.com", "https://www.paypal.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.stripe.com", "https://api.paypal.com", "https://api.openai.com"]
        }
    }
}));

// --- CORS CONFIGURATION ---
const allowedOrigins = [
    'https://ermiasgelaye.github.io',
    'https://ermiasgelaye.github.io/Photography',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://localhost:3000',
    'https://photo-backend-ten.vercel.app'
];

app.use(cors({
    origin: function(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('Blocked by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
}));

// --- RATE LIMITING ---
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// --- MONGOOSE SETUP ---
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/photo_gallery', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- DATABASE SCHEMAS ---
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    email: { type: String },
    machineId: { type: String },
    fingerprint: { type: String },
    createdAt: { type: Date, default: Date.now }
});

const downloadSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    imageId: { type: String, required: true },
    imageTitle: { type: String },
    downloadedAt: { type: Date, default: Date.now },
    watermarked: { type: Boolean, default: true },
    unlimitedAccess: { type: Boolean, default: false },
    ipAddress: { type: String },
    userAgent: { type: String }
});

const paymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    paymentId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
    paymentMethod: { type: String, enum: ['stripe', 'paypal', 'manual'] },
    unlimitedAccess: { type: Boolean, default: false },
    activationCode: { type: String },
    expiresAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
    metadata: { type: Map, of: mongoose.Schema.Types.Mixed }
});

const unlimitedAccessSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    activationCode: { type: String, required: true, unique: true },
    paymentId: { type: String, required: true },
    email: { type: String },
    machineIds: { type: [String], default: [] },
    features: { type: [String], default: [] },
    activatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    downloadsCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    lastDownloadAt: { type: Date }
});

// AI Analysis Schema
const aiAnalysisSchema = new mongoose.Schema({
    imageId: { type: String, required: true },
    analysis: {
        description: { type: String },
        tags: { type: [String] },
        colors: { type: [String] },
        composition: { type: String },
        technical: {
            aperture: { type: String },
            shutterSpeed: { type: String },
            iso: { type: Number },
            focalLength: { type: String }
        },
        mood: { type: String },
        similarImages: { type: [String] }
    },
    analyzedAt: { type: Date, default: Date.now },
    model: { type: String, default: 'gpt-4-vision-preview' }
});

// Create models
const User = mongoose.model('User', userSchema);
const Download = mongoose.model('Download', downloadSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const UnlimitedAccess = mongoose.model('UnlimitedAccess', unlimitedAccessSchema);
const AIAnalysis = mongoose.model('AIAnalysis', aiAnalysisSchema);

// --- PAYMENT PROVIDERS SETUP ---
let stripe, paypalClient, openai;

// Stripe
if (process.env.STRIPE_SECRET_KEY) {
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized');
}

// PayPal
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
    try {
        let environment;
        if (process.env.PAYPAL_CLIENT_ID.startsWith('A')) {
            environment = new paypal.core.LiveEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
            console.log('🟢 Using PayPal LIVE environment');
        } else {
            environment = new paypal.core.SandboxEnvironment(
                process.env.PAYPAL_CLIENT_ID,
                process.env.PAYPAL_SECRET
            );
            console.log('🟡 Using PayPal SANDBOX environment');
        }
        paypalClient = new paypal.core.PayPalHttpClient(environment);
        console.log('✅ PayPal client initialized');
    } catch (e) {
        console.error('❌ PayPal init failed:', e.message);
    }
}

// OpenAI
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });
    console.log('✅ OpenAI initialized');
}

// --- UTILITY FUNCTIONS ---
const generateActivationCode = () => {
    return `ARC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
};

const validateEmail = (email) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
};

// --- ROUTES ---

// 1. Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date(),
        services: {
            mongodb: mongoose.connection.readyState === 1,
            stripe: !!stripe,
            paypal: !!paypalClient,
            openai: !!openai,
            memoryUsage: process.memoryUsage()
        },
        uptime: process.uptime()
    });
});

// 2. User Registration & Tracking
app.post('/api/register-user', async (req, res) => {
    try {
        const { userId, email, machineId, fingerprint } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        let user = await User.findOne({ userId });
        
        if (!user) {
            user = new User({
                userId,
                email: validateEmail(email) ? email : null,
                machineId,
                fingerprint
            });
            await user.save();
        }
        
        res.json({
            success: true,
            user: {
                userId: user.userId,
                email: user.email,
                createdAt: user.createdAt
            }
        });
        
    } catch (error) {
        console.error('User registration error:', error);
        res.status(500).json({ error: 'Failed to register user' });
    }
});

// 3. Enhanced Download Tracking
app.post('/api/track-download', async (req, res) => {
    try {
        const { userId, imageId, imageTitle, unlimitedAccess, activationCode } = req.body;
        
        if (!userId || !imageId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Check unlimited access if provided
        let unlimitedData = null;
        if (activationCode) {
            unlimitedData = await UnlimitedAccess.findOne({
                activationCode,
                isActive: true,
                expiresAt: { $gt: new Date() }
            });
        }
        
        // Check if user has active unlimited access
        if (!unlimitedData) {
            unlimitedData = await UnlimitedAccess.findOne({
                userId,
                isActive: true,
                expiresAt: { $gt: new Date() }
            });
        }
        
        const isUnlimited = !!unlimitedData;
        const ip = req.ip;
        const userAgent = req.get('User-Agent');
        
        // Record download
        const download = new Download({
            userId,
            imageId,
            imageTitle,
            watermarked: !isUnlimited,
            unlimitedAccess: isUnlimited,
            ipAddress: ip,
            userAgent
        });
        await download.save();
        
        // Update unlimited access stats
        if (isUnlimited && unlimitedData) {
            unlimitedData.downloadsCount += 1;
            unlimitedData.lastDownloadAt = new Date();
            await unlimitedData.save();
        }
        
        // Check download limits for free users
        if (!isUnlimited) {
            const downloadsToday = await Download.countDocuments({
                userId,
                downloadedAt: {
                    $gte: new Date(new Date().setHours(0, 0, 0, 0))
                }
            });
            
            const downloadsThisMonth = await Download.countDocuments({
                userId,
                downloadedAt: {
                    $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                }
            });
            
            const monthlyLimit = 20; // Free downloads per month
            const dailyLimit = 5; // Free downloads per day
            
            if (downloadsToday >= dailyLimit) {
                return res.status(429).json({
                    success: false,
                    message: 'Daily download limit reached',
                    limit: dailyLimit,
                    used: downloadsToday,
                    reset: 'tomorrow'
                });
            }
            
            if (downloadsThisMonth >= monthlyLimit) {
                return res.status(429).json({
                    success: false,
                    message: 'Monthly download limit reached',
                    limit: monthlyLimit,
                    used: downloadsThisMonth,
                    reset: 'next month'
                });
            }
        }
        
        res.json({
            success: true,
            unlimited: isUnlimited,
            watermarked: !isUnlimited,
            downloadId: download._id,
            message: isUnlimited ? 'High-resolution download processed' : 'Watermarked download processed'
        });
        
    } catch (error) {
        console.error('Download tracking error:', error);
        res.status(500).json({ error: 'Failed to track download' });
    }
});

// 4. Stripe Checkout
app.post('/api/create-stripe-session', async (req, res) => {
    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
    }
    
    try {
        const { userId, email, plan = 'yearly' } = req.body;
        
        if (!userId || !validateEmail(email)) {
            return res.status(400).json({ error: 'Valid user ID and email are required' });
        }
        
        const plans = {
            yearly: {
                priceId: process.env.STRIPE_YEARLY_PRICE_ID,
                amount: 3000, // $30.00
                name: '1 Year Unlimited Access'
            },
            monthly: {
                priceId: process.env.STRIPE_MONTHLY_PRICE_ID,
                amount: 500, // $5.00
                name: 'Monthly Unlimited Access'
            },
            lifetime: {
                priceId: process.env.STRIPE_LIFETIME_PRICE_ID,
                amount: 15000, // $150.00
                name: 'Lifetime Unlimited Access'
            }
        };
        
        const selectedPlan = plans[plan] || plans.yearly;
        
        // Create customer in Stripe
        const customer = await stripe.customers.create({
            email,
            metadata: { userId }
        });
        
        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customer.id,
            payment_method_types: ['card'],
            line_items: [{
                price: selectedPlan.priceId,
                quantity: 1
            }],
            mode: 'subscription',
            success_url: `${SITE_BASE_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&user_id=${userId}`,
            cancel_url: `${SITE_BASE_URL}/payment-canceled`,
            metadata: {
                userId,
                plan,
                amount: selectedPlan.amount
            }
        });
        
        // Record payment attempt
        const payment = new Payment({
            userId,
            paymentId: session.id,
            amount: selectedPlan.amount,
            status: 'pending',
            paymentMethod: 'stripe',
            metadata: {
                plan,
                customerId: customer.id,
                sessionUrl: session.url
            }
        });
        await payment.save();
        
        res.json({
            success: true,
            sessionId: session.id,
            url: session.url,
            customerId: customer.id
        });
        
    } catch (error) {
        console.error('Stripe session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. PayPal Order
app.post('/api/create-paypal-order', async (req, res) => {
    if (!paypalClient) {
        return res.status(500).json({ error: 'PayPal not configured' });
    }
    
    try {
        const { userId, email, plan = 'yearly' } = req.body;
        
        if (!userId || !validateEmail(email)) {
            return res.status(400).json({ error: 'Valid user ID and email are required' });
        }
        
        const plans = {
            yearly: { amount: '30.00', name: '1 Year Unlimited' },
            monthly: { amount: '5.00', name: 'Monthly Unlimited' },
            lifetime: { amount: '150.00', name: 'Lifetime Unlimited' }
        };
        
        const selectedPlan = plans[plan] || plans.yearly;
        const orderId = `PAYPAL-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
        
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: selectedPlan.amount,
                    breakdown: {
                        item_total: {
                            currency_code: 'USD',
                            value: selectedPlan.amount
                        }
                    }
                },
                items: [{
                    name: `${selectedPlan.name} - ARC Nature Photography`,
                    description: 'Unlimited high-resolution downloads, no watermarks, commercial license',
                    quantity: '1',
                    unit_amount: {
                        currency_code: 'USD',
                        value: selectedPlan.amount
                    }
                }],
                custom_id: userId,
                invoice_id: orderId
            }],
            application_context: {
                brand_name: 'ARC-NATURE PHOTOGRAPHY',
                landing_page: 'BILLING',
                user_action: 'PAY_NOW',
                return_url: `${SITE_BASE_URL}/payment-success?provider=paypal&order_id={order_id}&user_id=${userId}`,
                cancel_url: `${SITE_BASE_URL}/payment-canceled`
            }
        });
        
        const order = await paypalClient.execute(request);
        
        // Record payment attempt
        const payment = new Payment({
            userId,
            paymentId: order.result.id,
            amount: parseFloat(selectedPlan.amount) * 100,
            status: 'pending',
            paymentMethod: 'paypal',
            metadata: {
                plan,
                orderId: order.result.id,
                status: order.result.status
            }
        });
        await payment.save();
        
        res.json({
            success: true,
            orderId: order.result.id,
            status: order.result.status,
            links: order.result.links
        });
        
    } catch (error) {
        console.error('PayPal order error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 6. Payment Webhooks
app.post('/api/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
    if (!stripe) {
        return res.status(500).json({ error: 'Stripe not configured' });
    }
    
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                const session = event.data.object;
                
                // Update payment status
                await Payment.findOneAndUpdate(
                    { paymentId: session.id },
                    {
                        status: 'completed',
                        metadata: { ...session.metadata, completedAt: new Date() }
                    }
                );
                
                // Activate unlimited access
                if (session.metadata && session.metadata.userId) {
                    const activationCode = generateActivationCode();
                    
                    // Calculate expiration based on plan
                    let expiresAt = new Date();
                    if (session.metadata.plan === 'yearly') {
                        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
                    } else if (session.metadata.plan === 'monthly') {
                        expiresAt.setMonth(expiresAt.getMonth() + 1);
                    } else if (session.metadata.plan === 'lifetime') {
                        expiresAt.setFullYear(expiresAt.getFullYear() + 100); // 100 years = lifetime
                    }
                    
                    const unlimitedAccess = new UnlimitedAccess({
                        userId: session.metadata.userId,
                        activationCode,
                        paymentId: session.id,
                        email: session.customer_email,
                        features: [
                            'unlimited_high_resolution_downloads',
                            'no_watermarks',
                            'commercial_license',
                            'priority_support',
                            'exclusive_photos',
                            'early_access',
                            'ai_analysis'
                        ],
                        expiresAt,
                        isActive: true
                    });
                    
                    await unlimitedAccess.save();
                    
                    // TODO: Send activation email
                    console.log(`Unlimited access activated for user: ${session.metadata.userId}`);
                }
                break;
                
            case 'customer.subscription.deleted':
                // Handle subscription cancellation
                const subscription = event.data.object;
                // Update user's access status
                break;
        }
        
        res.json({ received: true });
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// 7. AI Image Analysis
app.post('/api/analyze-image', async (req, res) => {
    if (!openai) {
        return res.status(500).json({ error: 'OpenAI not configured' });
    }
    
    try {
        const { imageUrl, imageId, analyzeFor = 'general' } = req.body;
        
        if (!imageUrl) {
            return res.status(400).json({ error: 'Image URL is required' });
        }
        
        // Check cache first
        const cachedAnalysis = await AIAnalysis.findOne({ imageId }).sort({ analyzedAt: -1 });
        if (cachedAnalysis) {
            return res.json({
                success: true,
                analysis: cachedAnalysis.analysis,
                cached: true,
                analyzedAt: cachedAnalysis.analyzedAt
            });
        }
        
        // Prepare prompt based on analysis type
        let prompt = "Analyze this photography image and provide:";
        if (analyzeFor === 'general') {
            prompt += "1. A detailed description of the scene\n2. 10 relevant tags\n3. Main color palette\n4. Composition analysis\n5. Estimated technical details (aperture, shutter speed, ISO, focal length)\n6. Mood/emotion conveyed\n7. Similar photographic styles";
        } else if (analyzeFor === 'technical') {
            prompt += "Technical analysis including likely camera settings, lighting conditions, post-processing techniques, and photographic principles used";
        } else if (analyzeFor === 'artistic') {
            prompt += "Artistic analysis including composition, color theory, emotional impact, and artistic influences";
        }
        
        // Call OpenAI Vision API
        const response = await openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: imageUrl } }
                    ]
                }
            ],
            max_tokens: 1000
        });
        
        // Parse response
        const analysisText = response.choices[0].message.content;
        
        // Extract structured data (simplified parsing)
        const analysis = {
            description: analysisText.split('\n')[0] || analysisText.substring(0, 200),
            tags: extractTags(analysisText),
            colors: extractColors(analysisText),
            composition: extractBetween(analysisText, 'Composition:', '\n') || 'Balanced',
            technical: {
                aperture: extractBetween(analysisText, 'Aperture:', ' ') || 'f/8',
                shutterSpeed: extractBetween(analysisText, 'Shutter speed:', ' ') || '1/125',
                iso: parseInt(extractBetween(analysisText, 'ISO:', ' ')) || 100,
                focalLength: extractBetween(analysisText, 'Focal length:', ' ') || '50mm'
            },
            mood: extractBetween(analysisText, 'Mood:', '\n') || 'Peaceful',
            similarImages: []
        };
        
        // Save to database
        const aiAnalysis = new AIAnalysis({
            imageId: imageId || `img_${Date.now()}`,
            analysis,
            model: 'gpt-4-vision-preview'
        });
        await aiAnalysis.save();
        
        res.json({
            success: true,
            analysis,
            analyzedAt: aiAnalysis.analyzedAt,
            model: aiAnalysis.model
        });
        
    } catch (error) {
        console.error('AI analysis error:', error);
        res.status(500).json({ error: 'Failed to analyze image' });
    }
});

// Helper functions for AI analysis
function extractTags(text) {
    const tagLines = text.match(/\d+\.\s*[^:\n]+:/g);
    if (tagLines) {
        return tagLines.slice(0, 10).map(tag => tag.replace(/\d+\.\s*/, '').replace(':', '').trim());
    }
    return ['nature', 'photography', 'landscape', 'scenic'];
}

function extractColors(text) {
    const colorMatch = text.match(/colors?:?\s*([^.\n]+)/i);
    if (colorMatch) {
        return colorMatch[1].split(/[,;]/).map(c => c.trim()).slice(0, 5);
    }
    return ['blue', 'green', 'brown', 'white'];
}

function extractBetween(text, start, end) {
    const regex = new RegExp(`${start}([^${end}]+)`);
    const match = text.match(regex);
    return match ? match[1].trim() : null;
}

// 8. User Dashboard API
app.get('/api/user/:userId/dashboard', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get user info
        const user = await User.findOne({ userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get download stats
        const totalDownloads = await Download.countDocuments({ userId });
        const unlimitedAccess = await UnlimitedAccess.findOne({
            userId,
            isActive: true,
            expiresAt: { $gt: new Date() }
        });
        
        // Get recent downloads
        const recentDownloads = await Download.find({ userId })
            .sort({ downloadedAt: -1 })
            .limit(10)
            .select('imageTitle downloadedAt watermarked unlimitedAccess');
        
        // Get payment history
        const payments = await Payment.find({ userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .select('amount status paymentMethod createdAt');
        
        res.json({
            success: true,
            user: {
                userId: user.userId,
                email: user.email,
                registeredAt: user.createdAt
            },
            stats: {
                totalDownloads,
                hasUnlimitedAccess: !!unlimitedAccess,
                unlimitedExpires: unlimitedAccess?.expiresAt,
                downloadsThisMonth: await Download.countDocuments({
                    userId,
                    downloadedAt: {
                        $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                    }
                }),
                downloadsToday: await Download.countDocuments({
                    userId,
                    downloadedAt: {
                        $gte: new Date(new Date().setHours(0, 0, 0, 0))
                    }
                })
            },
            unlimitedAccess: unlimitedAccess ? {
                activationCode: unlimitedAccess.activationCode,
                activatedAt: unlimitedAccess.activatedAt,
                expiresAt: unlimitedAccess.expiresAt,
                downloadsCount: unlimitedAccess.downloadsCount,
                features: unlimitedAccess.features
            } : null,
            recentDownloads,
            paymentHistory: payments
        });
        
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

// 9. Image Recommendations (AI-powered)
app.post('/api/recommendations', async (req, res) => {
    try {
        const { userId, basedOn = 'history', limit = 10 } = req.body;
        
        let recommendations = [];
        
        if (basedOn === 'history' && userId) {
            // Get user's downloaded images
            const userDownloads = await Download.find({ userId })
                .sort({ downloadedAt: -1 })
                .limit(5)
                .select('imageId');
            
            if (userDownloads.length > 0) {
                // Get similar images based on tags/categories
                const downloadedImageIds = userDownloads.map(d => d.imageId);
                
                // This is simplified - in production, you'd use a proper recommendation engine
                // based on image metadata, tags, or AI embeddings
                
                // For now, return random "recommendations"
                recommendations = Array(limit).fill().map((_, i) => ({
                    imageId: `rec_${i}_${Date.now()}`,
                    title: `Recommended Image ${i + 1}`,
                    reason: 'Based on your download history',
                    score: 0.8 + (Math.random() * 0.2)
                }));
            }
        } else if (basedOn === 'trending') {
            // Get trending images (most downloaded recently)
            const trendingDownloads = await Download.aggregate([
                {
                    $match: {
                        downloadedAt: {
                            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
                        }
                    }
                },
                {
                    $group: {
                        _id: '$imageId',
                        count: { $sum: 1 }
                    }
                },
                { $sort: { count: -1 } },
                { $limit: limit }
            ]);
            
            recommendations = trendingDownloads.map((item, index) => ({
                imageId: item._id,
                title: `Trending Image ${index + 1}`,
                reason: `Downloaded ${item.count} times this week`,
                score: 0.9
            }));
        }
        
        // If no specific recommendations, return featured images
        if (recommendations.length === 0) {
            recommendations = Array(limit).fill().map((_, i) => ({
                imageId: `featured_${i}`,
                title: `Featured Image ${i + 1}`,
                reason: 'Editor\'s pick',
                score: 0.95
            }));
        }
        
        res.json({
            success: true,
            basedOn,
            count: recommendations.length,
            recommendations
        });
        
    } catch (error) {
        console.error('Recommendations error:', error);
        res.status(500).json({ error: 'Failed to get recommendations' });
    }
});

// 10. Bulk Operations
app.post('/api/bulk-download', async (req, res) => {
    try {
        const { userId, imageIds, activationCode } = req.body;
        
        if (!userId || !imageIds || !Array.isArray(imageIds)) {
            return res.status(400).json({ error: 'Invalid request' });
        }
        
        if (imageIds.length > 50) {
            return res.status(400).json({ error: 'Maximum 50 images per bulk download' });
        }
        
        // Check unlimited access
        let unlimitedAccess = null;
        if (activationCode) {
            unlimitedAccess = await UnlimitedAccess.findOne({
                activationCode,
                isActive: true,
                expiresAt: { $gt: new Date() }
            });
        }
        
        if (!unlimitedAccess) {
            unlimitedAccess = await UnlimitedAccess.findOne({
                userId,
                isActive: true,
                expiresAt: { $gt: new Date() }
            });
        }
        
        if (!unlimitedAccess) {
            return res.status(403).json({
                error: 'Unlimited access required for bulk downloads',
                code: 'UNLIMITED_REQUIRED'
            });
        }
        
        // Create download entries for each image
        const downloadPromises = imageIds.map(imageId => {
            const download = new Download({
                userId,
                imageId,
                unlimitedAccess: true,
                watermarked: false
            });
            return download.save();
        });
        
        await Promise.all(downloadPromises);
        
        // Update unlimited access stats
        unlimitedAccess.downloadsCount += imageIds.length;
        unlimitedAccess.lastDownloadAt = new Date();
        await unlimitedAccess.save();
        
        // Create ZIP file (simplified - in production, you'd generate actual ZIP)
        const downloadId = `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        res.json({
            success: true,
            downloadId,
            count: imageIds.length,
            unlimited: true,
            message: `Processing ${imageIds.length} images for download`,
            estimatedTime: `${Math.ceil(imageIds.length * 0.5)} seconds`, // Estimated
            downloadUrl: `/api/download-bulk/${downloadId}` // This would be another endpoint
        });
        
    } catch (error) {
        console.error('Bulk download error:', error);
        res.status(500).json({ error: 'Failed to process bulk download' });
    }
});

// --- ERROR HANDLING MIDDLEWARE ---
app.use((err, req, res, next) => {
    console.error('Global error handler:', err);
    
    // Default error
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    
    res.status(statusCode).json({
        success: false,
        error: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// --- START SERVER ---
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Enhanced server running on port ${PORT}`);
        console.log(`📁 MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
        console.log(`💳 Stripe: ${stripe ? 'Ready' : 'Not configured'}`);
        console.log(`💰 PayPal: ${paypalClient ? 'Ready' : 'Not configured'}`);
        console.log(`🤖 OpenAI: ${openai ? 'Ready' : 'Not configured'}`);
    });
}

module.exports = app;