// Minimal fake for the Supabase query builder, scoped to what these tests
// need: a `.from(table)` call returns a chainable object where every method
// (select/eq/is/order/insert/update/upsert/single/maybeSingle/...) just
// returns itself, and awaiting it at any point resolves to the next queued
// `{ data, error }` — one queued result per logical `await db.from(...)...`
// in the code path under test, in call order. Not a faithful Supabase mock;
// just enough to drive the branches these tests exercise.
import { vi } from "vitest";

export type MockResult = { data: any; error: any };

export function makeMockDb(responses: MockResult[]) {
  const queue = [...responses];
  const chain: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: MockResult) => void) => resolve(queue.shift() ?? { data: null, error: null });
        }
        return (..._args: any[]) => chain;
      },
    }
  );
  return { from: vi.fn(() => chain), __queue: queue };
}

// Shared mutable slot the mocked "@/lib/supabase-admin" module reads from at
// call time — set it per-test before invoking the function under test.
export const mockDbHolder: { current: ReturnType<typeof makeMockDb> | null } = { current: null };
