import { compareProfiles } from "./profile-compare.js";
import { repairProfileSiteData } from "./profile-repair.js";

export async function runDoctor(options) {
  const {
    browser = "chrome",
    profile,
    compareProfile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs = 25000,
    settleTimeMs = 3500,
    includeAllLocations = false,
    autoRepair = false,
  } = options;

  if (!compareProfile) {
    throw new Error("Doctor mode requires --compare-profile so it can compare a failing profile against a working one.");
  }

  const comparison = await compareProfiles({
    browser,
    primaryProfile: profile,
    compareProfile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
    includeAllLocations,
  });
  const plan = buildDoctorPlan({
    profile,
    compareProfile,
    targetUrl,
    comparison,
  });
  let repair = null;

  if (autoRepair && plan.autoRepairSafe) {
    repair = await repairProfileSiteData({
      browser,
      profile,
      targetUrl,
      reportDir,
      detectionRules,
      timeoutMs,
      settleTimeMs,
    });
  }

  return {
    comparison,
    plan,
    repair,
  };
}

export function buildDoctorPlan({ profile, compareProfile, targetUrl, comparison }) {
  const summaryStatus = comparison.summary.status;
  const likelyCause = comparison.summary.likelyCause;
  const primaryBlocked = Boolean(comparison.primarySnapshot.blocked);
  const compareBlocked = Boolean(comparison.compareSnapshot.blocked);

  if (primaryBlocked && !compareBlocked && likelyCause === "site-data-or-session") {
    return {
      status: "repair-recommended",
      reason: `The failing profile "${profile}" is blocked while "${compareProfile}" loads, and the strongest signal is profile-scoped site data.`,
      autoRepairSafe: true,
      recommendedCommand: buildRepairCommand({ profile, targetUrl }),
    };
  }

  if (summaryStatus === "not-reproduced-with-delta" && likelyCause === "site-data-delta") {
    return {
      status: "watch-site-data",
      reason: `The page loaded in both profiles during this run, but site data still differs. If the failure comes back in "${profile}", the first repair should be a site-data reset.`,
      autoRepairSafe: false,
      recommendedCommand: buildRepairCommand({ profile, targetUrl }),
    };
  }

  if (primaryBlocked && !compareBlocked && likelyCause === "extension-state") {
    return {
      status: "inspect-extension-state",
      reason: `The failing profile "${profile}" differs mainly in enabled extension state versus "${compareProfile}".`,
      autoRepairSafe: false,
      recommendedCommand: buildCompareCommand({ profile, compareProfile, targetUrl }),
    };
  }

  if (primaryBlocked && compareBlocked) {
    return {
      status: "shared-failure",
      reason: "Both profiles failed, so a profile-only repair is unlikely to help on its own.",
      autoRepairSafe: false,
      recommendedCommand: "",
    };
  }

  return {
    status: "observe",
    reason: "No immediate automated repair is recommended from this run.",
    autoRepairSafe: false,
    recommendedCommand: buildCompareCommand({ profile, compareProfile, targetUrl }),
  };
}

function buildRepairCommand({ profile, targetUrl }) {
  return `node ./src/cli.js --url "${targetUrl}" --profile "${profile}" --repair-site-data`;
}

function buildCompareCommand({ profile, compareProfile, targetUrl }) {
  return `node ./src/cli.js --url "${targetUrl}" --profile "${profile}" --compare-profile "${compareProfile}"`;
}
