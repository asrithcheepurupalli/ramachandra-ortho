// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp assistant engine. Intent routing + the appointment flow + the four
// automations (confirm / cancel / reminder / availability), in te/en/hi.
//
// For the beta demo this runs on lightweight on-device intent matching so it
// works with zero config. In production the same handlers are driven by Claude
// (Anthropic API) for free-text understanding — the shapes below map 1:1.
// ─────────────────────────────────────────────────────────────────────────────
import { clinic, type Lang } from "@/clinic.config";
import { statusAt, fmt, weekdayName, allSlotsFor, windowsFor, ymd, nowIST, BOOKING_LEAD_MIN, type SchedState, type Window } from "@/lib/schedule";
import { addBooking, togglePaid, activeAppointmentsByPhone, rescheduleBooking, type Source, type Appt } from "@/lib/store";
import { hasSupabase } from "@/lib/supabase";
import { SlotTakenError, PendingHoldError } from "@/lib/errors";

// Report an issue from the bot engine to the bug desk. The same file ships to
// the browser (website chat: RCChat) AND the server (WhatsApp webhook), so it
// cannot statically import the server-only bugdesk module. Instead, when
// running server-side it does a self-fetch to the IP-rate-limited ingestion
// route (/api/bugdesk/report), which forwards on to the desk — same
// persistence, zero import-graph risk in the client bundle. On the client the
// browser console is the only sink — the chat already surfaces a patient-facing
// failure to the user.
async function reportBotError(
  source: string,
  message: string,
  info: Record<string, unknown> | undefined,
  err: unknown,
  opts?: { severity?: "critical" | "warning" }
): Promise<void> {
  console.error(source, message, err ?? "", info ?? {});
  if (typeof window === "undefined") {
    try {
      await fetch(`${clinic.url}/api/bugdesk/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          message,
          severity: opts?.severity ?? "warning",
          info,
        }),
        // Never let a slow/hung desk hold up a webhook ack or booking tail.
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      // A broken reporter must never break the bot.
      console.error("bugdesk: report failed", e);
    }
  }
}

export type Sender = "bot" | "user";
export type ChatMsg = { id: string; from: Sender; text: string };
// pendingDate: set once a day chip has been tapped, so the *next* chip tap is
// resolved as a time within that day rather than re-matching the day list —
// this is what lets the bot walk a patient into tomorrow or any future date
// instead of only ever surfacing the single nearest day with openings.
// pendingWindow: set once the day's slots span more than one window and the
// patient has picked one (e.g. morning vs evening) — narrows the time chips
// shown next instead of dumping every open slot across the whole day in one
// message. A day with only a single window skips straight to it.
// pendingRange: a window can still hold more open slots than fit one chip
// screen (the default 10-12:30 window alone is 15 slots at a 10-min grid) —
// once picked, if it's still over MAX_CHIPS, this narrows further to a
// sub-range of that window before finally listing individual times.
export type BotState = {
  stage:
    | "idle"
    // WhatsApp only: a brand-new phone number lands here before any greeting,
    // same gate the website's language switcher gives a visitor up front.
    | "await_lang"
    | "await_name"
    | "await_phone"
    | "await_pay_pick"
    | "await_pay_phone"
    | "await_view_phone"
    | "await_resched_phone"
    | "await_resched_pick"
    | "await_otp";
  slot?: Slot;
  name?: string;
  pendingDate?: string;
  pendingWindow?: Window;
  pendingRange?: Window;
  // reschedule target: which appointment (id) to move, booked under which phone.
  // Set once a booking is chosen, carried through the day/window/time picker, and
  // committed (cleared) when a new time is tapped. On WhatsApp the phone is the
  // sender's own; on the website chat it's the number the patient typed + OTP-gated.
  resched?: { id: string; phone: string };
  reschedCandidates?: CancelCandidate[]; // pick-one when the phone has several active
  payCandidates?: PayCandidate[]; // pick-one when the phone has several unpaid
  reschedPhone?: string; // website chat: owning phone while picking which booking to move
  reschedOtp?: boolean; // website chat: whether this reschedule needs the WhatsApp code
  otpPhone?: string; // website chat: phone awaiting the 6-digit WhatsApp code
  viewPhone?: string; // website chat: phone whose appointments were just listed
  replacePending?: boolean; // carry "start fresh" intent through the booking flow
};
// Stages the "cancel" escape hatch checks against, shared by the client and
// server bot so a future stage addition can't silently drift between them.
const MID_FLOW_STAGES: BotState["stage"][] = [
  "await_name", "await_phone", "await_pay_pick", "await_pay_phone",
  "await_view_phone", "await_resched_phone", "await_resched_pick", "await_otp",
];
// A candidate appointment shown when a cancel request is ambiguous (more
// than one active appointment on the requesting phone) — label is what's
// shown as a chip and matched back verbatim if tapped.
export type CancelCandidate = { id: string; token: number; name: string; label: string };
// Same shape, for the analogous "which appointment do you want to pay for?"
// disambiguation when a phone has more than one active, unpaid appointment.
export type PayCandidate = { id: string; token: number; name: string; label: string };
export type BotOut = { reply: string[]; chips: string[]; state: BotState };
type Slot = { date: string; time: string; label: string };

const uid = () => Math.random().toString(36).slice(2, 9);
export const mkMsg = (from: Sender, text: string): ChatMsg => ({ id: uid(), from, text });

export { SlotTakenError, PendingHoldError } from "@/lib/errors";

const cur = clinic.currency, fee = clinic.consultationFee, dr = clinic.doctor.name;

// ── next open slots (for the in-chat booking) ───────────────────────────────
// Real availability, not a fixed count: every open slot on the nearest day
// that has one (site chat has no WhatsApp-style 3/10-button cap, so there's no
// reason to truncate). In DB mode this reads the same live-availability route
// the booking page uses, so RC never offers a slot someone else just took.
async function availableSlotsFor(date: string): Promise<string[]> {
  if (hasSupabase()) {
    try {
      const res = await fetch(`/api/slots?date=${date}`);
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.slots) ? data.slots : [];
    } catch (err) {
      console.error("bot: slot list unavailable", err);
      return [];
    }
  }
  return allSlotsFor(new Date(date + "T00:00:00"));
}
type DayChip = { date: string; label: string };
const MAX_DAY_CHIPS = 7; // a week's worth — plenty of future dates without a giant chip list

function dayLabelForOffset(i: number, d: Date): string {
  return i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekdayName(d).slice(0, 3);
}
// Recovers the same "Today"/"Tomorrow"/weekday label from a bare date key,
// for when a date is already known (state.pendingDate) instead of being
// discovered by walking the 14-day window from i=0.
function dayLabelForDate(date: string, now: Date): string {
  const target = new Date(date + "T00:00:00");
  const base = new Date(now); base.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - base.getTime()) / 86_400_000);
  return dayLabelForOffset(diffDays, target);
}

// Days (not slots) that have at least one open slot, nearest first — the
// "which day?" step of the book flow, so a patient can reach any upcoming
// date instead of only ever being shown the single nearest open day.
async function openDays(): Promise<DayChip[]> {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: DayChip[] = [];
  for (let i = 0; i < 14 && out.length < MAX_DAY_CHIPS; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const key = ymd(d);
    let slots = await availableSlotsFor(key);
    if (i === 0) slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + BOOKING_LEAD_MIN; });
    if (slots.length) out.push({ date: key, label: dayLabelForOffset(i, d) });
  }
  return out;
}
async function timesForDate(date: string): Promise<string[]> {
  const now = new Date();
  let slots = await availableSlotsFor(date);
  if (date === ymd(now)) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + BOOKING_LEAD_MIN; });
  }
  return slots;
}

// "HH:MM" is zero-padded 24h, so plain string comparison sorts/bounds the
// same as numeric minutes would — no need for a separate toMin() here.
const inWindow = (t: string, w: Window) => t >= w.start && t < w.end;
const windowLabel = (w: Window) => `${fmt(w.start)}-${fmt(w.end)}`;

// WhatsApp's list message caps at 10 rows, so this is the hard ceiling for
// any single chip screen (day, window, range, or time). A window's own open
// times can exceed it on a fresh day (10-12:30 alone is 15 slots at the
// clinic's 10-min grid) — splitWindow below bisects it further so the
// patient always taps through a short list, never reads a numbered dump.
const MAX_CHIPS = 10;
const toMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMinutes = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Bisects a window into evenly-sized sub-ranges so each holds at most
// MAX_CHIPS open slots — e.g. a 15-slot 10-12:30 window becomes two ~7-8
// slot ranges. Returns [w] unchanged when it's already short enough.
function splitWindow(w: Window, slotCount: number): Window[] {
  const parts = Math.ceil(slotCount / MAX_CHIPS);
  if (parts <= 1) return [w];
  const start = toMinutes(w.start), end = toMinutes(w.end);
  const step = (end - start) / parts;
  const out: Window[] = [];
  for (let i = 0; i < parts; i++) {
    const s = Math.round(start + step * i);
    const e = i === parts - 1 ? end : Math.round(start + step * (i + 1));
    out.push({ start: fromMinutes(s), end: fromMinutes(e) });
  }
  return out;
}

// Only the windows that day actually has an open slot in — a day whose
// evening window is fully booked shouldn't offer an empty "Evening" option.
async function windowsWithSlotsFor(date: string): Promise<Window[]> {
  const times = await availableSlotsFor(date);
  return windowsFor(new Date(date + "T00:00:00")).filter((w) => times.some((t) => inWindow(t, w)));
}

// ── phrase packs ────────────────────────────────────────────────────────────
type PhrasePack = {
  greet: string;
  availIn: (u: string) => string;
  availSoon: (t: string) => string;
  availOut: (d: string, t: string) => string;
  availNone: string;
  bookIntro: string;
  pickDay: string;
  pickWindow: (day: string) => string;
  pickRange: (day: string) => string;
  timesFor: (day: string) => string;
  timesForWindow: (day: string, win: string) => string;
  dayFull: (day: string) => string;
  noSlots: string;
  askName: string;
  askPhone: string;
  askContactConfirm: (phone: string) => string;
  badPhone: string;
  slotTaken: string;
  bookFail: string;
  // A second booking attempt while a payment_pending hold is already on the
  // number. Refused so the patient finishes the first hold (pay or let it
  // expire) instead of stacking unpaid slots / a wrong returning fee.
  pendingHold: string;
  // One-shot equivalents of slotTaken/bookFail for the WhatsApp Flow's
  // structured booking submission, which has no chat turn to follow up in —
  // phrased as "message us again" rather than "here are other times".
  flowSlotTaken: string;
  flowBookFail: string;
  confirm: (tok: number, s: string, feeAmt: number) => string;
  // Self-declared payment exemptions (verified in person at the counter, no
  // online payment step). See claimCounterConfirm/claimFreeConfirm below.
  claimCounterConfirm: (tok: number, s: string, feeAmt: number) => string;
  claimFreeConfirm: (tok: number, s: string) => string;
  cancelAsk: string;
  payNone: string;
  payWhich: string;
  payNotFound: string;
  payDone: (url: string) => string;
  payFail: string;
  payMock: string;
  payPrompt: string;
  viewPrompt: string;
  reschedPrompt: string;
  viewNone: string;
  viewIntro: string;
  reschedWhich: string;
  reschedNotFound: string;
  otpSent: (phone: string) => string;
  otpBad: string;
  otpExpired: string;
  otpFail: string;
  reschedDone: (s: string) => string;
  reschedFail: string;
  flowCancelled: string;
  hours: string;
  location: string;
  about: string;
  fallback: string;
  thanks: string;
  chips: { avail: string; book: string; view: string; resched: string; timings: string; location: string; about: string; done: string; useNumber: string; payNow: string; startOver: string; payCounter: string; reviewFree: string };
};

// Appointment times are estimates, stated once at booking-complete: a patient's
// slot can slip with how earlier consultations and the doctor's pace run that
// day, so nobody should plan their visit to the minute.
const WAIT_NOTE: Record<Lang, string> = {
  en: "Appointment times are estimates. Earlier consultations and the doctor's availability can push things back, usually by 30 minutes to an hour, so allow a little extra time when you plan to arrive.",
  te: "అపాయింట్‌మెంట్ సమయం అంచనా మాత్రమే. మీకంటే ముందు ఉన్న కన్సల్టేషన్లు, డాక్టర్ లభ్యతను బట్టి సమయం వెనక్కి నెట్టవచ్చు, సాధారణంగా 30 నిమిషాల నుంచి ఒక గంట వరకు. రావాల్సినప్పుడు కొంచెం అదనపు సమయం పెట్టుకోండి.",
  hi: "अपॉइंटमेंट का समय सिर्फ एक अनुमान है। पहले की सलाह और डॉक्टर की उपलब्धता के आधार पर इसमें आमतौर पर 30 मिनट से एक घंटे तक की देरी हो सकती है। आने के लिए थोड़ा अतिरिक्त समय रखें।",
};

const P: Record<Lang, PhrasePack> = {
  en: {
    greet: `Namaste 🙏 I'm the assistant for ${clinic.shortName}. How can I help you today?`,
    availIn: (u: string) => `✅ Yes, ${dr} is in today, until ${u}. Tap *Book appointment* to reserve a token.`,
    availSoon: (t: string) => `${dr} consults today from ${t}. Tap *Book appointment* to reserve a slot.`,
    availOut: (d: string, t: string) => `${dr} is *not in today*. The next available is *${d} at ${t}*. Tap *Book appointment* to reserve.`,
    availNone: `${dr} has no slots in the coming days. Please call the clinic on ${clinic.contact.phone}.`,
    bookIntro: "Sure! Here are the open slots. Tap the one you want:",
    pickDay: "Sure! Here are the days with open slots. Tap one:",
    pickWindow: (day: string) => `Sure! For ${day}, would you prefer morning or evening?`,
    pickRange: (day: string) => `That's a lot of open times for ${day}. Pick a range:`,
    timesFor: (day: string) => `Great, here are the open times for ${day}:`,
    timesForWindow: (day: string, win: string) => `Great, here are the open times for ${day} (${win}):`,
    dayFull: (day: string) => `Sorry, ${day} just got fully booked. Please pick another day:`,
    noSlots: "There are no open slots right now. Please try later, or call the clinic.",
    askName: "Great choice. What name should I book it under?",
    askPhone: "And your phone number? We'll send the booking confirmation on WhatsApp.",
    askContactConfirm: (phone: string) => `We'll use *${phone}* as the contact number for this booking. Tap *Use this number* to confirm, or send a different number.`,
    badPhone: "That doesn't look like a valid phone number. Please enter a 10 digit number.",
    slotTaken: "Sorry, someone just booked that slot. Here are the times still open:",
    bookFail: "Something went wrong while booking. Please try again, or call the clinic.",
    pendingHold: "You already have a booking waiting for payment. Please complete that payment now to confirm your slot — an unpaid booking is released automatically after 15 minutes. Or tap *Start fresh* to cancel it and book a new slot.",
    flowSlotTaken: "Sorry, that slot was just taken. Please message us again to pick another time.",
    flowBookFail: "Something went wrong booking that. Please message us and we'll sort it out.",
    confirm: (tok: number, s: string, feeAmt: number) => `✅ *Slot held!* Your token is *#${tok}* for ${s}.\n${dr} · ${cur}${feeAmt}. It's *held for 30 minutes* — complete the consultation fee payment to confirm the appointment.\nMissed your slot? It's automatically moved to the next working day, no need to rebook.\n${WAIT_NOTE.en}`,
    claimCounterConfirm: (tok: number, s: string, feeAmt: number) => `✅ *Booked!* Your token is *#${tok}* for ${s}.\n${dr} · ${cur}${feeAmt} at the counter when you arrive. No online payment needed, the desk will verify and collect it there.\nMissed your slot? It's automatically moved to the next working day, no need to rebook.\n${WAIT_NOTE.en}`,
    claimFreeConfirm: (tok: number, s: string) => `✅ *Booked!* Your token is *#${tok}* for ${s}.\n${dr} · this review visit is free, nothing to pay.\nMissed your slot? It's automatically moved to the next working day, no need to rebook.\n${WAIT_NOTE.en}`,
    cancelAsk: `Cancellations are handled by the clinic, so I can't cancel it for you here. Would you like to move it to a new time instead? Tap *Reschedule*, or call the clinic on ${clinic.contact.phone} to cancel.`,
    payNone: "You don't have any unpaid appointments right now.",
    payWhich: "You have a few unpaid appointments. Tap the one you'd like to pay for:",
    payNotFound: "I couldn't match that to one of your unpaid appointments. Please tap an option above, or reply with the exact token number or name.",
    payDone: (url: string) => `Here's your payment link: ${url}\nIt's valid for 30 minutes. Please complete it before your slot is released.`,
    payFail: "Something went wrong starting the payment. Please try again, or call the clinic.",
    payMock: "✅ Payment confirmed! Your appointment is now confirmed.",
    payPrompt: "To confirm your slot, please complete the consultation fee payment now. Tap *Pay now* to pay online.",
    viewPrompt: "Of course. Which phone number did you book with?",
    reschedPrompt: "Sure, let's move your appointment. Which phone number did you book with?",
    viewNone: "You don't have any upcoming appointments on this number.",
    viewIntro: "Here's what I found for this number:",
    reschedWhich: "You have a few bookings on this number. Tap the one to move:",
    reschedNotFound: "I couldn't match that to one of your bookings to move. Please tap an option above, or reply with the exact token number or name.",
    otpSent: (phone: string) => `To move your appointment we'll verify it's you. We sent a 6-digit code on WhatsApp to *${phone}*. Type the code here.`,
    otpBad: "That code didn't match. Check it and try again.",
    otpExpired: "That code has expired. Tap *Reschedule* to send a fresh one.",
    otpFail: "We couldn't verify your number right now. Please try again, or open *My Appointment* on the site.",
    reschedDone: (s: string) => `✅ Moved! Your appointment is now *${s}*. A confirmation has been sent on WhatsApp.`,
    reschedFail: "Something went wrong moving your appointment. Please try again, or call the clinic.",
    flowCancelled: "No problem, stopped that. Tap *Book appointment* whenever you're ready. 🙏",
    hours: `🕒 Consulting hours:\nMon-Sat 10 AM-12:30 PM & 6-7:45 PM. Sunday closed.\nConsultation is ${cur}${fee}.\n🚑 Medical emergency? Call ${clinic.contact.emergency}.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.\n🗺️ Directions: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}*\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\nSpecialties: ${clinic.doctor.specialties.join(", ")}.\nRated ${clinic.rating.score}★ from ${clinic.rating.count}+ ${clinic.rating.source} reviews.\n\nEnjoyed your visit? Leave us a review: ${clinic.rating.reviewUrl}`,
    fallback: "I can tell you if the doctor is in, tell you about the doctor, book you an appointment, or share timings and location. What would you like?",
    thanks: `You're welcome 🙏 Get well soon! If you have a moment, a quick Google review helps other patients find us: ${clinic.rating.reviewUrl}`,
    chips: { avail: "Is the doctor in today?", book: "Book appointment", view: "View my appointment", resched: "Reschedule", timings: "Timings & fees", location: "Location", about: "About the doctor", done: "Thanks!", useNumber: "Use this number", payNow: "Pay now", startOver: "Start fresh", payCounter: "Returning patient, pay at counter", reviewFree: "Free review visit" },
  },
  te: {
    greet: `నమస్కారం 🙏 నేను ${clinic.shortName} అసిస్టెంట్‌ని. మీకు ఎలా సహాయపడగలను?`,
    availIn: (u: string) => `✅ అవును, ${dr} ఈరోజు ${u} వరకు అందుబాటులో ఉన్నారు. టోకెన్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availSoon: (t: string) => `${dr} ఈరోజు ${t} నుండి చూస్తారు. స్లాట్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availOut: (d: string, t: string) => `${dr} ఈరోజు *అందుబాటులో లేరు*. తర్వాత అందుబాటు: *${d}, ${t}*. బుక్ చేయడానికి *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availNone: `రాబోయే రోజుల్లో స్లాట్‌లు లేవు. దయచేసి క్లినిక్‌కు కాల్ చేయండి: ${clinic.contact.phone}.`,
    bookIntro: "తప్పకుండా! ఖాళీగా ఉన్న స్లాట్‌లు ఇవి. మీకు కావలసినది నొక్కండి:",
    pickDay: "తప్పకుండా! ఖాళీ స్లాట్‌లు ఉన్న రోజులు ఇవి. ఒకటి నొక్కండి:",
    pickWindow: (day: string) => `సరే! ${day} కోసం, ఉదయం లేదా సాయంత్రం, ఏది కావాలి?`,
    pickRange: (day: string) => `${day} కోసం చాలా సమయాలు ఖాళీగా ఉన్నాయి. ఒక పరిధిని ఎంచుకోండి:`,
    timesFor: (day: string) => `సరే, ${day} కోసం ఖాళీగా ఉన్న సమయాలు ఇవి:`,
    timesForWindow: (day: string, win: string) => `సరే, ${day} (${win}) కోసం ఖాళీగా ఉన్న సమయాలు ఇవి:`,
    dayFull: (day: string) => `క్షమించండి, ${day} ఇప్పుడే పూర్తిగా బుక్ అయ్యింది. దయచేసి వేరే రోజు ఎంచుకోండి:`,
    noSlots: "ప్రస్తుతం స్లాట్‌లు లేవు. దయచేసి తర్వాత ప్రయత్నించండి లేదా క్లినిక్‌కు కాల్ చేయండి.",
    askName: "మంచిది. ఏ పేరుతో బుక్ చేయాలి?",
    askPhone: "మీ ఫోన్ నంబర్ చెప్పండి. బుకింగ్ నిర్ధారణ వాట్సాప్‌కు పంపుతాము.",
    askContactConfirm: (phone: string) => `ఈ బుకింగ్ కోసం కాంటాక్ట్ నంబర్‌గా *${phone}* వాడతాము. నిర్ధారించడానికి *ఈ నంబర్ వాడండి* నొక్కండి, లేదా వేరే నంబర్ పంపండి.`,
    badPhone: "ఇది సరైన ఫోన్ నంబర్ లా లేదు. దయచేసి 10 అంకెల నంబర్ ఇవ్వండి.",
    slotTaken: "క్షమించండి, ఆ స్లాట్ ఇప్పుడే బుక్ అయ్యింది. ఇంకా ఖాళీగా ఉన్న సమయాలు ఇవి:",
    bookFail: "బుక్ చేయడంలో సమస్య వచ్చింది. దయచేసి మళ్ళీ ప్రయత్నించండి, లేదా క్లినిక్‌కు కాల్ చేయండి.",
    pendingHold: "మీకు ఇప్పటికే చెల్లింపు కోసం వేచి ఉన్న బుకింగ్ ఉంది. మీ స్లాట్ నిర్ధారించడానికి దయచేసి ఇప్పుడే ఆ చెల్లింపు పూర్తి చేయండి — చెల్లించని బుకింగ్ 15 నిమిషాల తర్వాత స్వయంచాలకంగా విడుదల అవుతుంది. లేదా *కొత్తగా మొదలుపెట్టండి* నొక్కి రద్దు చేసి కొత్త స్లాట్ బుక్ చేయండి.",
    flowSlotTaken: "క్షమించండి, ఆ స్లాట్ ఇప్పుడే బుక్ అయ్యింది. దయచేసి మళ్ళీ మెసేజ్ చేసి వేరే సమయం ఎంచుకోండి.",
    flowBookFail: "బుక్ చేయడంలో ఏదో సమస్య వచ్చింది. దయచేసి మళ్ళీ మెసేజ్ చేయండి, మేము సరిచేస్తాము.",
    confirm: (tok: number, s: string, feeAmt: number) => `✅ *స్లాట్ హోల్డ్!* మీ టోకెన్ *#${tok}*, ${s}.\n${dr} · ${cur}${feeAmt}. ఇది *30 నిమిషాలు* హోల్డ్ చేయబడుతుంది — అపాయింట్‌మెంట్ నిర్ధారించడానికి కన్సల్టేషన్ ఫీజు చెల్లించండి.\nసమయం మిస్ అయితే చింత అవసరం లేదు, అది స్వయంచాలకంగా తర్వాతి పనిదినానికి మారుతుంది.\n${WAIT_NOTE.te}`,
    claimCounterConfirm: (tok: number, s: string, feeAmt: number) => `✅ *బుక్ అయింది!* మీ టోకెన్ *#${tok}*, ${s}.\n${dr} · మీరు వచ్చినప్పుడు కౌంటర్‌లో ${cur}${feeAmt} చెల్లించండి. ఆన్‌లైన్ చెల్లింపు అవసరం లేదు, డెస్క్ వద్ద వెరిఫై చేసి తీసుకుంటారు.\nసమయం మిస్ అయితే చింత అవసరం లేదు, అది స్వయంచాలకంగా తర్వాతి పనిదినానికి మారుతుంది.\n${WAIT_NOTE.te}`,
    claimFreeConfirm: (tok: number, s: string) => `✅ *బుక్ అయింది!* మీ టోకెన్ *#${tok}*, ${s}.\n${dr} · ఈ రివ్యూ విజిట్ ఫ్రీ, ఏమీ చెల్లించాల్సిన అవసరం లేదు.\nసమయం మిస్ అయితే చింత అవసరం లేదు, అది స్వయంచాలకంగా తర్వాతి పనిదినానికి మారుతుంది.\n${WAIT_NOTE.te}`,
    cancelAsk: `రద్దులను క్లినిక్ నిర్వహిస్తుంది, కాబట్టి నేను ఇక్కడ రద్దు చేయలేను. బదులుగా కొత్త సమయానికి మార్చుకోవాలనుకుంటున్నారా? *రీషెడ్యూల్* నొక్కండి, లేదా రద్దు కోసం క్లినిక్‌కు ${clinic.contact.phone} కాల్ చేయండి.`,
    payNone: "ప్రస్తుతం మీకు చెల్లించని అపాయింట్‌మెంట్‌లు లేవు.",
    payWhich: "మీకు కొన్ని చెల్లించని అపాయింట్‌మెంట్‌లు ఉన్నాయి. చెల్లించాల్సినది నొక్కండి:",
    payNotFound: "అది మీ చెల్లించని అపాయింట్‌మెంట్‌లలో దేనికీ సరిపోలలేదు. దయచేసి పైన ఉన్న ఆప్షన్ నొక్కండి, లేదా సరైన టోకెన్ నంబర్ లేదా పేరు రిప్లై చేయండి.",
    payDone: (url: string) => `మీ చెల్లింపు లింక్ ఇదిగో: ${url}\nఇది 30 నిమిషాలు చెల్లుతుంది. మీ స్లాట్ విడుదల అయ్యేలోపు చెల్లించండి.`,
    payFail: "చెల్లింపు ప్రారంభించడంలో సమస్య వచ్చింది. దయచేసి మళ్ళీ ప్రయత్నించండి, లేదా క్లినిక్‌కు కాల్ చేయండి.",
    payMock: "✅ చెల్లింపు నిర్ధారించబడింది! మీ అపాయింట్‌మెంట్ ఇప్పుడు నిర్ధారించబడింది.",
    payPrompt: "మీ స్లాట్ నిర్ధారించడానికి, దయచేసి ఇప్పుడే కన్సల్టేషన్ ఫీజు చెల్లించండి. *ఇప్పుడే చెల్లించండి* నొక్కండి.",
    viewPrompt: "తప్పకుండా. మీ అపాయింట్ ఏ ఫోన్ నంబర్‌తో బుక్ చేశారు?",
    reschedPrompt: "తప్పకుండా, మీ అపాయింట్‌ని మారుద్దాం. మీరు ఏ ఫోన్ నంబర్‌తో బుక్ చేశారు?",
    viewNone: "ఈ నంబర్‌పై మీకు త్వరలో రాబోయే అపాయింట్‌లు లేవు.",
    viewIntro: "ఈ నంబర్ కోసం మీ వివరాలు ఇవి:",
    reschedWhich: "ఈ నంబర్‌పై మీకు కొన్ని బుకింగ్‌లు ఉన్నాయి. మార్చాల్సినది నొక్కండి:",
    reschedNotFound: "అది మార్చాల్సిన మీ బుకింగ్‌లలో దేనికీ సరిపోలలేదు. దయచేసి పైన ఉన్న ఆప్షన్ నొక్కండి, లేదా సరైన టోకెన్ నంబర్ లేదా పేరు రిప్లై చేయండి.",
    otpSent: (phone: string) => `మీ అపాయింట్ మార్చడానికి మీరే అని నిర్ధారిస్తాము. *${phone}* నంబర్‌కు వాట్సాప్‌పై 6 అంకెల కోడ్ పంపాము. కోడ్ ఇక్కడ టైప్ చేయండి.`,
    otpBad: "ఆ కోడ్ సరిపోలలేదు. మళ్ళీ చూసి ప్రయత్నించండి.",
    otpExpired: "ఆ కోడ్ గడువు ముగిసింది. కొత్త కోడ్ కోసం *Reschedule* నొక్కండి.",
    otpFail: "మీ నంబర్ ఇప్పుడు నిర్ధారించలేకపోయాము. దయచేసి మళ్ళీ ప్రయత్నించండి, లేదా సైట్‌లో *My Appointment* తెరవండి.",
    reschedDone: (s: string) => `✅ మార్చబడింది! మీ అపాయింట్ ఇప్పుడు *${s}*. వాట్సాప్‌పై నిర్ధారణ పంపాము.`,
    reschedFail: "మీ అపాయింట్ మార్చడంలో సమస్య వచ్చింది. దయచేసి మళ్ళీ ప్రయత్నించండి, లేదా క్లినిక్‌కు కాల్ చేయండి.",
    flowCancelled: "పర్వాలేదు, ఆపేశాను. మీరు సిద్ధమైనప్పుడు *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి. 🙏",
    hours: `🕒 కన్సల్టింగ్ సమయాలు:\nసోమ-శని ఉదయం 10-12:30 & సాయంత్రం 6-7:45 PM. ఆదివారం సెలవు.\nకన్సల్టేషన్ ${cur}${fee}.\n🚑 అత్యవసర పరిస్థితా? ${clinic.contact.emergency}కు కాల్ చేయండి.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.\n🗺️ దిశలు: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}* గురించి:\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\nస్పెషాలిటీలు: ${clinic.doctor.specialties.join(", ")}.\n${clinic.rating.source} రేటింగ్: ${clinic.rating.score}★ (${clinic.rating.count}+ రివ్యూలు).\n\nమీ విజిట్ నచ్చిందా? మాకు రివ్యూ ఇవ్వండి: ${clinic.rating.reviewUrl}`,
    fallback: "డాక్టర్ ఉన్నారో లేదో చెప్పగలను, డాక్టర్ గురించి చెప్పగలను, అపాయింట్‌మెంట్ బుక్ చేయగలను, లేదా సమయాలు, చిరునామా చెప్పగలను. ఏం కావాలి?",
    thanks: `సంతోషం 🙏 త్వరగా కోలుకోండి! కొద్ది సమయం ఉంటే, ఒక గూగుల్ రివ్యూ ఇతర పేషెంట్లకు సహాయపడుతుంది: ${clinic.rating.reviewUrl}`,
    chips: { avail: "ఈరోజు డాక్టర్ ఉన్నారా?", book: "అపాయింట్‌మెంట్ బుక్ చేయండి", view: "నా అపాయింట్ చూడండి", resched: "రీషెడ్యూల్", timings: "సమయాలు & ఫీజు", location: "చిరునామా", about: "డాక్టర్ గురించి", done: "ధన్యవాదాలు!", useNumber: "ఈ నంబర్ వాడండి", payNow: "ఇప్పుడే చెల్లించండి", startOver: "కొత్తగా మొదలుపెట్టండి", payCounter: "పాత పేషెంట్, కౌంటర్‌లో చెల్లిస్తాను", reviewFree: "ఫ్రీ రివ్యూ విజిట్" },
  },
  hi: {
    greet: `नमस्ते 🙏 मैं ${clinic.shortName} का असिस्टेंट हूँ। मैं आपकी कैसे मदद करूँ?`,
    availIn: (u: string) => `✅ हाँ, ${dr} आज ${u} तक उपलब्ध हैं। टोकन के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availSoon: (t: string) => `${dr} आज ${t} से देखेंगे। स्लॉट के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availOut: (d: string, t: string) => `${dr} आज *उपलब्ध नहीं* हैं। अगली उपलब्धता: *${d}, ${t}*। बुक करने के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availNone: `आने वाले दिनों में कोई स्लॉट नहीं है। कृपया क्लिनिक को कॉल करें: ${clinic.contact.phone}।`,
    bookIntro: "ज़रूर! ये खाली स्लॉट हैं। जो चाहिए उसे दबाएँ:",
    pickDay: "ज़रूर! ये वे दिन हैं जिनमें स्लॉट खाली हैं। एक चुनें:",
    pickWindow: (day: string) => `ठीक है! ${day} के लिए, सुबह या शाम, कौन सा समय बेहतर रहेगा?`,
    pickRange: (day: string) => `${day} के लिए बहुत सारे खाली समय हैं। एक रेंज चुनें:`,
    timesFor: (day: string) => `बढ़िया, ${day} के लिए खाली समय ये हैं:`,
    timesForWindow: (day: string, win: string) => `बढ़िया, ${day} (${win}) के लिए खाली समय ये हैं:`,
    dayFull: (day: string) => `माफ़ करें, ${day} अभी पूरी तरह बुक हो गया। कृपया दूसरा दिन चुनें:`,
    noSlots: "अभी कोई स्लॉट खाली नहीं है। कृपया बाद में कोशिश करें या क्लिनिक को कॉल करें।",
    askName: "बढ़िया। किस नाम से बुक करूँ?",
    askPhone: "आपका फ़ोन नंबर बताएं। बुकिंग की पुष्टि हम व्हाट्सएप पर भेजेंगे।",
    askContactConfirm: (phone: string) => `हम इस नंबर *${phone}* को बुकिंग के लिए संपर्क नंबर के रूप में उपयोग करेंगे। पुष्टि के लिए *यही नंबर उपयोग करें* दबाएँ, या कोई और नंबर भेजें।`,
    badPhone: "यह सही फ़ोन नंबर नहीं लग रहा। कृपया 10 अंकों का नंबर दर्ज करें।",
    slotTaken: "माफ़ करें, वह स्लॉट अभी किसी और ने बुक कर लिया। ये समय अभी भी खाली हैं:",
    bookFail: "बुकिंग में कुछ समस्या हुई। कृपया दोबारा कोशिश करें, या क्लिनिक को कॉल करें।",
    pendingHold: "आपकी एक बुकिंग पहले से भुगतान के लिए लंबित है। अपना स्लॉट पुष्टि करने के लिए कृपया अभी वह भुगतान पूरा करें — अवैतनिक बुकिंग 15 मिनट बाद अपने आप रिलीज़ हो जाती है। या *नया स्लॉट बुक करें* दबाकर पुरानी बुकिंग रद्द करें और नई बुक करें।",
    flowSlotTaken: "माफ़ करें, वह स्लॉट अभी बुक हो गया। कृपया दोबारा मैसेज करके दूसरा समय चुनें।",
    flowBookFail: "बुकिंग में कुछ समस्या हुई। कृपया दोबारा मैसेज करें, हम ठीक कर देंगे।",
    confirm: (tok: number, s: string, feeAmt: number) => `✅ *स्लॉट होल्ड है!* आपका टोकन *#${tok}*, ${s}।\n${dr} · ${cur}${feeAmt}। यह *30 मिनट* के लिए होल्ड है — अपॉइंटमेंट पुष्टि करने के लिए परामर्श शुल्क का भुगतान करें।\nसमय मिस हो जाए तो चिंता न करें, यह अपने आप अगले कार्य दिवस पर चला जाएगा।\n${WAIT_NOTE.hi}`,
    claimCounterConfirm: (tok: number, s: string, feeAmt: number) => `✅ *बुक हो गया!* आपका टोकन *#${tok}*, ${s}।\n${dr} · पहुंचने पर काउंटर पर ${cur}${feeAmt} का भुगतान करें। ऑनलाइन भुगतान की जरूरत नहीं है, डेस्क पर वेरिफाई करके ले लेंगे।\nसमय मिस हो जाए तो चिंता न करें, यह अपने आप अगले कार्य दिवस पर चला जाएगा।\n${WAIT_NOTE.hi}`,
    claimFreeConfirm: (tok: number, s: string) => `✅ *बुक हो गया!* आपका टोकन *#${tok}*, ${s}।\n${dr} · यह रिव्यू विजिट फ्री है, कुछ भी भुगतान नहीं करना है।\nसमय मिस हो जाए तो चिंता न करें, यह अपने आप अगले कार्य दिवस पर चला जाएगा।\n${WAIT_NOTE.hi}`,
    cancelAsk: `रद्दीकरण क्लिनिक संभालता है, इसलिए मैं इसे यहाँ रद्द नहीं कर सकता। क्या आप इसके बजाय इसे किसी नए समय पर ले जाना चाहेंगे? *रीशेड्यूल* दबाएँ, या रद्द करने के लिए क्लिनिक को ${clinic.contact.phone} पर कॉल करें।`,
    payNone: "अभी आपके पास कोई अवैतनिक अपॉइंटमेंट नहीं है।",
    payWhich: "आपके कुछ अपॉइंटमेंट का भुगतान बाकी है। जिसका भुगतान करना है उसे दबाएँ:",
    payNotFound: "यह आपके किसी बकाया भुगतान वाले अपॉइंटमेंट से मेल नहीं खाया। कृपया ऊपर दिया विकल्प दबाएँ, या सही टोकन नंबर या नाम रिप्लाई करें।",
    payDone: (url: string) => `यह रहा आपका भुगतान लिंक: ${url}\nयह 30 मिनट के लिए मान्य है। स्लॉट रिलीज़ होने से पहले भुगतान पूरा करें।`,
    payFail: "भुगतान शुरू करने में समस्या हुई। कृपया दोबारा कोशिश करें, या क्लिनिक को कॉल करें।",
    payMock: "✅ भुगतान पुष्ट हुआ! आपका अपॉइंटमेंट अब पुष्ट है।",
    payPrompt: "अपना स्लॉट पुष्टि करने के लिए कृपया अभी परामर्श शुल्क का भुगतान करें। *अभी भुगतान करें* दबाएँ।",
    viewPrompt: "ज़रूर। आपका अपॉइंटमेंट किस फ़ोन नंबर से बुक हुआ है?",
    reschedPrompt: "ज़रूर, आपका अपॉइंटमेंट बदलते हैं। आपने किस फ़ोन नंबर से बुक किया था?",
    viewNone: "इस नंबर पर आपका कोई आगामी अपॉइंटमेंट नहीं है।",
    viewIntro: "इस नंबर के लिए आपका विवरण यह है:",
    reschedWhich: "इस नंबर पर आपकी कुछ बुकिंग हैं। जिसे बदलना है उसे दबाएँ:",
    reschedNotFound: "यह आपकी बदलने वाली किसी बुकिंग से मेल नहीं खाया। कृपया ऊपर दिया विकल्प दबाएँ, या सही टोकन नंबर या नाम रिप्लाई करें।",
    otpSent: (phone: string) => `अपॉइंटमेंट बदलने के लिए हम पुष्टि करेंगे कि आप ही हैं। आपके *${phone}* नंबर पर व्हाट्सएप से 6 अंकों का कोड भेजा है। कोड यहाँ टाइप करें।`,
    otpBad: "वह कोड सही नहीं है। दोबारा देखें और कोशिश करें।",
    otpExpired: "उस कोड की अवधि समाप्त हो गई। नया कोड पाने के लिए *Reschedule* दबाएँ।",
    otpFail: "अभी आपका नंबर सत्यापित नहीं हो सका। कृपया दोबारा कोशिश करें, या साइट पर *My Appointment* खोलें।",
    reschedDone: (s: string) => `✅ बदल गया! आपका अपॉइंटमेंट अब *${s}* है। व्हाट्सएप पर पुष्टि भेजी गई।`,
    reschedFail: "अपॉइंटमेंट बदलने में समस्या हुई। कृपया दोबारा कोशिश करें, या क्लिनिक को कॉल करें।",
    flowCancelled: "कोई बात नहीं, रोक दिया। जब तैयार हों तब *अपॉइंटमेंट बुक करें* दबाएँ। 🙏",
    hours: `🕒 परामर्श समय:\nसोम-शनि सुबह 10-12:30 और शाम 6-7:45 बजे। रविवार बंद।\nपरामर्श ${cur}${fee}।\n🚑 आपातकाल में कॉल करें: ${clinic.contact.emergency}।`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}।\n🗺️ दिशा-निर्देश: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}* के बारे में:\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\nविशेषज्ञता: ${clinic.doctor.specialties.join(", ")}.\n${clinic.rating.source} रेटिंग: ${clinic.rating.score}★ (${clinic.rating.count}+ समीक्षाएं).\n\nआपकी विजिट अच्छी रही? हमें एक रिव्यू दें: ${clinic.rating.reviewUrl}`,
    fallback: "मैं बता सकता हूँ कि डॉक्टर उपलब्ध हैं या नहीं, डॉक्टर के बारे में बता सकता हूँ, अपॉइंटमेंट बुक कर सकता हूँ, या समय व पता बता सकता हूँ। क्या चाहिए?",
    thanks: `आपका स्वागत है 🙏 जल्दी स्वस्थ हों! अगर समय हो, तो एक गूगल रिव्यू दूसरे मरीज़ों की मदद करता है: ${clinic.rating.reviewUrl}`,
    chips: { avail: "क्या डॉक्टर आज उपलब्ध हैं?", book: "अपॉइंटमेंट बुक करें", view: "मेरा अपॉइंटमेंट देखें", resched: "रीशेड्यूल", timings: "समय व फीस", location: "पता", about: "डॉक्टर के बारे में", done: "धन्यवाद!", useNumber: "यही नंबर उपयोग करें", payNow: "अभी भुगतान करें", startOver: "नया स्लॉट बुक करें", payCounter: "पुराना मरीज़, काउंटर पर भुगतान करूंगा", reviewFree: "फ्री रिव्यू विजिट" },
  },
};

// ── intent detection (heuristic for the beta; Claude in production) ──────────
type Intent = "avail" | "book" | "cancel" | "pay" | "payCounter" | "reviewFree" | "reschedule" | "view" | "hours" | "location" | "fee" | "about" | "greet" | "thanks" | "fallback" | "startOver";
function detect(s: string): Intent {
  const has = (re: RegExp) => re.test(s);
  if (has(/cancel|రద్దు|कैंसिल|रद्द/i)) return "cancel";
  // The confirmation template's combined quick-reply button ("View or
  // reschedule") would otherwise fall into the reschedule check below (it
  // contains "reschedule") and drop the patient straight into the day picker
  // with no chance to just look first — checked ahead so the button opens the
  // (lower-commitment) view list, which itself offers a one-tap resched chip.
  if (has(/view or resched/i)) return "view";
  // Checked before "book" on purpose: "reschedule my appointment" contains
  // "appointment", so without this lead it would land in the booking flow.
  if (has(/resched|re-?schedule|move (my )?appointment|change (my )?(appointment|slot|date|time|day)|postpone|పునఃషెడ్యూల్|రీషెడ్యూల్|షెడ్యూల్ మార్చ|సమయం మార్చ|అపాయింట్ మార్చ|अपॉइंटमेंट बदल|पुनर्निर्धारित|रीशेड्यूल|समय बदल|डेट बदल|तारीख बदल/i)) return "reschedule";
  // Also before "book": "view my appointment" contains "appointment". \bview\b so
  // "review" never matches.
  if (has(/\bview\b|my appointment|(see|check|show) (my )?appointment|అపాయింట్(.{0,10}చూడ|.{0,10}వివర)|నా అపాయింట్|अपॉइंटमेंट(.{0,10}देख|.{0,10}स्थिति)|मेरा अपॉइंटमेंट/i)) return "view";
  // Checked before the generic "pay" match below — both of these self-declared
  // claims contain words ("pay", "counter", "review") that would otherwise be
  // swallowed by earlier or later checks.
  if (has(/pay at (the )?counter|returning patient.*counter|కౌంటర్|काउंटर/i)) return "payCounter";
  if (has(/free review|review visit|రివ్యూ విజిట్|रिव्यू विजिट/i)) return "reviewFree";
  if (has(/\bpay\b|payment|checkout|చెల్లించ|చెల్లింపు|भुगतान|पेमेंट/i)) return "pay";
  if (has(/start (fresh|over)|new slot|book new|కొత్తగా|నయा|नया स्लॉट|नया बुक/i)) return "startOver";
  if (has(/book|appoint|slot|token|బుక్|అపాయింట్|अपॉइंटमेंट|बुक|टोकन/i)) return "book";
  if (has(/about (the )?(doctor|dr)\b|doctor.?s? (bio|profile|qualification)|qualification|credentials|డాక్టర్.{0,3}గురించి|గురించి.{0,3}డాక్టర్|योग्यता|डॉक्टर.{0,3}(बारे|प्रोफाइल)/i)) return "about";
  if (has(/avail|open|in today|is (the )?doctor|doctor (in|there|available)|ఉన్నార|అందుబాటు|उपलब्ध|आज|डॉक्टर/i)) return "avail";
  if (has(/time|timing|hours|when|open|సమయ|టైమ|समय|कब/i)) return "hours";
  if (has(/where|location|address|reach|direction|చిరునామా|ఎక్కడ|पता|कहाँ|कहां/i)) return "location";
  if (has(/fee|cost|charge|price|కుడు|ఫీజు|ఛార్జ|फीस|शुल्क|कितने|कीमत/i)) return "fee";
  if (has(/thank|ధన్య|धन्यवाद|शुक्रिया/i)) return "thanks";
  if (has(/^(hi|hello|hey|namaste|hai|నమస|హాయ|नमस्ते|हाय|हेलो)/i)) return "greet";
  return "fallback";
}

// Whether a reply to the "use this WhatsApp number?" prompt should be read as
// yes — either the exact chip label tapped back, or a short affirmative typed
// across en/te/hi, rather than requiring the patient to tap the chip.
function isAffirmative(input: string, chipLabel: string): boolean {
  const s = input.trim();
  if (s === chipLabel) return true;
  return /^(ok(ay)?|yes|yeah|yep|sure|confirm|correct|అవును|సరే|ఓకే|हाँ|हां|ठीक|जी हाँ|कन्फर्म)$/i.test(s);
}

// Formats a raw WhatsApp sender id (e.g. "919876543210") into a readable
// Indian phone number for the confirm prompt; falls back to the raw digits
// for shapes we don't recognize rather than showing nothing.
function formatIndianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (local.length === 10) return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  return `+${digits}`;
}

// One line for the view/reschedule lists: token, name, and when they're booked
// (day + time + status), so a phone with a few appointments stays legible.
function fmtApptForView(a: Appt): string {
  const day = weekdayName(new Date(a.date + "T00:00:00"));
  return `#${a.token} · ${a.name}, ${day} ${fmt(a.time)} · ${a.status}`;
}

function availReply(t: PhrasePack): string {
  const st = statusAt();
  if (st.state === "in") return t.availIn(fmt(st.until));
  if (st.state === "soon") return t.availSoon(fmt(st.opensAt));
  if (st.next) return t.availOut(weekdayName(st.next.date), fmt(st.next.opensAt));
  return t.availNone;
}

export function botStart(lang: Lang): BotOut {
  const t = P[lang];
  return { reply: [t.greet], chips: [t.chips.view, t.chips.book, t.chips.resched, t.chips.avail, t.chips.about, t.chips.timings, t.chips.location], state: { stage: "idle" } };
}

// ── view / reschedule: client (website chat) ────────────────────────────────
// The site chat has no WhatsApp sender identity, so it looks the phone number
// up explicitly and, when the gate is enabled, proves ownership with a WhatsApp
// OTP code before anything is moved. In mock (no-Supabase) mode the store's
// localStorage mirrors the same reads and writes, and there is no gate to pass.

// Active appointments for a phone + whether self-service mutations are gated
// (mirrors the lookup route's response). Mock mode always reports no gate.
async function lookupClient(phone: string, includePending = false): Promise<{ appts: Appt[]; otp: boolean }> {
  if (hasSupabase()) {
    try {
      const res = await fetch("/api/appointments/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, includePending }),
      });
      if (!res.ok) return { appts: [], otp: false };
      const data = (await res.json()) as { appointments?: Appt[]; otpEnabled?: boolean };
      return { appts: data.appointments ?? [], otp: Boolean(data.otpEnabled) };
    } catch (err) {
      console.error("bot: appointment lookup failed", err);
      return { appts: [], otp: false };
    }
  }
  return { appts: activeAppointmentsByPhone(phone, includePending), otp: false };
}

