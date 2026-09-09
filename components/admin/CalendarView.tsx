"use client";

import { useState, useMemo, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Users,
  IndianRupee,
  CheckCircle2,
  CalendarDays,
  Phone,
  Clock,
} from "lucide-react";
import { ymd, fmt, windowsFor, allSlotsFor, type Window } from "@/lib/schedule";
import { clinic } from "@/clinic.config";
import type { Appt, ApptStatus } from "@/lib/store";

interface CalendarViewProps {
  appts: Appt[];
}

// How each live appointment state reads on the desk. payment_pending and
// cancelled are held out of the calendar entirely, so those never reach here.
const STATUS_META: Record<ApptStatus, { label: string; chip: string; dot: string }> = {
  reserved: { label: "Booked", chip: "bg-brand-tint text-brand", dot: "bg-brand" },
  confirmed: { label: "Confirmed", chip: "bg-brand-tint text-brand", dot: "bg-brand" },
  waiting: { label: "Waiting", chip: "bg-accent-tint text-accent", dot: "bg-accent" },
  consulting: { label: "Consulting", chip: "bg-out/15 text-out", dot: "bg-out" },
  done: { label: "Done", chip: "bg-in/15 text-in", dot: "bg-in" },
  cancelled: { label: "Cancelled", chip: "bg-line/60 text-muted", dot: "bg-line" },
  payment_pending: { label: "Unpaid", chip: "bg-out/15 text-out", dot: "bg-out" },
};

// Shift a YYYY-MM-DD by ±days (handles month/year boundaries via Date).
const shift = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return ymd(d);
};

