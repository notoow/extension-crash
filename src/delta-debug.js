import { chunkCandidates } from "./profile-discovery.js";

export async function minimizeFailureSet(items, testSubset) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      minimalItems: [],
      testsRun: 0,
    };
  }

  let current = [...items];
  let granularity = 2;
  let testsRun = 0;

  while (current.length >= 2) {
    const subsets = chunkCandidates(current, granularity);
    let reduced = false;

    for (const subset of subsets) {
      testsRun += 1;
      const outcome = await testSubset(subset);
      if (outcome.failed) {
        current = subset;
        granularity = 2;
        reduced = true;
        break;
      }
    }

    if (reduced) {
      continue;
    }

    for (const subset of subsets) {
      const complement = current.filter((item) => !subset.includes(item));
      if (complement.length === 0) {
        continue;
      }

      testsRun += 1;
      const outcome = await testSubset(complement);
      if (outcome.failed) {
        current = complement;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }

    if (reduced) {
      continue;
    }

    if (granularity >= current.length) {
      break;
    }

    granularity = Math.min(current.length, granularity * 2);
  }

  return {
    minimalItems: current,
    testsRun,
  };
}
