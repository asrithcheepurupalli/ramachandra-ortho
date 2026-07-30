// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp assistant engine. Intent routing + the appointment flow + the four
// automations (confirm / cancel / reminder / availability), in te/en/hi.
//
// For the beta demo this runs on lightweight on-device intent matching so it
// works with zero config. In production the same handlers are driven by Claude
// (Anthropic API) for free-text understanding — the shapes below map 1:1.
// ─────────────────────────────────────────────────────────────────────────────
import { clinic, type Lang } from "@/clinic.config";
import { statusAt, fmt, weekdayName, slotsFor, ymd } from "@/lib/schedule";
import { addBooking, takenSlots, setStatus } from "@/lib/store";

export type Sender = "bot" | "user";
export type ChatMsg = { id: string; from: Sender; text: string };
export type BotState = { stage: "idle" | "await_name"; slot?: Slot };
export type BotOut = { reply: string[]; chips: string[]; state: BotState };
type Slot = { date: string; time: string; label: string };

const uid = () => Math.random().toString(36).slice(2, 9);
export const mkMsg = (from: Sender, text: string): ChatMsg => ({ id: uid(), from, text });

let lastBookingId: string | null = null; // so "cancel" can undo the demo booking

const cur = clinic.currency, fee = clinic.consultationFee, dr = clinic.doctor.name;

// ── next open slots (for the in-chat booking) ───────────────────────────────
function nextSlots(n = 4): Slot[] {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: Slot[] = [];
  for (let i = 0; i < 14 && out.length < n; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const key = ymd(d);
    let slots = slotsFor(d, takenSlots(key));
    if (i === 0) slots = slots.filter((s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m > nowMin + 10; });
    for (const s of slots) {
      const day = i === 0 ? "Today" : i === 1 ? "Tomorrow" : weekdayName(d).slice(0, 3);
      out.push({ date: key, time: s, label: `${day} ${fmt(s)}` });
      if (out.length >= n) break;
    }
  }
  return out;
}
const slotByLabel = (label: string) => nextSlots(8).find((s) => s.label === label);

