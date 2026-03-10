#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { compareProfiles } from "./profile-compare.js";
import { discoverExtensions, listProfiles } from "./profile-discovery.js";
import { readDetectionReport, resolveRunInputs } from "./retest-config.js";
import { runDetection, runRetest } from "./test-runner.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportContext = args.fromReport ? readDetectionReport(args.fromReport) : null;
  const runInputs = resolveRunInputs({
    args,
    report: reportContext?.report,
  });
  const isRetestMode = Boolean(reportContext) || args.extensionIds.length > 0;

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listProfiles) {
    const profiles = listProfiles(runInputs.browser);
    printProfiles(profiles);
    return;
  }

  if (!runInputs.url) {
    throw new Error("Missing required --url option.");
  }

  if (args.compareProfile) {
    const reportDir = ensureReportDir(args.outputDir);
    const reportPath = path.join(reportDir, `profile-compare-report-${Date.now()}.json`);
    const comparison = await compareProfiles({
      browser: runInputs.browser,
      primaryProfile: runInputs.profile,
      compareProfile: args.compareProfile,
      targetUrl: runInputs.url,
      reportDir,
      detectionRules: runInputs.detectionRules,
      timeoutMs: args.timeoutMs,
      settleTimeMs: args.settleTimeMs,
      includeAllLocations: args.includeAllLocations,
    });

    fs.writeFileSync(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: "profile-compare",
      ...comparison,
    }, null, 2));

    console.log(`Browser: ${comparison.browser.displayName}`);
    console.log(`Primary profile: ${comparison.primaryProfile}`);
    console.log(`Compare profile: ${comparison.compareProfile}`);
    console.log(`URL: ${comparison.targetUrl}`);
    console.log("");
    console.log(`Primary page: ${comparison.primarySnapshot.blocked ? "blocked" : "loaded"} (${comparison.primarySnapshot.title || comparison.primarySnapshot.finalUrl})`);
    console.log(`Compare page: ${comparison.compareSnapshot.blocked ? "blocked" : "loaded"} (${comparison.compareSnapshot.title || comparison.compareSnapshot.finalUrl})`);
    console.log("");
    console.log(`Summary: ${comparison.summary.status}`);
    console.log(comparison.summary.reason);
    printComparisonHighlights(comparison.diff);
    console.log("");
    console.log(`Report written to ${reportPath}`);
    return;
  }

  const discovery = discoverExtensions({
    browser: runInputs.browser,
    profile: runInputs.profile,
    includeAllLocations: args.includeAllLocations,
    limit: runInputs.selectedExtensionIds ? null : args.limit,
  });

  let candidates = discovery.extensions;
  if (runInputs.selectedExtensionIds) {
    const selectedIds = new Set(runInputs.selectedExtensionIds);
    candidates = discovery.extensions.filter((extension) => selectedIds.has(extension.id));
    const missingIds = runInputs.selectedExtensionIds.filter((id) => !candidates.some((extension) => extension.id === id));

    if (missingIds.length > 0) {
      console.error(`Warning: some requested extensions are not currently available in profile "${runInputs.profile}": ${missingIds.join(", ")}`);
    }
  } else if (typeof args.limit === "number") {
    candidates = candidates.slice(0, args.limit);
  }

  if (candidates.length === 0) {
    if (args.fromReport) {
      throw new Error(`No retest candidates were found from report "${reportContext.absolutePath}".`);
    }

    throw new Error(`No enabled extension candidates were found in profile "${runInputs.profile}".`);
  }

  const reportDir = ensureReportDir(args.outputDir);
  const reportFilePrefix = isRetestMode ? "retest-report" : "report";
  const reportPath = path.join(reportDir, `${reportFilePrefix}-${Date.now()}.json`);

  console.log(`Browser: ${discovery.browser.displayName}`);
  console.log(`Profile: ${runInputs.profile}`);
  console.log(`URL: ${runInputs.url}`);
  console.log(`Candidates: ${candidates.length}`);
  if (reportContext) {
    console.log(`Source report: ${reportContext.absolutePath}`);
  }
  console.log("");
  console.log("Candidate extensions:");
  for (const extension of candidates) {
    console.log(`- ${extension.name} (${extension.id})`);
  }
  console.log("");
  console.log("Running diagnostics. Chrome windows may open briefly.");

  const runner = isRetestMode ? runRetest : runDetection;
  const result = await runner({
    executablePath: discovery.browser.executablePath,
    browserKey: discovery.browser.key,
    targetUrl: runInputs.url,
    candidates,
    reportDir,
    timeoutMs: args.timeoutMs,
    settleTimeMs: args.settleTimeMs,
    detectionRules: runInputs.detectionRules,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: isRetestMode ? "retest" : "full-scan",
    browser: {
      key: discovery.browser.key,
      displayName: discovery.browser.displayName,
      executablePath: discovery.browser.executablePath,
      userDataDir: discovery.browser.userDataDir,
    },
    profile: runInputs.profile,
    targetUrl: runInputs.url,
    sourceReport: reportContext?.absolutePath || null,
    detectionRules: runInputs.detectionRules,
    candidates,
    ...result,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(`Diagnosis: ${result.diagnosis.status}`);
  console.log(result.diagnosis.reason);

  if (result.diagnosis.culpritIds.length > 0) {
    console.log("");
    console.log("Likely culprit set:");
    for (const extension of candidates.filter((item) => result.diagnosis.culpritIds.includes(item.id))) {
      console.log(`- ${extension.name} (${extension.id})`);
    }
  }

  console.log("");
  console.log(`Report written to ${reportPath}`);
}

function parseArgs(argv) {
  const args = {
    browser: "",
    profile: "",
    includeAllLocations: false,
    listProfiles: false,
    help: false,
    url: "",
    fromReport: "",
    limit: null,
    outputDir: path.resolve(process.cwd(), "reports"),
    timeoutMs: 25000,
    settleTimeMs: 3500,
    blockPatterns: [],
    successPatterns: [],
    requiredUrlFragments: [],
    extensionIds: [],
    compareProfile: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--browser":
        args.browser = next;
        index += 1;
        break;
      case "--profile":
        args.profile = next;
        index += 1;
        break;
      case "--url":
        args.url = next;
        index += 1;
        break;
      case "--from-report":
        args.fromReport = next;
        index += 1;
        break;
      case "--compare-profile":
        args.compareProfile = next;
        index += 1;
        break;
      case "--limit":
        args.limit = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--output-dir":
        args.outputDir = path.resolve(process.cwd(), next);
        index += 1;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--settle-ms":
        args.settleTimeMs = Number.parseInt(next, 10);
        index += 1;
        break;
      case "--block-pattern":
        args.blockPatterns.push(next);
        index += 1;
        break;
      case "--success-pattern":
        args.successPatterns.push(next);
        index += 1;
        break;
      case "--url-must-contain":
        args.requiredUrlFragments.push(next);
        index += 1;
        break;
      case "--extension-id":
        args.extensionIds.push(next);
        index += 1;
        break;
      case "--include-all-locations":
        args.includeAllLocations = true;
        break;
      case "--list-profiles":
        args.listProfiles = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printProfiles(profiles) {
  if (profiles.length === 0) {
    console.log("No browser profiles found.");
    return;
  }

  for (const profile of profiles) {
    const suffix = profile.email ? ` <${profile.email}>` : "";
    console.log(`${profile.directoryName}: ${profile.name}${suffix}`);
  }
}

function ensureReportDir(reportDir) {
  fs.mkdirSync(reportDir, {
    recursive: true,
  });
  return reportDir;
}

function printHelp() {
  console.log(`Usage:
  extension-crash --url <target-url> [options]

Options:
  --browser <chrome|edge|brave>
  --profile <profile-directory>
  --compare-profile <profile-directory>
  --from-report <report.json>
  --extension-id <id>
  --limit <number>
  --include-all-locations
  --output-dir <directory>
  --timeout-ms <number>
  --settle-ms <number>
  --block-pattern <text>
  --success-pattern <text>
  --url-must-contain <text>
  --list-profiles
  --help
`);
}

function printComparisonHighlights(diff) {
  const highlightLines = [
    formatComparisonLine("Extensions only in primary", diff.extensions.onlyInPrimary),
    formatComparisonLine("Extensions only in compare", diff.extensions.onlyInCompare),
    formatComparisonLine("Enabled only in primary", diff.extensions.enabledOnlyInPrimary),
    formatComparisonLine("Enabled only in compare", diff.extensions.enabledOnlyInCompare),
    formatCountLine("Cookie values changed", diff.cookies.valueChanged.length),
    formatCountLine("Cookies only in primary", diff.cookies.onlyInPrimary.length),
    formatCountLine("Cookies only in compare", diff.cookies.onlyInCompare.length),
    formatCountLine("localStorage values changed", diff.localStorage.valueChanged.length),
    formatCountLine("Service workers only in primary", diff.serviceWorkers.onlyInPrimary.length),
    formatCountLine("Service workers only in compare", diff.serviceWorkers.onlyInCompare.length),
  ].filter(Boolean);

  if (highlightLines.length === 0) {
    return;
  }

  console.log("Highlights:");
  for (const line of highlightLines) {
    console.log(`- ${line}`);
  }
}

function formatComparisonLine(label, items) {
  if (!items || items.length === 0) {
    return "";
  }

  const names = items
    .slice(0, 4)
    .map((item) => item.name || item.id || item.key || String(item))
    .join(", ");
  const suffix = items.length > 4 ? ` (+${items.length - 4} more)` : "";
  return `${label}: ${names}${suffix}`;
}

function formatCountLine(label, count) {
  if (!count) {
    return "";
  }

  return `${label}: ${count}`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
