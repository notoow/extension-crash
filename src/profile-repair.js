import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { resolveBrowserEnvironment } from "./profile-discovery.js";
import { classifyBlocked } from "./test-runner.js";

const REPAIR_STORAGE_TYPES = "all";
const BACKUP_NOTE = "This backup contains raw site cookies and localStorage values. Treat it as sensitive.";

export async function repairProfileSiteData(options) {
  const {
    browser = "chrome",
    profile,
    targetUrl,
    reportDir,
    detectionRules,
    siteTemplate = null,
    timeoutMs = 25000,
    settleTimeMs = 3500,
  } = options;

  const environment = resolveBrowserEnvironment(browser);
  assertBrowserClosed(environment.executablePath, environment.displayName);

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const args = [
    `--user-data-dir=${environment.userDataDir}`,
    `--profile-directory=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--remote-debugging-port=0",
    "--new-window",
    "about:blank",
  ];
  const chromeProcess = spawn(environment.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  let browserConnection;
  try {
    const wsEndpoint = await waitForDevToolsEndpoint({
      chromeProcess,
      userDataDir: environment.userDataDir,
      timeoutMs,
    });
    browserConnection = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: {
        width: 1440,
        height: 960,
      },
    });

    const page = await getRepairPage(browserConnection);
    const before = await capturePageState({
      page,
      targetUrl,
      timeoutMs,
      settleTimeMs,
      screenshotPath: path.join(reportDir, `repair-before-${runId}.png`),
      detectionRules,
    });
    const repairTargets = deriveRepairTargets(targetUrl, before.finalUrl);
    const backup = await captureBackupState({
      page,
      browser: environment,
      profile,
      targetUrl,
      detectionRules,
      siteTemplate,
      repairTargets,
    });
    const backupPath = writeSiteDataBackup({
      reportDir,
      runId,
      backup,
    });
    const repair = await clearSiteData({
      page,
      targetUrls: repairTargets.urls,
      targetOrigins: repairTargets.origins,
    });
    const after = await capturePageState({
      page,
      targetUrl,
      timeoutMs,
      settleTimeMs,
      screenshotPath: path.join(reportDir, `repair-after-${runId}.png`),
      detectionRules,
    });

    return {
      browser: {
        key: environment.key,
        displayName: environment.displayName,
        executablePath: environment.executablePath,
        userDataDir: environment.userDataDir,
      },
      profile,
      targetUrl,
      repair: {
        storageTypes: REPAIR_STORAGE_TYPES,
        origins: repairTargets.origins,
        urls: repairTargets.urls,
        deletedCookieCount: repair.deletedCookies.length,
        deletedCookies: repair.deletedCookies,
        backupPath,
        backupCookieCount: backup.cookies.length,
        backupLocalStorageItemCount: backup.localStorage.length,
        backupSessionStorageItemCount: backup.sessionStorage.length,
      },
      before,
      after,
      diagnosis: summarizeRepairResult({
        beforeBlocked: before.blocked,
        afterBlocked: after.blocked,
      }),
    };
  } finally {
    await closeBrowser(browserConnection);
    await terminateProcess(chromeProcess);
  }
}

export function deriveRepairTargets(targetUrl, finalUrl = "") {
  const urls = [...new Set([targetUrl, finalUrl].filter(Boolean))];
  const origins = [...new Set(urls.map((item) => {
    try {
      return new URL(item).origin;
    } catch {
      return "";
    }
  }).filter(Boolean))];

  return {
    urls,
    origins,
  };
}

export function summarizeRepairResult({ beforeBlocked, afterBlocked }) {
  if (beforeBlocked && !afterBlocked) {
    return {
      status: "repair-succeeded",
      reason: "The page was blocked before the cleanup and loaded successfully after the site data reset.",
    };
  }

  if (beforeBlocked && afterBlocked) {
    return {
      status: "repair-not-effective",
      reason: "The page was still blocked after clearing the target site's profile data.",
    };
  }

  if (!beforeBlocked && afterBlocked) {
    return {
      status: "repair-regressed",
      reason: "The page loaded before cleanup but failed after the site data reset.",
    };
  }

  return {
    status: "already-healthy",
    reason: "The page loaded both before and after the site data reset.",
  };
}

export async function restoreProfileSiteData(options) {
  const {
    backupPath,
    reportDir,
    detectionRules,
    timeoutMs = 25000,
    settleTimeMs = 3500,
  } = options;

  const backupContext = readSiteDataBackup(backupPath);
  const backup = backupContext.backup;
  const environment = resolveBrowserEnvironment(backup.browser?.key || "chrome");
  assertBrowserClosed(environment.executablePath, environment.displayName);

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const args = [
    `--user-data-dir=${environment.userDataDir}`,
    `--profile-directory=${backup.profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--remote-debugging-port=0",
    "--new-window",
    "about:blank",
  ];
  const chromeProcess = spawn(environment.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  let browserConnection;
  try {
    const wsEndpoint = await waitForDevToolsEndpoint({
      chromeProcess,
      userDataDir: environment.userDataDir,
      timeoutMs,
    });
    browserConnection = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: {
        width: 1440,
        height: 960,
      },
    });

    const page = await getRepairPage(browserConnection);
    const before = await capturePageState({
      page,
      targetUrl: backup.targetUrl,
      timeoutMs,
      settleTimeMs,
      screenshotPath: path.join(reportDir, `restore-before-${runId}.png`),
      detectionRules,
    });
    await clearSiteData({
      page,
      targetUrls: backup.urls || [backup.targetUrl],
      targetOrigins: backup.origins || deriveRepairTargets(backup.targetUrl, backup.finalUrl).origins,
    });
    const restore = await restoreSiteData({
      page,
      backup,
      targetUrl: backup.targetUrl,
      timeoutMs,
    });
    const after = await capturePageState({
      page,
      targetUrl: backup.targetUrl,
      timeoutMs,
      settleTimeMs,
      screenshotPath: path.join(reportDir, `restore-after-${runId}.png`),
      detectionRules,
    });

    return {
      browser: {
        key: environment.key,
        displayName: environment.displayName,
        executablePath: environment.executablePath,
        userDataDir: environment.userDataDir,
      },
      profile: backup.profile,
      targetUrl: backup.targetUrl,
      restore: {
        backupPath: backupContext.absolutePath,
        restoredCookieCount: restore.restoredCookieCount,
        restoredLocalStorageItemCount: restore.restoredLocalStorageItemCount,
        skippedSessionStorageItemCount: restore.skippedSessionStorageItemCount,
      },
      before,
      after,
      diagnosis: summarizeRestoreResult({
        restoredCookieCount: restore.restoredCookieCount,
        restoredLocalStorageItemCount: restore.restoredLocalStorageItemCount,
        afterBlocked: after.blocked,
      }),
    };
  } finally {
    await closeBrowser(browserConnection);
    await terminateProcess(chromeProcess);
  }
}

