import type { ResultRecord, ScanRequest } from "./types";

export type ComparableScan = {
  id: string;
  createdAt: string;
  request: ScanRequest;
  results: ResultRecord[];
};

export type RecallBaseline = {
  scanId: string;
  createdAt: string;
  resultCount: number;
  acceptedCount: number;
  urls: string[];
  results: ResultRecord[];
};

const acceptedStatuses = new Set(["approved", "auto_approved"]);

function normalizedSet(values: string[] | undefined) {
  return [...new Set(values ?? [])].sort();
}

export function hasSameSourceSet(left: ScanRequest, right: ScanRequest) {
  const leftIds = normalizedSet(left.sourceIds);
  const rightIds = normalizedSet(right.sourceIds);
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export function chooseRecallBaseline(current: ScanRequest, candidates: ComparableScan[]): RecallBaseline | null {
  if (current.referenceRows?.length) return null;
  const comparable = candidates
    .filter((candidate) => candidate.request.startDate === current.startDate &&
      candidate.request.endDate === current.endDate && hasSameSourceSet(candidate.request, current))
    .map((candidate) => ({
      ...candidate,
      acceptedCount: candidate.results.filter((result) => acceptedStatuses.has(result.status)).length,
    }))
    .filter((candidate) => candidate.results.length > 0)
    .sort((left, right) => right.acceptedCount - left.acceptedCount ||
      right.results.length - left.results.length || right.createdAt.localeCompare(left.createdAt));
  const best = comparable[0];
  if (!best) return null;
  const urls = [...new Set(best.results.flatMap((result) => [result.primaryUrl, ...result.candidateUrls])
    .filter((url) => /^https?:\/\//i.test(url)))];
  return {
    scanId: best.id,
    createdAt: best.createdAt,
    resultCount: best.results.length,
    acceptedCount: best.acceptedCount,
    urls,
    results: best.results,
  };
}

export function recallComparison(currentResults: ResultRecord[], baseline: RecallBaseline | null) {
  const resultCount = currentResults.length;
  const acceptedCount = currentResults.filter((result) => acceptedStatuses.has(result.status)).length;
  if (!baseline) return { status: "no_baseline", resultCount, acceptedCount };
  const status = resultCount < baseline.resultCount || acceptedCount < baseline.acceptedCount
    ? "regressed"
    : resultCount > baseline.resultCount || acceptedCount > baseline.acceptedCount
      ? "improved"
      : "stable";
  return {
    status,
    resultCount,
    acceptedCount,
    baselineScanId: baseline.scanId,
    baselineResultCount: baseline.resultCount,
    baselineAcceptedCount: baseline.acceptedCount,
  };
}
