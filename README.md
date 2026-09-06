# Ramachandra Ortho Care & Clinics

Appointment website, WhatsApp booking and a clinic admin dashboard for an
orthopedic clinic in Chinnamushidiwada, Visakhapatnam. A **made. by ac** build.

## What's here

- **Patient website** (`/`): live "Doctor IN/OUT today" availability, Book / Chat on
  WhatsApp, services, Google reviews wall, location and hours. Telugu / English / Hindi.
- **Admin dashboard** (`/admin`): today's live queue with tokens, walk-in / reserve,
  schedule editor (drives availability everywhere), broadcast, patients, revenue.
- **Booking flow** (`/book`): live slot picker with real-time availability.
- **WhatsApp bot** (`lib/bot.ts`): intent routing plus confirm / cancel / reschedule /
  reminder / availability automations, fully operational on WhatsApp.

Everything is **config-driven** from `clinic.config.ts` and runs **zero-config on mock
data** (localStorage). Supabase and the WhatsApp Cloud API swap in for production;
`npm run dev` works out of the box with no setup.

## Run

```bash
npm install
npm run dev      # http://localhost:3000  (and /admin)
```

Built with Next.js, Tailwind CSS and TypeScript.

## Going from mock mode to production

Copy `.env.local.example` to `.env.local` and fill in the groups below. Every var is
commented in that file with exactly where to find its value; this is just the map.

- **Supabase** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`): Supabase project → Settings → API. Run
  `supabase/schema.sql` against the project once. Leave all three blank to keep
  running on the mock localStorage store.
- **Meta WhatsApp Cloud API** (`META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`,
  `META_APP_SECRET`, `META_VERIFY_TOKEN`): developers.facebook.com/apps → your app →
  WhatsApp → API Setup for the phone number ID and a temporary token; Business
  Settings → Users → System Users for a permanent token. `META_VERIFY_TOKEN` is any
  string you pick yourself, used only to confirm the webhook handshake.
- **Message templates** (`META_TEMPLATE_*`): each approved template in Meta Business
  Manager → Templates needs its exact name (and, if it wasn't approved under the
  global `META_TEMPLATE_LANG`, a per-template `META_TEMPLATE_LANG_*` override). All
  optional; anything left unset falls back to a plain-text message or is silently
  skipped, so the bot degrades rather than breaks.
- **Razorpay** (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
  `NEXT_PUBLIC_SITE_URL`): Razorpay Dashboard → Settings → API Keys, plus a webhook
  pointed at `/api/webhooks/razorpay` subscribed to `payment_link.paid` (the secret is
  whatever you set when adding that webhook). Powers optional online fee payment.
- **`CRON_SECRET`**: the one manual step that makes reminders fire. Generate with
  `openssl rand -hex 32`, then set the *same* value in **both** places: the Vercel
  project env, and this repo's GitHub Actions secrets (`.github/workflows/reminder-cron.yml`
  POSTs to `/api/cron/reminders` every 15 minutes with it). Mismatched or missing on
  either side means reminders silently stop.

For the clinic-facing operational handbook (how staff use the admin dashboard, the
patient journey, what to do day to day) see `docs/handbook/` rather than this file.
This README is for whoever is running or deploying the code.
