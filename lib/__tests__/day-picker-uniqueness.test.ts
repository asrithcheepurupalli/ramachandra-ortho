// Regression: interactive WhatsApp messages must never reuse a row/button id.
// Meta rejects the whole send with error #131009 ("Duplicated row id") when two
// rows in a single list (or two buttons) share an id — and the bot's ids are
// derived from the chip text, so a label collision silently kills the reply.
// The 7-chip day picker used to collide when Sunday was closed
// (Mon..Sat..Mon), which made "Book appointment" appear to do nothing.
// This drives the whole book flow and asserts every chip list is collision-free.
import { describe, test, expect } from "vitest";
import { botStartServer, botReplyServer, type Backend, type ServerBotState } from "@/lib/bot";
import { type SchedState } from "@/lib/schedule";

const WEEKLY: SchedState["weekly"] = {
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

const backend: Backend = {
  addBooking: () => {
    throw new Error("not needed");
  },
  activeAppointmentsByPhone: () => Promise.resolve([]),
  createPaymentLink: () => Promise.resolve("mock"),
  reschedule: () => {
    throw new Error("not needed");
  },
  notifyClaimBooking: () => Promise.resolve(),
};

function unique(arr: string[]): boolean {
  return new Set(arr).size === arr.length;
}

test("book flow chips never collide (interactive id safety)", async () => {
  const start = botStartServer("en");
  // The production route persists BotState and reloads it per message — the
  // stage/pending* fields carry everything, so each reply feeds its own state
  // back in, exactly as the webhook does. No lastChips needed.
  let state: ServerBotState = start.state;
  let input = "Book appointment";
  const seen = new Set<string>();
  for (let step = 0; step < 6; step++) {
    const out = await botReplyServer(input, "en", state, "919000000000", backend, sched, "whatsapp");
    console.log(`step ${step}: input="${input}" -> chips=${JSON.stringify(out.chips)}`);
    if (!unique(out.chips)) {
      const dup = out.chips.find((c) => seen.has(c));
      throw new Error(`duplicate chip in one message: "${dup}" — Meta would reject this send (#131009)`);
    }
    out.chips.forEach((c) => seen.add(c));
    state = out.state;
    const next = out.chips[0];
    if (!next || next === input) break;
    input = next;
  }
});