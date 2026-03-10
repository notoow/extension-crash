import test from "node:test";
import assert from "node:assert/strict";
import { buildComparisonDiff, summarizeComparison } from "../src/profile-compare.js";

test("buildComparisonDiff detects extension and storage deltas", () => {
  const diff = buildComparisonDiff({
    primaryExtensions: [
      { id: "a", name: "Alpha", version: "1.0.0", enabled: true, incognitoEnabled: false },
      { id: "b", name: "Beta", version: "1.0.0", enabled: true, incognitoEnabled: false },
    ],
    compareExtensions: [
      { id: "a", name: "Alpha", version: "1.0.1", enabled: false, incognitoEnabled: false },
      { id: "c", name: "Gamma", version: "2.0.0", enabled: true, incognitoEnabled: true },
    ],
    primarySnapshot: {
      cookies: [
        { name: "sid", domain: ".example.com", path: "/", valueHash: "1111", valueLength: 3 },
      ],
      localStorage: [
        { key: "token", valueHash: "aaaa", valueLength: 10 },
      ],
      sessionStorage: [],
      indexedDbNames: ["db-primary"],
      cacheStorageNames: ["cache-a"],
      serviceWorkerScopes: ["https://example.com/sw.js"],
    },
    compareSnapshot: {
      cookies: [
        { name: "sid", domain: ".example.com", path: "/", valueHash: "2222", valueLength: 3 },
        { name: "bm", domain: ".example.com", path: "/", valueHash: "3333", valueLength: 2 },
      ],
      localStorage: [
        { key: "token", valueHash: "bbbb", valueLength: 12 },
      ],
      sessionStorage: [],
      indexedDbNames: ["db-compare"],
      cacheStorageNames: [],
      serviceWorkerScopes: [],
    },
  });

  assert.equal(diff.extensions.onlyInPrimary.length, 1);
  assert.equal(diff.extensions.onlyInCompare.length, 1);
  assert.equal(diff.extensions.enabledOnlyInPrimary.length, 1);
  assert.equal(diff.extensions.versionMismatch.length, 1);
  assert.equal(diff.cookies.valueChanged.length, 1);
  assert.equal(diff.cookies.onlyInCompare.length, 1);
  assert.equal(diff.localStorage.valueChanged.length, 1);
  assert.deepEqual(diff.indexedDb.onlyInPrimary, ["db-primary"]);
  assert.deepEqual(diff.indexedDb.onlyInCompare, ["db-compare"]);
});

test("summarizeComparison prefers site data when only the primary profile fails", () => {
  const summary = summarizeComparison({
    primaryProfile: "Profile 2",
    compareProfile: "Default",
    primarySnapshot: { blocked: true },
    compareSnapshot: { blocked: false },
    diff: {
      extensions: {
        onlyInPrimary: [],
        onlyInCompare: [],
        enabledOnlyInPrimary: [],
        enabledOnlyInCompare: [],
        versionMismatch: [],
        incognitoMismatch: [],
      },
      cookies: {
        onlyInPrimary: [{ name: "bm" }],
        onlyInCompare: [],
        valueChanged: [],
      },
      localStorage: {
        onlyInPrimary: [],
        onlyInCompare: [],
        valueChanged: [],
      },
      sessionStorage: {
        onlyInPrimary: [],
        onlyInCompare: [],
        valueChanged: [],
      },
      indexedDb: { onlyInPrimary: [], onlyInCompare: [] },
      cacheStorage: { onlyInPrimary: [], onlyInCompare: [] },
      serviceWorkers: { onlyInPrimary: [], onlyInCompare: [] },
    },
  });

  assert.equal(summary.status, "profile-state");
  assert.equal(summary.likelyCause, "site-data-or-session");
});
