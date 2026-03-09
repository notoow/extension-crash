import test from "node:test";
import assert from "node:assert/strict";
import { minimizeFailureSet } from "../src/delta-debug.js";

test("minimizeFailureSet isolates a single failing item", async () => {
  const items = ["a", "b", "c", "d"];

  const result = await minimizeFailureSet(items, async (subset) => ({
    failed: subset.includes("c"),
  }));

  assert.deepEqual(result.minimalItems, ["c"]);
});

test("minimizeFailureSet keeps an interacting pair when neither item fails alone", async () => {
  const items = ["a", "b", "c", "d"];

  const result = await minimizeFailureSet(items, async (subset) => ({
    failed: subset.includes("b") && subset.includes("d"),
  }));

  assert.deepEqual(new Set(result.minimalItems), new Set(["b", "d"]));
});
