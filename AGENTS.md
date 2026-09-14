<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# PROJECT BRIEF - Ramachandra Ortho Care & Clinics

Cold-start brief for any AI model. Read this before touching the code. It tells you what
this project is, how the pieces connect, the invariants you must never break, and the
conventions the codebase follows.

## 1. What this is

A production appointment-management system for a real orthopedic clinic in
Chinnamushidiwada, Visakhapatnam, India. Built by **made. by ac** for the clinic owner
(Dr. Ramachandrudu). Live at https://ramachandraorthocare.com.

Surfaces:
- **Patient website** (`/`): live "Doctor IN/OUT" availability banner, services, map,
  hours, Google reviews, trilingual (English / Telugu / Hindi).
- **Booking** (`/book`): live slot picker, online payment via Razorpay, or pay-at-counter for
  returning / free-review patients.
- **My Appointment** (`/my-appointment`): phone-number lookup, view / reschedule / pay.
- **Admin dashboard** (`/admin`): live queue with token numbers, walk-in reserve, schedule
  editor (drives availability everywhere), broadcast to a queue, patients list, revenue,
  Bug Desk (error log).
- **Doctor dashboard** (`/doctor`): today's queue + patients, staff-only.
- **WhatsApp channel**: patients can book / view / reschedule / pay by chatting with a bot
  (`lib/bot.ts`) on the clinic's WhatsApp number, plus a structured booking Flow. Admin and
  staff also operate over WhatsApp (broadcast, doctor digest, OTP codes).
- **8 cron automations** (GitHub Actions): backup, reminders, payment-timeout, review-nudge,
  free-visit-nudge, session-digest, bugdesk-digest, doctor-digest.

## 2. Tech stack

- **Next.js** (App Router) + **React** + **TypeScript**, **Tailwind CSS v4**
  (`@import "tailwindcss"` in app/globals.css). See the auto-generated warning at the top of
  this file: this Next version has breaking changes, read `node_modules/next/dist/docs/` before
  writing Next-specific code.
- **Supabase** (`@supabase/ssr` + `@supabase/supabase-js`): Postgres database + auth.
- **Razorpay**: online consultation-fee payments (payment links + webhook).
- **Meta WhatsApp Cloud API** (direct, no BSP): all WhatsApp messaging.
- **Resend**: transactional email (booking/reschedule mails, backup digest).
- **Vercel**: hosting (region `bom1`). GitHub Actions for CI + cron.
- **Vitest**: unit tests. Playwright/cypress not used; UI verification is manual/browser-driven.

## 3. THE core mental model (read first)

Two interchangeable data layers, selected at runtime:
- **DB mode** (production): `NEXT_PUBLIC_SUPABASE_URL` is set -> reads/writes go to Supabase
  through `lib/db.ts`.
- **Mock mode** (dev/demo): that env var is empty -> `lib/store.ts` persists to localStorage.
  `npm run dev` works with zero config. Detect with `hasSupabase()` from `lib/supabase.ts`.

Everything patient-facing reads from **`clinic.config.ts`** (name, doctor title, specialty
list, fees, phone numbers, location, review URL, slot length, languages). Re-skinning for a
new clinic = editing that one file. Never hardcode these values elsewhere.

**Payment invariant (never break):** a new online booking is created as `payment_pending`
and is NOT live until the Razorpay webhook (`/api/payments/webhook`, event
`payment_link.paid`) calls `dbMarkPaidByPaymentLink` and flips it to `reserved`. Nothing on
the website/bot/Flow confirms a booking until that webhook lands. Returning patients
(`returning_unverified`) and free-review visits (`review_free`) claim straight into
`reserved` with no online payment. `proof-never-break`: the booking stores a Razorpay
payment-link id and only the service role may write the Razorpay audit columns (enforced by
a DB trigger, migration `014`).

## 4. Patient-facing flows

**Booking.** Patient picks date + time -> new/returning/free-review declaration -> name +
phone -> creates a `payment_pending` hold (15-min expiry, auto-cancelled by the
payment-timeout cron). New patients pay online via `/api/payments/link` -> Razorpay ->
webhook -> `reserved`. Enforcement rules: one phone cannot hold two unpaid holds
(`PendingHoldError`, enforce with "pay this one first" or "start fresh"); one phone cannot
hold two appointments on the same date+time (`DuplicateSlotError`); a slot picked before
submit can be taken under you (`SlotTakenError`, re-offer fresh slots). Lead time:
`BOOKING_LEAD_MIN = 5 + slotMinutes` (~20 min) - a slot at or before now+lead is not bookable
today (`isPastLeadTime`).

