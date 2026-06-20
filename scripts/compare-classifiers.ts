/**
 * One-off comparison harness: run a sample of emails through the
 * prompt-injection classifier with two different Ollama models
 * and emit a markdown report grouped by agreement/disagreement.
 *
 * Usage:
 *   npx tsx scripts/compare-classifiers.ts <sample.json> [model-a] [model-b]
 *
 * Defaults: model-a=gemma4:26b, model-b=gemma4:e4b.
 *
 * Sample file shape:
 *   { "emails": [ { "id": str, "from": str, "subject": str, "body": str, "label"?: str }, ... ] }
 *
 * Notes:
 *  - Calls classifyEmail with dryRun: true so the live quarantine log
 *    is not polluted.
 *  - All Ollama traffic routes through OLLAMA_HOST (the proxy in
 *    normal config) so model swaps are serialized automatically.
 */
import fs from 'fs';

import {
  classifyEmail,
  sanitizeEmail,
  type ClassificationResult,
} from '../src/email-classifier.js';

interface RawEmail {
  id: string;
  from: string;
  subject: string;
  body: string;
  label?: string;
}

interface RunResult {
  email: RawEmail;
  verdictA: ClassificationResult | { error: string };
  elapsedMsA: number;
  verdictB: ClassificationResult | { error: string };
  elapsedMsB: number;
}

function verdictTag(v: ClassificationResult | { error: string }): string {
  if ('error' in v) return `ERROR(${v.error})`;
  if ('retry' in v) return `RETRY(${v.reason})`;
  if (v.safe) return 'SAFE';
  return `FLAGGED(${v.reason})`;
}

function agreementKey(v: ClassificationResult | { error: string }): string {
  if ('error' in v || 'retry' in v) return 'unavailable';
  return v.safe ? 'safe' : 'flagged';
}

async function classifyOnce(
  email: RawEmail,
  model: string,
): Promise<{ result: ClassificationResult | { error: string }; ms: number }> {
  const sanitized = sanitizeEmail(
    email.id,
    email.from,
    email.subject,
    email.body,
  );
  if (!sanitized) {
    return { result: { error: 'sanitize-failed' }, ms: 0 };
  }
  const start = Date.now();
  try {
    const result = await classifyEmail(sanitized, {
      modelOverride: model,
      dryRun: true,
    });
    return { result, ms: Date.now() - start };
  } catch (err) {
    return {
      result: { error: err instanceof Error ? err.message : String(err) },
      ms: Date.now() - start,
    };
  }
}