// ── phrase packs ────────────────────────────────────────────────────────────
type PhrasePack = {
  greet: string;
  availIn: (u: string) => string;
  availSoon: (t: string) => string;
  availOut: (d: string, t: string) => string;
  availNone: string;
  bookIntro: string;
  noSlots: string;
  askName: string;
  confirm: (tok: number, s: string) => string;
  cancelDone: string;
  cancelNone: string;
  hours: string;
  location: string;
  fallback: string;
  thanks: string;
  chips: { avail: string; book: string; timings: string; location: string; done: string };
};
const P: Record<Lang, PhrasePack> = {
  en: {
    greet: `Namaste 🙏 I'm the assistant for ${clinic.shortName}. How can I help you today?`,
    availIn: (u: string) => `✅ Yes, ${dr} is in today, until ${u}. Tap *Book appointment* to reserve a token.`,
    availSoon: (t: string) => `${dr} consults today from ${t}. Tap *Book appointment* to reserve a slot.`,
    availOut: (d: string, t: string) => `${dr} is *not in today*. The next available is *${d} at ${t}*. Tap *Book appointment* to reserve.`,
    availNone: `${dr} has no slots in the coming days. Please call the clinic on ${clinic.contact.phone}.`,
    bookIntro: "Sure! Here are the next available slots. Tap the one you want:",
    noSlots: "There are no open slots right now. Please try later, or call the clinic.",
    askName: "Great choice. What name should I book it under?",
    confirm: (tok: number, s: string) => `✅ *Booked!* Your token is *#${tok}* for ${s}.\n${dr} · ${cur}${fee}. Please arrive a few minutes early.\nReply *Cancel* if your plans change.`,
    cancelDone: "Done, your appointment is cancelled. Tap *Book appointment* to rebook anytime. 🙏",
    cancelNone: "You don't have an active appointment to cancel right now.",
    hours: `🕒 Consulting hours:\nMon 10–11 AM · Tue & Thu 6–8 PM · Wed 7–8 PM · Fri 6–7 PM.\nSaturdays vary — always check here first. Consultation is ${cur}${fee}.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.`,
    fallback: "I can tell you if the doctor is in, book you an appointment, or share timings and location. What would you like?",
    thanks: "You're welcome 🙏 Get well soon!",
    chips: { avail: "Is the doctor in today?", book: "Book appointment", timings: "Timings & fees", location: "Location", done: "Thanks!" },
  },
  te: {
    greet: `నమస్కారం 🙏 నేను ${clinic.shortName} అసిస్టెంట్‌ని. మీకు ఎలా సహాయపడగలను?`,
    availIn: (u: string) => `✅ అవును, ${dr} ఈరోజు ${u} వరకు అందుబాటులో ఉన్నారు. టోకెన్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availSoon: (t: string) => `${dr} ఈరోజు ${t} నుండి చూస్తారు. స్లాట్ కోసం *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availOut: (d: string, t: string) => `${dr} ఈరోజు *అందుబాటులో లేరు*. తర్వాత అందుబాటు: *${d}, ${t}*. బుక్ చేయడానికి *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి.`,
    availNone: `రాబోయే రోజుల్లో స్లాట్‌లు లేవు. దయచేసి క్లినిక్‌కు కాల్ చేయండి: ${clinic.contact.phone}.`,
    bookIntro: "తప్పకుండా! తదుపరి అందుబాటు స్లాట్‌లు ఇవి. మీకు కావలసినది నొక్కండి:",
    noSlots: "ప్రస్తుతం స్లాట్‌లు లేవు. దయచేసి తర్వాత ప్రయత్నించండి లేదా క్లినిక్‌కు కాల్ చేయండి.",
    askName: "మంచిది. ఏ పేరుతో బుక్ చేయాలి?",
    confirm: (tok: number, s: string) => `✅ *బుక్ అయ్యింది!* మీ టోకెన్ *#${tok}*, ${s}.\n${dr} · ${cur}${fee}. దయచేసి కొన్ని నిమిషాల ముందు రండి.\nప్లాన్ మారితే *Cancel* అని రిప్లై చేయండి.`,
    cancelDone: "అయ్యింది, మీ అపాయింట్‌మెంట్ రద్దు చేయబడింది. మళ్లీ బుక్ చేయడానికి *అపాయింట్‌మెంట్ బుక్ చేయండి* నొక్కండి. 🙏",
    cancelNone: "ప్రస్తుతం రద్దు చేయడానికి యాక్టివ్ అపాయింట్‌మెంట్ లేదు.",
    hours: `🕒 కన్సల్టింగ్ సమయాలు:\nసోమ 10–11 AM · మంగళ & గురు 6–8 PM · బుధ 7–8 PM · శుక్ర 6–7 PM.\nశనివారాలు మారుతుంటాయి. కన్సల్టేషన్ ${cur}${fee}.`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}.`,
    fallback: "డాక్టర్ ఉన్నారో లేదో చెప్పగలను, అపాయింట్‌మెంట్ బుక్ చేయగలను, లేదా సమయాలు, చిరునామా చెప్పగలను. ఏం కావాలి?",
    thanks: "సంతోషం 🙏 త్వరగా కోలుకోండి!",
    chips: { avail: "ఈరోజు డాక్టర్ ఉన్నారా?", book: "అపాయింట్‌మెంట్ బుక్ చేయండి", timings: "సమయాలు & ఫీజు", location: "చిరునామా", done: "ధన్యవాదాలు!" },
  },
  hi: {
    greet: `नमस्ते 🙏 मैं ${clinic.shortName} का असिस्टेंट हूँ। मैं आपकी कैसे मदद करूँ?`,
    availIn: (u: string) => `✅ हाँ, ${dr} आज ${u} तक उपलब्ध हैं। टोकन के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availSoon: (t: string) => `${dr} आज ${t} से देखेंगे। स्लॉट के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availOut: (d: string, t: string) => `${dr} आज *उपलब्ध नहीं* हैं। अगली उपलब्धता: *${d}, ${t}*। बुक करने के लिए *अपॉइंटमेंट बुक करें* दबाएँ।`,
    availNone: `आने वाले दिनों में कोई स्लॉट नहीं है। कृपया क्लिनिक को कॉल करें: ${clinic.contact.phone}।`,
    bookIntro: "ज़रूर! ये अगले उपलब्ध स्लॉट हैं। जो चाहिए उसे दबाएँ:",
    noSlots: "अभी कोई स्लॉट खाली नहीं है। कृपया बाद में कोशिश करें या क्लिनिक को कॉल करें।",
    askName: "बढ़िया। किस नाम से बुक करूँ?",
    confirm: (tok: number, s: string) => `✅ *बुक हो गया!* आपका टोकन *#${tok}*, ${s}।\n${dr} · ${cur}${fee}। कृपया कुछ मिनट पहले पहुँचें।\nयोजना बदले तो *Cancel* लिखें।`,
    cancelDone: "हो गया, आपका अपॉइंटमेंट रद्द कर दिया गया है। दोबारा बुक करने के लिए *अपॉइंटमेंट बुक करें* दबाएँ। 🙏",
    cancelNone: "अभी रद्द करने के लिए कोई सक्रिय अपॉइंटमेंट नहीं है।",
    hours: `🕒 परामर्श समय:\nसोम 10–11 AM · मंगल व गुरु 6–8 PM · बुध 7–8 PM · शुक्र 6–7 PM।\nशनिवार बदलते रहते हैं। परामर्श ${cur}${fee}।`,
    location: `📍 ${clinic.location.line1}, ${clinic.location.line2}, ${clinic.location.city} ${clinic.location.pin}।`,
    fallback: "मैं बता सकता हूँ कि डॉक्टर उपलब्ध हैं या नहीं, अपॉइंटमेंट बुक कर सकता हूँ, या समय व पता बता सकता हूँ। क्या चाहिए?",
    thanks: "आपका स्वागत है 🙏 जल्दी स्वस्थ हों!",
    chips: { avail: "क्या डॉक्टर आज उपलब्ध हैं?", book: "अपॉइंटमेंट बुक करें", timings: "समय व फीस", location: "पता", done: "धन्यवाद!" },
  },
};

