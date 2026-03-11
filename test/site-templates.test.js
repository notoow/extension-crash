import test from "node:test";
import assert from "node:assert/strict";
import { mergeDetectionRules, resolveSiteTemplate } from "../src/site-templates.js";

test("resolveSiteTemplate auto-detects coupang by host", () => {
  const template = resolveSiteTemplate({
    requestedTemplate: "auto",
    url: "https://www.coupang.com/np/search?q=%EC%BB%A4%ED%94%BC",
  });

  assert.equal(template.resolved?.name, "coupang");
});

test("mergeDetectionRules combines template, report, and CLI rules without duplicates", () => {
  const merged = mergeDetectionRules({
    templateRules: {
      blockPatterns: ["access denied"],
      successPatterns: [],
      requiredUrlFragments: ["coupang.com"],
    },
    reportRules: {
      blockPatterns: ["reference #"],
      successPatterns: ["커피"],
      requiredUrlFragments: [],
    },
    argRules: {
      blockPatterns: ["access denied"],
      successPatterns: ["상품"],
      requiredUrlFragments: ["coupang.com"],
    },
  });

  assert.deepEqual(merged, {
    blockPatterns: ["access denied", "reference #"],
    successPatterns: ["커피", "상품"],
    requiredUrlFragments: ["coupang.com"],
  });
});
