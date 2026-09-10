// Covers task #38: two concurrent "Pay now" taps for the same appointment
// must not both mint a live Razorpay link. dbGetOrCreatePaymentLink claims
// the right to create the link with a conditional UPDATE guarded by
// `.is("razorpay_payment_link_id", null)` — only the caller whose UPDATE
// actually matches a row goes on to call Razorpay; the other polls for the
// winner's result instead of minting a second link.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeMockDb, mockDbHolder } from "./mock-db";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => mockDbHolder.current,
}));
// lib/db.ts now also imports the (real, server-only) bugdesk module for its
// fee-mismatch report; these tests never hit that branch, so stub it out rather
// than let server-only throw.
vi.mock("@/lib/bugdesk", () => ({ report: vi.fn(), reportError: vi.fn() }));

const createPaymentLink = vi.fn();
vi.mock("@/lib/razorpay", () => ({
  createPaymentLink: (...args: any[]) => createPaymentLink(...args),
}));

const apptRow = {
  id: "appt-1",
  token: 1,
  name: "Test Patient",
  phone: "9840000000",
  reason: "Consultation",
  appt_date: "2099-01-01",
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
  patient_code: null,
};

beforeEach(() => {
  createPaymentLink.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dbGetOrCreatePaymentLink", () => {
  it("mints exactly one link when there is no contention", async () => {
    const { dbGetOrCreatePaymentLink } = await import("@/lib/db");
    createPaymentLink.mockResolvedValue({ id: "plink_1", short_url: "https://rzp.io/winner" });

    mockDbHolder.current = makeMockDb([
      { data: [apptRow], error: null }, // dbActiveAppointmentsByPhone
      { data: { razorpay_payment_link_id: null, razorpay_payment_link_url: null }, error: null }, // initial read
      { data: { id: "appt-1" }, error: null }, // claim update — this caller wins
      { data: null, error: null }, // final update writing the real link
    ]);

    const url = await dbGetOrCreatePaymentLink("appt-1", "9840000000");

    expect(url).toBe("https://rzp.io/winner");
    expect(createPaymentLink).toHaveBeenCalledTimes(1);
  });

  it("a losing caller returns the winner's link instead of minting a second one", async () => {
    vi.useFakeTimers();
    const { dbGetOrCreatePaymentLink } = await import("@/lib/db");

    mockDbHolder.current = makeMockDb([
      { data: [apptRow], error: null }, // dbActiveAppointmentsByPhone
      { data: { razorpay_payment_link_id: null, razorpay_payment_link_url: null }, error: null }, // initial read
      { data: null, error: null }, // claim update — lost the race (someone else already flipped it)
      // waitForClaimedLink poll: winner's write has now landed
      {
        data: { razorpay_payment_link_id: "plink_1", razorpay_payment_link_url: "https://rzp.io/winner" },
        error: null,
      },
    ]);

    const promise = dbGetOrCreatePaymentLink("appt-1", "9840000000");
    await vi.advanceTimersByTimeAsync(300);
    const url = await promise;

    expect(url).toBe("https://rzp.io/winner");
    expect(createPaymentLink).not.toHaveBeenCalled();
  });

  it("self-heals the claim when Razorpay fails, instead of wedging the slot forever", async () => {
    const { dbGetOrCreatePaymentLink } = await import("@/lib/db");
    createPaymentLink.mockResolvedValue(null);

    mockDbHolder.current = makeMockDb([
      { data: [apptRow], error: null }, // dbActiveAppointmentsByPhone
      { data: { razorpay_payment_link_id: null, razorpay_payment_link_url: null }, error: null }, // initial read
      { data: { id: "appt-1" }, error: null }, // claim update — wins
      { data: null, error: null }, // reset claim back to null after Razorpay failure
    ]);

    await expect(dbGetOrCreatePaymentLink("appt-1", "9840000000")).rejects.toThrow("razorpay_unavailable");
  });
});
