import test from "node:test";
import assert from "node:assert/strict";
import { deriveRepairTargets, summarizeRepairResult, summarizeRestoreResult } from "../src/profile-repair.js";

test("deriveRepairTargets deduplicates origins from target and final URLs", () => {
  const targets = deriveRepairTargets(
    "https://www.coupang.com/np/search?q=%EC%BB%A4%ED%94%BC",
    "https://www.coupang.com/np/search?q=%EC%BB%A4%ED%94%BC&page=2",
  );

  assert.deepEqual(targets.urls, [
    "https://www.coupang.com/np/search?q=%EC%BB%A4%ED%94%BC",
    "https://www.coupang.com/np/search?q=%EC%BB%A4%ED%94%BC&page=2",
  ]);
  assert.deepEqual(targets.origins, ["https://www.coupang.com"]);
});

test("summarizeRepairResult reports success when cleanup fixes the page", () => {
  const summary = summarizeRepairResult({
    beforeBlocked: true,
    afterBlocked: false,
  });

  assert.equal(summary.status, "repair-succeeded");
});

test("summarizeRestoreResult reports applied restore for healthy page", () => {
  const summary = summarizeRestoreResult({
    restoredCookieCount: 3,
    restoredLocalStorageItemCount: 2,
    afterBlocked: false,
  });

  assert.equal(summary.status, "restore-applied");
});

test("summarizeRestoreResult reports nothing when backup is empty", () => {
  const summary = summarizeRestoreResult({
    restoredCookieCount: 0,
    restoredLocalStorageItemCount: 0,
    afterBlocked: false,
  });

  assert.equal(summary.status, "nothing-restored");
});