async function main(): Promise<void> {
  const [samplePath, modelA = 'gemma4:26b', modelB = 'gemma4:e4b'] =
    process.argv.slice(2);
  if (!samplePath) {
    console.error('Usage: compare-classifiers.ts <sample.json> [a] [b]');
    process.exit(1);
  }

  const raw = fs.readFileSync(samplePath, 'utf8');
  const { emails } = JSON.parse(raw) as { emails: RawEmail[] };

  console.error(
    `Running ${emails.length} emails × 2 models (${modelA}, ${modelB})…`,
  );

  // Batch by model: process all of A first, then all of B. With the proxy
  // enforcing single-model-loaded, this means just 2 model loads total
  // instead of one per email (which forced ~100 swaps).
  const aRuns: Array<{ id: string; result: ClassificationResult | { error: string }; ms: number }> = [];
  console.error(`\n[1/2] ${modelA} (single warm load expected)…`);
  for (const email of emails) {
    process.stderr.write(`  ${email.id} (${email.label ?? '?'})… `);
    const { result, ms } = await classifyOnce(email, modelA);
    aRuns.push({ id: email.id, result, ms });
    process.stderr.write(`${verdictTag(result)} (${ms}ms)\n`);
  }

  const bRuns: Array<{ id: string; result: ClassificationResult | { error: string }; ms: number }> = [];
  console.error(`\n[2/2] ${modelB} (single warm load expected)…`);
  for (const email of emails) {
    process.stderr.write(`  ${email.id} (${email.label ?? '?'})… `);
    const { result, ms } = await classifyOnce(email, modelB);
    bRuns.push({ id: email.id, result, ms });
    process.stderr.write(`${verdictTag(result)} (${ms}ms)\n`);
  }

  const byIdB = new Map(bRuns.map((r) => [r.id, r]));
  const results: RunResult[] = aRuns.map((a) => {
    const b = byIdB.get(a.id)!;
    const email = emails.find((e) => e.id === a.id)!;
    return {
      email,
      verdictA: a.result,
      elapsedMsA: a.ms,
      verdictB: b.result,
      elapsedMsB: b.ms,
    };
  });

  // Group
  const agreeSafe: RunResult[] = [];
  const agreeFlagged: RunResult[] = [];
  const disagree: RunResult[] = [];
  for (const r of results) {
    const ka = agreementKey(r.verdictA);
    const kb = agreementKey(r.verdictB);
    if (ka === 'safe' && kb === 'safe') agreeSafe.push(r);
    else if (ka === 'flagged' && kb === 'flagged') agreeFlagged.push(r);
    else disagree.push(r);
  }

  const lines: string[] = [];
  lines.push(`# Classifier comparison: \`${modelA}\` vs \`${modelB}\``);
  lines.push('');
  lines.push(`Sample: ${emails.length} emails.`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const meanA =
    results.reduce((a, r) => a + r.elapsedMsA, 0) / results.length;
  const meanB =
    results.reduce((a, r) => a + r.elapsedMsB, 0) / results.length;
  const flagsA = results.filter(
    (r) => agreementKey(r.verdictA) === 'flagged',
  ).length;
  const flagsB = results.filter(
    (r) => agreementKey(r.verdictB) === 'flagged',
  ).length;
  lines.push(`| Metric | ${modelA} | ${modelB} |`);
  lines.push('|---|---|---|');
  lines.push(
    `| Flagged | ${flagsA}/${results.length} | ${flagsB}/${results.length} |`,
  );
  lines.push(
    `| Mean latency | ${meanA.toFixed(0)}ms | ${meanB.toFixed(0)}ms |`,
  );
  lines.push(`| Agreement | ${results.length - disagree.length}/${results.length} | |`);
  lines.push('');

  lines.push('## Disagreements');
  lines.push('');
  if (disagree.length === 0) {
    lines.push('_None — the two models agreed on every email._');
  } else {
    for (const r of disagree) {
      lines.push(`### \`${r.email.id}\` (label: ${r.email.label ?? '—'})`);
      lines.push(`- **From**: ${r.email.from}`);
      lines.push(`- **Subject**: ${r.email.subject}`);
      lines.push(
        `- **Body** (first 200 chars): ${r.email.body.slice(0, 200).replace(/\n/g, ' ')}…`,
      );
      lines.push(`- **${modelA}**: ${verdictTag(r.verdictA)} (${r.elapsedMsA}ms)`);
      lines.push(`- **${modelB}**: ${verdictTag(r.verdictB)} (${r.elapsedMsB}ms)`);
      lines.push('');
    }
  }

  lines.push('## Both flagged');
  lines.push('');
  if (agreeFlagged.length === 0) {
    lines.push('_None._');
  } else {
    for (const r of agreeFlagged) {
      lines.push(
        `- \`${r.email.id}\` (label ${r.email.label ?? '—'}) — ${modelA}: ${verdictTag(r.verdictA)} | ${modelB}: ${verdictTag(r.verdictB)}`,
      );
    }
  }
  lines.push('');

  lines.push('## Both safe');
  lines.push('');
  if (agreeSafe.length === 0) {
    lines.push('_None._');
  } else {
    for (const r of agreeSafe) {
      lines.push(`- \`${r.email.id}\` (label ${r.email.label ?? '—'})`);
    }
  }
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
