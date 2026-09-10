// Covers task #37: the application-level "does this phone already hold a
// payment_pending slot?" check in dbAddBooking is a plain SELECT-then-INSERT
// and can be raced by two concurrent booking attempts for the same phone.
// appointments_pending_hold_idx (a partial unique index — see
// supabase/migrations/002_pending_hold_and_rate_limits.sql) is the real
// guard; dbAddBooking must translate the resulting 23505 into the same
// PendingHoldError the pre-check throws. Also covers the token-collision
// retry loop, since both share one catch block.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeMockDb, mockDbHolder } from "./mock-db";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => mockDbHolder.current,
}));
vi.mock("@/lib/razorpay", () => ({ createPaymentLink: vi.fn() }));
// lib/db.ts now also imports the (real, server-only) bugdesk module for its
// fee-mismatch report; these tests never hit that branch, so stub it out rather
// than let server-only throw.
vi.mock("@/lib/bugdesk", () => ({ report: vi.fn(), reportError: vi.fn() }));

// A Monday at least a couple weeks out so it's never "today" or in the past
// relative to whenever this test actually runs, and default weekly hours
// (Mon–Sat, 10:00–12:30 / 18:00–19:45) have it open. The app's own date math
// (ymd, allSlotsFor) reads dates through LOCAL getters, so the string must be
// built from local getters too — a UTC slice (toISOString) can land a day early
// when IST is behind UTC near midnight, misreading a Monday as Sunday.
function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const scheduleRow = { data: { weekly: null, exceptions: null, override: null }, error: null };
const existingPatient = { data: { id: "patient-1", patient_code: "P0001" }, error: null };

const insertedRow = {
  id: "appt-2",
  token: 2,
  name: "Test Patient",
  phone: "9840000000",
  reason: "Consultation",
  age: 30,
  appt_date: nextMonday(),
  appt_time: "10:00",
  status: "payment_pending",
  source: "website",
  fee: 400,
  paid: false,
  paid_via: null,
  razorpay_payment_id: null,
  razorpay_refund_id: null,
  refunded_at: null,
  reminder_sent_at: null,
  created_at: new Date().toISOString(),
  notes: null,
  patient_code: "P0001",
};

const booking = { name: "Test Patient", phone: "9840000000", age: 30, date: nextMonday(), time: "10:00" };

beforeEach(() => {
  vi.resetModules();
});

describe("dbAddBooking concurrency-sensitive error handling", () => {
  it("translates a pending-hold unique violation into PendingHoldError", async () => {
    const { dbAddBooking } = await import("@/lib/db");
    const { PendingHoldError } = await import("@/lib/errors");

    mockDbHolder.current = makeMockDb([
      scheduleRow, // dbLoadSchedule
      { data: null, error: null }, // expireStalePendingHolds
      { data: [], error: null }, // application-level pending check — passes (race window)
      existingPatient, // patients existing lookup
      { data: [], error: null }, // dayAppts token scan
      {
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "appointments_pending_hold_idx"' },
      }, // insert loses the race at the DB level
    ]);

    await expect(dbAddBooking(booking)).rejects.toBeInstanceOf(PendingHoldError);
  });

  it("retries once on an unrelated token collision and succeeds", async () => {
    const { dbAddBooking } = await import("@/lib/db");

    const mockDb = makeMockDb([
      scheduleRow, // dbLoadSchedule
      { data: null, error: null }, // expireStalePendingHolds
      { data: [], error: null }, // application-level pending check — passes
      existingPatient, // patients existing lookup
      { data: [{ token: 1 }], error: null }, // attempt 1: token scan
      { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "appointments_token_key"' } }, // attempt 1: collides
      { data: [{ token: 1 }, { token: 2 }], error: null }, // attempt 2: token scan (someone else inserted meanwhile)
      { data: insertedRow, error: null }, // attempt 2: succeeds
    ]);
    mockDbHolder.current = mockDb;

    const appt = await dbAddBooking(booking);
    expect(appt.id).toBe("appt-2");
    // Two token scans = two insert attempts, i.e. the retry actually happened.
    expect(mockDb.from).toHaveBeenCalledWith("appointments");
  });
});
