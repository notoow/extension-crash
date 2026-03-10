import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const DEFAULT_BLOCK_PATTERNS = [
  "access denied",
  "request blocked",
  "forbidden",
  "blocked",
  "errors.edgesuite.net",
];

export async function runDetection(options) {
  const {
    executablePath,
    browserKey,
    targetUrl,
    candidates,
    reportDir,
    detectionRules,
    timeoutMs = 25000,
    settleTimeMs = 3500,
  } = options;

  const { execute, tests } = createExecutor({
    executablePath,
    browserKey,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
  });

  const baselineWithoutExtensions = await execute([], "baseline-none");
  const baselineWithAllExtensions = await execute(candidates, "baseline-all");

  const baseline = {
    withoutExtensions: baselineWithoutExtensions,
    withAllExtensions: baselineWithAllExtensions,
  };

  if (baselineWithoutExtensions.blocked) {
    return {
      diagnosis: {
        status: "baseline-fails",
        reason: "The page was already blocked with no extensions loaded, so automated isolation is unreliable.",
        culpritIds: [],
      },
      baseline,
      tests,
    };
  }

  if (!baselineWithAllExtensions.blocked) {
    return {
      diagnosis: {
        status: "not-reproduced",
        reason: "The page loaded successfully even with all candidate extensions enabled.",
        culpritIds: [],
      },
      baseline,
      tests,
    };
  }

  const { minimizeFailureSet } = await import("./delta-debug.js");
  const { minimalItems } = await minimizeFailureSet(candidates, async (subset) => {
    const result = await execute(subset, `ddmin-${subset.length}`);
    return { failed: result.blocked };
  });

  const minimalResult = await execute(minimalItems, `minimal-${minimalItems.length}`);
  const individuallyBlocking = [];

  for (const extension of minimalItems) {
    const result = await execute([extension], `single-${extension.id}`);
    if (result.blocked) {
      individuallyBlocking.push(extension);
    }
  }

  const diagnosis = individuallyBlocking.length > 0
    ? {
        status: "single-extension",
        reason: "At least one extension reproduced the failure on its own.",
        culpritIds: individuallyBlocking.map((item) => item.id),
      }
    : minimalResult.blocked
      ? {
          status: minimalItems.length > 1 ? "interaction" : "inconclusive",
          reason: minimalItems.length > 1
            ? "No single extension failed alone, but a minimal combination still reproduced the failure."
            : "A minimal candidate was found, but confirmation was not definitive.",
          culpritIds: minimalItems.map((item) => item.id),
        }
      : {
          status: "inconclusive",
          reason: "The failure was reproduced initially but did not remain stable during minimization.",
          culpritIds: minimalItems.map((item) => item.id),
        };

  return {
    diagnosis,
    baseline,
    minimalSet: minimalItems,
    tests,
  };
}

export async function runRetest(options) {
  const {
    executablePath,
    browserKey,
    targetUrl,
    candidates,
    reportDir,
    detectionRules,
    timeoutMs = 25000,
    settleTimeMs = 3500,
  } = options;

  const { execute, tests } = createExecutor({
    executablePath,
    browserKey,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
  });

  const baselineWithoutExtensions = await execute([], "baseline-none");
  const suspectSetResult = await execute(candidates, `retest-set-${candidates.length}`);
  const individuallyBlocking = [];

  for (const extension of candidates) {
    const result = await execute([extension], `retest-single-${extension.id}`);
    if (result.blocked) {
      individuallyBlocking.push(extension);
    }
  }

  const baselineNote = baselineWithoutExtensions.blocked
    ? " The page also failed without extensions during retest, so the environment may be unstable."
    : "";
  const diagnosis = individuallyBlocking.length > 0
    ? {
        status: "single-extension",
        reason: `The suspect extension still reproduced the failure on its own.${baselineNote}`,
        culpritIds: individuallyBlocking.map((item) => item.id),
      }
    : suspectSetResult.blocked
      ? {
          status: candidates.length > 1 ? "interaction" : "inconclusive",
          reason: candidates.length > 1
            ? `The suspect set still reproduces the failure, but no single extension failed alone.${baselineNote}`
            : `The single suspect still reproduced the failure, but confirmation stayed ambiguous.${baselineNote}`,
          culpritIds: candidates.map((item) => item.id),
        }
      : baselineWithoutExtensions.blocked
        ? {
            status: "inconclusive",
            reason: "The page failed even without extensions during retest, and the suspect set did not reproduce the original failure consistently.",
            culpritIds: [],
          }
        : {
            status: "not-reproduced",
            reason: "The suspect set did not reproduce the failure during retest.",
            culpritIds: [],
          };

  return {
    diagnosis,
    baseline: {
      withoutExtensions: baselineWithoutExtensions,
      withAllExtensions: suspectSetResult,
    },
    minimalSet: candidates,
    tests,
  };
}

