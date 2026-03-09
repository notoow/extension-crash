import test from "node:test";
import assert from "node:assert/strict";
import { chunkCandidates } from "../src/profile-discovery.js";

test("chunkCandidates splits items into balanced groups", () => {
  const result = chunkCandidates([1, 2, 3, 4, 5], 2);

  assert.deepEqual(result, [
    [1, 2, 3],
    [4, 5],
  ]);
});
