#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { discoverExtensions, listProfiles } from "./profile-discovery.js";
import { runDetection } from "./test-runner.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.listProfiles) {
    const profiles = listProfiles(args.browser);
    printProfiles(profiles);
    return;
  }

  if (!args.url) {
    throw new Error("Missing required --url option.");
  }

  const discovery = discoverExtensions({
    browser: args.browser,
    profile: args.profile,
    includeAllLocations: args.includeAllLocations,
    limit: args.limit,
  });

  if (discovery.extensions.length === 0) {
    throw new Error(`No enabled extension candidates were found in profile "${args.profile}".`);
  }

  const reportDir = ensureReportDir(args.outputDir);
  const reportPath = path.join(reportDir, `report-${Date.now()}.json`);

  console.log(`Browser: ${discovery.browser.displayName}`);
  console.log(`Profile: ${args.profile}`);
  console.log(`URL: ${args.url}`);
  console.log(`Candidates: ${discovery.extensions.length}`);
  console.log("");
  console.log("Candidate extensions:");
  for (const extension of discovery.extensions) {
    console.log(`- ${extension.name} (${extension.id})`);
  }
  console.log("");
  console.log("Running diagnostics. Chrome windows may open briefly.");

  const result = await runDetection({
    executablePath: discovery.browser.executablePath,
    browserKey: discovery.browser.key,
    targetUrl: args.url,
    candidates: discovery.extensions,
    reportDir,
    timeoutMs: args.timeoutMs,
    settleTimeMs: args.settleTimeMs,
    detectionRules: {
      blockPatterns: args.blockPatterns,
      successPatterns: args.successPatterns,
      requiredUrlFragments: args.requiredUrlFragments,
    },
  });

  const report = {
    generatedAt: new Date().toISOString(),
    browser: {
      key: discovery.browser.key,
      displayName: discovery.browser.displayName,
      executablePath: discovery.browser.executablePath,
      userDataDir: discovery.browser.userDataDir,
    },
    profile: args.profile,
    targetUrl: args.url,
    detectionRules: {
      blockPatterns: args.blockPatterns,
      successPatterns: args.successPatterns,
      requiredUrlFragments: args.requiredUrlFragments,
    },
    candidates: discovery.extensions,
    ...result,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(`Diagnosis: ${result.diagnosis.status}`);
  console.log(result.diagnosis.reason);

  if (result.diagnosis.culpritIds.length > 0) {
    console.log("");
    console.log("Likely culprit set:");
    for (const extension of discovery.extensions.filter((item) => result.diagnosis.culpritIds.includes(item.id))) {
      console.log(`- ${extension.name} (${extension.id})`);
    }
  }

  console.log("");
  console.log(`Report written to ${reportPath}`);
}

function parseArgs(argv) {
  const args = {
    browser: "chrome",
    profile: "Default",
    includeAllLocations: false,
    listProfiles: false,
    help: false,
    url: "",
    limit: null,
    outputDir: path.resolve(process.cwd(), "reports"),
    timeoutMs: 25000,
    settleTimeMs: 3500,
    blockPatterns: [],
    successPatterns: [],
    requiredUrlFragments: [],
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