export async function executeBrowserTest(options) {
  const {
    executablePath,
    browserKey,
    targetUrl,
    extensions,
    reportDir,
    timeoutMs,
    settleTimeMs,
    label,
    detectionRules,
  } = options;

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userDataDir = path.join(os.tmpdir(), `extension-crash-${runId}`);
  fs.mkdirSync(userDataDir, {
    recursive: true,
  });
  const extensionPaths = extensions.map((item) => item.absolutePath);
  const args = buildChromeArguments({
    browserKey,
    userDataDir,
    extensionPaths,
  });
  const chromeProcess = spawn(executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  let browser;
  try {
    const wsEndpoint = await waitForDevToolsEndpoint({
      chromeProcess,
      userDataDir,
      timeoutMs,
    });
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: {
        width: 1440,
        height: 960,
      },
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });
    await page.setCacheEnabled(false);
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

    const responseStatus = response?.status() ?? null;
    const pageState = await page.evaluate(() => {
      const title = document.title || "";
      const bodyText = document.body?.innerText || "";
      return {
        title,
        bodyTextSample: bodyText.slice(0, 4000),
        finalUrl: location.href,
      };
    });

    const screenshotPath = path.join(reportDir, `${label}-${runId}.png`);
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    });

    const blocked = classifyBlocked({
      responseStatus,
      title: pageState.title,
      bodyTextSample: pageState.bodyTextSample,
      finalUrl: pageState.finalUrl,
      navigationError,
      detectionRules,
    });

    return {
      label,
      extensionIds: extensions.map((item) => item.id),
      extensionNames: extensions.map((item) => item.name),
      extensionCount: extensions.length,
      blocked,
      responseStatus,
      finalUrl: pageState.finalUrl,
      title: pageState.title,
      bodyTextSample: pageState.bodyTextSample,
      navigationError,
      screenshotPath,
      startedAt: new Date().toISOString(),
    };
  } finally {
    await closeBrowser(browser);
    await terminateProcess(chromeProcess);
    await safeRemoveDirectory(userDataDir);
  }
}

function createExecutor(options) {
  const {
    executablePath,
    browserKey,
    targetUrl,
    reportDir,
    detectionRules,
    timeoutMs,
    settleTimeMs,
  } = options;

  const tests = [];
  const cache = new Map();

  const execute = async (subset, label) => {
    const cacheKey = subset.map((item) => item.id).sort().join(",");
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const result = await executeBrowserTest({
      executablePath,
      browserKey,
      targetUrl,
      extensions: subset,
      timeoutMs,
      settleTimeMs,
      reportDir,
      label,
      detectionRules,
    });

    tests.push(result);
    cache.set(cacheKey, result);
    return result;
  };

  return {
    execute,
    tests,
  };
}

function buildChromeArguments({ browserKey, userDataDir, extensionPaths }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
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
    "about:blank",
  ];

  if (browserKey === "chrome") {
    args.push("--disable-component-update");
  }

  if (extensionPaths.length > 0) {
    const joined = extensionPaths.join(",");
    args.push(`--disable-extensions-except=${joined}`);
    args.push(`--load-extension=${joined}`);
  } else {
    args.push("--disable-extensions");
  }

  return args;
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

export function classifyBlocked({ responseStatus, title, bodyTextSample, finalUrl, navigationError, detectionRules }) {
  if (navigationError) {
    return true;
  }

  const normalized = `${title}\n${bodyTextSample}`.toLowerCase();
  const url = (finalUrl || "").toLowerCase();
  const blockPatterns = normalizePatterns([
    ...DEFAULT_BLOCK_PATTERNS,
    ...(detectionRules?.blockPatterns || []),
  ]);
  const successPatterns = normalizePatterns(detectionRules?.successPatterns || []);
  const requiredUrlFragments = normalizePatterns(detectionRules?.requiredUrlFragments || []);

  if (responseStatus && responseStatus >= 400) {
    return true;
  }

  if (url.startsWith("chrome-error://") || url.startsWith("edge-error://")) {
    return true;
  }

  if (blockPatterns.some((pattern) => normalized.includes(pattern))) {
    return true;
  }

  if (requiredUrlFragments.some((fragment) => !url.includes(fragment))) {
    return true;
  }

  if (successPatterns.length > 0 && successPatterns.some((pattern) => !normalized.includes(pattern))) {
    return true;
  }

  return false;
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

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    await waitForExit(child, 3000);
    return;
  }

  child.kill("SIGTERM");
  await waitForExit(child, 2000);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 1000);
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizePatterns(patterns) {
  return patterns
    .filter(Boolean)
    .map((pattern) => String(pattern).trim().toLowerCase())
    .filter(Boolean);
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
