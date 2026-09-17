"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Printer, Sliders, ArrowLeft, Eye, RotateCcw, Check, UserCheck } from "lucide-react";
import { clinic } from "@/clinic.config";
import { fmt, nowIST, ymd } from "@/lib/schedule";

function formatOpDate(dateStr: string): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return y && m && d ? `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}` : dateStr;
}

function getOpValidUpTo(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + 10);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}`;
}

function OpSlipPrinterInner() {
  const searchParams = useSearchParams();

  const initialName = searchParams.get("name") || "";
  const initialCode = searchParams.get("code") || searchParams.get("patientCode") || "";
  const initialAge = searchParams.get("age") || "";
  const initialGender = searchParams.get("gender") || "";
  const initialLocality = searchParams.get("locality") || clinic.location.city || "Visakhapatnam";
  const initialDate = searchParams.get("date") || ymd(nowIST());
  const initialTime = searchParams.get("time") || "";
  const initialToken = searchParams.get("token") || "";
  const autoprint = searchParams.get("autoprint") === "1";

  // Editable patient data
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  const [age, setAge] = useState(initialAge);
  const [gender, setGender] = useState(initialGender);
  const [locality, setLocality] = useState(initialLocality);
  const [date, setDate] = useState(initialDate);
  const [token, setToken] = useState(initialToken);
  const [time, setTime] = useState(initialTime);

  // Calibration & margin settings (persisted to localStorage)
  const [topMarginMm, setTopMarginMm] = useState(48);
  const [leftMarginMm, setLeftMarginMm] = useState(15);
  const [rightMarginMm, setRightMarginMm] = useState(15);
  const [fontSizePt, setFontSizePt] = useState(13);
  const [showOverlay, setShowOverlay] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Load saved calibration from localStorage
  useEffect(() => {
    setMounted(true);
    try {
      const savedTop = localStorage.getItem("roc_op_slip_top_mm");
      const savedLeft = localStorage.getItem("roc_op_slip_left_mm");
      const savedRight = localStorage.getItem("roc_op_slip_right_mm");
      const savedFont = localStorage.getItem("roc_op_slip_font_pt");
      if (savedTop && !isNaN(Number(savedTop))) setTopMarginMm(Number(savedTop));
      if (savedLeft && !isNaN(Number(savedLeft))) setLeftMarginMm(Number(savedLeft));
      if (savedRight && !isNaN(Number(savedRight))) setRightMarginMm(Number(savedRight));
      if (savedFont && !isNaN(Number(savedFont))) setFontSizePt(Number(savedFont));
    } catch {}
  }, []);

  const saveTopMargin = (val: number) => {
    setTopMarginMm(val);
    try { localStorage.setItem("roc_op_slip_top_mm", String(val)); } catch {}
  };
  const saveLeftMargin = (val: number) => {
    setLeftMarginMm(val);
    try { localStorage.setItem("roc_op_slip_left_mm", String(val)); } catch {}
  };
  const saveRightMargin = (val: number) => {
    setRightMarginMm(val);
    try { localStorage.setItem("roc_op_slip_right_mm", String(val)); } catch {}
  };
  const saveFontSize = (val: number) => {
    setFontSizePt(val);
    try { localStorage.setItem("roc_op_slip_font_pt", String(val)); } catch {}
  };

  // Autoprint handler if opened from notification email or print shortcut
  useEffect(() => {
    if (autoprint && mounted) {
      const timer = setTimeout(() => {
        window.print();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [autoprint, mounted]);

  const genderDisplay = gender === "M" || gender === "Male" ? "Male" : gender === "F" || gender === "Female" ? "Female" : gender || "—";
  const ageGenderDisplay = `${age ? `${age} Years/ ` : "— Years/ "}${genderDisplay}`;

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      {/* ── Top Control Bar (Screen Only, Hidden on Print) ─────────────── */}
      <header className="no-print sticky top-0 z-50 border-b border-neutral-300 bg-white/95 px-4 py-3 shadow-xs backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/admin"
              className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-xs font-semibold text-neutral-700 transition hover:bg-neutral-100"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Admin Queue
            </Link>
            <div className="h-4 w-px bg-neutral-300" />
            <div>
              <h1 className="text-sm font-bold text-neutral-900">
                OP Slip Letterhead Printer
              </h1>
              <p className="text-[11px] text-neutral-500">
                Prints only patient metadata onto pre-printed clinic A4 stationery
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowOverlay(!showOverlay)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showOverlay
                  ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
              title="Toggle preview of the pre-printed green clinic header"
            >
              <Eye className="h-3.5 w-3.5" />
              {showOverlay ? "Hide Letterhead Preview" : "Simulate Letterhead"}
            </button>

            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showSettings
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              <Sliders className="h-3.5 w-3.5" />
              Adjust Margins ({topMarginMm}mm)
            </button>

            <button
              onClick={() => window.print()}
              className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-bold text-white shadow-xs transition hover:bg-emerald-800 active:scale-95"
            >
              <Printer className="h-4 w-4" />
              Print OP Slip (⌘P)
            </button>
          </div>
        </div>

        {/* ── Collapsible Calibration & Data Editor ──────────────────────── */}
        {showSettings && (
          <div className="mx-auto mt-3 max-w-5xl rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {/* Printer Margin Calibration */}
              <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-3.5">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold text-neutral-800 uppercase tracking-wide">
                    Stationery Margins (Auto-saved)
                  </h2>
                  <button
                    onClick={() => {
                      saveTopMargin(48);
                      saveLeftMargin(15);
                      saveRightMargin(15);
                      saveFontSize(13);
                    }}
                    className="flex items-center gap-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-800"
                  >
                    <RotateCcw className="h-3 w-3" /> Reset default (48mm)
                  </button>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-semibold">
                    <span>Top Offset (Header height)</span>
                    <span className="text-emerald-700">{topMarginMm} mm</span>
                  </div>
                  <input
                    type="range"
                    min="30"
                    max="70"
                    step="1"
                    value={topMarginMm}
                    onChange={(e) => saveTopMargin(Number(e.target.value))}
                    className="mt-1.5 w-full accent-emerald-700"
                  />
                  <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-400">
                    <span>30mm</span>
                    <div className="flex gap-1">
                      {[-2, -1, 1, 2].map((delta) => (
                        <button
                          key={delta}
                          onClick={() => saveTopMargin(Math.max(20, Math.min(80, topMarginMm + delta)))}
                          className="rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10px] font-semibold text-neutral-700 hover:bg-neutral-100"
                        >
                          {delta > 0 ? `+${delta}` : delta}mm
                        </button>
                      ))}
                    </div>
                    <span>70mm</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="text-[11px] font-medium text-neutral-600">Left Margin</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="5"
                        max="40"
                        value={leftMarginMm}
                        onChange={(e) => saveLeftMargin(Number(e.target.value))}
                        className="mt-1 w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-semibold"
                      />
                      <span className="text-xs text-neutral-500">mm</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-neutral-600">Font Size</label>
                    <div className="flex items-center gap-1.5">
                      <select
                        value={fontSizePt}
                        onChange={(e) => saveFontSize(Number(e.target.value))}
                        className="mt-1 w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-semibold"
                      >
                        <option value="11">11 pt</option>
                        <option value="12">12 pt</option>
                        <option value="13">13 pt (Default)</option>
                        <option value="14">14 pt (Large)</option>
                        <option value="15">15 pt</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Patient Fields Editor */}
              <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3.5">
                <h2 className="text-xs font-bold text-neutral-800 uppercase tracking-wide">
                  Edit Details Before Printing
                </h2>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">Patient Name</label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Name"
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">Patient Code</label>
                    <input
                      type="text"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="PT29500"
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-mono font-semibold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">Age</label>
                    <input
                      type="text"
                      value={age}
                      onChange={(e) => setAge(e.target.value)}
                      placeholder="e.g. 35"
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">Gender</label>
                    <select
                      value={gender}
                      onChange={(e) => setGender(e.target.value)}
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
                    >
                      <option value="">Select gender</option>
                      <option value="Male">Male (M)</option>
                      <option value="Female">Female (F)</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">Locality / Area</label>
                    <input
                      type="text"
                      value={locality}
                      onChange={(e) => setLocality(e.target.value)}
                      placeholder="Visakhapatnam"
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-neutral-500">OP Date</label>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* ── Main Printable A4 Canvas Container ─────────────────────────── */}
      <main className="flex justify-center p-4 sm:p-8">
        {/* A4 Sheet Container (210mm x 297mm) */}
        <div
          id="op-slip-sheet"
          className="relative w-full max-w-[210mm] min-h-[297mm] bg-white text-black shadow-lg transition-all"
          style={{
            paddingTop: `${topMarginMm}mm`,
            paddingLeft: `${leftMarginMm}mm`,
            paddingRight: `${rightMarginMm}mm`,
            fontFamily: 'Arial, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: `${fontSizePt}pt`,
            lineHeight: 1.5,
          }}
        >
          {/* Simulated Pre-printed Green Header (Screen Only) */}
          {showOverlay && (
            <div
              className="no-print absolute top-0 left-0 right-0 border-b-2 border-dashed border-emerald-500 bg-emerald-800/10 p-4 text-emerald-900 select-none"
              style={{ height: `${topMarginMm}mm` }}
            >
              <div className="flex h-full flex-col justify-between">
                <div className="flex items-center justify-between border-b border-emerald-800/20 pb-2">
                  <div>
                    <div className="text-sm font-extrabold tracking-wide uppercase text-emerald-950">
                      {clinic.name}
                    </div>
                    <div className="text-[10px] font-semibold tracking-wider text-emerald-800">
                      {clinic.doctor.name} · {clinic.doctor.title}
                    </div>
                  </div>
                  <div className="text-right text-[10px] font-bold text-emerald-900">
                    Ph: {clinic.contact.phone} / {clinic.contact.emergency}
                  </div>
                </div>
                <div className="text-center text-[10px] font-bold uppercase tracking-widest text-emerald-700/80">
                  ─── Simulated Pre-printed Stationery Header ({topMarginMm}mm) ───
                </div>
              </div>
            </div>
          )}

          {/* ── THE EXACT OP PRESCRIPTION SLIP CONTENT ─────────────────── */}
          <div className="op-slip-content w-full">
            <div className="grid grid-cols-12 items-start gap-4">
              {/* Left Column: Patient Details */}
              <div className="col-span-7 space-y-1.5">
                <div className="font-bold text-black" style={{ fontSize: `${fontSizePt + 1}pt` }}>
                  <span>Patient Details : </span>
                  <span>{name || "____________________"}</span>
                  {code ? <span className="ml-1.5 font-bold">({code})</span> : null}
                </div>
                <div className="font-medium text-black">
                  {ageGenderDisplay}
                </div>
                <div className="font-medium text-black">
                  {locality || "Visakhapatnam"}
                </div>
              </div>

              {/* Right Column: Date & Validity */}
              <div className="col-span-5 text-right space-y-1.5">
                <div className="font-bold text-black" style={{ fontSize: `${fontSizePt}pt` }}>
                  <span>Date : </span>
                  <span>{formatOpDate(date) || "____/____/________"}</span>
                </div>
                <div className="font-semibold text-black" style={{ fontSize: `${fontSizePt - 0.5}pt` }}>
                  <span>Op Valid up to </span>
                  <span>{getOpValidUpTo(date) || "____/____/________"}</span>
                </div>
                {(token || time) && (
                  <div className="text-[10.5pt] font-medium text-neutral-700">
                    {token ? `Token #${token}` : ""}
                    {time ? ` · ${fmt(time)}` : ""}
                  </div>
                )}
              </div>
            </div>

            {/* Doctor's manual pen-writing area indicator (Screen Only) */}
            <div className="no-print mt-24 rounded-lg border-2 border-dashed border-neutral-300 p-8 text-center text-xs text-neutral-400">
              Doctor writes clinical examination, prescription, and notes by hand below this line.
            </div>
          </div>
        </div>
      </main>

      {/* ── Print Media Stylesheet ───────────────────────────────────────── */}
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 0mm !important;
        }
        @media print {
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          #op-slip-sheet {
            box-shadow: none !important;
            margin: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
            min-height: auto !important;
            background: transparent !important;
          }
          .op-slip-content {
            color: #000000 !important;
          }
          .op-slip-content * {
            color: #000000 !important;
          }
        }
      `}</style>
    </div>
  );
}

export default function OpSlipPrintPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center font-medium text-neutral-500">Loading OP Slip Printer…</div>}>
      <OpSlipPrinterInner />
    </Suspense>
  );
}
