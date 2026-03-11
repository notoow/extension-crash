import fs from "node:fs";
import path from "node:path";
import { mergeDetectionRules, resolveSiteTemplate } from "./site-templates.js";

export function readDetectionReport(reportPath) {
  const absolutePath = path.resolve(reportPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Report file was not found: ${absolutePath}`);
  }

  return {
    absolutePath,
    report: JSON.parse(fs.readFileSync(absolutePath, "utf8")),
  };
}

export function resolveRunInputs({ args, report }) {
  const url = args.url || report?.targetUrl || "";
  const siteTemplate = resolveSiteTemplate({
    requestedTemplate: args.siteTemplate || report?.siteTemplate?.requested || "",
    url,
  });

  return {
    browser: args.browser || report?.browser?.key || "chrome",
    profile: args.profile || report?.profile || "Default",
    url,
    siteTemplate,
    detectionRules: mergeDetectionRules({
      templateRules: siteTemplate.resolved?.detectionRules,
      reportRules: report?.detectionRules || {},
      argRules: {
        blockPatterns: args.blockPatterns,
        successPatterns: args.successPatterns,
        requiredUrlFragments: args.requiredUrlFragments,
      },
    }),
    selectedExtensionIds: resolveSelectedExtensionIds({ args, report }),
  };
}

function resolveSelectedExtensionIds({ args, report }) {
  if (args.extensionIds.length > 0) {
    return uniqueValues(args.extensionIds);
  }

  if (!report) {
    return null;
  }

  const culpritIds = uniqueValues(report?.diagnosis?.culpritIds || []);
  if (culpritIds.length > 0) {
    return culpritIds;
  }

  const minimalIds = uniqueValues((report?.minimalSet || []).map((item) => item?.id).filter(Boolean));
  if (minimalIds.length > 0) {
    return minimalIds;
  }

  return [];
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}
