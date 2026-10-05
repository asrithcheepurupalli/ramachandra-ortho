import { describe, it, expect } from "vitest";
import { isPastSlot, PAST_SLOT_GRACE_MIN } from "@/lib/schedule";

// `now` is already "IST wall clock" (see nowIST), so build it from local parts.
const at = (date: string, hh: number, mm: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
};

describe("isPastSlot", () => {
  it("uses a 30 minute grace after the slot start", () => {
    expect(PAST_SLOT_GRACE_MIN).toBe(30);
  });
  it("is not past before the grace has elapsed", () => {
    expect(isPastSlot("2026-10-05", "10:15", at("2026-10-05", 10, 44))).toBe(false);
  });
  it("is past exactly at slot + 30 minutes", () => {
    expect(isPastSlot("2026-10-05", "10:15", at("2026-10-05", 10, 45))).toBe(true);
  });
  it("is past later the same day", () => {
    expect(isPastSlot("2026-10-05", "10:15", at("2026-10-05", 17, 44))).toBe(true);
  });
  it("is never past for an upcoming slot today", () => {
    expect(isPastSlot("2026-10-05", "19:00", at("2026-10-05", 17, 44))).toBe(false);
  });
  it("treats earlier dates as past and later dates as not", () => {
    expect(isPastSlot("2026-10-03", "19:45", at("2026-10-05", 0, 5))).toBe(true);
    expect(isPastSlot("2026-10-06", "09:00", at("2026-10-05", 23, 59))).toBe(false);
  });
  it("honours a custom grace", () => {
    expect(isPastSlot("2026-10-05", "10:00", at("2026-10-05", 10, 20), 20)).toBe(true);
    expect(isPastSlot("2026-10-05", "10:00", at("2026-10-05", 10, 19), 20)).toBe(false);
  });
});
