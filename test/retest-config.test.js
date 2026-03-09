import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunInputs } from "../src/retest-config.js";

test("resolveRunInputs uses report defaults for quick retest", () => {
  const args = {
    browser: "",
    profile: "",
    url: "",
    blockPatterns: [],
    successPatterns: [],
    requiredUrlFragments: [],
    extensionIds: [],
  };
  const report = {
    browser: { key: "chrome" },
    profile: "Default",
    targetUrl: "https://example.com",
    detectionRules: {
      blockPatterns: ["access denied"],
      successPatterns: ["example domain"],
      requiredUrlFragments: ["example.com"],
    },
    diagnosis: {
      culpritIds: ["abc123"],
    },
  };

  const resolved = resolveRunInputs({ args, report });

  assert.equal(resolved.browser, "chrome");
  assert.equal(resolved.profile, "Default");
  assert.equal(resolved.url, "https://example.com");
  assert.deepEqual(resolved.detectionRules, {
    blockPatterns: ["access denied"],
    successPatterns: ["example domain"],
    requiredUrlFragments: ["example.com"],
  });
  assert.deepEqual(resolved.selectedExtensionIds, ["abc123"]);
});

test("resolveRunInputs lets explicit CLI extension IDs override report suspects", () => {
  const args = {
    browser: "edge",
    profile: "Profile 2",
    url: "https://override.example",
    blockPatterns: ["blocked"],
    successPatterns: [],
    requiredUrlFragments: [],
    extensionIds: ["manual-one", "manual-two"],
  };
  const report = {
    browser: { key: "chrome" },
    profile: "Default",
    targetUrl: "https://example.com",
    diagnosis: {
      culpritIds: ["abc123"],
    },
  };

  const resolved = resolveRunInputs({ args, report });

  assert.equal(resolved.browser, "edge");
  assert.equal(resolved.profile, "Profile 2");
  assert.equal(resolved.url, "https://override.example");
  assert.deepEqual(resolved.detectionRules.blockPatterns, ["blocked"]);
  assert.deepEqual(resolved.selectedExtensionIds, ["manual-one", "manual-two"]);
});
