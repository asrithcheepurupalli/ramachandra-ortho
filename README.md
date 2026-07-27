# Ramachandra Ortho Care & Clinics

Appointment website, WhatsApp booking and a clinic admin dashboard for an
orthopedic clinic in Chinnamushidiwada, Visakhapatnam. A **made. by ac** build.

## What's here

- **Patient website** (`/`) — live "Doctor IN/OUT today" availability, Book / Chat on
  WhatsApp, services, Google reviews wall, location and hours. Telugu / English / Hindi.
- **Admin dashboard** (`/admin`) — today's live queue with tokens, walk-in / reserve,
  schedule editor (drives availability everywhere), broadcast, patients, revenue.
- **Booking flow** (`/book`) — slot picker (in progress).
- **WhatsApp bot** — intent routing + confirm / cancel / reminder / availability
  automations (in progress).

Everything is **config-driven** from `clinic.config.ts` and runs **zero-config on mock
data** (localStorage); Supabase and the WhatsApp Cloud API swap in for production.

## Run

```bash
npm install
npm run dev      # http://localhost:3000  (and /admin)
```

Built with Next.js, Tailwind CSS and TypeScript.
