type RetentionCandidate = { name: string; kind: string; createdAt: string };

/** Safety snapshots (pre-update, pre-settings, pre-restore) are kept separately so they can't evict scheduled history. */
export const SAFETY_SNAPSHOTS_KEPT = 5;

export function retentionGroup(kind: string) {
  if (kind.startsWith("pre-")) return "safety";
  if (kind === "scheduled") return "scheduled";
  return "manual";
}

/** Returns the snapshots to forget: each group keeps its newest entries independently. */
export function snapshotsToForget<T extends RetentionCandidate>(snapshots: T[], retention: number): T[] {
  const groups = new Map<string, T[]>();
  for (const snapshot of snapshots) {
    const group = retentionGroup(snapshot.kind);
    groups.set(group, [...(groups.get(group) || []), snapshot]);
  }
  const forget: T[] = [];
  for (const [group, items] of groups) {
    const keep = group === "safety" ? SAFETY_SNAPSHOTS_KEPT : retention;
    const newestFirst = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    forget.push(...newestFirst.slice(Math.max(keep, 1)));
  }
  return forget;
}
