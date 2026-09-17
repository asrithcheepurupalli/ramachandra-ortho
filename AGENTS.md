<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# PROJECT BRIEF - Ramachandra Ortho Care & Clinics

Cold-start brief for any AI model. Read this before touching the code. It tells you what
this project is, how the pieces connect, the invariants you must never break, and the
conventions the codebase follows.

---

## ⚠️ STRICT OPERATIONAL INVARIANT: LIVE PRODUCTION DATA
**Ramachandra Ortho Care is 100% LIVE IN PRODUCTION with REAL PATIENT RECORDS, LIVE APPOINTMENTS, AND REAL PAYMENTS.**
- **NEVER propose, execute, or script destructive database actions (`TRUNCATE TABLE`, `DROP TABLE`, or raw bulk deletes).**
- Any script such as `clear-database.sql` was a pre-go-live one-time purge script and **MUST NEVER BE RUN OR SUGGESTED** in production.
- All database modifications must be non-destructive additive migrations in `supabase/migrations/`.

---

## 1. What this is

A production appointment-management system for a real orthopedic clinic in
Chinnamushidiwada, Visakhapatnam, India. Built by **made. by ac** for the clinic owner
(Dr. Ramachandrudu). Live at https://ramachandraorthocare.com.

Surfaces:
- **Patient website** (`/`): live "Doctor IN/OUT" availability banner, services, map,
  hours, Google reviews, trilingual (English / Telugu / Hindi), structured JSON-LD SEO schema.
- **Booking** (`/book`): live slot picker, online payment via Razorpay, or pay-at-counter for
  returning / free-review patients. Collects Name, Mobile, Age, Gender, Locality.
- **My Appointment** (`/my-appointment`): phone-number lookup, view / reschedule / pay.
- **Admin dashboard** (`/admin`): live queue with token numbers, walk-in reserve, schedule
  editor (drives availability everywhere), broadcast to a queue, patients list, revenue,
  1-click OP Slip printer, Bug Desk (error log).
- **Doctor dashboard** (`/doctor`): today's queue + patients, staff-only.
- **OP Slip Letterhead Printer** (`/print/op-slip`): prints patient metadata (Name, Code, Age,
  Gender, Locality, Mobile, OP Date, 10-day Validity, Token, Time) directly onto pre-printed clinic A4 stationery.
  Features configurable zero-margin layout with calibration sliders (top offset default 48mm, left/right margins,
  font size) auto-saved in `localStorage`.
- **WhatsApp channel**: patients can book / view / reschedule / pay by chatting with a bot
  (`lib/bot.ts`) on the clinic's WhatsApp number, plus a structured booking Flow. Admin and
  staff also operate over WhatsApp (broadcast, doctor digest, OTP codes).
- **8 cron automations** (GitHub Actions): backup, reminders, payment-timeout, review-nudge,
  free-visit-nudge, session-digest, bugdesk-digest, doctor-digest.

## 2. Tech stack

- **Next.js** (App Router, React 19) + **TypeScript**, **Tailwind CSS v4**
  (`@import "tailwindcss"` in app/globals.css). See the auto-generated warning at the top of
  this file: this Next version has breaking changes, read `node_modules/next/dist/docs/` before
  writing Next-specific code.
- **Supabase** (`@supabase/ssr` + `@supabase/supabase-js`): Postgres database + auth.
- **Razorpay**: online consultation-fee payments (payment links + webhook).
- **Meta WhatsApp Cloud API** (direct Graph API v21.0, no BSP): all WhatsApp messaging.
- **Resend**: transactional email (booking/reschedule mails with 1-click OP slip print link, backup digest).
- **Vercel**: hosting (region `bom1`). GitHub Actions for CI + cron.
- **Vitest**: unit tests. Run with `npm test`.

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

## 4. Patient-facing flows & OP Slip System

