import test from "node:test";
import assert from "node:assert/strict";
import { buildDoctorPlan } from "../src/doctor.js";

test("buildDoctorPlan recommends repair for blocked profile with site data signal", () => {
  const plan = buildDoctorPlan({
    profile: "Profile 2",
    compareProfile: "Profile 7",
    targetUrl: "https://www.coupang.com/",
    siteTemplate: { resolved: { name: "coupang" } },
    comparison: {
      summary: {
        status: "profile-state",
        likelyCause: "site-data-or-session",
      },
      primarySnapshot: { blocked: true },
      compareSnapshot: { blocked: false },
    },
  });

  assert.equal(plan.status, "repair-recommended");
  assert.equal(plan.autoRepairSafe, true);
  assert.match(plan.recommendedCommand, /--repair-site-data/);
  assert.match(plan.recommendedCommand, /--site-template "coupang"/);
});

test("buildDoctorPlan suggests watch mode when the issue is not reproduced", () => {
  const plan = buildDoctorPlan({
    profile: "Profile 2",
    compareProfile: "Profile 7",
    targetUrl: "https://www.coupang.com/",
    siteTemplate: { resolved: { name: "coupang" } },
    comparison: {
      summary: {
        status: "not-reproduced-with-delta",
        likelyCause: "site-data-delta",
      },
      primarySnapshot: { blocked: false },
      compareSnapshot: { blocked: false },
    },
  });

  assert.equal(plan.status, "watch-site-data");
  assert.equal(plan.autoRepairSafe, false);
});
