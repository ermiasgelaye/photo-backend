// In your backend API (e.g., /api/track-download.js)
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
        const {
            userId,
            imageSrc,
            imageTitle,
            timestamp,
            userAgent,
            remainingDownloads
        } = req.body;
        
        // Get client IP (works on Vercel)
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        
        // Store in database (using your preferred database)
        // For now, we'll just log it
        const downloadRecord = {
            userId,
            imageSrc,
            imageTitle,
            timestamp: new Date(timestamp).toISOString(),
            userAgent,
            ip,
            remainingDownloads,
            year: new Date().getFullYear()
        };
        
        // TODO: Save to database
        
        console.log('Download tracked:', downloadRecord);
        
        // Check if user has exceeded limits
        const userDownloads = await getUserDownloads(userId, new Date().getFullYear());
        
        if (userDownloads >= 3 && !hasUnlimitedAccess(userId)) {
            return res.status(429).json({ 
                error: 'Download limit reached',
                remaining: 0 
            });
        }
        
        res.status(200).json({ 
            success: true,
            remaining: 3 - (userDownloads + 1)
        });
        
    } catch (error) {
        console.error('Download tracking error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}