**Appointment self-service.** Phone number is the trust boundary (no patient logins). Lookup
is free; cancel/reschedule/pay on legacy appointments require a one-time WhatsApp OTP proof
when the OTP gate is enabled (`lib/otp.ts`, `otp_challenges` table, template
`ortho_verification_codev1`).

**Availability engine** (`lib/schedule.ts`): the single source of truth for "is the doctor
in?". `statusAt()` returns in / soon / out using schedule windows + per-date exceptions
(`closed`, `windows`, `disabled` slot times, `note`) + a manual front-desk override. It must
use `allSlotsFor()` (which drops `disabled` times), not `windowsFor()` (raw hours) - that
was a real bug where blocked morning slots still showed "in until 12:45". `nowIST()` is the
wall-clock for every "what is today" decision, client AND server (Vercel runs UTC).

**WhatsApp** (`lib/bot.ts`): intent routing (heuristic regex for the beta, Claude-pluggable
in production), a stateful slot picker (day -> window -> range -> time chips), and the five
automations. Ships to BOTH the browser (site chat `RCChat`) and the server (webhook), so it
cannot statically import server-only modules - server-side errors self-fetch to
`/api/bugdesk/report`. Phrase packs are per-language in `P[lang]` (en/te/hi). Notify senders
(`lib/meta-whatsapp.ts`) never throw: they return `Promise<boolean>`; check it and report via
bugdesk. WhatsApp auto-links a URL only if it sits alone on its own line in the message text;
embedded URLs (review links, payment links, maps) must be on their own line.

## 5. Architecture map

```
app/
  page.tsx            Home
  book/               Booking page
  my-appointment/     Self-service lookup
  login/ admin/ doctor/   Staff portals (gated by proxy.ts)
  api/
    book/             Create booking (DB write + notifications)
    slots/            Live availability for pickers (used by site + bot)
    payments/link | webhook/    Razorpay
    appointments/     lookup | reschedule | cancel-status | refund |
                      request-otp | verify-otp | admin-reschedule
    admin/            broadcast | bugdesk | notify-new | whatsapp-invite
    cron/             backup | reminders | payment-timeout | review-nudge |
                      free-visit-nudge | session-digest | bugdesk-digest |
                      doctor-digest
    whatsapp/         webhook + structured Flow endpoint
    bugdesk/report/   Error ingestion (IP rate-limited)
lib/
  clinic.config.ts    Single source of truth (see above)
  db.ts / store.ts    Supabase / localStorage layers. Same shape.
  supabase.ts         hasSupabase() + browser client
  supabase-admin.ts   service-role client (server only)
  schedule.ts         Availability engine + nowIST + booking lead time
  bot.ts              WhatsApp assistant (client + server)
  meta-whatsapp.ts    Graph API sends + signature verify (webhook)
  whatsapp-flow-crypto.ts   Structured Flow payload signing
  razorpay.ts         Payment links + refunds fetch
  otp.ts              OTP gate
  phone.ts            Phone normalization + Indian mobile validation
  i18n.ts             Trilingual site copy (en/te/hi)
  rate-limit.ts       DB-backed limiter (rate_limits table) - use on public routes
  bugdesk.ts          Error desk (report/reportError)
  mailer.ts           Resend email
  csv.ts, refunds.ts, reviews.ts, admin-db.ts, errors.ts, auth-server.ts
proxy.ts              Middleware: auth gate for /admin /doctor /login; staff
                      role routing. Covers all page routes.
```

## 6. Database (Supabase)

Tables: `patients`, `appointments`, `settings`, `staff_emails`, `rate_limits`,
`otp_challenges`, `wa_sessions`, `doctor_digest_sent`, `error_logs` (bugdesk). Staff access
is an allowlist in `staff_emails` checked by RPCs `is_staff()` / `staff_role()`,
NOT an env var. Public signup is on, so a valid Supabase session alone is not proof of staff.
`appointments` gets a `BEFORE INSERT OR UPDATE` trigger (migration `014`) that rejects writes
to the Razorpay columns when `auth.role()` is not `service_role` - client-side dashboards
must never write those. Migrations live in `supabase/migrations/` (001-014); keep
`supabase/schema.sql` idempotent and in sync with them.

## 7. Env vars & services

Full reference with where to get each value: `.env.local.example`. Groups: **Supabase**
(URL, anon key, service-role key - service role is server-only, never browser, never commit),
**Meta WhatsApp** (token, phone-number-id, app secret + `META_APP_SECRET_ALT` for a second
verified Meta app, verify token, per-template names/overrides), **Razorpay** (key id, key
secret, webhook secret, `NEXT_PUBLIC_SITE_URL`), **Resend** (API key), plus **CRON_SECRET**.
`CRON_SECRET` must match between the Vercel env and the GitHub Actions secrets, or cron calls
401 (mismatch silently stops reminders - a known ops trap).

