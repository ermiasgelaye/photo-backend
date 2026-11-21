# Photography Backend

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-635BFF?logo=stripe&logoColor=white)
![PayPal](https://img.shields.io/badge/PayPal-00457C?logo=paypal&logoColor=white)
![Vercel](https://img.shields.io/badge/deployed_on-Vercel-000000?logo=vercel&logoColor=white)

The Express API behind the [ARC-NATURE Photography](https://ermiasgelaye.github.io/Photography/Home.html) gallery. It tracks free downloads and processes payments for unlimited downloads through Stripe and PayPal.

**Production:** `https://photo-backend-ten.vercel.app` · health check: [`/api/health`](https://photo-backend-ten.vercel.app/api/health)

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Service status (Stripe/PayPal configured, price) |
| POST | `/api/create-checkout-session` | Create a Stripe Checkout session for the unlimited licence ($30) |
| POST | `/api/create-paypal-order` | Create a PayPal order |
| POST | `/api/capture-paypal-order` | Capture an approved PayPal order |
| POST | `/api/check-download-allowance` | Free downloads remaining this year (3 per user) |
| POST | `/api/register-download` | Record a download |
| POST | `/api/activate-unlimited` | Mark a user as having unlimited access |
| GET | `/api/user-downloads/:userId` | A user's download history |
| GET | `/api/test-paypal` | PayPal configuration check |

Downloads are tracked per user ID, per machine ID and per IP address.

## Run locally

```bash
git clone https://github.com/ermiasgelaye/photo-backend.git
cd photo-backend
npm install
cp .env.example .env      # add your Stripe and PayPal keys
npm run dev               # http://localhost:3000
```

| Variable | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | for Stripe | Stripe secret key. Use `sk_test_…` locally. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | for PayPal | PayPal REST app credentials |
| `SITE_URL` | no | Frontend URL used for payment redirects |
| `PORT` | no | Local port (default `3000`) |

## Deployment

Deployed on Vercel as a single serverless function ([`vercel.json`](vercel.json)). Every push to `main` deploys to production, and secrets are set in the Vercel project settings, never committed.

> **Note:** download tracking is stored in memory, so it resets whenever a serverless instance restarts. To make limits and purchases persistent, move it to a database such as Vercel KV, Postgres or MongoDB.

## Author

**Ermias Gelaye** · [Portfolio](https://ermiasgelaye.github.io) · [GitHub](https://github.com/ermiasgelaye)
