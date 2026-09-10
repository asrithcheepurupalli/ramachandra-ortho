// The desk's contract: every report() lands in error_logs (new row or count
// bump), criticals alert via email once per fingerprint per hour (plus a global
// cap), warnings never alert, and - non-negotiably - report() never throws and
// never blocks the error path that called it, even when the DB or email are
// down.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeMockDb, mockDbHolder } from "./mock-db";

// server-only throws outside a bundler RSC context; the module under test is
// real bugdesk.ts, so stub the guard rather than the module itself.
vi.mock("server-only", () => ({}));

const m = vi.hoisted(() => ({
  sendBugdeskEmail: vi.fn(async (opts: any) => { m.emailCalls.push(opts); return true; }),
  isRateLimited: vi.fn(async () => false),
  emailCalls: [] as any[],
}));

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: () => mockDbHolder.current,
}));

vi.mock("@/lib/mailer", () => ({
  sendBugdeskEmail: m.sendBugdeskEmail,
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited: m.isRateLimited,
}));

// The bugdesk module is imported lazily per-test so a fresh (mock) module
// graph is used across cases; the mocks above are shared via vi.hoisted.

const OLD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

beforeEach(() => {
  mockDbHolder.current = null;
  m.emailCalls.length = 0;
  // mockClear, NOT mockReset: reset wipes the recording implementation in the
  // vi.fn above (emailCalls would stop filling while toHaveBeenCalledTimes
  // still passes — a lie).
  m.sendBugdeskEmail.mockClear();
  m.isRateLimited.mockClear();
  m.isRateLimited.mockResolvedValue(false);
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
});

afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = OLD_KEY;
});

describe("bugdesk.report", () => {
  it("persists a warning (insert) and sends no immediate alert", async () => {
    const { report } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null }, // select/maybeSingle → no existing row
      { data: null, error: null }, // insert
    ]);

    await report({ source: "bot", message: "retry exceeded", severity: "warning", info: { stage: "mock" } });

    expect(m.sendBugdeskEmail).not.toHaveBeenCalled();
    expect(m.isRateLimited).not.toHaveBeenCalled();
  });

  it("bumps count on a recurring warning and still does not alert", async () => {
    const { report } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([
      { data: { count: 3, info: { earlier: true } }, error: null }, // existing row
      { data: null, error: null }, // update { count: 4, last_seen, info }
    ]);

    await report({ source: "bot", message: "recurring thing", severity: "warning" });

    expect(m.sendBugdeskEmail).not.toHaveBeenCalled();
  });

  it("alerts immediately on a critical and marks alerted_at", async () => {
    const { report } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null }, // select
      { data: null, error: null }, // insert
      { data: null, error: null }, // update alerted_at
    ]);

    await report({ source: "payments/webhook", message: "bad signature", severity: "critical" });

    expect(m.sendBugdeskEmail).toHaveBeenCalledTimes(1);
    expect(m.emailCalls[0].kind).toBe("alert");
    expect(m.emailCalls[0].items[0].source).toBe("payments/webhook");
    expect(m.emailCalls[0].items[0].severity).toBe("critical");
    expect(m.emailCalls[0].items[0].count).toBe(1);
  });

  it("does not alert when the fingerprint throttle is engaged", async () => {
    m.isRateLimited.mockResolvedValue(true); // every throttle check says "blocked"
    const { report } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null }, // select
      { data: null, error: null }, // insert
    ]);

    await report({ source: "cron", message: "boom", severity: "critical" });

    expect(m.sendBugdeskEmail).not.toHaveBeenCalled();
  });

  it("reportError derives the message from the thrown value", async () => {
    const { reportError } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([
      { data: null, error: null }, // select
      { data: null, error: null }, // insert
      { data: null, error: null }, // update alerted_at
    ]);

    await reportError("bot", new Error("boom"), { severity: "critical" });

    expect(m.sendBugdeskEmail).toHaveBeenCalledTimes(1);
    expect(m.emailCalls[0].items[0].message).toBe("boom");
  });

  it("never throws and never blocks the caller even when persistence fails", async () => {
    const { report } = await import("@/lib/bugdesk");
    // The select itself errors — persist swallows it (fallback count 1) and the
    // reporting continues to the alert path.
    mockDbHolder.current = makeMockDb([
      { data: null, error: new Error("connection reset") }, // select errors
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(report({ source: "bot", message: "db broken", severity: "critical" })).resolves.toBeUndefined();
    expect(m.sendBugdeskEmail).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("is a no-op beyond the console log when no service-role key is configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { report } = await import("@/lib/bugdesk");
    mockDbHolder.current = makeMockDb([]); // no db calls should be attempted
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await report({ source: "bot", message: "anything", severity: "critical" });

    expect(m.sendBugdeskEmail).not.toHaveBeenCalled();
    expect(m.isRateLimited).not.toHaveBeenCalled();

    spy.mockRestore();
  });
});