// ── intent detection (heuristic for the beta; Claude in production) ──────────
type Intent = "avail" | "book" | "cancel" | "hours" | "location" | "fee" | "greet" | "thanks" | "fallback";
function detect(s: string): Intent {
  const has = (re: RegExp) => re.test(s);
  if (has(/cancel|రద్దు|कैंसिल|रद्द/i)) return "cancel";
  if (has(/book|appoint|slot|token|బుక్|అపాయింట్|अपॉइंटमेंट|बुक|टोकन/i)) return "book";
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
  return { reply: [t.greet], chips: [t.chips.avail, t.chips.book, t.chips.timings, t.chips.location], state: { stage: "idle" } };
}

export function botReply(input: string, lang: Lang, state: BotState): BotOut {
  const t = P[lang];
  const c = t.chips;

  // completing a booking: this input is the patient's name
  if (state.stage === "await_name" && state.slot) {
    const appt = addBooking({ name: input.trim() || "Patient", phone: "", reason: "WhatsApp booking", date: state.slot.date, time: state.slot.time, source: "whatsapp" });
    lastBookingId = appt.id;
    return { reply: [t.confirm(appt.token, state.slot.label)], chips: [c.avail, c.done], state: { stage: "idle" } };
  }

  // tapped a slot chip
  const picked = slotByLabel(input);
  if (picked) return { reply: [t.askName], chips: [], state: { stage: "await_name", slot: picked } };

  switch (detect(input)) {
    case "avail":
      return { reply: [availReply(t)], chips: [c.book, c.timings], state: { stage: "idle" } };
    case "book": {
      const slots = nextSlots(4);
      if (!slots.length) return { reply: [t.noSlots], chips: [c.avail], state: { stage: "idle" } };
      return { reply: [t.bookIntro], chips: slots.map((s) => s.label), state: { stage: "idle" } };
    }
    case "cancel": {
      if (lastBookingId) { setStatus(lastBookingId, "cancelled"); lastBookingId = null; return { reply: [t.cancelDone], chips: [c.book], state: { stage: "idle" } }; }
      return { reply: [t.cancelNone], chips: [c.book], state: { stage: "idle" } };
    }
    case "hours": case "fee":
      return { reply: [t.hours], chips: [c.book, c.location], state: { stage: "idle" } };
    case "location":
      return { reply: [t.location], chips: [c.book, c.timings], state: { stage: "idle" } };
    case "thanks":
      return { reply: [t.thanks], chips: [c.avail, c.book], state: { stage: "idle" } };
    case "greet":
      return botStart(lang);
    default:
      return { reply: [t.fallback], chips: [c.avail, c.book, c.timings], state: { stage: "idle" } };
  }
}
