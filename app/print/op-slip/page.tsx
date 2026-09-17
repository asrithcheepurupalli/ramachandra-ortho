"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Printer, Sliders, ArrowLeft, Eye, RotateCcw, Pencil, Check, X } from "lucide-react";
import { clinic } from "@/clinic.config";
import { nowIST, ymd } from "@/lib/schedule";
import { supabaseBrowser, hasSupabase } from "@/lib/supabase";

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
  const initialPhone = searchParams.get("phone") || searchParams.get("mobile") || "";
  const initialDate = searchParams.get("date") || ymd(nowIST());
  const autoprint = searchParams.get("autoprint") === "1";

  // Editable patient data
  const [name, setName] = useState(initialName);
  const [code, setCode] = useState(initialCode);
  const [age, setAge] = useState(initialAge);
  const [gender, setGender] = useState(initialGender);
  const [locality, setLocality] = useState(initialLocality);
  const [phone, setPhone] = useState(initialPhone);
  const [date, setDate] = useState(initialDate);

  // Panels
  const [showEdit, setShowEdit] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);

  // Calibration & margin settings (persisted to localStorage with lazy initializers for React 19)
  const [topMarginMm, setTopMarginMm] = useState(() => {
    if (typeof window === "undefined") return 48;
    try {
      const saved = localStorage.getItem("roc_op_slip_top_mm");
      if (saved && !isNaN(Number(saved))) return Number(saved);
    } catch {}
    return 48;
  });
  const [leftMarginMm, setLeftMarginMm] = useState(() => {
    if (typeof window === "undefined") return 15;
    try {
      const saved = localStorage.getItem("roc_op_slip_left_mm");
      if (saved && !isNaN(Number(saved))) return Number(saved);
    } catch {}
    return 15;
  });
  const [rightMarginMm, setRightMarginMm] = useState(() => {
    if (typeof window === "undefined") return 15;
    try {
      const saved = localStorage.getItem("roc_op_slip_right_mm");
      if (saved && !isNaN(Number(saved))) return Number(saved);
    } catch {}
    return 15;
  });
  const [fontSizePt, setFontSizePt] = useState(() => {
    if (typeof window === "undefined") return 13;
    try {
      const saved = localStorage.getItem("roc_op_slip_font_pt");
      if (saved && !isNaN(Number(saved))) return Number(saved);
    } catch {}
    return 13;
  });

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
    if (autoprint) {
      const timer = setTimeout(() => {
        window.print();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [autoprint]);

  // Auto-resolve missing patient data (phone, locality, age, gender) from Supabase if opened with partial parameters
  useEffect(() => {
    if (!hasSupabase()) return;
    if (!phone && (code || name)) {
      const db = supabaseBrowser();
      let cancelled = false;

      async function fetchPatient() {
        try {
          if (code) {
            const { data: pData } = await db.from("patients").select("phone, name, age, gender, locality").eq("patient_code", code).maybeSingle();
            if (cancelled) return;
            if (pData) {
              if (pData.phone) setPhone((prev) => prev || pData.phone || "");
              if (pData.name) setName((prev) => prev || pData.name || "");
              if (pData.age) setAge((prev) => prev || String(pData.age) || "");
              if (pData.gender) setGender((prev) => prev || pData.gender || "");
              if (pData.locality) setLocality((prev) => (!prev || prev === clinic.location.city ? pData.locality || prev : prev));
              return;
            }

            const { data: aData } = await db.from("appointments").select("phone, name, age, gender, locality").eq("patient_code", code).order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (cancelled) return;
            if (aData) {
              if (aData.phone) setPhone((prev) => prev || aData.phone || "");
              if (aData.name) setName((prev) => prev || aData.name || "");
              if (aData.age) setAge((prev) => prev || String(aData.age) || "");
              if (aData.gender) setGender((prev) => prev || aData.gender || "");
              if (aData.locality) setLocality((prev) => (!prev || prev === clinic.location.city ? aData.locality || prev : prev));
              return;
            }
          }

          if (name) {
            const { data: pNameData } = await db.from("patients").select("phone, patient_code, age, gender, locality").ilike("name", name.trim()).order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (cancelled) return;
            if (pNameData) {
              if (pNameData.phone) setPhone((prev) => prev || pNameData.phone || "");
              if (pNameData.patient_code) setCode((prev) => prev || pNameData.patient_code || "");
              if (pNameData.age) setAge((prev) => prev || String(pNameData.age) || "");
              if (pNameData.gender) setGender((prev) => prev || pNameData.gender || "");
              if (pNameData.locality) setLocality((prev) => (!prev || prev === clinic.location.city ? pNameData.locality || prev : prev));
            }
          }
        } catch {}
      }

      fetchPatient();
      return () => {
        cancelled = true;
      };
    }
  }, [code, name, phone]);

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
                Prints patient metadata onto pre-printed clinic A4 stationery
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setShowEdit(!showEdit);
                if (showSettings) setShowSettings(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showEdit
                  ? "border-emerald-700 bg-emerald-50 text-emerald-800 font-semibold"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
              title="Edit patient details, name, phone, age, or date before printing"
            >
              <Pencil className="h-3.5 w-3.5 text-emerald-700" />
              {showEdit ? "Hide Edit Form" : "Edit Details"}
            </button>

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
              onClick={() => {
                setShowSettings(!showSettings);
                if (showEdit) setShowEdit(false);
              }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                showSettings
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
              }`}
              title="Adjust margin offsets and font size for pre-printed letterhead alignment"
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

        {/* ── Edit Patient Details Panel ─────────────────────────────────── */}
        {showEdit && (
          <div className="mx-auto mt-3 max-w-5xl rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-xs">
            <div className="flex items-center justify-between border-b border-emerald-200/60 pb-2.5 mb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-700 text-white">
                  <Pencil className="h-3.5 w-3.5" />
                </div>
                <div>
                  <h2 className="text-xs font-bold text-emerald-950 uppercase tracking-wide">
                    Edit Details Before Printing
                  </h2>
                  <p className="text-[11px] text-emerald-800/80">
                    Make corrections to any field before sending to the printer
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowEdit(false)}
                  className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                >
                  <Check className="h-3.5 w-3.5 text-emerald-600" /> Done Editing
                </button>
                <button
                  onClick={() => {
                    setShowEdit(false);
                    setTimeout(() => window.print(), 100);
                  }}
                  className="flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-1 text-xs font-bold text-white shadow-xs hover:bg-emerald-800"
                >
                  <Printer className="h-3.5 w-3.5" /> Print Now
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="text-[11px] font-bold text-neutral-700">Patient Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ramesh Kumar"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">Patient Code</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. PT29500 / ROC-0013"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-mono font-semibold text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">Mobile / Phone</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. 9876543210"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">Age (Years)</label>
                <input
                  type="text"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="e.g. 35"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">Gender</label>
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                >
                  <option value="">Select gender</option>
                  <option value="Male">Male (M)</option>
                  <option value="Female">Female (F)</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">Locality / Area</label>
                <input
                  type="text"
                  value={locality}
                  onChange={(e) => setLocality(e.target.value)}
                  placeholder="e.g. Chinnamushidiwada"
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-neutral-700">OP Date</label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-900 focus:border-emerald-600 focus:outline-hidden focus:ring-1 focus:ring-emerald-600"
                />
              </div>

              <div className="flex items-end">
                <div className="w-full rounded-lg border border-emerald-300 bg-white p-2 text-[11px] text-emerald-950">
                  <span className="font-semibold text-emerald-800">10-Day Validity:</span>{" "}
                  <span className="font-bold">{getOpValidUpTo(date) || "—"}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Collapsible Calibration Settings ───────────────────────────── */}
        {showSettings && (
          <div className="mx-auto mt-3 max-w-5xl rounded-xl border border-neutral-200 bg-neutral-50 p-4">
            <div className="flex items-center justify-between border-b border-neutral-200 pb-2.5 mb-3">
              <h2 className="text-xs font-bold text-neutral-800 uppercase tracking-wide">
                Stationery Margin & Font Calibration (Auto-saved)
              </h2>
              <div className="flex items-center gap-2">
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
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-neutral-400 hover:text-neutral-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {/* Top Offset Slider */}
              <div className="rounded-lg border border-neutral-200 bg-white p-3 space-y-2">
                <div className="flex justify-between text-xs font-semibold">
                  <span>Top Offset (Header Height)</span>
                  <span className="text-emerald-700 font-bold">{topMarginMm} mm</span>
                </div>
                <input
                  type="range"
                  min="30"
                  max="70"
                  step="1"
                  value={topMarginMm}
                  onChange={(e) => saveTopMargin(Number(e.target.value))}
                  className="w-full accent-emerald-700"
                />
                <div className="flex items-center justify-between text-[11px] text-neutral-400">
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

              {/* Left & Right Margins */}
              <div className="rounded-lg border border-neutral-200 bg-white p-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] font-semibold text-neutral-600">Left Margin</label>
                    <div className="flex items-center gap-1 mt-1">
                      <input
                        type="number"
                        min="5"
                        max="40"
                        value={leftMarginMm}
                        onChange={(e) => saveLeftMargin(Number(e.target.value))}
                        className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-semibold"
                      />
                      <span className="text-xs text-neutral-500">mm</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-neutral-600">Right Margin</label>
                    <div className="flex items-center gap-1 mt-1">
                      <input
                        type="number"
                        min="5"
                        max="40"
                        value={rightMarginMm}
                        onChange={(e) => saveRightMargin(Number(e.target.value))}
                        className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs font-semibold"
                      />
                      <span className="text-xs text-neutral-500">mm</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Font Size */}
              <div className="rounded-lg border border-neutral-200 bg-white p-3 space-y-2">
                <label className="text-[11px] font-semibold text-neutral-600">Font Size</label>
                <select
                  value={fontSizePt}
                  onChange={(e) => saveFontSize(Number(e.target.value))}
                  className="w-full rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs font-semibold"
                >
                  <option value="11">11 pt</option>
                  <option value="12">12 pt</option>
                  <option value="13">13 pt (Default)</option>
                  <option value="14">14 pt (Large)</option>
                  <option value="15">15 pt</option>
                </select>
                <p className="text-[10px] text-neutral-400">
                  Scales all printed text cleanly across the page
                </p>
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

          {/* Quick Edit Trigger Bar on Canvas (Screen Only) */}
          <div className="no-print mb-2 flex items-center justify-between rounded-md bg-neutral-50 px-3 py-1 text-xs text-neutral-500 border border-neutral-200">
            <span>Print Preview</span>
            <button
              onClick={() => setShowEdit(true)}
              className="flex items-center gap-1 font-semibold text-emerald-700 hover:text-emerald-800 hover:underline"
            >
              <Pencil className="h-3 w-3" /> Edit details
            </button>
          </div>

          {/* ── THE EXACT OP PRESCRIPTION SLIP CONTENT ─────────────────── */}
          <div className="op-slip-content w-full">
            <div className="grid grid-cols-12 items-start gap-4">
              {/* Left Column: Patient Name, Age/Gender, Locality & Phone */}
              <div className="col-span-7 space-y-1.5">
                <div className="font-bold text-black" style={{ fontSize: `${fontSizePt + 1}pt` }}>
                  <span>{name || "____________________"}</span>
                  {code ? <span className="ml-1.5 font-bold">({code})</span> : null}
                </div>
                <div className="font-medium text-black">
                  {ageGenderDisplay}
                </div>
                <div className="font-medium text-black">
                  {locality || "Visakhapatnam"}
                  <span className="ml-2">· Ph: {phone || "____________________"}</span>
                </div>
              </div>

              {/* Right Column: OP Date & 10-Day Validity */}
              <div className="col-span-5 text-right space-y-1.5">
                <div className="font-bold text-black" style={{ fontSize: `${fontSizePt}pt` }}>
                  <span>Date : </span>
                  <span>{formatOpDate(date) || "____/____/________"}</span>
                </div>
                <div className="font-semibold text-black" style={{ fontSize: `${fontSizePt - 0.5}pt` }}>
                  <span>Op Valid up to </span>
                  <span>{getOpValidUpTo(date) || "____/____/________"}</span>
                </div>
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
