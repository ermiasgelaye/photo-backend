import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const { items, userId, imageId } = req.body;
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: items.map(item => ({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: item.name,
                        description: item.description || 'Unlimited photo downloads for 1 year',
                        metadata: {
                            userId: userId,
                            imageId: imageId || 'general'
                        }
                    },
                    unit_amount: Math.round(item.price * 100), // Convert to cents
                },
                quantity: item.quantity || 1,
            })),
            mode: 'payment',
            success_url: `${req.headers.origin}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/?payment=cancel`,
            metadata: {
                userId: userId,
                purchaseType: 'unlimited_downloads',
                expiryDays: '365'
            }
        });
        
        res.status(200).json({ id: session.id });
        
    } catch (error) {
        console.error('Stripe session error:', error);
        res.status(500).json({ error: error.message });
    }
}