"use client";

import { useEffect, useRef, useState } from "react";
import { Phone, Video, MoreVertical, ArrowLeft, Send, CheckCheck } from "lucide-react";
import { clinic, type Lang } from "@/clinic.config";
import { langLabels } from "@/lib/i18n";
import { botStart, botReply, mkMsg, type ChatMsg, type BotState } from "@/lib/bot";
import { DoctorPhoto } from "@/components/DoctorPhoto";

// render WhatsApp-style *bold* and line breaks
function fmt(s: string) {
  return s.split("\n").map((line, li) => (
    <span key={li}>
      {li > 0 && <br />}
      {line.split(/(\*[^*]+\*)/).map((p, pi) =>
        p.startsWith("*") && p.endsWith("*") ? <b key={pi}>{p.slice(1, -1)}</b> : <span key={pi}>{p}</span>
      )}
    </span>
  ));
}
const nowTime = () => new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

export function WhatsAppDemo() {
  const [lang, setLang] = useState<Lang>("en");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [state, setState] = useState<BotState>({ stage: "idle" });
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // (re)start the conversation when the demo language changes
  useEffect(() => {
    const o = botStart(lang);
    setMsgs([mkMsg("bot", o.reply[0])]);
    setChips(o.chips); setState(o.state); setTyping(false);
  }, [lang]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typing, chips]);

  const send = (text: string) => {
    const v = text.trim();
    if (!v || typing) return;
    setMsgs((m) => [...m, mkMsg("user", v)]);
    setChips([]); setInput(""); setTyping(true);
    window.setTimeout(async () => {
      const o = await botReply(v, lang, state);
      setTyping(false);
      o.reply.forEach((r, i) => window.setTimeout(() => setMsgs((m) => [...m, mkMsg("bot", r)]), i * 550));
      window.setTimeout(() => { setChips(o.chips); setState(o.state); }, (o.reply.length - 1) * 550 + 60);
    }, 750);
  };

  return (
    <div className="w-full">
      {/* language toggle for the demo */}
      <div className="mb-3 flex justify-center">
        <div className="flex items-center rounded-full border border-line bg-surface p-0.5">
          {(Object.keys(langLabels) as Lang[]).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`press rounded-full px-3 py-1 text-xs font-medium transition ${lang === l ? "bg-brand text-white" : "text-muted"}`}>{langLabels[l]}</button>
          ))}
        </div>
      </div>

      {/* phone */}
      <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-[2rem] border-[6px] border-ink bg-ink shadow-[0_30px_60px_-20px_rgba(14,26,23,0.5)]">
        {/* header */}
        <div className="flex items-center gap-2.5 bg-[#075E54] px-3 py-2.5 text-white">
          <ArrowLeft className="h-5 w-5 opacity-90" />
          <DoctorPhoto className="h-9 w-9 shrink-0 rounded-full text-sm" monogramText="R" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[15px] font-semibold">{clinic.shortName}</div>
            <div className="text-[11px] text-white/70">online</div>
          </div>
          <Video className="h-5 w-5 opacity-90" />
          <Phone className="h-[18px] w-[18px] opacity-90" />
          <MoreVertical className="h-5 w-5 opacity-90" />
        </div>

        {/* chat */}
        <div ref={scrollRef} className="h-[420px] space-y-2 overflow-y-auto bg-[#ECE5DD] px-3 py-3" style={{ backgroundImage: "radial-gradient(rgba(0,0,0,0.03) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
          <div className="mx-auto w-fit rounded-lg bg-[#FCF4CB] px-2.5 py-1 text-[11px] text-ink/60 shadow-sm">Today</div>
          {msgs.map((m) => (
            <div key={m.id} className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`relative max-w-[82%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-[13.5px] leading-snug shadow-sm ${m.from === "user" ? "bg-[#DCF8C6] text-ink" : "bg-white text-ink"}`}>
                {fmt(m.text)}
                <span className="ml-2 inline-flex translate-y-0.5 items-center gap-0.5 text-[10px] text-ink/40">
                  {nowTime()}{m.from === "user" && <CheckCheck className="h-3 w-3 text-[#34B7F1]" />}
                </span>
              </div>
            </div>
          ))}
          {typing && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1 rounded-lg bg-white px-3 py-2 shadow-sm">
                {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink/30" style={{ animationDelay: `${i * 0.15}s` }} />)}
              </div>
            </div>
          )}
        </div>

        {/* quick replies */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 bg-[#ECE5DD] px-3 pb-2">
            {chips.map((ch) => (
              <button key={ch} onClick={() => send(ch)} className="press rounded-full border border-[#075E54]/30 bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#075E54] shadow-sm hover:bg-[#075E54]/5">{ch}</button>
            ))}
          </div>
        )}

        {/* input */}
        <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-2 bg-[#F0F0F0] px-2.5 py-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message" className="flex-1 rounded-full border-0 bg-white px-4 py-2 text-[14px] outline-none" />
          <button type="submit" className="press grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#075E54] text-white"><Send className="h-[18px] w-[18px]" /></button>
        </form>
      </div>

      <p className="mx-auto mt-3 max-w-xs text-center text-xs text-muted">A live demo of the WhatsApp assistant. Bookings you make here appear in the clinic dashboard, just like the real thing.</p>
    </div>
  );
}