**Booking.** Patient picks date + time -> new/returning/free-review declaration -> name, phone,
age, gender, locality -> creates a `payment_pending` hold (15-min expiry, auto-cancelled by the
payment-timeout cron). New patients pay online via `/api/payments/link` -> Razorpay ->
webhook -> `reserved`. Enforcement rules:
- One phone cannot hold two unpaid holds (`PendingHoldError`).
- One phone cannot hold two appointments on the same date+time (`DuplicateSlotError`).
- Slot collision handling (`SlotTakenError`).
- Lead time: `BOOKING_LEAD_MIN = 5 + slotMinutes` (~20 min) - a slot at or before now+lead is not bookable today (`isPastLeadTime`).

**Patient Code Sequence:** Real patient codes follow the format `PT#####` starting from `PT29500` (governed by Postgres sequence `patient_code_seq` via migration `017`).

**OP Slip Printing (`/print/op-slip`):**
- Zero-margin A4 print stylesheet (`@page { size: A4 portrait; margin: 0mm !important; }`).
- Fits pre-printed clinic stationery with customizable top offset (default 48mm), left/right margin (15mm), and font size (13pt) calibrated via interactive sliders.
- Displays: Patient Details (Name, `(PT#####)` code, Age Years/ Gender, Locality, Mobile / Phone), Date (`DD/MM/YYYY`), Op Valid up to (+10 days validity), Token Number, and Slot Time.
- Accessible directly from the admin queue row or notification email (`/print/op-slip?name=...&code=...&phone=...&date=...&token=...`).

**Appointment self-service.** Phone number is the trust boundary (no patient logins). Lookup
is free; cancel/reschedule/pay on legacy appointments require a one-time WhatsApp OTP proof
when the OTP gate is enabled (`lib/otp.ts`, `otp_challenges` table, template `ortho_verification_codev1`).

**Availability engine** (`lib/schedule.ts`): the single source of truth for "is the doctor
in?". `statusAt()` returns in / soon / out using schedule windows + per-date exceptions
(`closed`, `windows`, `disabled` slot times, `note`) + a manual front-desk override. It must
use `allSlotsFor()` (which drops `disabled` times), not `windowsFor()` (raw hours).
`nowIST()` is the wall-clock for every "what is today" decision, client AND server (Vercel runs UTC).

**WhatsApp** (`lib/bot.ts`): intent routing, stateful slot picker (batch-loaded to 1 range query per message),
and automations. Dual client/server build. All outgoing WhatsApp messages are logged to `whatsapp_logs` for delivery audit.

## 5. Architecture map

```
app/
  page.tsx            Home (Services, Reviews, Doctor Status, SEO Schema)
  book/               Booking page (Slot picker, Razorpay modal)
  my-appointment/     Self-service lookup & management
  print/op-slip/      Zero-margin A4 OP Slip Letterhead Printer
  login/ admin/ doctor/   Staff portals (gated by proxy.ts)
  api/
    book/             Create booking (DB write + notifications)
    slots/            Live availability for pickers (used by site + bot)
    payments/link | webhook/    Razorpay payment links & webhook
    appointments/     lookup | reschedule | cancel-status | refund |
                      request-otp | verify-otp | admin-reschedule
    admin/            broadcast | bugdesk | notify-new | whatsapp-invite
    cron/             backup | reminders | payment-timeout | review-nudge |
                      free-visit-nudge | session-digest | bugdesk-digest |
                      doctor-digest
    whatsapp/         webhook + structured Flow endpoint
    bugdesk/report/   Error ingestion (IP rate-limited)
lib/
  clinic.config.ts    Single source of truth (contact, fees, slots, doctor info)
  db.ts / store.ts    Supabase / localStorage layers. Same shape.
  supabase.ts         hasSupabase() + browser client
  supabase-admin.ts   service-role client (server only)
  schedule.ts         Availability engine + nowIST + booking lead time
  bot.ts              WhatsApp assistant (client + server)
  meta-whatsapp.ts    Graph API sends + signature verify (webhook) + whatsapp_logs logging
  whatsapp-flow-crypto.ts   Structured Flow payload signing
  razorpay.ts         Payment links + refunds fetch
  otp.ts              OTP gate (otp_challenges)
  phone.ts            Phone normalization + Indian mobile validation
  i18n.ts             Trilingual site copy (en/te/hi)
  rate-limit.ts       DB-backed limiter (rate_limits table) - use on public routes
  bugdesk.ts          Error desk (report/reportError -> error_logs table)
  mailer.ts           Resend email (booking notifications + OP slip link)
  csv.ts, refunds.ts, reviews.ts, admin-db.ts, errors.ts, auth-server.ts
proxy.ts              Middleware: auth gate for /admin /doctor /login; staff
                      role routing. Covers all page routes.
```