// Create a payment link for one unpaid appointment. DB mode asks the live API
// (which returns a real Razorpay URL); mock mode has no gateway, so it marks
// the hold paid locally instead (the same toggle BookForm's mock pay uses) and
// returns the sentinel "mock". Returns null when a link can't be produced.
async function payClientLink(id: string, phone: string): Promise<string | "mock" | null> {
  if (hasSupabase()) {
    try {
      const res = await fetch("/api/payments/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, phone }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: unknown };
      return typeof data.url === "string" && data.url ? data.url : null;
    } catch (err) {
      console.error("bot: payment link creation failed", err);
      return null;
    }
  }
  togglePaid(id);
  return "mock";
}

// Turn a payment-link attempt into its full reply. Mock mode returns the
// sentinel "mock" (the hold was marked paid locally) so the message is a plain
// confirmation rather than a made-up Razorpay URL; null is a real failure.
function payOutcome(t: PhrasePack, c: PhrasePack["chips"], link: string | "mock" | null): BotOut {
  if (link === null) return { reply: [t.payFail], chips: [c.book], state: { stage: "idle" } };
  if (link === "mock") return { reply: [t.payMock], chips: [c.avail, c.book], state: { stage: "idle" } };
  return { reply: [t.payDone(link)], chips: [c.avail, c.book], state: { stage: "idle" } };
}

// Ask Meta to send the verification code over WhatsApp. Errors are collapsed
// into three outcomes the caller can phrase:
//   "sent"  a fresh code went out
//   "rate"  a code still stands (recently sent) - the patient has one to type
//   "fail"  template missing / send failed / no active appointment
async function requestOtpClient(phone: string): Promise<"sent" | "rate" | "fail"> {
  try {
    const res = await fetch("/api/appointments/request-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    if (res.status === 429) return "rate";
    if (!res.ok) return "fail";
    return "sent";
  } catch (err) {
    console.error("bot: OTP request failed", err);
    return "fail";
  }
}

// Resume the slot picker for a move (resched carries which booking + phone).
async function enterPickerClient(resched: { id: string; phone: string }, t: PhrasePack): Promise<BotOut> {
  const days = await openDays();
  if (!days.length) return { reply: [t.noSlots], chips: [t.chips.avail], state: { stage: "idle" } };
  return { reply: [t.pickDay], chips: days.map((d) => d.label), state: { stage: "idle", resched } };
}

// Fresh-slot fallback after the target time got taken on a reschedule commit:
// same day, same window where possible, re-listed as chips with the move kept
// alive so the next tap still reschedules (not re-books).
async function slotTakenFallbackClient(resched: { id: string; phone: string }, date: string, time: string, t: PhrasePack): Promise<BotOut> {
  const fresh = await timesForDate(date);
  const win = windowsFor(new Date(date + "T00:00:00")).find((w) => inWindow(time, w));
  const scoped = win ? fresh.filter((t2) => inWindow(t2, win)) : fresh;
  if (!scoped.length) return { reply: [t.slotTaken, t.noSlots], chips: [t.chips.avail], state: { stage: "idle" } };
  if (win && scoped.length > MAX_CHIPS) {
    const ranges = splitWindow(win, scoped.length);
    const dayLabel = dayLabelForDate(date, new Date());
    return { reply: [t.slotTaken, t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", resched, pendingDate: date, pendingWindow: win } };
  }
  return { reply: [t.slotTaken], chips: scoped.map(fmt), state: { stage: "idle", resched, pendingDate: date, pendingWindow: win } };
}

// Website chat: list the active appointments for a phone (the "view" outcome).
async function viewAppointmentsClient(phone: string, t: PhrasePack): Promise<BotOut> {
  const { appts } = await lookupClient(phone);
  if (!appts.length) return { reply: [t.viewNone], chips: [t.chips.book], state: { stage: "idle" } };
  return { reply: [t.viewIntro, ...appts.map(fmtApptForView)], chips: [t.chips.resched, t.chips.book], state: { stage: "idle", viewPhone: phone } };
}

// Website-chat entry to a reschedule for a known phone: fresh lookup, then
// either ask which booking (several active), send the OTP code (gate on), or
// drop straight into the slot picker (gate off / mock).
async function startRescheduleClient(phone: string, t: PhrasePack): Promise<BotOut> {
  const { appts, otp } = await lookupClient(phone);
  if (!appts.length) return { reply: [t.viewNone], chips: [t.chips.book], state: { stage: "idle" } };
  if (appts.length > 1) {
    const candidates: CancelCandidate[] = appts.map((a) => ({ id: a.id, token: a.token, name: a.name, label: `#${a.token} · ${a.name}` }));
    return { reply: [t.reschedWhich], chips: candidates.map((cd) => cd.label), state: { stage: "await_resched_pick", reschedCandidates: candidates, reschedPhone: phone, reschedOtp: otp } };
  }
  const appt = appts[0];
  if (otp) {
    const sent = await requestOtpClient(phone);
    if (sent === "fail") return { reply: [t.otpFail], chips: [t.chips.resched], state: { stage: "idle", viewPhone: phone } };
    return { reply: [t.otpSent(phone)], chips: [], state: { stage: "await_otp", otpPhone: phone, resched: { id: appt.id, phone } } };
  }
  return enterPickerClient({ id: appt.id, phone }, t);
}

// Self-declared payment exemptions (payCounter / reviewFree). The patient
// already picked a slot and gave a name/phone through the normal booking
// flow above, which left a payment_pending hold — re-run the same booking
// with replacePending so that hold is cancelled and a fresh row is created,
// this time going straight to reserved with no Razorpay step at all.
async function claimRebookClient(
  state: BotState,
  t: PhrasePack,
  c: PhrasePack["chips"],
  claim: "returning_unverified" | "review_free",
  source: Source
): Promise<BotOut> {
  if (!state.slot || state.viewPhone === undefined) {
    return { reply: [t.fallback], chips: [c.book, c.avail], state: { stage: "idle" } };
  }
  const name = state.name || "Patient";
  const phone = state.viewPhone;
  try {
    let appt: Appt;
    if (hasSupabase()) {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, age: 0, date: state.slot.date, time: state.slot.time, source, replacePending: true, claim }),
      });
      if (!res.ok) throw new Error("claim booking failed");
      const body = await res.json();
      appt = body.appointment as Appt;
    } else {
      appt = addBooking({ name, phone, age: 0, date: state.slot.date, time: state.slot.time, source, replacePending: true, claim });
    }
    const msg = claim === "returning_unverified" ? t.claimCounterConfirm(appt.token, state.slot.label, appt.fee) : t.claimFreeConfirm(appt.token, state.slot.label);
    return { reply: [msg], chips: [c.avail, c.about, c.done], state: { stage: "idle", viewPhone: phone } };
  } catch (err) {
    console.error("bot: claim booking failed", err);
    return { reply: [t.bookFail], chips: [c.book, c.avail], state: { stage: "idle" } };
  }
}

