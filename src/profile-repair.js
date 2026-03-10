import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";
import { resolveBrowserEnvironment } from "./profile-discovery.js";
import { classifyBlocked } from "./test-runner.js";

const REPAIR_STORAGE_TYPES = "all";

export async function repairProfileSiteData(options) {
  const {
    browser = "chrome",
    profile,
    targetUrl,
    reportDir,
    detectionRules,
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

async function readPageStateWithRetry(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await page.evaluate(async () => {
        const safeEntries = (storage) => {
          try {
            return Object.entries(storage).map(([key, value]) => ({ key, valueLength: String(value || "").length }));
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
