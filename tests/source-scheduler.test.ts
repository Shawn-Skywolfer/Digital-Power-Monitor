import assert from "node:assert/strict";
import test from "node:test";
import { runAllSourceJobs } from "../server/source-scheduler";

test("a failed source never prevents later sources from running", async () => {
  const visited: number[] = [];
  const outcomes = await runAllSourceJobs([1, 2, 3, 4], 2, async (item) => {
    visited.push(item);
    if (item === 2) throw new Error("site failed");
    return item * 10;
  });

  assert.deepEqual([...visited].sort(), [1, 2, 3, 4]);
  assert.equal(outcomes.length, 4);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
});

test("source concurrency never exceeds the configured limit", async () => {
  let active = 0;
  let peak = 0;
  await runAllSourceJobs([1, 2, 3, 4, 5], 2, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return item;
  });
  assert.equal(peak, 2);
});
