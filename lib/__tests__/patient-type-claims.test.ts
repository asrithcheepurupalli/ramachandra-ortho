// Branch coverage for the patient-type step on the WhatsApp bot. "Book
// appointment" must ask New / Returning / Free review up front (buttons, not a
// dropdown), and each choice must thread the right claim into addBooking:
//   New       → claim undefined → payment_pending hold, completion shows ONLY
//               the Pay now button (the noisy standing-menu dropdown is gone).
//   Returning → claim "returning_unverified" → reserved, ₹returningFee at the
//               counter, instantly confirmed (no pay step), desk email fired.
//   Free review → claim "review_free" → reserved at ₹0, instantly confirmed.
// Also asserts the "cancel" escape hatch still works at this new stage.
import { describe, test, expect } from "vitest";
import { botStartServer, botReplyServer, type Backend } from "@/lib/bot";
import { clinic } from "@/clinic.config";
import type { SchedState, WeeklyHours } from "@/lib/schedule";
import type { Appt } from "@/lib/store";

const WEEKLY: WeeklyHours = {
  0: [],
  1: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
  2: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
  3: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
  4: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
  5: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
  6: [
    { start: "10:00", end: "12:45" },
    { start: "18:00", end: "19:45" },
  ],
};
const sched: SchedState = { weekly: WEEKLY, exceptions: {}, override: null };
const PHONE = "919000000000";

const PATIENT_TYPE_CHIPS = ["New patient", "Returning patient", "Free review visit"];

// A backend that fails loudly if any booking path is actually exercised — used
// for the tests that stop at the patient-type step (re-ask / cancel / free-text
// intents never reach addBooking).
function noBookingBackend(): Backend {
  return {
    addBooking: async () => {
      throw new Error("not needed");
    },
    activeAppointmentsByPhone: () => Promise.resolve([]),
    createPaymentLink: () => Promise.resolve("mock"),
    reactivateExpiredHold: () => Promise.resolve(null),
    reschedule: async () => {
      throw new Error("not needed");
    },
    notifyClaimBooking: () => Promise.resolve(),
  };
}

// Wraps the real Bangkok-webhook bot with a backend that records every
// addBooking's claim (and every claim desk-notification), returning an Appt
// shaped like the real dbAddBooking for that claim (reserved + claimType for
// claims, payment_pending hold otherwise).
function driveBooking() {
  const addCalls: Array<{ claim?: "returning_unverified" | "review_free"; replacePending: boolean }> = [];
  let claimNotified = 0;
  const backend: Backend = {
    addBooking: async (input): Promise<Appt> => {
      addCalls.push({ claim: input.claim, replacePending: input.replacePending === true });
      const claim = input.claim ?? null;
      const fee = claim === "returning_unverified" ? clinic.returningFee : claim === "review_free" ? 0 : clinic.consultationFee;
      return {
        id: "b1", token: 1, name: input.name, phone: input.phone, age: 0, gender: null,
        date: input.date, time: input.time, status: claim ? "reserved" : "payment_pending",
        source: "whatsapp", fee, paid: claim === "review_free", paidVia: claim === "review_free" ? "cash" : null,
        paymentId: null, refundId: null, refundedAt: null, reminderSentAt: null,
        reviewNudgeSentAt: null, freeVisitReminderSentAt: null, cancelReason: null, expiredPaymentNudgedAt: null,
        createdAt: Date.now(), notes: null, patientCode: null,
        claimType: claim, paymentDeadlineAt: claim ? null : Date.now() + 15 * 60 * 1000, locality: null,
      };
    },
    activeAppointmentsByPhone: () => Promise.resolve([]),
    createPaymentLink: () => Promise.resolve("mock"),
    reactivateExpiredHold: () => Promise.resolve(null),
    reschedule: async () => {
      throw new Error("not needed");
    },
    notifyClaimBooking: async () => {
      claimNotified++;
    },
  };

  // Walk: Book appointment → patient type → day → window → range → time → name.
  // Chips[0] always leads somewhere (the uniqueness test proves the walk), so
  // the loop just follows it until the bot asks for a name (chips run out).
  async function walk(patientTypeLabel: string) {
    let state = botStartServer("en").state;
    let input = "Book appointment";
    let out = { reply: [] as string[], chips: [] as string[], state };
    for (let step = 0; step < 8; step++) {
      if (state.stage === "await_name") break;
      out = await botReplyServer(input, "en", state, PHONE, backend, sched, "whatsapp");
      state = out.state;
      // The time-tap reply lands on await_name with no chips — end the picker walk.
      if (state.stage === "await_name") break;
      if (state.stage === "await_patient_type") {
        input = patientTypeLabel;
        continue;
      }
      const next = out.chips[0];
      expect(next, `step ${step} ran out of chips`).toBeTruthy();
      input = next;
    }
    expect(state.stage).toBe("await_name");
    out = await botReplyServer("Test Patient", "en", state, PHONE, backend, sched, "whatsapp");
    state = out.state;
    expect(state.stage).toBe("await_phone");
    // "yes" is an affirmative — keeps the sender's own number as the booking phone.
    out = await botReplyServer("yes", "en", state, PHONE, backend, sched, "whatsapp");
    state = out.state;
    // Bot now collects age, gender, and locality before calling addBooking.
    if (state.stage === "await_age") {
      out = await botReplyServer("30", "en", state, PHONE, backend, sched, "whatsapp");
      state = out.state;
    }
    if (state.stage === "await_gender") {
      out = await botReplyServer("Male", "en", state, PHONE, backend, sched, "whatsapp");
      state = out.state;
    }
    if (state.stage === "await_locality") {
      out = await botReplyServer("Dwaraka Nagar", "en", state, PHONE, backend, sched, "whatsapp");
    }
    return { out, addCalls, claimNotified };
  }

  return { backend, walk };
}