## 6. Database (Supabase)

Tables: `patients`, `appointments`, `settings`, `staff_emails`, `rate_limits`,
`otp_challenges`, `wa_sessions`, `doctor_digest_sent`, `session_digest_sent`, `error_logs`, `whatsapp_logs`.

Migrations (`supabase/migrations/`):
- `001_staff_emails.sql`: Staff email allowlist & auth RPCs (`is_staff`, `staff_role`).
- `002_pending_hold_and_rate_limits.sql`: Unpaid booking holds & rate limiter tables.
- `003_age_and_session_digest.sql`: Patient age column and session digest tracking.
- `004_age_not_null.sql`: Age constraint enforcement.
- `005_bugdesk.sql`: Server error logging (`error_logs`).
- `006_self_declared_claims.sql`: Returning patient & free review self-declarations.
- `007_gender.sql`: Patient gender field.
- `008_remove_slot_capacity.sql`: 1-patient-per-slot constraint.
- `009_revoke_anon_staff_rpc.sql`: Security tightening on staff check RPCs.
- `010_duplicate_slot_guard.sql`: Guard against duplicate appointments for same phone/slot.
- `011_review_nudge.sql`: Google review automated follow-up tracking.
- `012_free_visit_nudge.sql`: 10-day free review eligibility reminders.
- `013_expired_payment_nudge.sql`: Abandoned payment recovery nudges.
- `014_lock_razorpay_columns.sql`: DB trigger preventing non-service-role updates to payment audit columns.
- `015_locality.sql`: Locality / area column on appointments.
- `016_whatsapp_logs.sql`: WhatsApp message audit logs table with 7-day retention.
- `017_patient_code_pt29500.sql`: Sequential patient code generation starting from `PT29500`.

## 7. Env vars & services

Full reference in `.env.local.example`.
- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- **Meta WhatsApp:** `META_WHATSAPP_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `META_APP_SECRET_ALT`, `META_VERIFY_TOKEN`, `META_FLOW_PRIVATE_KEY_PASSPHRASE`.
- **Razorpay:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
- **Resend:** `RESEND_API_KEY`.
- **Cron:** `CRON_SECRET` (must match Vercel env and GitHub Actions secrets).

## 8. Deploy, CI, cron

- **Deploy:** Pushing to `main` triggers Vercel auto-deploy to production (`bom1`).
- **CI** (`.github/workflows/ci.yml`):
  Runs `npm run lint` -> `npm test` -> `npx tsc --noEmit` -> `npm run build`.
- **React 19 / ESLint Rule:** `react-hooks/set-state-in-effect` is strictly enforced. Never call `setState` synchronously in a mount `useEffect`; initialize persistent client state with lazy initializers `useState(() => ...)`.

## 9. Testing & Code Quality

- Vitest: `npm test` (49 unit tests covering booking invariants, availability, phone normalization, bot routing).
- Typecheck: `npx tsc --noEmit`.
- Lint: `npm run lint`.
- Build: `npm run build`.

## 10. Working conventions

- **Config-driven:** `clinic.config.ts` is the single source of truth for clinic identity and fees.
- **Dual-mode always:** Keep `lib/db.ts` and `lib/store.ts` identical in shape for zero-config local dev.
- **Notifications never throw:** WhatsApp and email helpers return boolean and log errors to Bug Desk.
- **Indian Mobile Validation:** 10 digits starting with 6-9 (`lib/phone.ts`).
- **Copy tone (humanizer):** Zero em/en dashes, concise, natural copy across English, Telugu, and Hindi.
- **Doctor name:** "Dr. Ramachandrudu (Rajesh)"; clinic: "Ramachandra Ortho Care".
- **Git:** Commits use `loksaiasrith123@gmail.com`. Never add AI attribution lines (`Co-Authored-By Claude`) to commits or PRs. Push to `main` only when asked / at checkpoints.
