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
        const { orderID } = req.body;
        
        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});
        
        const capture = await client.execute(request);
        
        // Here you would update your database to mark user as having unlimited access
        
        res.status(200).json({ 
            success: true, 
            captureId: capture.result.id,
            message: 'Payment captured successfully'
        });
        
    } catch (error) {
        console.error('PayPal capture error:', error);
        res.status(500).json({ error: error.message });
    }
}