export function summarizeRestoreResult({ restoredCookieCount, restoredLocalStorageItemCount, afterBlocked }) {
  if (restoredCookieCount === 0 && restoredLocalStorageItemCount === 0) {
    return {
      status: "nothing-restored",
      reason: "The backup did not contain cookies or localStorage entries to restore.",
    };
  }

  if (afterBlocked) {
    return {
      status: "restore-applied-but-still-blocked",
      reason: "The backup was restored, but the page is still blocked in the current profile state.",
    };
  }

  return {
    status: "restore-applied",
    reason: "The backup was restored and the page loaded after restoration.",
  };
}

export function readSiteDataBackup(backupPath) {
  const absolutePath = path.resolve(backupPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Backup file was not found: ${absolutePath}`);
  }

  return {
    absolutePath,
    backup: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
  };
}

function assertBrowserClosed(executablePath, displayName) {
  const processName = path.basename(executablePath);
  const result = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });

  const output = result.stdout || "";
  const isRunning = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.startsWith("INFO:"));

  if (isRunning) {
    throw new Error(`Close all ${displayName} windows before running --repair-site-data. This command modifies the real profile state.`);
  }
}

async function getRepairPage(browserConnection) {
  const pages = await browserConnection.pages();
  return pages[0] || browserConnection.newPage();
}

async function captureBackupState({ page, browser, profile, targetUrl, detectionRules, siteTemplate, repairTargets }) {
  const detailedCookies = await readDetailedCookies(page, repairTargets.urls);
  const state = await readPageStateWithRetry(page, {
    includeSensitiveValues: true,
  });

  return {
    generatedAt: new Date().toISOString(),
    mode: "site-data-backup",
    note: BACKUP_NOTE,
    browser: {
      key: browser.key,
      displayName: browser.displayName,
    },
    profile,
    targetUrl,
    finalUrl: state.finalUrl,
    siteTemplate,
    detectionRules,
    urls: repairTargets.urls,
    origins: repairTargets.origins,
    cookies: detailedCookies,
    localStorage: attachOriginToEntries(state.localStorage, state.finalUrl),
    sessionStorage: attachOriginToEntries(state.sessionStorage, state.finalUrl),
  };
}

async function capturePageState({ page, targetUrl, timeoutMs, settleTimeMs, screenshotPath, detectionRules }) {
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

  const cookies = await readCookies(page, targetUrl);
  const state = await readPageStateWithRetry(page);

  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  const blocked = classifyBlocked({
    responseStatus: response?.status() ?? null,
    title: state.title,
    bodyTextSample: state.bodyTextSample,
    finalUrl: state.finalUrl,
    navigationError,
    detectionRules,
  });

  return {
    blocked,
    responseStatus: response?.status() ?? null,
    navigationError,
    finalUrl: state.finalUrl,
    title: state.title,
    bodyTextSample: state.bodyTextSample,
    userAgent: state.userAgent,
    cookies,
    localStorage: state.localStorage,
    sessionStorage: state.sessionStorage,
    indexedDbNames: state.indexedDbNames,
    cacheStorageNames: state.cacheStorageNames,
    serviceWorkerScopes: state.serviceWorkerScopes,
    screenshotPath,
  };
}

function writeSiteDataBackup({ reportDir, runId, backup }) {
  const backupPath = path.join(reportDir, `site-data-backup-${runId}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  return backupPath;
}

async function clearSiteData({ page, targetUrls, targetOrigins }) {
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  const cookieResult = await client.send("Network.getCookies", {
    urls: targetUrls,
  });
  const deletedCookies = [];

  for (const cookie of cookieResult.cookies || []) {
    try {
      await client.send("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        partitionKey: cookie.partitionKey,
      });
      deletedCookies.push({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      });
    } catch {
      // Ignore cookies Chrome declines to delete individually.
    }
  }

  for (const origin of targetOrigins) {
    try {
      await client.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: REPAIR_STORAGE_TYPES,
      });
    } catch {
      // Ignore storage buckets the browser does not expose for this origin.
    }
  }

  return {
    deletedCookies,
  };
}

