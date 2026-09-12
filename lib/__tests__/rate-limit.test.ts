// Covers task #45/#36: the shared limiter backing the booking endpoints must
// actually track state across calls (unlike the old in-memory-per-instance
// Map), and must reset once its window has elapsed.
import { describe, it, expect, vi } from "vitest";
import { makeMockDb, mockDbHolder } from "./mock-db";

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => mockDbHolder.current,
}));

describe("isRateLimited", () => {
  it("allows the first request for a key and then blocks once the limit is exceeded", async () => {
    const { isRateLimited } = await import("@/lib/rate-limit");
    const start = new Date().toISOString();

    // 1st call: no row yet → not limited (and writes count=1).
    mockDbHolder.current = makeMockDb([{ data: null, error: null }, { data: null, error: null }]);
    expect(await isRateLimited("k", 2, 60_000)).toBe(false);

    // 2nd call: count 1 → 2, still within limit of 2.
    mockDbHolder.current = makeMockDb([{ data: { count: 1, window_start: start }, error: null }, { data: null, error: null }]);
    expect(await isRateLimited("k", 2, 60_000)).toBe(false);

    // 3rd call: count 2 → 3, now over the limit of 2.
    mockDbHolder.current = makeMockDb([{ data: { count: 2, window_start: start }, error: null }, { data: null, error: null }]);
    expect(await isRateLimited("k", 2, 60_000)).toBe(true);
  });

  it("resets once the window has elapsed even though the row is still there", async () => {
    const { isRateLimited } = await import("@/lib/rate-limit");
    const longAgo = new Date(Date.now() - 120_000).toISOString();

    // Row exists with a count over the limit, but its window started 2
    // minutes ago against a 1-minute window — must be treated as expired.
    mockDbHolder.current = makeMockDb([{ data: { count: 99, window_start: longAgo }, error: null }, { data: null, error: null }]);
    expect(await isRateLimited("k", 2, 60_000)).toBe(false);
  });

  it("fails open (does not block bookings/lookups) if the limiter's own read errors", async () => {
    const { isRateLimited } = await import("@/lib/rate-limit");
    mockDbHolder.current = makeMockDb([{ data: null, error: new Error("connection reset") }]);
    expect(await isRateLimited("k", 2, 60_000)).toBe(false);
  });
});
