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
