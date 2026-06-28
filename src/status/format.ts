/**
 * Human-readable duration. Never emit raw milliseconds in status output.
 * 0 → "0s"; <1s → "<n>ms"; <1m → "<n>s"; <1h → "<n>m <n>s"; <1d → "<n>h <n>m"; ≥1d → "<n>d <n>h".
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0s';
  if (ms < 1_000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1_000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) return `${totalHr}h ${totalMin % 60}m`;
  const totalDay = Math.floor(totalHr / 24);
  return `${totalDay}d ${totalHr % 24}h`;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago". `null` → "never". */
export function formatRelativeTime(
  iso: string | null,
  now: number = Date.now(),
): string {
  if (iso === null) return 'never';
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/** "500 B" / "1.5 KB" / "2.3 MB" / "3.0 GB". One decimal place above 1 KB. */
export function formatBytes(n: number): string {
  if (n < 1_024) return `${n} B`;
  if (n < 1_024 * 1_024) return `${(n / 1_024).toFixed(1)} KB`;
  if (n < 1_024 * 1_024 * 1_024)
    return `${(n / (1_024 * 1_024)).toFixed(1)} MB`;
  return `${(n / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`;
}
