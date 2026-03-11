const SITE_TEMPLATES = [
  {
    name: "coupang",
    description: "Coupang pages that can flip to Akamai-style access denied responses.",
    hostSuffixes: ["coupang.com"],
    detectionRules: {
      blockPatterns: [
        "access denied",
        "reference #",
        "errors.edgesuite.net",
      ],
      successPatterns: [],
      requiredUrlFragments: ["coupang.com"],
    },
  },
  {
    name: "akamai-access-denied",
    description: "Generic Akamai or edgesuite access denied pages.",
    hostSuffixes: [],
    detectionRules: {
      blockPatterns: [
        "access denied",
        "reference #",
        "errors.edgesuite.net",
      ],
      successPatterns: [],
      requiredUrlFragments: [],
    },
  },
  {
    name: "cloudflare-challenge",
    description: "Cloudflare interstitial and browser challenge pages.",
    hostSuffixes: [],
    detectionRules: {
      blockPatterns: [
        "just a moment",
        "checking your browser",
        "attention required!",
        "cf-chl",
      ],
      successPatterns: [],
      requiredUrlFragments: [],
    },
  },
];

export function listSiteTemplates() {
  return SITE_TEMPLATES.map((template) => ({
    name: template.name,
    description: template.description,
    hostSuffixes: template.hostSuffixes,
  }));
}

export function resolveSiteTemplate({ requestedTemplate = "", url = "" }) {
  const normalizedRequest = String(requestedTemplate || "").trim().toLowerCase();

  if (normalizedRequest === "none") {
    return {
      requested: "none",
      resolved: null,
    };
  }

  if (normalizedRequest && normalizedRequest !== "auto") {
    const explicit = SITE_TEMPLATES.find((template) => template.name === normalizedRequest);
    if (!explicit) {
      throw new Error(`Unknown site template "${requestedTemplate}". Use --list-templates to see available names.`);
    }

    return {
      requested: explicit.name,
      resolved: explicit,
    };
  }

  const auto = findTemplateForUrl(url);
  return {
    requested: normalizedRequest || "auto",
    resolved: auto,
  };
}

export function mergeDetectionRules({ templateRules, reportRules, argRules }) {
  return {
    blockPatterns: uniqueValues([
      ...(templateRules?.blockPatterns || []),
      ...(reportRules?.blockPatterns || []),
      ...(argRules?.blockPatterns || []),
    ]),
    successPatterns: uniqueValues([
      ...(templateRules?.successPatterns || []),
      ...(reportRules?.successPatterns || []),
      ...(argRules?.successPatterns || []),
    ]),
    requiredUrlFragments: uniqueValues([
      ...(templateRules?.requiredUrlFragments || []),
      ...(reportRules?.requiredUrlFragments || []),
      ...(argRules?.requiredUrlFragments || []),
    ]),
  };
}

function findTemplateForUrl(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  return SITE_TEMPLATES.find((template) => template.hostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) || null;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}
