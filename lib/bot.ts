// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp assistant engine. Intent routing + the appointment flow + the four
// automations (confirm / cancel / reminder / availability), in te/en/hi.
//
// For the beta demo this runs on lightweight on-device intent matching so it
// works with zero config. In production the same handlers are driven by Claude
// (Anthropic API) for free-text understanding — the shapes below map 1:1.
// ─────────────────────────────────────────────────────────────────────────────
import { clinic, type Lang } from "@/clinic.config";
import { statusAt, fmt, weekdayName, slotsFor, windowsFor, ymd, nowIST, BOOKING_LEAD_MIN, type SchedState, type Window } from "@/lib/schedule";
import { addBooking, takenSlots, setStatus, type Source, type Appt, type ApptStatus } from "@/lib/store";
import { hasSupabase } from "@/lib/supabase";
import { SlotTakenError } from "@/lib/errors";

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
export type BotState = { stage: "idle" | "await_name" | "await_phone"; slot?: Slot; name?: string; pendingDate?: string; pendingWindow?: Window; pendingRange?: Window };
export type BotOut = { reply: string[]; chips: string[]; state: BotState };
type Slot = { date: string; time: string; label: string };

const uid = () => Math.random().toString(36).slice(2, 9);
export const mkMsg = (from: Sender, text: string): ChatMsg => ({ id: uid(), from, text });

export { SlotTakenError } from "@/lib/errors";

