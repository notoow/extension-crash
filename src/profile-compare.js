import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { resolveBrowserEnvironment } from "./profile-discovery.js";
import { classifyBlocked } from "./test-runner.js";

const USER_EXTENSION_LOCATIONS = new Set([1, 6]);
const CLONE_SKIP_NAMES = new Set([
  "BrowserMetrics",
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "Media Cache",
  "Sessions",
  "ShaderCache",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);
const CLONE_SKIP_FILES = new Set([
  "Current Session",
  "Current Tabs",
  "Last Session",
  "Last Tabs",
]);

export async function compareProfiles(options) {
  const {
    browser = "chrome",
    primaryProfile,
    compareProfile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs = 25000,
    settleTimeMs = 3500,
    includeAllLocations = false,
  } = options;

  const environment = resolveBrowserEnvironment(browser);
  const primaryExtensions = readProfileExtensions({
    browser,
    profile: primaryProfile,
    includeAllLocations,
  });
  const compareExtensions = readProfileExtensions({
    browser,
    profile: compareProfile,
    includeAllLocations,
  });
  const primarySnapshot = await captureProfileSnapshot({
    environment,
    profile: primaryProfile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
    label: "primary",
  });
  const compareSnapshot = await captureProfileSnapshot({
    environment,
    profile: compareProfile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
    label: "compare",
  });
  const diff = buildComparisonDiff({
    primaryExtensions,
    compareExtensions,
    primarySnapshot,
    compareSnapshot,
  });
  const summary = summarizeComparison({
    primaryProfile,
    compareProfile,
    primarySnapshot,
    compareSnapshot,
    diff,
  });

  return {
    browser: {
      key: environment.key,
      displayName: environment.displayName,
      executablePath: environment.executablePath,
      userDataDir: environment.userDataDir,
    },
    primaryProfile,
    compareProfile,
    targetUrl,
    primarySnapshot,
    compareSnapshot,
    diff,
    summary,
  };
}

export function buildComparisonDiff({ primaryExtensions, compareExtensions, primarySnapshot, compareSnapshot }) {
  return {
    extensions: diffExtensions(primaryExtensions, compareExtensions),
    cookies: diffRecordSets(primarySnapshot.cookies, compareSnapshot.cookies, cookieRecordKey),
    localStorage: diffRecordSets(primarySnapshot.localStorage, compareSnapshot.localStorage, (item) => item.key),
    sessionStorage: diffRecordSets(primarySnapshot.sessionStorage, compareSnapshot.sessionStorage, (item) => item.key),
    indexedDb: diffStringLists(primarySnapshot.indexedDbNames, compareSnapshot.indexedDbNames),
    cacheStorage: diffStringLists(primarySnapshot.cacheStorageNames, compareSnapshot.cacheStorageNames),
    serviceWorkers: diffStringLists(primarySnapshot.serviceWorkerScopes, compareSnapshot.serviceWorkerScopes),
  };
}

export function summarizeComparison({ primaryProfile, compareProfile, primarySnapshot, compareSnapshot, diff }) {
  const primaryBlocked = Boolean(primarySnapshot.blocked);
  const compareBlocked = Boolean(compareSnapshot.blocked);
  const extensionSignals = diff.extensions.enabledOnlyInPrimary.length
    + diff.extensions.enabledOnlyInCompare.length
    + diff.extensions.versionMismatch.length
    + diff.extensions.incognitoMismatch.length;
  const storageSignals = diff.cookies.onlyInPrimary.length
    + diff.cookies.onlyInCompare.length
    + diff.cookies.valueChanged.length
    + diff.localStorage.onlyInPrimary.length
    + diff.localStorage.onlyInCompare.length
    + diff.localStorage.valueChanged.length
    + diff.sessionStorage.onlyInPrimary.length
    + diff.sessionStorage.onlyInCompare.length
    + diff.sessionStorage.valueChanged.length
    + diff.indexedDb.onlyInPrimary.length
    + diff.indexedDb.onlyInCompare.length
    + diff.cacheStorage.onlyInPrimary.length
    + diff.cacheStorage.onlyInCompare.length
    + diff.serviceWorkers.onlyInPrimary.length
    + diff.serviceWorkers.onlyInCompare.length;

  if (primaryBlocked && !compareBlocked) {
    if (storageSignals > 0) {
      return {
        status: "profile-state",
        reason: `Only "${primaryProfile}" failed, and the strongest differences were profile-scoped site data such as cookies, storage, or service workers.`,
        likelyCause: "site-data-or-session",
      };
    }

    if (extensionSignals > 0) {
      return {
        status: "extension-state",
        reason: `Only "${primaryProfile}" failed, and the main differences were enabled extension state or version mismatches versus "${compareProfile}".`,
        likelyCause: "extension-state",
      };
    }

    return {
      status: "runtime-state",
      reason: `Only "${primaryProfile}" failed, but no stable extension or storage delta stood out. The failure is likely tied to transient profile runtime state.`,
      likelyCause: "runtime-state",
    };
  }

  if (!primaryBlocked && compareBlocked) {
    return {
      status: "compare-profile-fails",
      reason: `"${compareProfile}" failed while "${primaryProfile}" loaded successfully during this comparison run.`,
      likelyCause: "reference-profile-failing",
    };
  }

  if (primaryBlocked && compareBlocked) {
    return {
      status: "both-fail",
      reason: "Both profiles failed during comparison, so the issue is not isolated to a single profile state.",
      likelyCause: "shared-environment",
    };
  }

  if (storageSignals > 0 || extensionSignals > 0) {
    return {
      status: "not-reproduced-with-delta",
      reason: "Both profiles loaded successfully, but they still differ in stored site data or extension state.",
      likelyCause: storageSignals >= extensionSignals ? "site-data-delta" : "extension-delta",
    };
  }

  return {
    status: "not-reproduced",
    reason: "Both profiles loaded successfully and no strong profile-specific delta stood out.",
    likelyCause: "no-clear-delta",
  };
}

function readProfileExtensions({ browser, profile, includeAllLocations = false }) {
  const environment = resolveBrowserEnvironment(browser);
  const profileDir = path.join(environment.userDataDir, profile);
  const securePreferencesPath = path.join(profileDir, "Secure Preferences");
  const preferencesPath = path.join(profileDir, "Preferences");
  const extensionState = readJson(securePreferencesPath, true)?.extensions?.settings
    || readJson(preferencesPath, true)?.extensions?.settings
    || {};

  const items = [];
  for (const [id, info] of Object.entries(extensionState)) {
    if (!info?.path || !info?.manifest) {
      continue;
    }

    const location = info.location ?? null;
    if (!includeAllLocations && !USER_EXTENSION_LOCATIONS.has(location)) {
      continue;
    }

    const disableReasons = Array.isArray(info.disable_reasons) ? info.disable_reasons : [];
    items.push({
      id,
      name: localizeManifestName(info.manifest.name),
      version: info.manifest.version || "unknown",
      enabled: disableReasons.length === 0,
      incognitoEnabled: Boolean(info.incognito),
      permissions: info.active_permissions?.api || info.granted_permissions?.api || [],
      location,
    });
  }

  items.sort((left, right) => left.name.localeCompare(right.name));
  return items;
}

async function captureProfileSnapshot(options) {
  const {
    environment,
    profile,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
    label,
  } = options;

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tempRoot = path.join(os.tmpdir(), `extension-crash-profile-compare-${runId}`);
  const cloneInfo = cloneProfileForLaunch({
    userDataDir: environment.userDataDir,
    profile,
    tempRoot,
  });
  const args = [
    `--user-data-dir=${tempRoot}`,
    `--profile-directory=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=OptimizationHints,MediaRouter",
    "--disable-blink-features=AutomationControlled",
    "--lang=ko-KR",
    "--remote-debugging-port=0",
    "--new-window",
    targetUrl,
  ];
  const chromeProcess = spawn(environment.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  let browser;
  try {
    const wsEndpoint = await waitForDevToolsEndpoint({
      chromeProcess,
      userDataDir: tempRoot,
      timeoutMs,
    });
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: {
        width: 1440,
        height: 960,
      },
    });
    const snapshot = await inspectPageState({
      browser,
      targetUrl,
      timeoutMs,
      settleTimeMs,
    });
    const screenshotPath = path.join(reportDir, `${label}-${runId}.png`);
    await snapshot.page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    const blocked = classifyBlocked({
      responseStatus: snapshot.responseStatus,
      title: snapshot.title,
      bodyTextSample: snapshot.bodyTextSample,
      finalUrl: snapshot.finalUrl,
      navigationError: snapshot.navigationError,
      detectionRules,
    });

    return {
      profile,
      blocked,
      finalUrl: snapshot.finalUrl,
      title: snapshot.title,
      bodyTextSample: snapshot.bodyTextSample,
      navigationError: snapshot.navigationError,
      responseStatus: snapshot.responseStatus,
      screenshotPath,
      userAgent: snapshot.userAgent,
      cookies: snapshot.cookies,
      localStorage: snapshot.localStorage,
      sessionStorage: snapshot.sessionStorage,
      indexedDbNames: snapshot.indexedDbNames,
      cacheStorageNames: snapshot.cacheStorageNames,
      serviceWorkerScopes: snapshot.serviceWorkerScopes,
      cloneSkippedPaths: cloneInfo.skippedPaths,
      cloneWarnings: cloneInfo.warnings,
    };
  } finally {
    await closeBrowser(browser);
    await terminateProcess(chromeProcess);
    await safeRemoveDirectory(tempRoot);
  }
}

function cloneProfileForLaunch({ userDataDir, profile, tempRoot }) {
  const skippedPaths = [];
  const warnings = [];
  fs.mkdirSync(tempRoot, { recursive: true });

  for (const rootFile of ["Local State", "First Run"]) {
    const sourcePath = path.join(userDataDir, rootFile);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const targetPath = path.join(tempRoot, rootFile);
    try {
      fs.copyFileSync(sourcePath, targetPath);
    } catch (error) {
      skippedPaths.push(sourcePath);
      warnings.push(describeCopyWarning(sourcePath, error));
    }
  }

  copyTree({
    sourceRoot: path.join(userDataDir, profile),
    targetRoot: path.join(tempRoot, profile),
    skippedPaths,
    warnings,
  });

  return {
    skippedPaths,
    warnings,
  };
}

function copyTree({ sourceRoot, targetRoot, skippedPaths, warnings }) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (CLONE_SKIP_NAMES.has(entry.name) || CLONE_SKIP_FILES.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    try {
      if (entry.isDirectory()) {
        copyTree({
          sourceRoot: sourcePath,
          targetRoot: targetPath,
          skippedPaths,
          warnings,
        });
      } else if (entry.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    } catch (error) {
      skippedPaths.push(sourcePath);
      warnings.push(describeCopyWarning(sourcePath, error));
    }
  }
}

async function inspectPageState({ browser, targetUrl, timeoutMs, settleTimeMs }) {
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes(extractHost(targetUrl))) || pages[0] || await browser.newPage();
  await page.setDefaultNavigationTimeout(timeoutMs);

  let response = null;
  let navigationError = null;
  try {
    response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  await wait(settleTimeMs);

  const client = await page.target().createCDPSession();
  const cookies = await readCookies(client, targetUrl);
  const state = await readPageStateWithRetry(page);

  return {
    page,
    title: state.title,
    bodyTextSample: state.bodyTextSample,
    finalUrl: state.finalUrl,
    responseStatus: response?.status() ?? null,
    navigationError,
    userAgent: state.userAgent,
    cookies,
    localStorage: normalizeStorageEntries(state.localStorageEntries),
    sessionStorage: normalizeStorageEntries(state.sessionStorageEntries),
    indexedDbNames: uniqueStrings(state.indexedDbNames),
    cacheStorageNames: uniqueStrings(state.cacheStorageNames),
    serviceWorkerScopes: uniqueStrings(state.serviceWorkerScopes),
  };
}

async function readCookies(client, targetUrl) {
  try {
    const cookieResult = await client.send("Network.getCookies", {
      urls: [targetUrl],
    });
    return normalizeCookies(cookieResult.cookies || []);
  } catch {
    return [];
  }
}

async function readPageStateWithRetry(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await page.evaluate(async () => {
        const safeEntries = (storage) => {
          try {
            return Object.entries(storage).map(([key, value]) => ({ key, value }));
          } catch {
            return [];
          }
        };
        const safeCacheNames = async () => {
          try {
            return typeof caches !== "undefined" ? await caches.keys() : [];
          } catch {
            return [];
          }
        };
        const safeServiceWorkers = async () => {
          try {
            if (!navigator.serviceWorker) {
              return [];
            }
            const registrations = await navigator.serviceWorker.getRegistrations();
            return registrations.map((registration) => registration.scope).filter(Boolean);
          } catch {
            return [];
          }
        };
        const safeIndexedDbNames = async () => {
          try {
            if (typeof indexedDB.databases !== "function") {
              return [];
            }
            const databases = await indexedDB.databases();
            return databases.map((database) => database.name).filter(Boolean);
          } catch {
            return [];
          }
        };

        return {
          title: document.title || "",
          bodyTextSample: (document.body?.innerText || "").slice(0, 4000),
          finalUrl: location.href,
          userAgent: navigator.userAgent,
          localStorageEntries: safeEntries(localStorage),
          sessionStorageEntries: safeEntries(sessionStorage),
          cacheStorageNames: await safeCacheNames(),
          serviceWorkerScopes: await safeServiceWorkers(),
          indexedDbNames: await safeIndexedDbNames(),
        };
      });
    } catch (error) {
      if (!isExecutionContextReset(error) || attempt === 5) {
        throw error;
      }
      await wait(500 * (attempt + 1));
    }
  }
}

function isExecutionContextReset(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed")
    || message.includes("Cannot find context with specified id")
    || message.includes("Target closed");
}

function diffExtensions(primaryExtensions, compareExtensions) {
  const primaryById = new Map(primaryExtensions.map((item) => [item.id, item]));
  const compareById = new Map(compareExtensions.map((item) => [item.id, item]));
  const onlyInPrimary = [];
  const onlyInCompare = [];
  const enabledOnlyInPrimary = [];
  const enabledOnlyInCompare = [];
  const versionMismatch = [];
  const incognitoMismatch = [];

  for (const [id, item] of primaryById.entries()) {
    const other = compareById.get(id);
    if (!other) {
      onlyInPrimary.push(item);
      continue;
    }

    if (item.enabled !== other.enabled) {
      if (item.enabled) {
        enabledOnlyInPrimary.push({
          id,
          name: item.name,
          primaryEnabled: item.enabled,
          compareEnabled: other.enabled,
        });
      } else {
        enabledOnlyInCompare.push({
          id,
          name: item.name,
          primaryEnabled: item.enabled,
          compareEnabled: other.enabled,
        });
      }
    }

    if (item.version !== other.version) {
      versionMismatch.push({
        id,
        name: item.name,
        primaryVersion: item.version,
        compareVersion: other.version,
      });
    }

    if (item.incognitoEnabled !== other.incognitoEnabled) {
      incognitoMismatch.push({
        id,
        name: item.name,
        primaryIncognitoEnabled: item.incognitoEnabled,
        compareIncognitoEnabled: other.incognitoEnabled,
      });
    }
  }

  for (const [id, item] of compareById.entries()) {
    if (!primaryById.has(id)) {
      onlyInCompare.push(item);
    }
  }

  return {
    onlyInPrimary: sortByName(onlyInPrimary),
    onlyInCompare: sortByName(onlyInCompare),
    enabledOnlyInPrimary: sortByName(enabledOnlyInPrimary),
    enabledOnlyInCompare: sortByName(enabledOnlyInCompare),
    versionMismatch: sortByName(versionMismatch),
    incognitoMismatch: sortByName(incognitoMismatch),
  };
}

function diffRecordSets(primaryItems, compareItems, keySelector) {
  const primaryByKey = new Map(primaryItems.map((item) => [keySelector(item), item]));
  const compareByKey = new Map(compareItems.map((item) => [keySelector(item), item]));
  const onlyInPrimary = [];
  const onlyInCompare = [];
  const valueChanged = [];

  for (const [key, item] of primaryByKey.entries()) {
    const other = compareByKey.get(key);
    if (!other) {
      onlyInPrimary.push(item);
      continue;
    }

    if (recordFingerprint(item) !== recordFingerprint(other)) {
      valueChanged.push({
        key,
        primary: item,
        compare: other,
      });
    }
  }

  for (const [key, item] of compareByKey.entries()) {
    if (!primaryByKey.has(key)) {
      onlyInCompare.push(item);
    }
  }

  return {
    onlyInPrimary,
    onlyInCompare,
    valueChanged,
  };
}

function diffStringLists(primaryItems, compareItems) {
  const primary = new Set(primaryItems);
  const compare = new Set(compareItems);

  return {
    onlyInPrimary: [...primary].filter((item) => !compare.has(item)).sort(),
    onlyInCompare: [...compare].filter((item) => !primary.has(item)).sort(),
  };
}

function normalizeCookies(cookies) {
  return cookies
    .map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite || "unspecified",
      session: Boolean(cookie.session),
      valueHash: hashValue(cookie.value || ""),
      valueLength: String(cookie.value || "").length,
    }))
    .sort((left, right) => cookieRecordKey(left).localeCompare(cookieRecordKey(right)));
}

function normalizeStorageEntries(entries) {
  return entries
    .map((entry) => ({
      key: entry.key,
      valueHash: hashValue(entry.value || ""),
      valueLength: String(entry.value || "").length,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function normalizePatterns(patterns) {
  return patterns
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(normalizePatterns(values))].sort();
}

function cookieRecordKey(item) {
  return `${item.name}|${item.domain}|${item.path}`;
}

function recordFingerprint(item) {
  return JSON.stringify(item);
}

function hashValue(value) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
}

function localizeManifestName(value) {
  if (typeof value !== "string") {
    return "Unknown extension";
  }

  if (value.startsWith("__MSG_")) {
    return value;
  }

  return value;
}

function sortByName(items) {
  return [...items].sort((left, right) => {
    const leftName = left.name || left.id || "";
    const rightName = right.name || right.id || "";
    return leftName.localeCompare(rightName);
  });
}

function readJson(filePath, optional = false) {
  if (!fs.existsSync(filePath)) {
    if (optional) {
      return null;
    }

    throw new Error(`Missing JSON file: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function describeCopyWarning(sourcePath, error) {
  const code = error?.code || "UNKNOWN";
  return `${code}: ${sourcePath}`;
}

function extractHost(targetUrl) {
  try {
    return new URL(targetUrl).host;
  } catch {
    return targetUrl;
  }
}

async function waitForDevToolsEndpoint({ chromeProcess, userDataDir, timeoutMs }) {
  const stderr = [];
  const stdout = [];
  chromeProcess.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  chromeProcess.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(activePortFile)) {
      const [port, browserPath] = fs.readFileSync(activePortFile, "utf8").trim().split(/\r?\n/);
      if (port && browserPath) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    }

    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chrome exited before DevTools became available.\nSTDOUT:\n${stdout.join("")}\nSTDERR:\n${stderr.join("")}`);
    }

    await wait(250);
  }

  throw new Error(`Timed out waiting for DevTools endpoint.\nSTDOUT:\n${stdout.join("")}\nSTDERR:\n${stderr.join("")}`);
}

async function closeBrowser(browser) {
  if (!browser) {
    return;
  }

  try {
    await browser.close();
  } catch {
    // Ignore shutdown failures.
  }
}

async function terminateProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("exit", () => resolve());
    killer.on("error", () => resolve());
  });
  await waitForExit(child, 3000);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(timeoutMs),
  ]);
}

async function safeRemoveDirectory(targetPath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
      });
      return;
    } catch (error) {
      const code = error?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw error;
      }
      await wait(400 * (attempt + 1));
    }
  }
}
