"use client";

import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ymd, fmt, windowsFor, allSlotsFor } from "@/lib/schedule";
import type { Appt } from "@/lib/store";

interface CalendarViewProps {
  appts: Appt[];
}

export function CalendarView({ appts }: CalendarViewProps) {
  const [selectedDate, setSelectedDate] = useState(() => ymd(new Date()));
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const monthStart = useMemo(() => {
    return new Date(viewMonth.year, viewMonth.month, 1);
  }, [viewMonth]);

  const daysInMonth = useMemo(() => {
    return new Date(viewMonth.year, viewMonth.month + 1, 0).getDate();
  }, [viewMonth]);

  const firstDayOfWeek = useMemo(() => {
    return monthStart.getDay();
  }, [monthStart]);

  const monthMatrix = useMemo(() => {
    const days = [];
    // Empty cells before month starts
    for (let i = 0; i < firstDayOfWeek; i++) {
      days.push(null);
    }
    // Days of month
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(i);
    }
    return days;
  }, [daysInMonth, firstDayOfWeek]);

  const dateStr = (day: number) => {
    const d = new Date(viewMonth.year, viewMonth.month, day);
    return ymd(d);
  };

  const apptsByDate = useMemo(() => {
    const map = new Map<string, Appt[]>();
    for (const appt of appts) {
      if (appt.status !== "cancelled" && appt.status !== "payment_pending") {
        const arr = map.get(appt.date) || [];
        arr.push(appt);
        map.set(appt.date, arr);
      }
    }
    return map;
  }, [appts]);

  const dayAppts = useMemo(() => {
    const list = apptsByDate.get(selectedDate) || [];
    return list.sort((a, b) => a.time.localeCompare(b.time));
  }, [apptsByDate, selectedDate]);

  const sessionGroups = useMemo(() => {
    const selectedDateObj = new Date(selectedDate + "T00:00:00");
    const wins = windowsFor(selectedDateObj);
    const allSlots = allSlotsFor(selectedDateObj);
    const groups: Array<{ label: string; slots: string[] }> = [];
    for (const win of wins) {
      const [startH, startM] = win.start.split(":").map(Number);
      const startMin = startH * 60 + startM;
      const label =
        startMin < 14 * 60
          ? "Morning"
          : startMin < 17 * 60
            ? "Afternoon"
            : "Evening";

      const [endH, endM] = win.end.split(":").map(Number);
      const endMin = endH * 60 + endM;

      const slotsInWindow = allSlots.filter(
        (t) => {
          const [h, m] = t.split(":").map(Number);
          const mins = h * 60 + m;
          return mins >= startMin && mins < endMin;
        }
      );

      if (slotsInWindow.length > 0) {
        groups.push({ label, slots: slotsInWindow });
      }
    }
    return groups;
  }, [selectedDate]);

  const prevMonth = () => {
    setViewMonth((m) =>
      m.month === 0
        ? { year: m.year - 1, month: 11 }
        : { year: m.year, month: m.month - 1 }
    );
  };

  const nextMonth = () => {
    setViewMonth((m) =>
      m.month === 11
        ? { year: m.year + 1, month: 0 }
        : { year: m.year, month: m.month + 1 }
    );
  };

  return (
    <div className="space-y-6">
      {/* Month Calendar */}
      <div className="rounded-2xl border border-line bg-paper p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            {monthStart.toLocaleDateString("en-IN", {
              month: "long",
              year: "numeric",
            })}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={prevMonth}
              className="rounded-lg border border-line p-2 text-muted hover:bg-line/40 hover:text-ink"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={nextMonth}
              className="rounded-lg border border-line p-2 text-muted hover:bg-line/40 hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Weekday headers */}
        <div className="mb-3 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-muted">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
            <div key={day} className="py-1">
              {day}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {monthMatrix.map((day, i) => {
            const date = day ? dateStr(day) : null;
            const hasAppts = date ? apptsByDate.has(date) : false;
            const isSelected = date === selectedDate;
            const isToday = date === ymd(new Date());

            return (
              <button
                key={i}
                onClick={() => date && setSelectedDate(date)}
                className={`aspect-square rounded-lg py-1 text-sm font-medium transition ${
                  !date
                    ? ""
                    : isSelected
                      ? "bg-brand text-white"
                      : isToday
                        ? "border-2 border-brand bg-brand-tint text-brand"
                        : hasAppts
                          ? "border border-line bg-white text-ink hover:border-brand/40"
                          : "text-muted hover:bg-line/30"
                }`}
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>

      {/* Day View - Slot Grid */}
      <div className="rounded-2xl border border-line bg-paper p-6">
        <h2 className="mb-4 text-lg font-semibold">
          {new Date(selectedDate + "T00:00:00").toLocaleDateString("en-IN", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </h2>

        <div className="space-y-6">
          {sessionGroups.map((session) => (
            <div key={session.label}>
              <h3 className="mb-3 text-sm font-semibold text-muted">
                {session.label} Session
              </h3>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {session.slots.map((slot) => {
                  const appt = dayAppts.find((a) => a.time === slot);
                  return (
                    <div
                      key={slot}
                      className={`aspect-square rounded-lg border p-2 text-center text-xs font-medium flex flex-col items-center justify-center transition ${
                        appt
                          ? "border-brand bg-brand-tint text-brand"
                          : "border-line bg-white text-muted"
                      }`}
                    >
                      <div className="text-[11px]">{fmt(slot)}</div>
                      {appt && (
                        <div className="truncate text-[10px] font-semibold text-brand">
                          #{appt.token}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Booked Appointments */}
        {dayAppts.length > 0 && (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="mb-3 text-sm font-semibold">
              {dayAppts.length} Appointment{dayAppts.length > 1 ? "s" : ""}
            </h3>
            <div className="space-y-2">
              {dayAppts.map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center justify-between rounded-lg border border-line bg-white p-3 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-tint font-semibold text-brand">
                      #{appt.token}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{appt.name}</div>
                      <div className="text-xs text-muted">
                        {fmt(appt.time)} · {appt.phone}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {appt.age && <span className="text-muted">Age {appt.age}</span>}
                    <span
                      className={`rounded-full px-2 py-1 ${
                        appt.status === "done"
                          ? "bg-in/15 text-in"
                          : appt.status === "consulting"
                            ? "bg-accent-tint text-accent"
                            : "bg-brand-tint text-brand"
                      }`}
                    >
                      {appt.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