let lastBookingId: string | null = null; // so "cancel" can undo the demo booking

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
    } catch {
      return [];
    }
  }
  return slotsFor(new Date(date + "T00:00:00"), takenSlots(date));
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
  badPhone: string;
  slotTaken: string;
  bookFail: string;
  confirm: (tok: number, s: string) => string;
  cancelDone: string;
  cancelNone: string;
  flowCancelled: string;
  hours: string;
  location: string;
  about: string;
  fallback: string;
  thanks: string;
  chips: { avail: string; book: string; timings: string; location: string; about: string; done: string };
};
const P: Record<Lang, PhrasePack> = {
  en: {
    greet: `Namaste 🙏 I'm the assistant for ${clinic.shortName}. How can I help you today?`,
    availIn: (u: string) => `✅ Yes, ${dr} is in today, until ${u}. Tap *Book appointment* to reserve a token.`,
    availSoon: (t: string) => `${dr} consults today from ${t}. Tap *Book appointment* to reserve a slot.`,
    availOut: (d: string, t: string) => `${dr} is *not in today*. The next available is *${d} at ${t}*. Tap *Book appointment* to reserve.`,
    availNone: `${dr} has no slots in the coming days. Please call the clinic on ${clinic.contact.phone}.`,
    bookIntro: "Sure! Here are the open slots. Tap the one you want:",
    pickDay: "Sure! Here are the days with open slots — tap one:",
    pickWindow: (day: string) => `Sure! For ${day}, would you prefer morning or evening?`,
    pickRange: (day: string) => `That's a lot of open times for ${day}. Pick a range:`,
    timesFor: (day: string) => `Great, here are the open times for ${day}:`,
    timesForWindow: (day: string, win: string) => `Great, here are the open times for ${day} (${win}):`,
    dayFull: (day: string) => `Sorry, ${day} just got fully booked. Please pick another day:`,
    noSlots: "There are no open slots right now. Please try later, or call the clinic.",
    askName: "Great choice. What name should I book it under?",
    askPhone: "And your phone number? We'll send the booking confirmation on WhatsApp.",
    badPhone: "That doesn't look like a valid phone number. Please enter a 10 digit number.",
    slotTaken: "Sorry, someone just booked that slot. Here are the times still open:",
    bookFail: "Something went wrong while booking. Please try again, or call the clinic.",
    confirm: (tok: number, s: string) => `✅ *Booked!* Your token is *#${tok}* for ${s}.\n${dr} · ${cur}${fee}. Please arrive a few minutes early.\nMissed your slot? It's automatically moved to the next working day, no need to rebook.\nReply *Cancel* if your plans change.`,
    cancelDone: "Done, your appointment is cancelled. Tap *Book appointment* to rebook anytime. 🙏",
    cancelNone: "You don't have an active appointment to cancel right now.",
    flowCancelled: "No problem, stopped that. Tap *Book appointment* whenever you're ready. 🙏",
    hours: `🕒 Consulting hours:\nMon–Sat 10 AM–12:30 PM & 6–7:45 PM. Sunday closed.\nConsultation is ${cur}${fee}.\n🚑 Medical emergency? Call ${clinic.contact.emergency}.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.\n🗺️ Directions: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}*\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\nRated ${clinic.rating.score}★ from ${clinic.rating.count}+ ${clinic.rating.source} reviews.`,
    fallback: "I can tell you if the doctor is in, tell you about the doctor, book you an appointment, or share timings and location. What would you like?",
    thanks: "You're welcome 🙏 Get well soon!",
    chips: { avail: "Is the doctor in today?", book: "Book appointment", timings: "Timings & fees", location: "Location", about: "About the doctor", done: "Thanks!" },
  },
  te: {
    greet: `నమస్కారం 🙏 నేను ${clinic.shortName} అసిస్టెంట్‌ని. మీకు ఎలా సహాయపడగలను?`,
    availIn: (u: string) => `✅ అవును, ${dr} ఈరోజు ${u} వరకు అందుబాటులో ఉన్నారు. టోకెన్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availSoon: (t: string) => `${dr} ఈరోజు ${t} నుండి చూస్తారు. స్లాట్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availOut: (d: string, t: string) => `${dr} ఈరోజు *అందుబాటులో లేరు*. తర్వాత అందుబాటు: *${d}, ${t}*. బుక్ చేయడానికి *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availNone: `రాబోయే రోజుల్లో స్లాట్‌లు లేవు. దయచేసి క్లినిక్‌కు కాల్ చేయండి: ${clinic.contact.phone}.`,
    bookIntro: "తప్పకుండా! ఖాళీగా ఉన్న స్లాట్‌లు ఇవి. మీకు కావలసినది నొక్కండి:",
    pickDay: "తప్పకుండా! ఖాళీ స్లాట్‌లు ఉన్న రోజులు ఇవి — ఒకటి నొక్కండి:",
    pickWindow: (day: string) => `సరే! ${day} కోసం, ఉదయం లేదా సాయంత్రం, ఏది కావాలి?`,
    pickRange: (day: string) => `${day} కోసం చాలా సమయాలు ఖాళీగా ఉన్నాయి. ఒక పరిధిని ఎంచుకోండి:`,
    timesFor: (day: string) => `సరే, ${day} కోసం ఖాళీగా ఉన్న సమయాలు ఇవి:`,
    timesForWindow: (day: string, win: string) => `సరే, ${day} (${win}) కోసం ఖాళీగా ఉన్న సమయాలు ఇవి:`,
    dayFull: (day: string) => `క్షమించండి, ${day} ఇప్పుడే పూర్తిగా బుక్ అయ్యింది. దయచేసి వేరే రోజు ఎంచుకోండి:`,
    noSlots: "ప్రస్తుతం స్లాట్‌లు లేవు. దయచేసి తర్వాత ప్రయత్నించండి లేదా క్లినిక్‌కు కాల్ చేయండి.",
    askName: "మంచిది. ఏ పేరుతో బుక్ చేయాలి?",
    askPhone: "మీ ఫోన్ నంబర్ చెప్పండి. బుకింగ్ నిర్ధారణ వాట్సాప్‌కు పంపుతాము.",
    badPhone: "ఇది సరైన ఫోన్ నంబర్ లా లేదు. దయచేసి 10 అంకెల నంబర్ ఇవ్వండి.",
    slotTaken: "క్షమించండి, ఆ స్లాట్ ఇప్పుడే బుక్ అయ్యింది. ఇంకా ఖాళీగా ఉన్న సమయాలు ఇవి:",
    bookFail: "బుక్ చేయడంలో సమస్య వచ్చింది. దయచేసి మళ్ళీ ప్రయత్నించండి, లేదా క్లినిక్‌కు కాల్ చేయండి.",
    confirm: (tok: number, s: string) => `✅ *బుక్ అయ్యింది!* మీ టోకెన్ *#${tok}*, ${s}.\n${dr} · ${cur}${fee}. దయచేసి కొన్ని నిమిషాల ముందు రండి.\nసమయం మిస్ అయితే చింత అవసరం లేదు, అది స్వయంచాలకంగా తర్వాతి పనిదినానికి మారుతుంది.\nప్లాన్ మారితే *Cancel* అని రిప్లై చేయండి.`,
    cancelDone: "అయ్యింది, మీ అపాయింట్‌మెంట్ రద్దు చేయబడింది. మళ్లీ బుక్ చేయడానికి *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి. 🙏",
    cancelNone: "ప్రస్తుతం రద్దు చేయడానికి యాక్టివ్ అపాయింట్‌మెంట్ లేదు.",
    flowCancelled: "పర్వాలేదు, ఆపేశాను. మీరు సిద్ధమైనప్పుడు *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి. 🙏",
    hours: `🕒 కన్సల్టింగ్ సమయాలు:\nసోమ–శని ఉదయం 10–12:30 & సాయంత్రం 6–7:45 PM. ఆదివారం సెలవు.\nకన్సల్టేషన్ ${cur}${fee}.\n🚑 అత్యవసర పరిస్థితా? ${clinic.contact.emergency}కు కాల్ చేయండి.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.\n🗺️ దిశలు: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}* గురించి:\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\n${clinic.rating.source} రేటింగ్: ${clinic.rating.score}★ (${clinic.rating.count}+ రివ్యూలు).`,
    fallback: "డాక్టర్ ఉన్నారో లేదో చెప్పగలను, డాక్టర్ గురించి చెప్పగలను, అపాయింట్‌మెంట్ బుక్ చేయగలను, లేదా సమయాలు, చిరునామా చెప్పగలను. ఏం కావాలి?",
    thanks: "సంతోషం 🙏 త్వరగా కోలుకోండి!",
    chips: { avail: "ఈరోజు డాక్టర్ ఉన్నారా?", book: "అపాయింట్‌మెంట్ బుక్ చేయండి", timings: "సమయాలు & ఫీజు", location: "చిరునామా", about: "డాక్టర్ గురించి", done: "ధన్యవాదాలు!" },
  },
  hi: {
    greet: `नमस्ते 🙏 मैं ${clinic.shortName} का असिस्टेंट हूँ। मैं आपकी कैसे मदद करूँ?`,
    availIn: (u: string) => `✅ हाँ, ${dr} आज ${u} तक उपलब्ध हैं। टोकन के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availSoon: (t: string) => `${dr} आज ${t} से देखेंगे। स्लॉट के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availOut: (d: string, t: string) => `${dr} आज *उपलब्ध नहीं* हैं। अगली उपलब्धता: *${d}, ${t}*। बुक करने के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availNone: `आने वाले दिनों में कोई स्लॉट नहीं है। कृपया क्लिनिक को कॉल करें: ${clinic.contact.phone}।`,
    bookIntro: "ज़रूर! ये खाली स्लॉट हैं। जो चाहिए उसे दबाएँ:",
    pickDay: "ज़रूर! ये वे दिन हैं जिनमें स्लॉट खाली हैं — एक चुनें:",
    pickWindow: (day: string) => `ठीक है! ${day} के लिए, सुबह या शाम, कौन सा समय बेहतर रहेगा?`,
    pickRange: (day: string) => `${day} के लिए बहुत सारे खाली समय हैं। एक रेंज चुनें:`,
    timesFor: (day: string) => `बढ़िया, ${day} के लिए खाली समय ये हैं:`,
    timesForWindow: (day: string, win: string) => `बढ़िया, ${day} (${win}) के लिए खाली समय ये हैं:`,
    dayFull: (day: string) => `माफ़ करें, ${day} अभी पूरी तरह बुक हो गया। कृपया दूसरा दिन चुनें:`,
    noSlots: "अभी कोई स्लॉट खाली नहीं है। कृपया बाद में कोशिश करें या क्लिनिक को कॉल करें।",
    askName: "बढ़िया। किस नाम से बुक करूँ?",
    askPhone: "आपका फ़ोन नंबर बताएं। बुकिंग की पुष्टि हम व्हाट्सएप पर भेजेंगे।",
    badPhone: "यह सही फ़ोन नंबर नहीं लग रहा। कृपया 10 अंकों का नंबर दर्ज करें।",
    slotTaken: "माफ़ करें, वह स्लॉट अभी किसी और ने बुक कर लिया। ये समय अभी भी खाली हैं:",
    bookFail: "बुकिंग में कुछ समस्या हुई। कृपया दोबारा कोशिश करें, या क्लिनिक को कॉल करें।",
    confirm: (tok: number, s: string) => `✅ *बुक हो गया!* आपका टोकन *#${tok}*, ${s}।\n${dr} · ${cur}${fee}। कृपया कुछ मिनट पहले पहुँचें।\nसमय मिस हो जाए तो चिंता न करें, यह अपने आप अगले कार्य दिवस पर चला जाएगा।\nयोजना बदले तो *Cancel* लिखें।`,
    cancelDone: "हो गया, आपका अपॉइंटमेंट रद्द कर दिया गया है। दोबारा बुक करने के लिए *अपॉइंटमेंट बुक करें* दबाएँ। 🙏",
    cancelNone: "अभी रद्द करने के लिए कोई सक्रिय अपॉइंटमेंट नहीं है।",
    flowCancelled: "कोई बात नहीं, रोक दिया। जब तैयार हों तब *अपॉइंटमेंट बुक करें* दबाएँ। 🙏",
    hours: `🕒 परामर्श समय:\nसोम–शनि सुबह 10–12:30 और शाम 6–7:45 बजे। रविवार बंद।\nपरामर्श ${cur}${fee}।\n🚑 आपातकाल में कॉल करें: ${clinic.contact.emergency}।`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}।\n🗺️ दिशा-निर्देश: ${clinic.location.mapsUrl}`,
    about: `👨‍⚕️ *${dr}* के बारे में:\n${clinic.doctor.title}.\n${clinic.doctor.experienceNote}.\n${clinic.rating.source} रेटिंग: ${clinic.rating.score}★ (${clinic.rating.count}+ समीक्षाएं).`,
    fallback: "मैं बता सकता हूँ कि डॉक्टर उपलब्ध हैं या नहीं, डॉक्टर के बारे में बता सकता हूँ, अपॉइंटमेंट बुक कर सकता हूँ, या समय व पता बता सकता हूँ। क्या चाहिए?",
    thanks: "आपका स्वागत है 🙏 जल्दी स्वस्थ हों!",
    chips: { avail: "क्या डॉक्टर आज उपलब्ध हैं?", book: "अपॉइंटमेंट बुक करें", timings: "समय व फीस", location: "पता", about: "डॉक्टर के बारे में", done: "धन्यवाद!" },
  },
};

// ── intent detection (heuristic for the beta; Claude in production) ──────────
type Intent = "avail" | "book" | "cancel" | "hours" | "location" | "fee" | "about" | "greet" | "thanks" | "fallback";
function detect(s: string): Intent {
  const has = (re: RegExp) => re.test(s);
  if (has(/cancel|రద్దు|कैंसिल|रद्द/i)) return "cancel";
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

function availReply(t: PhrasePack): string {
  const st = statusAt();
  if (st.state === "in") return t.availIn(fmt(st.until));
  if (st.state === "soon") return t.availSoon(fmt(st.opensAt));
  if (st.next) return t.availOut(weekdayName(st.next.date), fmt(st.next.opensAt));
  return t.availNone;
}

export function botStart(lang: Lang): BotOut {
  const t = P[lang];
  return { reply: [t.greet], chips: [t.chips.avail, t.chips.book, t.chips.about, t.chips.timings, t.chips.location], state: { stage: "idle" } };
}

export async function botReply(input: string, lang: Lang, state: BotState, source: Source = "whatsapp"): Promise<BotOut> {
  const t = P[lang];
  const c = t.chips;

  // Escape hatch: without this, "cancel" typed while answering name/phone was
  // swallowed as literal input for that stage (e.g. booked as a patient named
  // "cancel") instead of backing the patient out of a flow they no longer want.
  if ((state.stage === "await_name" || state.stage === "await_phone") && detect(input) === "cancel") {
    return { reply: [t.flowCancelled], chips: [c.book, c.avail], state: { stage: "idle" } };
  }

  // completing a booking: this input is the patient's name
  if (state.stage === "await_name" && state.slot) {
    const name = input.trim() || "Patient";
    // DB mode needs a phone (confirmation goes out on WhatsApp, and it's how
    // the admin dashboard reaches the patient) — the mock demo doesn't.
    if (hasSupabase()) {
      return { reply: [t.askPhone], chips: [], state: { stage: "await_phone", slot: state.slot, name } };
    }
    const appt = addBooking({ name, phone: "", reason: source === "website" ? "Booked via RC (site chat)" : "WhatsApp booking", date: state.slot.date, time: state.slot.time, source });
    lastBookingId = appt.id;
    return { reply: [t.confirm(appt.token, state.slot.label)], chips: [c.avail, c.about, c.location, c.done], state: { stage: "idle" } };
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
          reason: source === "website" ? "Booked via RC (site chat)" : "WhatsApp booking",
          date: state.slot.date,
          time: state.slot.time,
          source,
        }),
      });
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
      const { appointment: appt } = (await res.json()) as { appointment: Appt };
      lastBookingId = appt.id;
      return { reply: [t.confirm(appt.token, state.slot.label)], chips: [c.avail, c.about, c.location, c.done], state: { stage: "idle" } };
    } catch {
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
      return { reply: [t.askName], chips: [], state: { stage: "await_name", slot: { date: state.pendingDate, time: match, label } } };
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
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedRange))], chips: times.map(fmt), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: state.pendingWindow, pendingRange: pickedRange } };
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
        return { reply: [t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: pickedWin } };
      }
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedWin))], chips: times.map(fmt), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: pickedWin } };
    }
  }

  // tapped a day chip
  const days = await openDays();
  const pickedDay = days.find((d) => d.label === input);
  if (pickedDay) {
    const times = await timesForDate(pickedDay.date);
    if (!times.length) {
      const fresh = days.filter((d) => d.date !== pickedDay.date);
      if (!fresh.length) return { reply: [t.dayFull(pickedDay.label), t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.dayFull(pickedDay.label)], chips: fresh.map((d) => d.label), state: { stage: "idle" } };
    }
    const wins = await windowsWithSlotsFor(pickedDay.date);
    if (wins.length > 1) {
      return { reply: [t.pickWindow(pickedDay.label)], chips: wins.map(windowLabel), state: { stage: "idle", pendingDate: pickedDay.date } };
    }
    if (times.length > MAX_CHIPS) {
      const ranges = splitWindow(wins[0], times.length);
      return { reply: [t.pickRange(pickedDay.label)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: pickedDay.date, pendingWindow: wins[0] } };
    }
    return { reply: [t.timesFor(pickedDay.label)], chips: times.map(fmt), state: { stage: "idle", pendingDate: pickedDay.date, pendingWindow: wins[0] } };
  }

  switch (detect(input)) {
    case "avail":
      return { reply: [availReply(t)], chips: [c.book, c.about, c.timings], state: { stage: "idle" } };
    case "book": {
      const dayList = await openDays();
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle" } };
    }
    case "cancel": {
      if (lastBookingId) { setStatus(lastBookingId, "cancelled"); lastBookingId = null; return { reply: [t.cancelDone], chips: [c.book], state: { stage: "idle" } }; }
      return { reply: [t.cancelNone], chips: [c.book], state: { stage: "idle" } };
    }
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
      return { reply: [t.fallback], chips: [c.avail, c.book, c.about, c.timings], state: { stage: "idle" } };
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
  addBooking: (input: { name: string; phone: string; reason: string; date: string; time: string; source?: Source }) => Promise<Appt>;
  takenSlots: (date: string) => Promise<string[]>;
  setStatus: (id: string, status: ApptStatus) => Promise<void>;
};
export type ServerBotState = BotState & { lastBookingId?: string | null };

async function openDaysServer(backend: Backend, sched: SchedState): Promise<DayChip[]> {
  const now = nowIST();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: DayChip[] = [];
  for (let i = 0; i < 14 && out.length < MAX_DAY_CHIPS; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const key = ymd(d);
    let slots = slotsFor(d, await backend.takenSlots(key), sched);
    if (i === 0) slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + BOOKING_LEAD_MIN; });
    if (slots.length) out.push({ date: key, label: dayLabelForOffset(i, d) });
  }
  return out;
}
async function timesForDateServer(date: string, backend: Backend, sched: SchedState): Promise<string[]> {
  const now = nowIST();
  const d = new Date(date + "T00:00:00");
  let slots = slotsFor(d, await backend.takenSlots(date), sched);
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

export function botStartServer(lang: Lang): { reply: string[]; chips: string[]; state: ServerBotState } {
  const t = P[lang];
  return { reply: [t.greet], chips: [t.chips.avail, t.chips.book, t.chips.about, t.chips.timings, t.chips.location], state: { stage: "idle" } };
}

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
  if ((state.stage === "await_name" || state.stage === "await_phone") && detect(input) === "cancel") {
    return { reply: [t.flowCancelled], chips: [c.book, c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
  }

  // completing a booking: this input is the patient's name
  if (state.stage === "await_name" && state.slot) {
    try {
      const appt = await backend.addBooking({ name: input.trim() || "Patient", phone, reason: "WhatsApp booking", date: state.slot.date, time: state.slot.time, source });
      return { reply: [t.confirm(appt.token, state.slot.label)], chips: [c.avail, c.about, c.location, c.done], state: { stage: "idle", lastBookingId: appt.id } };
    } catch (err) {
      if (err instanceof SlotTakenError) {
        const fresh = await timesForDateServer(state.slot.date, backend, sched);
        const win = windowsFor(new Date(state.slot.date + "T00:00:00"), sched).find((w) => inWindow(state.slot!.time, w));
        const scoped = win ? fresh.filter((t2) => inWindow(t2, win)) : fresh;
        if (!scoped.length) return { reply: [t.slotTaken, t.noSlots], chips: [c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
        if (win && scoped.length > MAX_CHIPS) {
          const ranges = splitWindow(win, scoped.length);
          const dayLabel = dayLabelForDate(state.slot.date, nowIST());
          return { reply: [t.slotTaken, t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win, lastBookingId: state.lastBookingId } };
        }
        return { reply: [t.slotTaken], chips: scoped.map(fmt), state: { stage: "idle", pendingDate: state.slot.date, pendingWindow: win, lastBookingId: state.lastBookingId } };
      }
      return { reply: [t.bookFail], chips: [c.book, c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    }
  }

  // tapped a time chip (only meaningful once a day AND a window are picked)
  if (state.pendingDate && state.pendingWindow) {
    const effective = state.pendingRange ?? state.pendingWindow;
    const times = (await timesForDateServer(state.pendingDate, backend, sched)).filter((s) => inWindow(s, effective));
    const match = times.find((s) => fmt(s) === input);
    if (match) {
      const label = `${dayLabelForDate(state.pendingDate, nowIST())} ${fmt(match)}`;
      return { reply: [t.askName], chips: [], state: { stage: "await_name", slot: { date: state.pendingDate, time: match, label }, lastBookingId: state.lastBookingId } };
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
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedRange))], chips: times.map(fmt), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: state.pendingWindow, pendingRange: pickedRange, lastBookingId: state.lastBookingId } };
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
        return { reply: [t.pickRange(dayLabel)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: pickedWin, lastBookingId: state.lastBookingId } };
      }
      return { reply: [t.timesForWindow(dayLabel, windowLabel(pickedWin))], chips: times.map(fmt), state: { stage: "idle", pendingDate: state.pendingDate, pendingWindow: pickedWin, lastBookingId: state.lastBookingId } };
    }
  }

  // tapped a day chip
  const days = await openDaysServer(backend, sched);
  const pickedDay = days.find((d) => d.label === input);
  if (pickedDay) {
    const times = await timesForDateServer(pickedDay.date, backend, sched);
    if (!times.length) {
      const fresh = days.filter((d) => d.date !== pickedDay.date);
      if (!fresh.length) return { reply: [t.dayFull(pickedDay.label), t.noSlots], chips: [c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
      return { reply: [t.dayFull(pickedDay.label)], chips: fresh.map((d) => d.label), state: { stage: "idle", lastBookingId: state.lastBookingId } };
    }
    const wins = await windowsWithSlotsForServer(pickedDay.date, backend, sched);
    if (wins.length > 1) {
      return { reply: [t.pickWindow(pickedDay.label)], chips: wins.map(windowLabel), state: { stage: "idle", pendingDate: pickedDay.date, lastBookingId: state.lastBookingId } };
    }
    if (times.length > MAX_CHIPS) {
      const ranges = splitWindow(wins[0], times.length);
      return { reply: [t.pickRange(pickedDay.label)], chips: ranges.map(windowLabel), state: { stage: "idle", pendingDate: pickedDay.date, pendingWindow: wins[0], lastBookingId: state.lastBookingId } };
    }
    return { reply: [t.timesFor(pickedDay.label)], chips: times.map(fmt), state: { stage: "idle", pendingDate: pickedDay.date, pendingWindow: wins[0], lastBookingId: state.lastBookingId } };
  }

  switch (detect(input)) {
    case "avail":
      return { reply: [availReplyServer(t, sched)], chips: [c.book, c.about, c.timings], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    case "book": {
      const dayList = await openDaysServer(backend, sched);
      if (!dayList.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
      return { reply: [t.pickDay], chips: dayList.map((d) => d.label), state: { stage: "idle", lastBookingId: state.lastBookingId } };
    }
    case "cancel": {
      if (state.lastBookingId) {
        await backend.setStatus(state.lastBookingId, "cancelled");
        return { reply: [t.cancelDone], chips: [c.book], state: { stage: "idle", lastBookingId: null } };
      }
      return { reply: [t.cancelNone], chips: [c.book], state: { stage: "idle" } };
    }
    case "hours": case "fee":
      return { reply: [t.hours], chips: [c.book, c.location], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    case "location":
      return { reply: [t.location], chips: [c.book, c.timings], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    case "about":
      return { reply: [t.about], chips: [c.book, c.avail], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    case "thanks":
      return { reply: [t.thanks], chips: [c.avail, c.book], state: { stage: "idle", lastBookingId: state.lastBookingId } };
    case "greet":
      return botStartServer(lang);
    default:
      return { reply: [t.fallback], chips: [c.avail, c.book, c.about, c.timings], state: { stage: "idle", lastBookingId: state.lastBookingId } };
  }
}