## 8. Deploy, CI, cron

- **Deploy:** pushing to `main` triggers Vercel's git-triggered auto-deploy to production.
  Nothing else deploys. Build happens on Vercel.
- **CI** (`.github/workflows/ci.yml`): lint + test + typecheck + build on every push/PR to
  main. It guards code but does NOT gate the deploy (was tried, deliberately reverted).
- **Cron** (`.github/workflows/*-cron.yml`): each posts `{CRON_SECRET}` to a `/api/cron/*`
  route on a schedule. Check the Actions tab run history for failures.

## 9. Testing

Vitest. `npm test` (alias `vitest run`). Existing coverage is focused on the hard parts:
schedule/availability, booking rules (pending-hold, duplicate-slot, races), phone
normalization, bot intent routing. When you change those, add a test.

## 10. Working conventions (our ways of implementing)

- **Config-driven:** clinic identity, fees, contact, hours defaults all come from
  `clinic.config.ts`.
- **Dual-mode always:** build data paths so they work in both DB and mock mode; gate with
  `hasSupabase()`; keep `lib/db.ts` and `lib/store.ts` the SAME shape.
- **Notifications never break the booking:** every WhatsApp/email send returns a boolean;
  check it and report a bugdesk row on failure, never throw.
- **Report errors server-side via `lib/bugdesk`** (`reportError`/`report`), which writes
  `error_logs` rows visible in /admin's Bug Desk tab.
- **Public routes are rate-limited** via `lib/rate-limit.ts` (DB-backed, shared across
  serverless instances). Do not reintroduce in-memory limits.
- **Trilingual by default:** new user-facing copy needs en + te + hi (site copy in
  `lib/i18n.ts`, bot phrases in `lib/bot.ts`).
- **Phone numbers** go through `lib/phone.ts` `normalizePhone()` on every write/lookup;
  validate `isValidIndianMobile()` (10 digits starting 6-9) on user input.
- **Copy tone (humanizer rule):** no em/en dashes, no AI-sounding phrasing, natural
  conversational Telugu/Hindi. Applies to patient-facing and AI-generation copy.
- **WhatsApp URLs** go on their own line in message text, or Meta won't make them tappable.
- **Doctor name** is "Dr. Ramachandrudu (Rajesh)"; the clinic is "Ramachandra Ortho Care".
  Fees: ₹400 new / ₹350 returning (returning collected at the counter, never online).
- **git:** commits use loksaiasrith123@gmail.com (Vercel requires a verified GitHub email).
  Never add AI attribution lines (no "Co-Authored-By Claude") to commits or PRs. Push to
  main only when asked / at checkpoints - main auto-deploys to prod.
- **Confidential docs** in `docs/internal/` (pricing, valuation, budget) are gitignored. Their
  content must NEVER appear in client-facing output. `docs/` client deliverables (PDFs,
  RUNBOOK.md, REDESIGN docs) are intentionally untracked handover files.

## 11. AI tooling available in the dev environment (MCPs)

These are session-level Claude Code MCP servers, not repo config (no `.mcp.json`):
- **Firecrawl**: web search / scrape / research.
- **Mobbin**: UI screen/flow references (use on UI design work).
- **claude-in-chrome**: browser automation to verify running pages. Verification preference:
  drive Chrome and read the DOM / console output, do NOT rely on screenshots or images as
  proof (the current model is text-only). The big-pickle operating rules: analyze DOM/
  markdown, not screenshots.

## 12. Gotchas / traps

- **This Next.js version differs from training data** - read the docs in
  `node_modules/next/dist/docs/` before Next-specific work.
- **The AGENTS.md top block is auto-re-generated by `next dev`**; committing it with your
  work keeps the tree clean, removing it just comes back.
- **No CSP by design:** a nonce+strict-dynamic CSP was tried and broke statically
  pre-rendered pages (React never hydrated). Other security headers (HSTS, X-Frame-Options,
  XCTO, Referrer-Policy) live in `next.config.ts`; do not re-add a script-nonce CSP.
- **Webhook signatures:** the WABA is on two Meta apps; check `META_APP_SECRET` AND
  `META_APP_SECRET_ALT` (`verifySignature` in `lib/meta-whatsapp.ts`).
- **OTP send quirk:** `sendVerificationCode` must pass the code in the body slot AND the URL
  button param, or Meta rejects the send (#131008).
- **Availability reads must respect `disabled` slots:** use `allSlotsFor()`, not
  `windowsFor()`, when deciding "in / soon / until" - the raw windows include blocked times.
- **Timezone:** every server-side "now" uses `nowIST()`; a bare `new Date()` on Vercel (UTC)
  is up to 5.5h off and can flip the calendar date near midnight IST.
