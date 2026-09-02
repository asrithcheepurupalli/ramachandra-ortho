"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, X, Send, Sparkles } from "lucide-react";
import { type Lang } from "@/clinic.config";
import { tr, langLabels } from "@/lib/i18n";
import { botStart, botReply, mkMsg, type ChatMsg, type BotState } from "@/lib/bot";

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

// "RC" — the on-site assistant. Same engine as the WhatsApp bot, own UI.
export function RCChat() {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<Lang>("en");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [state, setState] = useState<BotState>({ stage: "idle" });
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // (re)seed the conversation with RC's greeting when opened / language changes
  useEffect(() => {
    const o = botStart(lang);
    setMsgs([mkMsg("bot", tr(lang, "rc.greet"))]);
    setChips(o.chips); setState(o.state); setTyping(false);
  }, [lang]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typing, chips, open]);

  const send = (text: string) => {
    const v = text.trim();
    if (!v || typing) return;
    setMsgs((m) => [...m, mkMsg("user", v)]);
    setChips([]); setInput(""); setTyping(true);
    window.setTimeout(async () => {
      const o = await botReply(v, lang, state, "website");
      setTyping(false);
      o.reply.forEach((r, i) => window.setTimeout(() => setMsgs((m) => [...m, mkMsg("bot", r)]), i * 500));
      window.setTimeout(() => { setChips(o.chips); setState(o.state); }, (o.reply.length - 1) * 500 + 50);
    }, 650);
  };

  return (
    <>
      {/* Floating button (clears the mobile sticky bar) */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label={tr(lang, "rc.open")}
          className="press fixed right-4 bottom-24 z-[60] flex items-center gap-2 rounded-full bg-brand py-3 pl-3 pr-4 text-sm font-semibold text-white shadow-lift transition hover:bg-brand-dark md:right-6 md:bottom-6"
        >
          <span className="relative grid h-8 w-8 place-items-center rounded-full bg-white/15">
            <Bot className="h-[18px] w-[18px]" />
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-brand bg-in" />
          </span>
          {tr(lang, "rc.open")}
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="fixed inset-x-3 top-16 bottom-3 z-[60] flex flex-col overflow-hidden rounded-3xl border border-line bg-bg shadow-lift md:inset-auto md:right-6 md:bottom-6 md:top-auto md:h-[600px] md:max-h-[85vh] md:w-[384px]">
          {/* header */}
          <div className="flex items-center gap-3 bg-brand px-4 py-3 text-white">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15"><Bot className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5 font-semibold">RC <Sparkles className="h-3.5 w-3.5 text-white/80" /></div>
              <div className="flex items-center gap-1 text-[11px] text-white/75"><span className="h-1.5 w-1.5 rounded-full bg-in" /> {tr(lang, "rc.sub")}</div>
            </div>
            <div className="flex items-center rounded-full bg-white/15 p-0.5">
              {(Object.keys(langLabels) as Lang[]).map((l) => (
                <button key={l} onClick={() => setLang(l)} className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${lang === l ? "bg-white text-brand" : "text-white/80"}`}>{langLabels[l]}</button>
              ))}
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="press grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/15"><X className="h-5 w-5" /></button>
          </div>

          {/* messages */}
          <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto bg-bg px-3 py-3">
            {msgs.map((m) => (
              <div key={m.id} className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13.5px] leading-snug ${m.from === "user" ? "rounded-br-md bg-brand text-white" : "rounded-bl-md border border-line bg-surface text-ink"}`}>
                  {fmt(m.text)}
                </div>
              </div>
            ))}
            {typing && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-surface px-3 py-2.5">
                  {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/50" style={{ animationDelay: `${i * 0.15}s` }} />)}
                </div>
              </div>
            )}
          </div>

          {/* quick replies */}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-line bg-bg px-3 pt-2.5">
              {chips.map((ch) => (
                <button key={ch} onClick={() => send(ch)} className="press rounded-full border border-brand/25 bg-surface px-3 py-1.5 text-[12.5px] font-medium text-brand hover:bg-brand-tint/50">{ch}</button>
              ))}
            </div>
          )}

          {/* input */}
          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-2 bg-bg px-3 py-3">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message…" className="flex-1 rounded-full border border-line bg-surface px-4 py-2.5 text-[14px] outline-none focus:border-brand" />
            <button type="submit" className="press grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white transition hover:bg-brand-dark"><Send className="h-[18px] w-[18px]" /></button>
          </form>
        </div>
      )}
    </>
  );
}
