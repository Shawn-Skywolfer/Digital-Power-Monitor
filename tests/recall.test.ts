import assert from "node:assert/strict";
import test from "node:test";
import { chooseRecallBaseline, hasSameSourceSet, recallComparison } from "../server/recall";
import type { ResultRecord, ScanRequest } from "../server/types";

const request = (sourceIds: string[]): ScanRequest => ({
  startDate: "2026-07-01", endDate: "2026-08-05", sourceIds, fieldIds: [],
  budget: { maxPages: 100, maxSearches: 0, maxMinutes: 10, maxConcurrency: 3, maxCostUsd: 0 },
});
const result = (id: string, status: ResultRecord["status"], url = `https://example.com/${id}`): ResultRecord => ({
  id, scanId: "old", documentId: id, fields: { project_name: id }, primaryUrl: url,
  candidateUrls: [url], evidence: {}, conflicts: [], score: 80, status, revision: 1,
});

test("same source set ignores order but not missing sources", () => {
  assert.equal(hasSameSourceSet(request(["a", "b"]), request(["b", "a"])), true);
  assert.equal(hasSameSourceSet(request(["a", "b"]), request(["a"])), false);
});

test("recall baseline prefers accepted quality before raw result count", () => {
  const baseline = chooseRecallBaseline(request(["a", "b"]), [
    { id: "many-low", createdAt: "2026-08-05T01:00:00Z", request: request(["a", "b"]), results: [result("1", "rejected"), result("2", "review"), result("3", "review")] },
    { id: "quality", createdAt: "2026-08-04T01:00:00Z", request: request(["b", "a"]), results: [result("4", "auto_approved"), result("5", "approved")] },
    { id: "wrong-sources", createdAt: "2026-08-05T02:00:00Z", request: request(["a"]), results: [result("6", "approved")] },
  ]);
  assert.equal(baseline?.scanId, "quality");
  assert.equal(baseline?.acceptedCount, 2);
  assert.equal(baseline?.urls.length, 2);
});

test("recall comparison flags either total or accepted regression", () => {
  const baseline = {
    scanId: "old", createdAt: "2026-08-04", resultCount: 3, acceptedCount: 2,
    urls: [], results: [result("1", "approved"), result("2", "approved"), result("3", "review")],
  };
  assert.equal(recallComparison([result("new", "approved")], baseline).status, "regressed");
  assert.equal(recallComparison([result("1", "approved"), result("2", "approved"), result("3", "review")], baseline).status, "stable");
  assert.equal(recallComparison([result("1", "approved"), result("2", "approved"), result("3", "review"), result("4", "review")], baseline).status, "improved");
});
