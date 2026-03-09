import fs from "node:fs";
import path from "node:path";
import { getBrowserConfig } from "./browser-config.js";

const USER_EXTENSION_LOCATIONS = new Set([1, 6]);

export function resolveBrowserEnvironment(browserKey = "chrome") {
  const config = getBrowserConfig(browserKey);
  const executablePath = config.executableCandidates.find((candidate) => fs.existsSync(candidate));

  if (!executablePath) {
    throw new Error(`Could not find ${config.displayName}. Checked: ${config.executableCandidates.join(", ")}`);
  }

  if (!fs.existsSync(config.userDataDir)) {
    throw new Error(`Could not find user data directory for ${config.displayName}: ${config.userDataDir}`);
  }

  return {
    ...config,
    executablePath,
  };
}

export function listProfiles(browserKey = "chrome") {
  const environment = resolveBrowserEnvironment(browserKey);
  const localStatePath = path.join(environment.userDataDir, "Local State");
  const localState = readJson(localStatePath, true);
  const infoCache = localState?.profile?.info_cache || {};

  return Object.entries(infoCache)
    .map(([directoryName, info]) => ({
      directoryName,
      name: info?.name || directoryName,
      email: info?.user_name || null,
      isManaged: Boolean(info?.is_managed),
      lastActiveUnix: info?.active_time || null,
    }))
    .sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

export function discoverExtensions(options = {}) {
  const {
    browser = "chrome",
    profile = "Default",
    includeAllLocations = false,
    limit = null,
  } = options;

  const environment = resolveBrowserEnvironment(browser);
  const profileDir = path.join(environment.userDataDir, profile);
  const securePreferencesPath = path.join(profileDir, "Secure Preferences");
  const preferencesPath = path.join(profileDir, "Preferences");
  const extensionState = readJson(securePreferencesPath, true)?.extensions?.settings
    || readJson(preferencesPath, true)?.extensions?.settings
    || {};
  const extensionsRoot = path.join(profileDir, "Extensions");

  if (!fs.existsSync(profileDir)) {
    throw new Error(`Chrome profile "${profile}" was not found at ${profileDir}`);
  }

  const catalog = [];

  for (const [id, info] of Object.entries(extensionState)) {
    if (!info?.path || !info?.manifest) {
      continue;
    }

    const location = info.location ?? null;
    if (!includeAllLocations && !USER_EXTENSION_LOCATIONS.has(location)) {
      continue;
    }

    const disableReasons = Array.isArray(info.disable_reasons) ? info.disable_reasons : [];
    const enabled = disableReasons.length === 0;
    if (!enabled) {
      continue;
    }

    const absolutePath = path.isAbsolute(info.path) ? info.path : path.join(extensionsRoot, info.path);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    catalog.push({
      id,
      name: localizeManifestName(info.manifest.name),
      version: info.manifest.version || "unknown",
      description: localizeManifestName(info.manifest.description || ""),
      location,
      enabled,
      fromWebStore: Boolean(info.from_webstore),
      absolutePath,
      rawPath: info.path,
      disableReasons,
      permissions: info.active_permissions?.api || info.granted_permissions?.api || [],
    });
  }

  catalog.sort((left, right) => left.name.localeCompare(right.name));

  return {
    browser: environment,
    profile,
    profileDir,
    securePreferencesPath: fs.existsSync(securePreferencesPath) ? securePreferencesPath : null,
    preferencesPath: fs.existsSync(preferencesPath) ? preferencesPath : null,
    extensionsRoot,
    extensions: typeof limit === "number" ? catalog.slice(0, limit) : catalog,
    totalDiscovered: catalog.length,
  };
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

function readJson(filePath, optional = false) {
  if (!fs.existsSync(filePath)) {
    if (optional) {
      return null;
    }

    throw new Error(`Missing JSON file: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function chunkCandidates(items, parts) {
  const chunkSize = Math.ceil(items.length / parts);
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}
