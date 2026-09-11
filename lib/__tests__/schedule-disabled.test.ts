// Covers the per-date slot-block feature: allSlotsFor must drop times listed in
// that date's exception `disabled` set, while keep everything else intact, and
// applySchedule must round-trip the `disabled` key onto the live singleton
// unchanged (it rides along inside the jsonb `exceptions` map).
import { describe, it, expect, beforeEach } from "vitest";
import {
  allSlotsFor, applySchedule, ymd, exceptions, defaultWeeklyHours,
  type Exception, type SchedState, type WeeklyHours,
} from "@/lib/schedule";

// A fixed date whose weekday drives the weekly map — allSlotsFor indexes by
// getDay(), so the grid windows are keyed to whatever weekday this lands on.
const date = new Date("2026-09-14T00:00:00");
const weekly: WeeklyHours = { [date.getDay()]: [{ start: "10:00", end: "10:45" }] };
// 15-minute slots → 10:00, 10:15, 10:30
const BASE = ["10:00", "10:15", "10:30"];

const sched = (exceptions: Record<string, Exception> = {}): SchedState =>
  ({ weekly, exceptions, override: null });

// The live singleton is module-global and mutated by applySchedule; reset it so
// each test (and the round-trip assertion) starts from a clean state.
beforeEach(() => applySchedule(defaultWeeklyHours(), {}));

describe("allSlotsFor with a disabled set", () => {
  it("drops blocked times and keeps the rest in order", () => {
    const s = sched({ [ymd(date)]: { disabled: ["10:15"] } });
    expect(allSlotsFor(date, s)).toEqual(["10:00", "10:30"]);
  });

  it("creates a garden-variety gap when a mid-window slot is blocked", () => {
    const s = sched({ [ymd(date)]: { disabled: ["10:15"] } });
    expect(allSlotsFor(date, s).length).toBe(2);
  });

  it("returns no slots when every time is blocked", () => {
    const s = sched({ [ymd(date)]: { disabled: BASE } });
    expect(allSlotsFor(date, s)).toEqual([]);
  });

  it("does not apply to a different date", () => {
    const other = new Date("2026-09-15T00:00:00");
    const otherWeekly: WeeklyHours = { [other.getDay()]: [{ start: "10:00", end: "10:45" }] };
    // A block keyed to one date must leave other dates alone.
    const s: SchedState = {
      weekly: otherWeekly,
      exceptions: { [ymd(date)]: { disabled: ["10:15"] } },
      override: null,
    };
    expect(allSlotsFor(other, s)).toEqual(["10:00", "10:15", "10:30"]);
  });

  it("closed still empties the day even with a disabled list present", () => {
    const s = sched({ [ymd(date)]: { closed: true, disabled: ["10:00"] } });
    expect(allSlotsFor(date, s)).toEqual([]);
  });

  it("composes with a windows override", () => {
    // Custom hours 10:00–10:30 (two slots), one of them blocked.
    const s: SchedState = {
      weekly,
      exceptions: { [ymd(date)]: { windows: [{ start: "10:00", end: "10:30" }], disabled: ["10:00"] } },
      override: null,
    };
    expect(allSlotsFor(date, s)).toEqual(["10:15"]);
  });
});

describe("applySchedule round-trip", () => {
  it("keeps the disabled key intact on the live singleton", () => {
    const d = ymd(date);
    applySchedule(weekly, { [d]: { disabled: ["10:15"] } });
    expect(exceptions[d]?.disabled).toEqual(["10:15"]);
    expect(allSlotsFor(date)).toEqual(["10:00", "10:30"]);
  });
});