export async function botReply(input: string, lang: Lang, state: BotState, source: Source = "whatsapp"): Promise<BotOut> {
  const t = P[lang];
  const c = t.chips;

  // Escape hatch: without this, "cancel" typed while answering name/phone was
  // swallowed as literal input for that stage (e.g. booked as a patient named
  // "cancel") instead of backing the patient out of a flow they no longer want.
  if (MID_FLOW_STAGES.includes(state.stage) && detect(input) === "cancel") {
    return { reply: [t.flowCancelled], chips: [c.book, c.avail], state: { stage: "idle" } };
  }

  // A wrong or expired OTP code used to be a dead end (retry-only, no way
  // out). Tapping the resched chip we now offer alongside a bad/expired code
  // should actually restart the OTP request, not get swallowed as another
  // guess at the 6-digit code.
  if (state.stage === "await_otp" && state.otpPhone && detect(input) === "reschedule") {
    return startRescheduleClient(state.otpPhone, t);
  }

  // VIEW: this input is the phone number to look up
  if (state.stage === "await_view_phone") {
    const digits = input.replace(/\D/g, "");
    if (digits.length < 10) return { reply: [t.badPhone], chips: [], state };
    return viewAppointmentsClient(digits, t);
  }

  // RESCHEDULE: this input is the phone number whose booking we move
  if (state.stage === "await_resched_phone") {
    const digits = input.replace(/\D/g, "");
    if (digits.length < 10) return { reply: [t.badPhone], chips: [], state };
    return startRescheduleClient(digits, t);
  }

  // RESCHEDULE: picking which appointment when the phone has several active
  if (state.stage === "await_resched_pick" && state.reschedCandidates?.length) {
    const raw = input.trim();
    const picked =
      state.reschedCandidates.find((cd) => cd.label === raw) ??
      state.reschedCandidates.find((cd) => String(cd.token) === raw) ??
      state.reschedCandidates.find((cd) => cd.name.toLowerCase().includes(raw.toLowerCase()));
    if (!picked) {
      return { reply: [t.reschedNotFound], chips: state.reschedCandidates.map((cd) => cd.label), state: { stage: "await_resched_pick", reschedCandidates: state.reschedCandidates, reschedPhone: state.reschedPhone, reschedOtp: state.reschedOtp } };
    }
    const phone = state.reschedPhone ?? "";
    if (state.reschedOtp) {
      const sent = await requestOtpClient(phone);
      if (sent === "fail") return { reply: [t.otpFail], chips: [c.resched], state: { stage: "idle", viewPhone: phone } };
      return { reply: [t.otpSent(phone)], chips: [], state: { stage: "await_otp", otpPhone: phone, resched: { id: picked.id, phone } } };
    }
    return enterPickerClient({ id: picked.id, phone }, t);
  }

  // OTP: this input is the 6-digit code proving the phone owns the booking
  if (state.stage === "await_otp" && state.otpPhone && state.resched) {
    const code = input.trim();
    if (code.length !== 6) return { reply: [t.otpBad], chips: [c.resched], state };
    try {
      const res = await fetch("/api/appointments/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: state.otpPhone, code }),
      });
      if (res.status === 410) return { reply: [t.otpExpired], chips: [c.resched], state: { stage: "idle", viewPhone: state.otpPhone } };
      if (res.status === 401) return { reply: [t.otpBad], chips: [c.resched], state: { stage: "await_otp", otpPhone: state.otpPhone, resched: state.resched } };
      if (!res.ok) return { reply: [t.otpFail], chips: [c.resched], state: { stage: "idle", viewPhone: state.otpPhone } };
      return enterPickerClient(state.resched, t);
    } catch {
      return { reply: [t.otpFail], chips: [c.resched], state: { stage: "idle", viewPhone: state.otpPhone } };
    }
  }

  // completing a booking: this input is the patient's name
  if (state.stage === "await_name" && state.slot) {
    const name = input.trim() || "Patient";
    // DB mode needs a phone (confirmation goes out on WhatsApp, and it's how
    // the admin dashboard reaches the patient) — the mock demo doesn't.
    if (hasSupabase()) {
      return { reply: [t.askPhone], chips: [], state: { stage: "await_phone", slot: state.slot, name, replacePending: state.replacePending } };
    }
    const appt = addBooking({ name, phone: "", age: 0, date: state.slot.date, time: state.slot.time, source, replacePending: state.replacePending });
    // Carry viewPhone ("" in mock) so the Pay now chip that follows resolves
    // the just-created payment_pending hold without re-asking for a number.
    // slot/name stay in state too, so a payCounter/reviewFree tap afterward
    // can re-book the same slot without asking the patient anything again.
    return { reply: [t.confirm(appt.token, state.slot.label, appt.fee), t.payPrompt], chips: [c.payNow, c.payCounter, c.reviewFree, c.avail, c.about, c.done], state: { stage: "idle", viewPhone: appt.phone, slot: state.slot, name } };
  }

  // completing a booking (DB mode): this input is the patient's phone number
  if (state.stage === "await_phone" && state.slot) {
    const digits = input.replace(/\D/g, "");
    if (digits.length < 10) return { reply: [t.badPhone], chips: [], state };

    try {
      const res = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.name || "Patient",
          phone: input.trim(),
          age: 0,
          date: state.slot.date,
          time: state.slot.time,
          source,
          replacePending: state.replacePending === true,
        }),
      });
      const body = res.ok || res.status === 409 ? await res.json() : null;
      if (res.status === 409 && body?.code === "pending_hold") {
        // A payment_pending hold is already on this number — don't book a
        // second slot (and don't charge a wrong returning fee). Point them at
        // paying the hold they already have; viewPhone carries the typed number
        // so the Pay now chip resolves it without re-asking.
        return { reply: [t.pendingHold], chips: [c.payNow, c.startOver, c.view, c.book], state: { stage: "idle", viewPhone: input.trim() } };
      }
      if (res.status === 409) {
        const fresh = await timesForDate(state.slot.date);
        const win = windowsFor(new Date(state.slot.date + "T00:00:00")).find((w) => inWindow(state.slot!.time, w));
        const scoped = win ? fresh.filter((t2) => inWindow(t2, win)) : fresh;
        if (!scoped.length) return { reply: [t.slotTaken, t.noSlots], chips: [c.avail], state: { stage: "idle" } };
        if (win && scoped.length > MAX_CHIPS) {
          const ranges = splitWindow(win, scoped.length);
          const dayLabel = dayLabelForDate(state.slot.date, new Date());
          return { reply: [t.slotTaken, t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win } };
        }
        return { reply: [t.slotTaken], chips: scoped.map(fmt), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win } };
      }
      if (!res.ok) throw new Error("booking failed");
      const { appointment: appt } = body as { appointment: Appt };
      // Carry the just-entered phone into viewPhone so the Pay now chip that
      // follows the confirmation resolves the unpaid hold without re-asking.
      // slot/name stay in state too, for the payCounter/reviewFree rebook path.
      return { reply: [t.confirm(appt.token, state.slot.label, appt.fee), t.payPrompt], chips: [c.payNow, c.payCounter, c.reviewFree, c.avail, c.about, c.done], state: { stage: "idle", viewPhone: input.trim(), slot: state.slot, name: state.name } };
    } catch (err) {
      console.error("bot: booking failed", err);
      return { reply: [t.bookFail], chips: [c.book, c.avail], state: { stage: "idle" } };
    }
  }

  // tapped a time chip (only meaningful once a day AND a window are picked)
  if (state.pendingDate && state.pendingWindow) {
    const effective = state.pendingRange ?? state.pendingWindow;
    const times = (await timesForDate(state.pendingDate)).filter((s) => inWindow(s, effective));
    const match = times.find((s) => fmt(s) === input);
    if (match) {
      const label = `${dayLabelForDate(state.pendingDate, new Date())} ${fmt(match)}`;
      // a reschedule in progress: the tap MOVE the existing booking
      if (state.resched) {
        try {
          if (hasSupabase()) {
            const res = await fetch("/api/appointments/reschedule", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: state.resched.id, phone: state.resched.phone, date: state.pendingDate, time: match }),
            });
            if (res.status === 401) {
              // OTP window lapsed (10 min) between the code and the tap
              return { reply: [t.otpExpired], chips: [c.resched], state: { stage: "idle", viewPhone: state.resched.phone } };
            }
            if (res.status === 409) {
              return slotTakenFallbackClient(state.resched, state.pendingDate, match, t);
            }
            if (!res.ok) throw new Error("reschedule failed");
            return { reply: [t.reschedDone(label)], chips: [c.avail, c.book, c.done], state: { stage: "idle" } };
          }
          rescheduleBooking(state.resched.id, state.pendingDate, match);
          return { reply: [t.reschedDone(label)], chips: [c.avail, c.book, c.done], state: { stage: "idle" } };
        } catch (err) {
          if (err instanceof SlotTakenError) return slotTakenFallbackClient(state.resched, state.pendingDate, match, t);
          console.error("bot: reschedule failed", err);
          return { reply: [t.reschedFail], chips: [c.book], state: { stage: "idle" } };
        }
      }
      return { reply: [t.askName], chips: [], state: { stage: "await_name", slot: { date: state.pendingDate, time: match, label }, replacePending: state.replacePending } };
    }
  }

  // tapped a range chip (window picked, but it had too many slots for one screen)
  if (state.pendingDate && state.pendingWindow && !state.pendingRange) {
    const winTimes = (await timesForDate(state.pendingDate)).filter((s) => inWindow(s, state.pendingWindow!));
    const ranges = splitWindow(state.pendingWindow, winTimes.length);
    const pickedRange = ranges.length > 1 ? ranges.find((r) => windowLabel(r) === input) : undefined;
    if (pickedRange) {
      const times = winTimes.filter((s) => inWindow(s, pickedRange));
      const dayLabel = dayLabelForDate(state.pendingDate, new Date());
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedRange))], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: state.pendingWindow, pendingRange: pickedRange, replacePending: state.replacePending } };
    }
  }

  // tapped a window chip (day picked, more than one window that day)
  if (state.pendingDate && !state.pendingWindow) {
    const wins = await windowsWithSlotsFor(state.pendingDate);
    const pickedWin = wins.find((w) => windowLabel(w) === input);
    if (pickedWin) {
      const times = (await timesForDate(state.pendingDate)).filter((s) => inWindow(s, pickedWin));
      const dayLabel = dayLabelForDate(state.pendingDate, new Date());
      if (times.length > MAX_CHIPS) {
        const ranges = splitWindow(pickedWin, times.length);
        return { reply: [t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: pickedWin, replacePending: state.replacePending } };
      }
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedWin))], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: pickedWin, replacePending: state.replacePending } };
    }
  }

  // Pay intent stages short-circuit BEFORE any availability fetch: the day-scan
  // below costs up to ~14 sequential round-trips in DB mode, and a pay-stage
  // message must never be misread as a day/token chip.

  // picking which appointment to pay for (multiple unpaid)
  if (state.stage === "await_pay_pick" && state.payCandidates?.length) {
    const raw = input.trim();
    const picked =
      state.payCandidates.find((cd) => cd.label === raw) ??
      state.payCandidates.find((cd) => String(cd.token) === raw) ??
      state.payCandidates.find((cd) => cd.name.toLowerCase().includes(raw.toLowerCase()));
    if (!picked) {
      // Keep the phone (and candidates) on a mismatch — dropping viewPhone
      // would strand the flow forever, since every later pick then fails its
      // guard.
      return {
        reply: [t.payNotFound],
        chips: state.payCandidates.map((cd) => cd.label),
        state: { stage: "await_pay_pick", payCandidates: state.payCandidates, viewPhone: state.viewPhone },
      };
    }
    // viewPhone and payCandidates are always set together, so a picked-but-no-
    // phone is state corruption — restart cleanly by asking again. (An empty
    // string is valid: mock bookings carry phone "" and the pay flow uses it.)
    if (state.viewPhone === undefined) {
      return { reply: [t.viewPrompt], chips: [], state: { stage: "await_pay_phone" } };
    }
    const link = await payClientLink(picked.id, state.viewPhone);
    return payOutcome(t, c, link);
  }

  // waiting for phone number to look up unpaid appointments
  if (state.stage === "await_pay_phone") {
    const digits = input.replace(/\D/g, "");
    if (digits.length >= 10) {
      const phone10 = digits.slice(-10);
      const { appts } = await lookupClient(phone10, true);
      const unpaid = appts.filter((a) => !a.paid);
      if (!unpaid.length) return { reply: [t.payNone], chips: [c.book], state: { stage: "idle" } };
      if (unpaid.length === 1) {
        const link = await payClientLink(unpaid[0].id, phone10);
        return payOutcome(t, c, link);
      }
      const candidates: PayCandidate[] = unpaid.map((a) => ({ id: a.id, token: a.token, name: a.name, label: `#${a.token} · ${a.name}` }));
      return { reply: [t.payWhich], chips: candidates.map((cd) => cd.label), state: { stage: "await_pay_pick", payCandidates: candidates, viewPhone: phone10 } };
    }
    // Not a phone number. A real intent (book / view / reschedule) should fall
    // through to the switch below instead of looping on the phone prompt
    // forever; only genuinely junk input re-asks.
    if (detect(input) === "fallback") {
      return { reply: [t.badPhone], chips: [], state: { stage: "await_pay_phone" } };
    }
  }

  // tapped a day chip
  const days = await openDays();
  const pickedDay = days.find((d) => d.label === input);
  if (pickedDay) {
    const times = await timesForDate(pickedDay.date);
    if (!times.length) {
      const fresh = days.filter((d) => d.date !== pickedDay.date);
      if (!fresh.length) return { reply: [t.dayFull(pickedDay.label), t.noSlots], chips: [c.avail], state: { stage: "idle", resched: state.resched, replacePending: state.replacePending } };
      return { reply: [t.dayFull(pickedDay.label)], chips: fresh.map((d) => d.label), state: { stage: "idle", resched: state.resched, replacePending: state.replacePending } };
    }
    const wins = await windowsWithSlotsFor(pickedDay.date);
    if (wins.length > 1) {
      return { reply: [t.pickWindow(pickedDay.label)], chips: wins.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, replacePending: state.replacePending } };
    }
    if (times.length > MAX_CHIPS) {
      const ranges = splitWindow(wins[0], times.length);
      return { reply: [t.pickRange(pickedDay.label)], chips: ranges.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, pendingWindow: wins[0], replacePending: state.replacePending } };
    }
    return { reply: [t.timesFor(pickedDay.label)], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, pendingWindow: wins[0], replacePending: state.replacePending } };
  }

  switch (detect(input)) {
    case "avail":
      return { reply: [availReply(t)], chips: [c.book, c.about, c.timings], state: { stage: "idle" } };
    case "view": {
      // A prior view already knows the phone, so re-show it instead of asking again.
      if (state.viewPhone) return viewAppointmentsClient(state.viewPhone, t);
      return { reply: [t.viewPrompt], chips: [], state: { stage: "await_view_phone" } };
    }
    case "reschedule": {
      // A prior "view" already knows the phone, so hop straight to the move —
      // otherwise ask for the number, same as looking one up.
      if (state.viewPhone) return startRescheduleClient(state.viewPhone, t);
      return { reply: [t.reschedPrompt], chips: [], state: { stage: "await_resched_phone" } };
    }
    case "book": {
      const dayList = await openDays();
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle" } };
    }
    case "startOver": {
      const dayList = await openDays();
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle", replacePending: true } };
    }
    case "cancel": {
      // Cancellations are handled by the clinic, not automated — offer a move
      // to a new time and point the patient at the phone to cancel.
      return { reply: [t.cancelAsk], chips: [c.resched, c.book], state: { stage: "idle" } };
    }
    case "pay": {
      // includePending: a just-booked appointment is payment_pending until the
      // webhook confirms payment, and the whole point of the pay intent is to
      // collect that payment.
      const phone = state.viewPhone;
      // Mock bookings carry phone "" — that "no phone" is the demo's contact,
      // so "" is a valid lookup key here, not a missing prompt.
      if (phone === undefined) {
        return { reply: [t.viewPrompt], chips: [], state: { stage: "await_pay_phone" } };
      }
      const { appts } = await lookupClient(phone, true);
      const unpaid = appts.filter((a) => !a.paid);
      if (!unpaid.length) {
        return { reply: [t.payNone], chips: [c.book], state: { stage: "idle" } };
      }
      if (unpaid.length === 1) {
        const link = await payClientLink(unpaid[0].id, phone);
        return payOutcome(t, c, link);
      }
      const candidates: PayCandidate[] = unpaid.map((a) => ({ id: a.id, token: a.token, name: a.name, label: `#${a.token} · ${a.name}` }));
      return {
        reply: [t.payWhich],
        chips: candidates.map((cd) => cd.label),
        state: { stage: "await_pay_pick", payCandidates: candidates, viewPhone: phone },
      };
    }
    case "payCounter":
      return claimRebookClient(state, t, c, "returning_unverified", source);
    case "reviewFree":
      return claimRebookClient(state, t, c, "review_free", source);
    case "hours": case "fee":
      return { reply: [t.hours], chips: [c.book, c.location], state: { stage: "idle" } };
    case "location":
      return { reply: [t.location], chips: [c.book, c.timings], state: { stage: "idle" } };
    case "about":
      return { reply: [t.about], chips: [c.book, c.avail], state: { stage: "idle" } };
    case "thanks":
      return { reply: [t.thanks], chips: [c.avail, c.book], state: { stage: "idle" } };
    case "greet":
      return botStart(lang);
    default:
      return { reply: [t.fallback], chips: [c.view, c.book, c.resched, c.avail, c.about, c.timings, c.payNow], state: { stage: "idle" } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side variant (WhatsApp webhook). A webhook route has no browser tab —
// no localStorage-backed lib/store.ts, no module-singleton schedule — so this
// mirrors botStart/botReply above but takes its data access and schedule state
// as explicit arguments instead of reaching for module singletons, and stores
// the last booking (for "cancel") in the per-conversation state instead of a
// module-level variable, since a webhook serves many concurrent phone numbers.
// Kept as a parallel path rather than folded into botReply so RCChat, the
// live site chat surface that calls botReply/botStart synchronously, is
// untouched.
// ─────────────────────────────────────────────────────────────────────────────
export type Backend = {
  addBooking: (input: { name: string; phone: string; age: number; date: string; time: string; source?: Source; replacePending?: boolean; claim?: "returning_unverified" | "review_free" }) => Promise<Appt>;
  // includePending adds payment_pending rows — the pay intent needs them, the
  // view/reschedule intents don't (an unpaid booking isn't confirmed yet).
  activeAppointmentsByPhone: (phone: string, includePending?: boolean) => Promise<Appt[]>;
  createPaymentLink: (id: string, phone: string) => Promise<string>;
  reschedule: (id: string, date: string, time: string) => Promise<Appt>;
  // Claim bookings (payCounter / reviewFree) skip Razorpay entirely, so there's
  // no webhook to notify staff — the route that calls addBooking must do it.
  notifyClaimBooking: (appt: Appt) => Promise<void>;
};
export type ServerBotState = BotState & { payCandidates?: PayCandidate[] };

async function openDaysServer(backend: Backend, sched: SchedState): Promise<DayChip[]> {
  const now = nowIST();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: DayChip[] = [];
  for (let i = 0; i < 14 && out.length < MAX_DAY_CHIPS; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const key = ymd(d);
    let slots = allSlotsFor(d, sched);
    if (i === 0) slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + BOOKING_LEAD_MIN; });
    if (slots.length) out.push({ date: key, label: dayLabelForOffset(i, d) });
  }
  return out;
}
async function timesForDateServer(date: string, backend: Backend, sched: SchedState): Promise<string[]> {
  const now = nowIST();
  const d = new Date(date + "T00:00:00");
  let slots = allSlotsFor(d, sched);
  if (date === ymd(now)) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + BOOKING_LEAD_MIN; });
  }
  return slots;
}
async function windowsWithSlotsForServer(date: string, backend: Backend, sched: SchedState): Promise<Window[]> {
  const times = await timesForDateServer(date, backend, sched);
  return windowsFor(new Date(date + "T00:00:00"), sched).filter((w) => times.some((t) => inWindow(t, w)));
}

