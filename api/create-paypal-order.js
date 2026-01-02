import paypal from '@paypal/checkout-server-sdk';

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const environment = new paypal.core.SandboxEnvironment(clientId, clientSecret);
const client = new paypal.core.PayPalHttpClient(environment);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'USD',
                    value: '30.00'
                },
                description: 'Unlimited photo downloads for 1 year'
            }]
        });
        
        const order = await client.execute(request);
        res.status(200).json({ id: order.result.id });
        
    } catch (error) {
        console.error('PayPal order error:', error);
        res.status(500).json({ error: error.message });
    }
}