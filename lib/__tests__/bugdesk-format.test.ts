// Guards the bug desk's most important reading: a thrown value must surface on
// the desk as a real reason, never as "[object Object]". Supabase's PostgrestError
// is a plain object and String() of it is the least helpful output in the
// language — this is what the desk was actually seeing for every DB failure.
import { describe, it, expect, vi } from "vitest";

// lib/bugdesk.ts imports "server-only" at its top, which throws outside a
// server bundle — neutralize it so the module can load in vitest.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(async () => true) }));
vi.mock("@/lib/mailer", () => ({ sendBugdeskEmail: vi.fn(async () => true) }));
vi.mock("@/lib/meta-whatsapp", () => ({ sendText: vi.fn(async () => true) }));

import { formatThrown } from "@/lib/bugdesk";

describe("formatThrown", () => {
  it("turns a Supabase PostgrestError into readable text, not [object Object]", () => {
    const dbErr = {
      message: "Failure retrieving data from server",
      code: "PGRST301",
      details: "The schema cache was not loaded",
      hint: null,
    };
    expect(formatThrown(dbErr)).toContain("Failure retrieving data from server");
    expect(formatThrown(dbErr)).toContain("PGRST301");
    expect(formatThrown(dbErr)).not.toBe("[object Object]");
  });

  it("keeps an Error instance's message", () => {
    expect(formatThrown(new Error("razorpay link expired"))).toBe("razorpay link expired");
  });

  it("reads a plain string as-is", () => {
    expect(formatThrown("timeout")).toBe("timeout");
  });

  it("serializes generic objects instead of [object Object]", () => {
    const out = formatThrown({ http: 429, detail: "rate limited" });
    expect(out).toContain("429");
    expect(out).not.toBe("[object Object]");
  });

  it("maps null/undefined to a readable placeholder", () => {
    expect(formatThrown(null)).toBe("unknown error");
    expect(formatThrown(undefined)).toBe("unknown error");
  });

  it("stringifies primitives", () => {
    expect(formatThrown(123)).toBe("123");
  });
});