function availReplyServer(t: PhrasePack, sched: SchedState): string {
  const st = statusAt(nowIST(), sched);
  if (st.state === "in") return t.availIn(fmt(st.until));
  if (st.state === "soon") return t.availSoon(fmt(st.opensAt));
  if (st.next) return t.availOut(weekdayName(st.next.date), fmt(st.next.opensAt));
  return t.availNone;
}

// The WhatsApp bot trusts the sender's number as identity (no OTP needed here,
// same as cancel/pay) — enter the slot picker for the move directly.
async function enterPickerServer(resched: { id: string; phone: string }, backend: Backend, sched: SchedState, t: PhrasePack): Promise<{ reply: string[]; chips: string[]; state: ServerBotState }> {
  const days = await openDaysServer(backend, sched);
  if (!days.length) return { reply: [t.noSlots], chips: [t.chips.avail], state: { stage: "idle" } };
  return { reply: [t.pickDay], chips: days.map((d) => d.label), state: { stage: "idle", resched } };
}

// Fresh-slot fallback after the target time got taken on a reschedule commit:
// same day, same window where possible, re-listed as chips with the move kept
// alive so the next tap still reschedules (not re-books).
async function slotTakenFallbackServer(resched: { id: string; phone: string }, date: string, time: string, backend: Backend, sched: SchedState, t: PhrasePack): Promise<{ reply: string[]; chips: string[]; state: ServerBotState }> {
  const fresh = await timesForDateServer(date, backend, sched);
  const win = windowsFor(new Date(date + "T00:00:00"), sched).find((w) => inWindow(time, w));
  const scoped = win ? fresh.filter((t2) => inWindow(t2, win)) : fresh;
  if (!scoped.length) return { reply: [t.slotTaken, t.noSlots], chips: [t.chips.avail], state: { stage: "idle" } };
  if (win && scoped.length > MAX_CHIPS) {
    const ranges = splitWindow(win, scoped.length);
    const dayLabel = dayLabelForDate(date, nowIST());
    return { reply: [t.slotTaken, t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", resched, pendingDate: date, pendingWindow: win } };
  }
  return { reply: [t.slotTaken], chips: scoped.map(fmt), state: { stage: "idle", resched, pendingDate: date, pendingWindow: win } };
}

// Self-declared payment exemptions (payCounter / reviewFree), server side.
// Same idea as claimRebookClient above: the slot/name/phone from the booking
// that just happened are still in state, so re-run it through the backend
// with replacePending to cancel the stale payment_pending hold and land the
// claim booking straight in reserved, no Razorpay step involved. This path
// calls backend.addBooking directly (bypassing /api/book), so it must fire
// the staff notification itself via notifyClaimBooking.
async function claimRebookServer(
  state: ServerBotState,
  phone: string,
  backend: Backend,
  t: PhrasePack,
  c: PhrasePack["chips"],
  claim: "returning_unverified" | "review_free",
  source: Source
): Promise<{ reply: string[]; chips: string[]; state: ServerBotState }> {
  if (!state.slot) {
    return { reply: [t.fallback], chips: [c.book, c.avail], state: { stage: "idle" } };
  }
  const bookPhone = state.viewPhone ?? phone;
  try {
    const appt = await backend.addBooking({ name: state.name || "Patient", phone: bookPhone, age: 0, date: state.slot.date, time: state.slot.time, source, replacePending: true, claim });
    await backend.notifyClaimBooking(appt);
    const msg = claim === "returning_unverified" ? t.claimCounterConfirm(appt.token, state.slot.label, appt.fee) : t.claimFreeConfirm(appt.token, state.slot.label);
    return { reply: [msg], chips: [c.avail, c.about, c.done], state: { stage: "idle" } };
  } catch (err) {
    await reportBotError("bot", "claim booking failed", { stage: "claim_rebook", phone: bookPhone }, err, { severity: "critical" });
    return { reply: [t.bookFail], chips: [c.book, c.avail], state: { stage: "idle" } };
  }
}

export function botStartServer(lang: Lang): { reply: string[]; chips: string[]; state: ServerBotState } {
  const t = P[lang];
  return { reply: [t.greet], chips: [t.chips.view, t.chips.book, t.chips.resched, t.chips.avail, t.chips.about, t.chips.timings, t.chips.location], state: { stage: "idle" } };
}

// WhatsApp's one-time language gate — asked once per phone number, before the
// bot has any lang to render replies in, so it's written out in all three up
// front rather than picked from a PhrasePack.
export const LANG_CHOICES: { lang: Lang; label: string }[] = [
  { lang: "en", label: "English" },
  { lang: "te", label: "తెలుగు" },
  { lang: "hi", label: "हिंदी" },
];
export function langPickPrompt(): { reply: string[]; chips: string[] } {
  return {
    reply: ["Please choose your language.\nదయచేసి మీ భాషను ఎంచుకోండి.\nकृपया अपनी भाषा चुनें।"],
    chips: LANG_CHOICES.map((c) => c.label),
  };
}
export function matchLangChoice(input: string): Lang | null {
  const raw = input.trim().toLowerCase();
  const byLabel = LANG_CHOICES.find((c) => c.label.toLowerCase() === raw);
  if (byLabel) return byLabel.lang;
  // "hi" is deliberately not an alias for Hindi here — it's the single most
  // likely thing a patient replies to this exact prompt as a plain greeting,
  // not a language pick, so it falls through to a re-prompt instead of
  // silently switching them into Hindi.
  if (raw === "1" || raw === "en" || raw === "english") return "en";
  if (raw === "2" || raw === "te" || raw === "telugu" || raw.includes("తెలుగు")) return "te";
  if (raw === "3" || raw === "hindi" || raw.includes("हिंदी")) return "hi";
  return null;
}

// Lets an *existing* session switch languages mid-conversation, not just a
// brand-new phone number — e.g. "మీరు ఇంగ్లీష్‌లో మాట్లాడుతున్నారు" or just
// "telugu"/"hindi" typed at any point. Only unambiguous words qualify (no
// bare "hi"/"en"/digit aliases here, unlike the picker reply above, since
// this fires against ordinary conversation text, not a reply to a prompt
// that was just shown). Checked in the webhook, not here, because only it
// persists which language is active.
export function detectLangSwitch(input: string): Lang | "ask" | null {
  const raw = input.trim().toLowerCase();
  if (/తెలుగు|\btelugu\b/.test(raw)) return "te";
  if (/हिंदी|\bhindi\b/.test(raw)) return "hi";
  if (/\benglish\b/.test(raw)) return "en";
  if (/^(language|languages|change language|భాష|भाषा)$/.test(raw)) return "ask";
  return null;
}
export function flowSlotTakenMsg(lang: Lang): string { return P[lang].flowSlotTaken; }
export function flowBookFailMsg(lang: Lang): string { return P[lang].flowBookFail; }
// A WhatsApp Flow booking was refused because a payment_pending hold is already
// on the number — the patient should finish that payment, not book a second slot.
export function flowPendingHoldMsg(lang: Lang): string { return P[lang].pendingHold; }
// The mandatory pay prompt sent right after a WhatsApp Flow booking
// confirmation — the slot is held 30 minutes while payment is pending.
export function flowPayPrompt(lang: Lang): string { return P[lang].payPrompt; }
// The matching "Pay now" button label for that prompt (per-language chip label),
// so the Flow follow-up carries a real tappable button, not just the word.
export function flowPayNowLabel(lang: Lang): string { return P[lang].chips.payNow; }
export function flowStartOverLabel(lang: Lang): string { return P[lang].chips.startOver; }

export async function botReplyServer(
  input: string,
  lang: Lang,
  state: ServerBotState,
  phone: string,
  backend: Backend,
  sched: SchedState,
  source: Source = "whatsapp"
): Promise<{ reply: string[]; chips: string[]; state: ServerBotState }> {
  const t = P[lang];
  const c = t.chips;

  // Escape hatch: without this, "cancel" typed while answering name/phone was
  // swallowed as literal input for that stage (e.g. booked as a patient named
  // "cancel") instead of backing the patient out of a flow they no longer want.
  if (MID_FLOW_STAGES.includes(state.stage) && detect(input) === "cancel") {
    return { reply: [t.flowCancelled], chips: [c.book, c.avail], state: { stage: "idle" } };
  }

  // picking which appointment to pay for, when the phone has more than one
  // active and unpaid — same matching rules as the cancel picker above.
  if (state.stage === "await_pay_pick" && state.payCandidates?.length) {
    const raw = input.trim();
    const picked =
      state.payCandidates.find((cd) => cd.label === raw) ??
      state.payCandidates.find((cd) => String(cd.token) === raw) ??
      state.payCandidates.find((cd) => cd.name.toLowerCase().includes(raw.toLowerCase()));
    if (picked) {
      try {
        const url = await backend.createPaymentLink(picked.id, phone);
        return { reply: [t.payDone(url)], chips: [c.avail, c.book], state: { stage: "idle" } };
      } catch (err) {
        await reportBotError("bot", "create payment link failed", { stage: "await_pay_pick" }, err, { severity: "critical" });
        return { reply: [t.payFail], chips: [c.book], state: { stage: "idle" } };
      }
    }
    return {
      reply: [t.payNotFound],
      chips: state.payCandidates.map((cd) => cd.label),
      state: { stage: "await_pay_pick", payCandidates: state.payCandidates },
    };
  }

  // picking which appointment to reschedule, when the phone has more than one
  // active booking — same matching rules as the cancel/pay pickers above.
  if (state.stage === "await_resched_pick" && state.reschedCandidates?.length) {
    const raw = input.trim();
    const picked =
      state.reschedCandidates.find((cd) => cd.label === raw) ??
      state.reschedCandidates.find((cd) => String(cd.token) === raw) ??
      state.reschedCandidates.find((cd) => cd.name.toLowerCase().includes(raw.toLowerCase()));
    if (!picked) {
      return {
        reply: [t.reschedNotFound],
        chips: state.reschedCandidates.map((cd) => cd.label),
        state: { stage: "await_resched_pick", reschedCandidates: state.reschedCandidates },
      };
    }
    return enterPickerServer({ id: picked.id, phone }, backend, sched, t);
  }

  // name collected: hold the slot, ask which number to book it under —
  // defaults to the WhatsApp sender's own number, but a parent booking for a
  // child (or anyone messaging from someone else's phone) can swap it out.
  if (state.stage === "await_name" && state.slot) {
    const name = input.trim() || "Patient";
    return {
      reply: [t.askContactConfirm(formatIndianPhone(phone))],
      chips: [c.useNumber],
      state: { stage: "await_phone", slot: state.slot, name, replacePending: state.replacePending },
    };
  }

  // contact number confirmed (or overridden): this is where the booking
  // actually happens, using whichever number the patient settled on.
  if (state.stage === "await_phone" && state.slot) {
    let bookPhone = phone;
    if (!isAffirmative(input, c.useNumber)) {
      const digits = input.replace(/\D/g, "");
      if (digits.length < 10) return { reply: [t.badPhone], chips: [c.useNumber], state };
      bookPhone = digits;
    }
    try {
      const appt = await backend.addBooking({ name: state.name || "Patient", phone: bookPhone, age: 0, date: state.slot.date, time: state.slot.time, source, replacePending: state.replacePending });
      // The booking is done — offer to settle the fee right here, so the
      // patient doesn't have to know a "pay" keyword exists or find the My
      // Appointment page. The chip routes into the shared pay intent below.
      // slot/name/viewPhone stay in state for the payCounter/reviewFree rebook
      // path — viewPhone remembers bookPhone since it can differ from the
      // WhatsApp sender's own number.
      return { reply: [t.confirm(appt.token, state.slot.label, appt.fee), t.payPrompt], chips: [c.payNow, c.payCounter, c.reviewFree, c.avail, c.about, c.location, c.done], state: { stage: "idle", slot: state.slot, name: state.name, viewPhone: bookPhone } };
    } catch (err) {
      if (err instanceof PendingHoldError) {
        // A payment_pending hold already sits on this number. Don't stack a
        // second slot (or charge a wrong returning fee) — point them at paying
        // the hold they already have. Pay now routes into the shared pay intent
        // (which uses the sender's number, the default booking number).
        return { reply: [t.pendingHold], chips: [c.payNow, c.startOver, c.view, c.book], state: { stage: "idle" } };
      }
      if (err instanceof SlotTakenError) {
        const fresh = await timesForDateServer(state.slot.date, backend, sched);
        const win = windowsFor(new Date(state.slot.date + "T00:00:00"), sched).find((w) => inWindow(state.slot!.time, w));
        const scoped = win ? fresh.filter((t2) => inWindow(t2, win)) : fresh;
        if (!scoped.length) return { reply: [t.slotTaken, t.noSlots], chips: [c.avail], state: { stage: "idle" } };
        if (win && scoped.length > MAX_CHIPS) {
          const ranges = splitWindow(win, scoped.length);
          const dayLabel = dayLabelForDate(state.slot.date, nowIST());
          return { reply: [t.slotTaken, t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win } };
        }
        return { reply: [t.slotTaken], chips: scoped.map(fmt), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win } };
      }
      await reportBotError("bot", "booking failed", { stage: "await_phone", phone: bookPhone }, err, { severity: "critical" });
      return { reply: [t.bookFail], chips: [c.book, c.avail], state: { stage: "idle" } };
    }
  }

  // tapped a time chip (only meaningful once a day AND a window are picked)
  if (state.pendingDate && state.pendingWindow) {
    const effective = state.pendingRange ?? state.pendingWindow;
    const times = (await timesForDateServer(state.pendingDate, backend, sched)).filter((s) => inWindow(s, effective));
    const match = times.find((s) => fmt(s) === input);
    if (match) {
      const label = `${dayLabelForDate(state.pendingDate, nowIST())} ${fmt(match)}`;
      // a reschedule in progress: the tap MOVE the existing booking
      if (state.resched) {
        try {
          await backend.reschedule(state.resched.id, state.pendingDate, match);
          return { reply: [t.reschedDone(label)], chips: [c.avail, c.book, c.done], state: { stage: "idle" } };
        } catch (err) {
          if (err instanceof SlotTakenError) return slotTakenFallbackServer(state.resched, state.pendingDate, match, backend, sched, t);
          await reportBotError("bot", "reschedule failed", { stage: "time_pick", id: state.resched.id }, err);
          return { reply: [t.reschedFail], chips: [c.book], state: { stage: "idle" } };
        }
      }
      return { reply: [t.askName], chips: [], state: { stage: "await_name", slot: { date: state.pendingDate, time: match, label }, replacePending: state.replacePending } };
    }
  }

  // tapped a range chip (window picked, but it had too many slots for one screen)
  if (state.pendingDate && state.pendingWindow && !state.pendingRange) {
    const winTimes = (await timesForDateServer(state.pendingDate, backend, sched)).filter((s) => inWindow(s, state.pendingWindow!));
    const ranges = splitWindow(state.pendingWindow, winTimes.length);
    const pickedRange = ranges.length > 1 ? ranges.find((r) => windowLabel(r) === input) : undefined;
    if (pickedRange) {
      const times = winTimes.filter((s) => inWindow(s, pickedRange));
      const dayLabel = dayLabelForDate(state.pendingDate, nowIST());
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedRange))], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: state.pendingWindow, pendingRange: pickedRange, replacePending: state.replacePending } };
    }
  }

  // tapped a window chip (day picked, more than one window that day)
  if (state.pendingDate && !state.pendingWindow) {
    const wins = await windowsWithSlotsForServer(state.pendingDate, backend, sched);
    const pickedWin = wins.find((w) => windowLabel(w) === input);
    if (pickedWin) {
      const times = (await timesForDateServer(state.pendingDate, backend, sched)).filter((s) => inWindow(s, pickedWin));
      const dayLabel = dayLabelForDate(state.pendingDate, nowIST());
      if (times.length > MAX_CHIPS) {
        const ranges = splitWindow(pickedWin, times.length);
        return { reply: [t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: pickedWin, replacePending: state.replacePending } };
      }
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedWin))], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: state.pendingDate, pendingWindow: pickedWin, replacePending: state.replacePending } };
    }
  }

  // tapped a day chip
  const days = await openDaysServer(backend, sched);
  const pickedDay = days.find((d) => d.label === input);
  if (pickedDay) {
    const times = await timesForDateServer(pickedDay.date, backend, sched);
    if (!times.length) {
      const fresh = days.filter((d) => d.date !== pickedDay.date);
      if (!fresh.length) return { reply: [t.dayFull(pickedDay.label), t.noSlots], chips: [c.avail], state: { stage: "idle", resched: state.resched, replacePending: state.replacePending } };
      return { reply: [t.dayFull(pickedDay.label)], chips: fresh.map((d) => d.label), state: { stage: "idle", resched: state.resched, replacePending: state.replacePending } };
    }
    const wins = await windowsWithSlotsForServer(pickedDay.date, backend, sched);
    if (wins.length > 1) {
      return { reply: [t.pickWindow(pickedDay.label)], chips: wins.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, replacePending: state.replacePending } };
    }
    if (times.length > MAX_CHIPS) {
      const ranges = splitWindow(wins[0], times.length);
      return { reply: [t.pickRange(pickedDay.label)], chips: ranges.map(windowLabel), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, pendingWindow: wins[0], replacePending: state.replacePending } };
    }
    return { reply: [t.timesFor(pickedDay.label)], chips: times.map(fmt), state: { stage: "idle", resched: state.resched, pendingDate: pickedDay.date, pendingWindow: wins[0], replacePending: state.replacePending } };
  }

  switch (detect(input)) {
    case "avail":
      return { reply: [availReplyServer(t, sched)], chips: [c.book, c.about, c.timings], state: { stage: "idle" } };
    case "view": {
      // includePending: a just-booked row is payment_pending until the webhook
      // confirms payment. It must show as "finish payment" (order is held, not
      // yet confirmed) rather than the misleading "you have no appointments".
      const all = await backend.activeAppointmentsByPhone(phone, true);
      const pending = all.filter((a) => a.status === "payment_pending");
      const active = all.filter((a) => a.status !== "payment_pending");
      const lines = [...(pending.length ? [t.payPrompt] : []), ...active.map(fmtApptForView)];
      if (!lines.length) return { reply: [t.viewNone], chips: [c.book], state: { stage: "idle" } };
      return {
        reply: [t.viewIntro, ...lines],
        chips: pending.length ? [c.payNow, ...(active.length ? [c.resched] : []), c.book] : [c.resched, c.book],
        state: { stage: "idle" },
      };
    }
    case "reschedule": {
      const all = await backend.activeAppointmentsByPhone(phone, true);
      const active = all.filter((a) => a.status !== "payment_pending");
      if (!active.length) {
        // Only unpaid holds on this number — they can't be moved until paid.
        const pending = all.filter((a) => a.status === "payment_pending");
        if (pending.length) return { reply: [t.payPrompt], chips: [c.payNow, c.book], state: { stage: "idle" } };
        return { reply: [t.viewNone], chips: [c.book], state: { stage: "idle" } };
      }
      if (active.length === 1) return enterPickerServer({ id: active[0].id, phone }, backend, sched, t);
      const candidates: CancelCandidate[] = active.map((a) => ({ id: a.id, token: a.token, name: a.name, label: `#${a.token} · ${a.name}` }));
      return { reply: [t.reschedWhich], chips: candidates.map((cd) => cd.label), state: { stage: "await_resched_pick", reschedCandidates: candidates } };
    }
    case "book": {
      const dayList = await openDaysServer(backend, sched);
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle" } };
    }
    case "startOver": {
      const dayList = await openDaysServer(backend, sched);
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle", replacePending: true } };
    }
    case "cancel": {
      // Cancellations are handled by the clinic, not automated — so instead of
      // cancelling here, offer a move to a new time and point the patient at
      // the phone if they still want to cancel.
      return { reply: [t.cancelAsk], chips: [c.resched, c.book], state: { stage: "idle" } };
    }
    case "pay": {
      // includePending: a just-booked appointment is payment_pending until the
      // webhook confirms payment, and the whole point of the pay intent is to
      // collect that payment.
      const active = (await backend.activeAppointmentsByPhone(phone, true)).filter((a) => !a.paid);
      if (!active.length) {
        return { reply: [t.payNone], chips: [c.book], state: { stage: "idle" } };
      }
      if (active.length === 1) {
        try {
          const url = await backend.createPaymentLink(active[0].id, phone);
          return { reply: [t.payDone(url)], chips: [c.avail, c.book], state: { stage: "idle" } };
        } catch (err) {
          await reportBotError("bot", "create payment link failed", { stage: "pay_intent" }, err, { severity: "critical" });
          return { reply: [t.payFail], chips: [c.book], state: { stage: "idle" } };
        }
      }
      const candidates: PayCandidate[] = active.map((a) => ({ id: a.id, token: a.token, name: a.name, label: `#${a.token} · ${a.name}` }));
      return {
        reply: [t.payWhich],
        chips: candidates.map((cd) => cd.label),
        state: { stage: "await_pay_pick", payCandidates: candidates },
      };
    }
    case "payCounter":
      return claimRebookServer(state, phone, backend, t, c, "returning_unverified", source);
    case "reviewFree":
      return claimRebookServer(state, phone, backend, t, c, "review_free", source);
    case "hours": case "fee":
      return { reply: [t.hours], chips: [c.book, c.location], state: { stage: "idle" } };
    case "location":
      return { reply: [t.location], chips: [c.book, c.timings], state: { stage: "idle" } };
    case "about":
      return { reply: [t.about], chips: [c.book, c.avail], state: { stage: "idle" } };
    case "thanks":
      return { reply: [t.thanks], chips: [c.avail, c.book], state: { stage: "idle" } };
    case "greet":
      return botStartServer(lang);
    default:
      return { reply: [t.fallback], chips: [c.view, c.book, c.resched, c.avail, c.about, c.timings, c.payNow], state: { stage: "idle" } };
  }
}
