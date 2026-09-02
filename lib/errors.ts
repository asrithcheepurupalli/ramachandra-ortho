// Shared error types with zero dependencies, so both the client bot engine
// (lib/bot.ts, which pulls in the "use client" lib/store.ts) and server-only
// code (lib/db.ts, API routes) can throw/catch the same class without either
// side accidentally importing the other's runtime.

// Thrown by lib/db.ts's dbAddBooking when a race means someone else booked
// the same date+time first (a unique DB constraint enforces this). Caught by
// /api/book (returns 409) and by botReplyServer, and surfaced to the client
// bot engine via that 409 response.
export class SlotTakenError extends Error {
  constructor() {
    super("slot_taken");
    this.name = "SlotTakenError";
  }
}

// A booking request for a date+time that was never bookable — outside clinic
// hours, on a closed/exception day, or off the slot grid. Different cause
// than SlotTakenError (no race; the slot just isn't open) but extends it so
// every existing `instanceof SlotTakenError` catch (which all just mean "tell
// the patient to pick another time") handles this the same way for free.
export class InvalidSlotError extends SlotTakenError {
  constructor() {
    super();
    this.name = "InvalidSlotError";
  }
}
