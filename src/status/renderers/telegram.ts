import { formatClock } from '../../timezone.js';
import type { StatusContribution } from '../types.js';

const TELEGRAM_MAX_CHARS = 4096;

export function renderTelegramStatus(
  contributions: StatusContribution[],
  now: Date,
  tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const stamp = formatClock(now, tz);
  const header = `📊 NANOCLAW STATUS · Updated ${stamp} (${tz})`;
  const sections = contributions.map((c) => {
    const lines = [c.title];
    if (c.warn) lines.push(`  ⚠️ ${c.warn}`);
    for (const row of c.rows) {
      lines.push(`  ${row.label.padEnd(18)} ${row.value}`);
    }
    return lines.join('\n');
  });
  const full = [header, '', ...sections].join('\n\n');
  if (full.length <= TELEGRAM_MAX_CHARS) return full;
  return full.slice(0, TELEGRAM_MAX_CHARS - 1) + '…';
}
