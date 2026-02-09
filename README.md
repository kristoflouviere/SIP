# SIP Texting

Web-based interface for managing inbound and outbound SMS for Telnyx SIP trunks. Includes a Node/Express backend with Prisma + PostgreSQL and a React (Vite) frontend.

## Requirements
- Node.js 18+
- PostgreSQL database
- Telnyx API key with SMS enabled

## Setup
1. Install dependencies:
   - `npm install`

2. Backend environment:
   - Copy [server/.env.example](server/.env.example) to server/.env
   - Set `DATABASE_URL` and `TELNYX_API_KEY`

3. Frontend environment:
   - Copy [client/.env.example](client/.env.example) to client/.env
   - Adjust `VITE_API_BASE_URL` if needed

4. Prisma setup:
   - `npm run generate -w server`
   - `npm run migrate -w server`

## Development
- Run both frontend and backend:
  - `npm run dev`

The frontend will be available at http://localhost:5173 and the backend at http://localhost:3001.

## Telnyx Webhook
Configure your Telnyx messaging webhook URL to:
- `https://YOUR_PUBLIC_URL/webhooks/telnyx`

## Render Deployment
This repo includes a Render configuration in [render.yaml](render.yaml).

1. Push this repo to GitHub.
2. In Render, create a new Blueprint from the repo.
3. Set environment variables for the API service:
   - `DATABASE_URL`
   - `TELNYX_API_KEY`
   - Optional: `SYNC_ON_STARTUP`, `SYNC_LOOKBACK_DAYS`
4. Set `VITE_API_BASE_URL` for the client service to your API URL.

After deploy, use the API service URL for Telnyx webhooks:
- `https://YOUR_RENDER_API_URL/webhooks/telnyx`

## API Endpoints
- `GET /messages` — list recent messages
- `POST /messages/send` — send SMS
- `POST /webhooks/telnyx` — receive Telnyx webhook events

## Notes
- This project stores message payloads in PostgreSQL via Prisma.
- Replace example environment values with production values before deployment.