const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function CalendarView({ appts }: CalendarViewProps) {
  const [selectedDate, setSelectedDate] = useState(() => ymd(new Date()));
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const todayStr = useMemo(() => ymd(new Date()), []);
  const isToday = selectedDate === todayStr;
  const selectedDay = useMemo(() => new Date(selectedDate + "T00:00:00"), [selectedDate]);
  const dayLabel = useMemo(
    () =>
      selectedDay.toLocaleDateString("en-IN", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    [selectedDay]
  );
  const shortDayLabel = useMemo(
    () =>
      selectedDay.toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    [selectedDay]
  );

  // ── Month-grid helpers ──────────────────────────────
  const monthStart = useMemo(() => new Date(viewMonth.year, viewMonth.month, 1), [viewMonth]);
  const daysInMonth = useMemo(
    () => new Date(viewMonth.year, viewMonth.month + 1, 0).getDate(),
    [viewMonth]
  );
  const firstDay = useMemo(() => monthStart.getDay(), [monthStart]);
  const monthCells = useMemo(() => {
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [firstDay, daysInMonth]);
  const dateStr = (d: number) => ymd(new Date(viewMonth.year, viewMonth.month, d));

  const gotoMonth = (d: Date) => setViewMonth({ year: d.getFullYear(), month: d.getMonth() });
  const selectAndShow = (iso: string) => {
    setSelectedDate(iso);
    gotoMonth(new Date(iso + "T00:00:00"));
  };

  // ── Appointments for the two views ─────────────────
  const apptsByDate = useMemo(() => {
    const map = new Map<string, Appt[]>();
    for (const appt of appts) {
      if (appt.status === "cancelled" || appt.status === "payment_pending") continue;
      const arr = map.get(appt.date) || [];
      arr.push(appt);
      map.set(appt.date, arr);
    }
    return map;
  }, [appts]);

  const dayAppts = useMemo(
    () => (apptsByDate.get(selectedDate) || []).sort((a, b) => a.time.localeCompare(b.time)),
    [apptsByDate, selectedDate]
  );

  const sessions = useMemo(() => {
    const wins = windowsFor(selectedDay);
    const slots = allSlotsFor(selectedDay);
    const groups: Array<{ label: string; window: Window; startMin: number; slots: string[] }> = [];
    for (const win of wins) {
      const [sh, sm] = win.start.split(":").map(Number);
      const startMin = sh * 60 + sm;
      const [eh, em] = win.end.split(":").map(Number);
      const endMin = eh * 60 + em;
      const inWindow = slots.filter((t) => {
        const [h, m] = t.split(":").map(Number);
        const mins = h * 60 + m;
        return mins >= startMin && mins < endMin;
      });
      if (!inWindow.length) continue;
      const label = startMin < 14 * 60 ? "Morning" : startMin < 17 * 60 ? "Afternoon" : "Evening";
      groups.push({ label, window: win, startMin, slots: inWindow });
    }
    return groups;
  }, [selectedDay]);

  const openSlots = useMemo(
    () =>
      sessions.reduce(
        (sum, g) => sum + g.slots.filter((s) => !dayAppts.some((a) => a.time === s)).length,
        0
      ),
    [sessions, dayAppts]
  );

  const paidCount = useMemo(() => dayAppts.filter((a) => a.paid).length, [dayAppts]);
  const revenue = useMemo(() => dayAppts.reduce((sum, a) => sum + (a.fee || 0), 0), [dayAppts]);
  const monthDayCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [date, list] of apptsByDate) counts.set(date, list.length);
    return counts;
  }, [apptsByDate]);

  const isClosed = sessions.length === 0;

  const nav = (dir: -1 | 1) => selectAndShow(shift(selectedDate, dir));

  // ── Reusable atoms ─────────────────────────────
  const stat = (icon: ReactNode, label: string, value: string, valueClass: string) => (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-paper px-3.5 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-brand">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        <div className={`truncate text-lg font-semibold leading-tight ${valueClass}`}>{value}</div>
      </div>
    </div>
  );

  const slotCard = (appt: Appt) => {
    const meta = STATUS_META[appt.status] ?? STATUS_META.reserved;
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-3 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{appt.name}</div>
          <div className="flex items-center gap-2 truncate text-xs text-muted">
            <span>#{appt.token}</span>
            <span className="flex items-center gap-0.5">
              <Phone className="h-3 w-3" />
              {appt.phone}
            </span>
            {appt.age ? <span>· Age {appt.age}</span> : null}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.chip}`}>
          {meta.label}
        </span>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* ── Day view — the primary surface ── */}
      <section className="rounded-2xl border border-line bg-paper p-4 md:p-6">
        {/* Date + day navigation */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-ink md:text-xl">{dayLabel}</h1>
              {isToday && (
                <span className="shrink-0 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold text-white">
                  Today
                </span>
              )}
            </div>
            {isClosed ? (
              <p className="mt-0.5 text-sm text-muted">Clinic closed today</p>
            ) : (
              <p className="mt-0.5 text-sm text-muted">
                {dayAppts.length} booked · {openSlots} free
              </p>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => nav(-1)}
              aria-label="Previous day"
              className="rounded-lg border border-line p-2 text-muted transition hover:bg-line/40 hover:text-ink"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {!isToday && (
              <button
                onClick={() => selectAndShow(todayStr)}
                className="rounded-lg border border-brand/40 px-3 py-2 text-xs font-semibold text-brand transition hover:bg-brand hover:text-white"
              >
                Today
              </button>
            )}
            <button
              onClick={() => nav(1)}
              aria-label="Next day"
              className="rounded-lg border border-line p-2 text-muted transition hover:bg-line/40 hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Quick stats */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {stat(<CalendarDays className="h-4 w-4" />, "Appointments", String(dayAppts.length), "text-ink")}
          {stat(<CheckCircle2 className="h-4 w-4" />, "Paid", String(paidCount), "text-in")}
          {stat(<IndianRupee className="h-4 w-4" />, "Fee total", `${clinic.currency}${revenue}`, "text-brand-dark")}
          {stat(<Users className="h-4 w-4" />, "Open slots", String(openSlots), "text-muted")}
        </div>

        {/* Timeline */}
        {isClosed ? (
          <div className="mt-5 flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-bone/60 px-4 py-10 text-center">
            <Clock className="h-6 w-6 text-line" />
            <p className="text-sm font-medium text-muted">
              The clinic is closed on {selectedDay.toLocaleDateString("en-IN", { weekday: "long" })}.
            </p>
            <p className="text-xs text-muted/70">No sessions are scheduled this day.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            {sessions.map((s) => {
              const booked = dayAppts.filter((a) => s.slots.includes(a.time));
              const free = s.slots.length - booked.length;
              return (
                <div key={s.label}>
                  <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-1">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-ink">
                      {s.label}
                    </h2>
                    <span className="text-xs text-muted">
                      {fmt(s.window.start)} to {fmt(s.window.end)} · {booked.length} booked · {free} free
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {s.slots.map((slot) => {
                      const appt = dayAppts.find((a) => a.time === slot);
                      return (
                        <div key={slot} className="flex items-center gap-3 md:gap-4">
                          <div className="w-14 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted">
                            {fmt(slot)}
                          </div>
                          {appt ? (
                            <div className="min-w-0 flex-1">{slotCard(appt)}</div>
                          ) : (
                            <div className="flex h-8 min-w-0 flex-1 items-center rounded-xl px-3 text-[11px] font-medium text-brand/40">
                              Free
                              <span className="mx-2 h-px flex-1 border-b border-dashed border-line" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-4">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-brand" />
            Booked or confirmed
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-accent" />
            Waiting
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-out" />
            Consulting
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-in" />
            Done
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-brand/30" />
            Free slot
          </div>
        </div>
      </section>

      {/* ── Month view — compact navigator ── */}
      <section className="rounded-2xl border border-line bg-paper p-4 md:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted">
            {monthStart.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
          </h3>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => gotoMonth(new Date(viewMonth.year, viewMonth.month - 1, 1))}
              aria-label="Previous month"
              className="rounded-md border border-line p-1.5 text-muted transition hover:bg-line/40 hover:text-ink"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => selectAndShow(todayStr)}
              className="rounded-md border border-brand/40 px-2 py-1 text-[11px] font-semibold text-brand transition hover:bg-brand hover:text-white"
            >
              Today
            </button>
            <button
              onClick={() => gotoMonth(new Date(viewMonth.year, viewMonth.month + 1, 1))}
              aria-label="Next month"
              className="rounded-md border border-line p-1.5 text-muted transition hover:bg-line/40 hover:text-ink"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mb-2 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-muted">
          {DAY_HEADERS.map((d) => (
            <div key={d} className="py-0.5">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {monthCells.map((day, i) => {
            const date = day ? dateStr(day) : null;
            const count = date ? monthDayCounts.get(date) || 0 : 0;
            const isSel = date === selectedDate;
            const isTodayCell = date === todayStr;
            return (
              <button
                key={i}
                disabled={!day}
                onClick={() => day && selectAndShow(dateStr(day))}
                className={`relative flex h-9 flex-col items-center justify-center rounded-lg text-xs transition ${
                  !day
                    ? ""
                    : isSel
                      ? "bg-brand font-semibold text-white"
                      : isTodayCell
                        ? "border border-brand bg-brand-tint font-semibold text-brand"
                        : count
                          ? "text-ink hover:bg-line/40"
                          : "text-muted hover:bg-line/30"
                }`}
              >
                {day && (
                  <>
                    <span>{day}</span>
                    {count > 0 && !isSel && (
                      <span
                        className={`absolute bottom-1 h-1 w-1 rounded-full ${isTodayCell ? "bg-brand" : "bg-brand/50"}`}
                      />
                    )}
                  </>
                )}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-right text-[11px] text-muted">{shortDayLabel} selected</p>
      </section>
    </div>
  );
}