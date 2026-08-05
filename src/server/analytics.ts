import { listRuns, listRunsFor } from "./store.js";
import { listDocuments } from "../tools/documents.js";
import { DEPARTMENTS } from "../agents.js";

const TREND_DAYS = 14;

function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Aggregates real data from the run store and document store — nothing here
 * is sample/placeholder data. Computed fresh on every request; cheap at the
 * data volumes a single-user local instance accumulates.
 */
export function getAnalytics() {
  const runs = listRuns();
  const documents = listDocuments();

  const totals = {
    totalRuns: runs.length,
    successRuns: runs.filter((r) => r.status === "success").length,
    errorRuns: runs.filter((r) => r.status === "error").length,
    runningRuns: runs.filter((r) => r.status === "running").length,
    totalCostUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    totalDocuments: documents.length,
    totalLinearTasks: runs.reduce((sum, r) => sum + r.linearTasks.length, 0),
  };

  // Last TREND_DAYS calendar days, oldest first, zero-filled for days with no runs.
  const dayBuckets = new Map<string, number>();
  const today = new Date();
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dayBuckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of runs) {
    const day = isoDate(r.createdAt);
    if (dayBuckets.has(day)) dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);
  }
  const runsByDay = [...dayBuckets.entries()].map(([date, count]) => ({ date, count }));

  const runsByDepartment = DEPARTMENTS.map((d) => ({
    key: d.key,
    label: d.label,
    count: listRunsFor(d.key).length,
  }));

  return { totals, runsByDay, runsByDepartment };
}
