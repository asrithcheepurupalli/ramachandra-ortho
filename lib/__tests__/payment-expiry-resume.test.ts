// Covers the payment-expiry resume path: dbReactivateExpiredHold revives a
// phone's most recent payment-expired hold so the patient can pay for the same
// booking with a FRESH Razorpay link, and the integration test proves the full
// closed loop — revived row → dbGetOrCreatePaymentLink mints a new link →
// dbMarkPaidByPaymentLink (the payment_link.paid webhook) flips it to reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeMockDb, mockDbHolder } from "./mock-db";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => mockDbHolder.current,
}));
vi.mock("@/lib/bugdesk", () => ({ report: vi.fn(), reportError: vi.fn() }));

const createPaymentLink = vi.fn();
vi.mock("@/lib/razorpay", () => ({
  createPaymentLink: (...args: any[]) => createPaymentLink(...args),
}));

// A full appointment row shaped like lib/db.ts's DbApptRow. The revived /
// confirmed rows the mock queue hands back carry every column rowToAppt reads.
const row = {
  id: "appt-1",
  token: 1,
  name: "Test Patient",
  phone: "9840000000",
  age: 30,
  gender: "M",
  appt_date: "2099-01-01",
  appt_time: "10:00",
  status: "payment_pending",
  source: "whatsapp",
  fee: 400,
  paid: false,
  paid_via: null,
  razorpay_payment_id: null,
  razorpay_refund_id: null,
  refunded_at: null,
  reminder_sent_at: null,
  created_at: new Date().toISOString(),
  notes: null,
  patient_code: null,
  claim_type: null,
  review_nudge_sent_at: null,
  free_visit_reminder_sent_at: null,
  cancel_reason: "payment_timeout",
  expired_payment_nudged_at: null,
  patient_id: "pat-9",
  razorpay_payment_link_id: null,
  razorpay_payment_link_url: null,
};

const cancelledCandidate = { id: "appt-1", appt_date: "2099-01-01", appt_time: "10:00" };

const reservedRow = { ...row, status: "reserved", paid: true, paid_via: "razorpay", razorpay_payment_id: "pay_XYZ" };

beforeEach(() => {
  createPaymentLink.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dbReactivateExpiredHold", () => {
  it("revives the newest timeout-cancelled hold", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: cancelledCandidate, error: null }, // primary: timeout-cancelled candidate
      { data: [], error: null },                  // pending-hold guard: none
      { data: [], error: null },                  // same-slot guard: none
      { data: row, error: null },                 // revive UPDATE result
    ]);

    const revived = await dbReactivateExpiredHold("9840000000");

    expect(revived).not.toBeNull();
    expect(revived?.status).toBe("payment_pending");
    expect(revived?.cancelReason).toBe("payment_timeout");
    expect(revived?.expiredPaymentNudgedAt).toBeNull();
  });

  it("returns null for a cancel that was not a payment timeout", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null }, // no 'payment_timeout'-cancelled row
      { data: null, error: null }, // fallback: no stale pending hold either
    ]);

    expect(await dbReactivateExpiredHold("9840000000")).toBeNull();
  });

  it("refuses while the phone already holds another payment_pending row", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: cancelledCandidate, error: null }, // primary: candidate found
      { data: [{ id: "appt-2" }], error: null }, // pending-hold guard: blocked
    ]);

    expect(await dbReactivateExpiredHold("9840000000")).toBeNull();
  });

  it("refuses when an active row already occupies the candidate's slot", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: cancelledCandidate, error: null }, // primary: candidate found
      { data: [], error: null },                  // pending-hold guard: clear
      { data: [{ id: "other-1" }], error: null }, // same-slot guard: blocked
    ]);

    expect(await dbReactivateExpiredHold("9840000000")).toBeNull();
  });

  it("falls back to refreshing a stale payment_pending hold the cron lagged on", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null },                 // primary: no cancelled row yet
      { data: cancelledCandidate, error: null },   // fallback: stale pending candidate
      { data: [], error: null },                   // pending-hold guard (candidate itself excluded)
      { data: [], error: null },                   // same-slot guard: none
      { data: row, error: null },                  // revive UPDATE result
    ]);

    const revived = await dbReactivateExpiredHold("9840000000");

    expect(revived).not.toBeNull();
    expect(revived?.status).toBe("payment_pending");
  });

  it("returns null when nothing matches", async () => {
    const { dbReactivateExpiredHold } = await import("@/lib/db");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null },
      { data: null, error: null },
    ]);

    expect(await dbReactivateExpiredHold("9840000000")).toBeNull();
  });

  it("integration: revived row pays via a fresh link and the webhook closes the loop", async () => {
    const { dbReactivateExpiredHold, dbGetOrCreatePaymentLink, dbMarkPaidByPaymentLink } = await import("@/lib/db");
    createPaymentLink.mockResolvedValue({ id: "pl2", short_url: "https://rzp.io/fresh" });

    mockDbHolder.current = makeMockDb([
      { data: cancelledCandidate, error: null }, // revive: candidate
      { data: [], error: null },                  // revive: pending-hold guard
      { data: [], error: null },                  // revive: same-slot guard
      { data: row, error: null },                 // revive: UPDATE result
      { data: [row], error: null },               // link mint: active appointments
      { data: { razorpay_payment_link_id: null, razorpay_payment_link_url: null }, error: null }, // link mint: initial read
      { data: { id: "appt-1" }, error: null },    // link mint: claim update (wins)
      { data: null, error: null },                // link mint: final write of the new URL
      { data: { id: "appt-1", status: "payment_pending", fee: 400 }, error: null }, // webhook: read row
      { data: reservedRow, error: null },         // webhook: flip to reserved
    ]);

    const revived = await dbReactivateExpiredHold("9840000000");
    expect(revived?.status).toBe("payment_pending");

    const url = await dbGetOrCreatePaymentLink("appt-1", "9840000000");
    expect(url).toBe("https://rzp.io/fresh");

    const confirmed = await dbMarkPaidByPaymentLink("pl2", "pay_XYZ");
    expect(confirmed?.status).toBe("reserved");
    expect(confirmed?.paid).toBe(true);
  });
});