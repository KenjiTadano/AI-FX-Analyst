import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canPoll, createVisibleRefreshStagger } from "../lib/client/polling";

test("polling pauses while hidden and resumes visibly", () => {
  assert.equal(canPoll("hidden"), false);
  assert.equal(canPoll("visible"), true);
});

test("visible refreshes are staggered and a later resume starts a new batch", () => {
  const delay = createVisibleRefreshStagger(250, 1000);
  assert.deepEqual([delay(10_000), delay(10_000), delay(10_000)], [0, 250, 500]);
  assert.equal(delay(12_000), 0);
});

test("market, fundamental and AI hooks stop hidden timers and stagger visible resume", () => {
  for (const file of ["market.tsx", "fundamental.tsx", "ai-analysis.tsx"]) {
    const source = readFileSync(join(process.cwd(), "components/dashboard", file), "utf8");
    assert.match(source, /document\.addEventListener\("visibilitychange"/);
    assert.match(source, /canPoll\(document\.visibilityState\)/);
    assert.match(source, /scheduleVisibleRefresh/);
  }
  const ai = readFileSync(join(process.cwd(), "components/dashboard/ai-analysis.tsx"), "utf8");
  assert.match(ai, /Date\.parse\(value\.data\.expiresAt\)/);
});