async function restoreSiteData({ page, backup, targetUrl, timeoutMs }) {
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  let restoredCookieCount = 0;
  for (const cookie of backup.cookies || []) {
    const success = await setCookie(client, cookie, targetUrl);
    if (success) {
      restoredCookieCount += 1;
    }
  }

  const localStorageByOrigin = groupEntriesByOrigin(backup.localStorage || []);
  let restoredLocalStorageItemCount = 0;
  for (const [origin, entries] of localStorageByOrigin.entries()) {
    try {
      await page.goto(origin, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      const restored = await page.evaluate((items) => {
        localStorage.clear();
        let count = 0;
        for (const item of items) {
          localStorage.setItem(item.key, item.value);
          count += 1;
        }
        return count;
      }, entries);
      restoredLocalStorageItemCount += restored;
    } catch {
      // Ignore origins the browser cannot open directly.
    }
  }

  return {
    restoredCookieCount,
    restoredLocalStorageItemCount,
    skippedSessionStorageItemCount: Array.isArray(backup.sessionStorage) ? backup.sessionStorage.length : 0,
  };
}

async function readCookies(page, targetUrl) {
  const client = await page.target().createCDPSession();
  try {
    const cookieResult = await client.send("Network.getCookies", {
      urls: [targetUrl],
    });
    return (cookieResult.cookies || [])
      .map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      }))
      .sort((left, right) => `${left.name}|${left.domain}|${left.path}`.localeCompare(`${right.name}|${right.domain}|${right.path}`));
  } catch {
    return [];
  }
}

async function readDetailedCookies(page, targetUrls) {
  const client = await page.target().createCDPSession();
  try {
    const cookieResult = await client.send("Network.getCookies", {
      urls: targetUrls,
    });
    return (cookieResult.cookies || [])
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite,
        expires: typeof cookie.expires === "number" ? cookie.expires : undefined,
        partitionKey: cookie.partitionKey,
      }))
      .sort((left, right) => `${left.name}|${left.domain}|${left.path}`.localeCompare(`${right.name}|${right.domain}|${right.path}`));
  } catch {
    return [];
  }
}

async function readPageStateWithRetry(page, options = {}) {
  const {
    includeSensitiveValues = false,
  } = options;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await page.evaluate(async ({ includeValues }) => {
        const safeEntries = (storage) => {
          try {
            return Object.entries(storage).map(([key, value]) => includeValues
              ? { key, value: String(value ?? "") }
              : { key, valueLength: String(value || "").length });
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
          localStorage: safeEntries(localStorage),
          sessionStorage: safeEntries(sessionStorage),
          cacheStorageNames: await safeCacheNames(),
          serviceWorkerScopes: await safeServiceWorkers(),
          indexedDbNames: await safeIndexedDbNames(),
        };
      }, {
        includeValues: includeSensitiveValues,
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

function attachOriginToEntries(entries, finalUrl) {
  const origin = safeOrigin(finalUrl);
  return entries.map((entry) => ({
    origin,
    ...entry,
  }));
}

function groupEntriesByOrigin(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const origin = entry.origin || "";
    const bucket = grouped.get(origin) || [];
    bucket.push({
      key: entry.key,
      value: entry.value,
    });
    grouped.set(origin, bucket);
  }
  return grouped;
}

async function setCookie(client, cookie, targetUrl) {
  try {
    const response = await client.send("Network.setCookie", {
      name: cookie.name,
      value: cookie.value,
      url: buildCookieUrl(cookie, targetUrl),
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires,
      partitionKey: cookie.partitionKey,
    });
    return Boolean(response?.success);
  } catch {
    return false;
  }
}

function buildCookieUrl(cookie, targetUrl) {
  try {
    const target = new URL(targetUrl);
    const host = String(cookie.domain || target.hostname).replace(/^\./, "");
    const protocol = cookie.secure ? "https:" : (target.protocol || "https:");
    return `${protocol}//${host}${cookie.path || "/"}`;
  } catch {
    return targetUrl;
  }
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
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

async function closeBrowser(browserConnection) {
  if (!browserConnection) {
    return;
  }

  try {
    await browserConnection.close();
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