describe("patient type up front", () => {
  test("Book appointment asks New / Returning / Free review as buttons", async () => {
    const state = botStartServer("en").state;
    const out = await botReplyServer("Book appointment", "en", state, PHONE, undefined as never, sched, "whatsapp");
    expect(out.state.stage).toBe("await_patient_type");
    expect(out.chips).toEqual(PATIENT_TYPE_CHIPS);
  });

  test("non-matching input at the patient-type step re-asks", async () => {
    const backend = noBookingBackend();
    const state = botStartServer("en").state;
    let out = await botReplyServer("Book appointment", "en", state, PHONE, backend, sched, "whatsapp");
    expect(out.state.stage).toBe("await_patient_type");
    out = await botReplyServer("garbage", "en", out.state, PHONE, backend, sched, "whatsapp");
    expect(out.state.stage).toBe("await_patient_type");
    expect(out.chips).toEqual(PATIENT_TYPE_CHIPS);
  });

  test("cancel escapes the patient-type step", async () => {
    const backend = noBookingBackend();
    const state = botStartServer("en").state;
    let out = await botReplyServer("Book appointment", "en", state, PHONE, backend, sched, "whatsapp");
    out = await botReplyServer("cancel", "en", out.state, PHONE, backend, sched, "whatsapp");
    expect(out.state.stage).toBe("idle");
    expect(out.chips).not.toEqual(PATIENT_TYPE_CHIPS);
  });

  test("New patient books a hold and completes with ONLY the Pay now button", async () => {
    const { walk } = driveBooking();
    const { out, addCalls } = await walk("New patient");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].claim).toBeUndefined();
    // The dropdown trim: a single Pay now, no doctor-in/about/location/thanks.
    expect(out.chips).toEqual(["Pay now"]);
    const payPrompt = out.reply.join("\n");
    expect(payPrompt).toContain("Pay");
  });

  test("Returning patient books reserved with the counter fee, confirmed with no pay step", async () => {
    const { walk } = driveBooking();
    const { out, addCalls, claimNotified } = await walk("Returning patient");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].claim).toBe("returning_unverified");
    expect(claimNotified).toBe(1); // webhook path fires the desk email itself
    expect(out.chips).not.toContain("Pay now");
    // paid:false but confirmed — the fee is collected at the counter, so the
    // reply is the instant confirmation (quoting the counter fee), not the pay prompt.
    const reply = out.reply.join("\n");
    expect(reply).not.toContain("To confirm your slot");
    expect(reply).toContain(`${clinic.currency}${clinic.returningFee}`);
  });

  test("Free review visit books at ₹0 with no pay step", async () => {
    const { walk } = driveBooking();
    const { out, addCalls, claimNotified } = await walk("Free review visit");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].claim).toBe("review_free");
    expect(claimNotified).toBe(1);
    expect(out.chips).not.toContain("Pay now");
    expect(out.reply.join("\n")).not.toContain("To confirm your slot");
  });

  test("typing returning/free-review free text at idle starts a claim booking with the day picker", async () => {
    const backend = noBookingBackend();
    const state = botStartServer("en").state;
    const returning = await botReplyServer("returning patient", "en", state, PHONE, backend, sched, "whatsapp");
    expect(returning.state.stage).toBe("idle");
    expect((returning.state as { claim?: string }).claim).toBe("returning_unverified");
    expect(returning.chips.length).toBeGreaterThan(0);
    expect(returning.chips).not.toEqual(PATIENT_TYPE_CHIPS);

    const review = await botReplyServer("free review", "en", state, PHONE, backend, sched, "whatsapp");
    expect(review.state.stage).toBe("idle");
    expect((review.state as { claim?: string }).claim).toBe("review_free");
  });
});