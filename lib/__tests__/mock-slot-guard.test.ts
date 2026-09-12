// Covers the MOCK_MODE twin of the DB same-slot duplicate guard: addBooking in
// lib/store.ts must throw DuplicateSlotError for the same phone + date + time
// (instead of stacking a second token) while still allowing a different time,
// a replacePending start-over, a fresh claim, and a different phone on the same
// slot. Mirrors lib/db.ts dbAddBooking so the demo behaves like production.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The store is localStorage-backed; Node has none, so install a Map-backed one
// before the module loads. resetModules() between tests keeps the in-memory
// read cache from leaking across cases.
function stubStorage() {
  const data = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (data.has(k) ? data.get(k) : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  } as unknown as Storage;
}

// A date comfortably in the future: the only constraint addBooking enforces is
// the lead-time guard (slot availability isn't checked in the mock), so any
// far-out weekday passes.
function futureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

beforeEach(() => {
  stubStorage();
  vi.resetModules();
});

describe("mock addBooking same-slot duplicate guard", () => {
  // A fresh website booking lands in payment_pending, where the older
  // pending-hold guard fires before this one — which is correct. The duplicate
  // guard matters once that slot is PAID and reserved (the pending guard no
  // longer sees a hold, so a same-slot rebooking must be caught here). Pay the
  // first booking before asserting it.
  it("blocks a second booking on the same date + time for the same phone", async () => {
    const { addBooking, togglePaid } = await import("@/lib/store");
    const { DuplicateSlotError } = await import("@/lib/errors");
    const date = futureDate();
    const first = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00" });
    togglePaid(first.id); // webhook flips payment_pending -> reserved
    expect(() => addBooking({ name: "Anil K", phone: "9840012345", age: 31, date, time: "10:00" }))
      .toThrow(DuplicateSlotError);
  });

  it("matches a 91-prefixed duplicate against a locally-stored number", async () => {
    const { addBooking, togglePaid } = await import("@/lib/store");
    const { DuplicateSlotError } = await import("@/lib/errors");
    const date = futureDate();
    const first = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00" });
    togglePaid(first.id);
    expect(() => addBooking({ name: "Anil", phone: "919840012345", age: 30, date, time: "10:00" }))
      .toThrow(DuplicateSlotError);
  });

  it("still allows a different time once the earlier slot is paid", async () => {
    const { addBooking, togglePaid } = await import("@/lib/store");
    const date = futureDate();
    const first = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00" });
    togglePaid(first.id); // clear the payment_pending hold so a second slot is legal
    const second = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:30" });
    expect(second.time).toBe("10:30");
    expect(second.token).toBeGreaterThan(1);
  });

  it("a different phone can still take the same slot", async () => {
    const { addBooking } = await import("@/lib/store");
    const date = futureDate();
    addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00" });
    const other = addBooking({ name: "Bindu", phone: "9790001234", age: 28, date, time: "10:00" });
    expect(other.phone).toBe("9790001234");
  });

  it("replacePending start-over cancels the old hold and books the slot fresh", async () => {
    const { addBooking } = await import("@/lib/store");
    const date = futureDate();
    const first = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00" });
    expect(first.status).toBe("payment_pending");
    const fresh = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00", replacePending: true });
    expect(fresh.status).toBe("payment_pending");
    expect(fresh.token).toBeGreaterThan(first.token);
  });

  it("claims the slot once; a repeat claim on it is a duplicate", async () => {
    const { addBooking } = await import("@/lib/store");
    const { DuplicateSlotError } = await import("@/lib/errors");
    const date = futureDate();
    const claimed = addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00", claim: "review_free" });
    expect(claimed.status).toBe("reserved");
    expect(() => addBooking({ name: "Anil", phone: "9840012345", age: 30, date, time: "10:00", claim: "review_free" }))
      .toThrow(DuplicateSlotError);
  });
});