/**
 * Context dump instrumentation for agent-runner.
 *
 * Pure computation functions (estimateTokens, sumComponentTokens, buildDump) are
 * exported for unit testing. probeSchemas() is the side-effectful MCP probe.
 *
 * Enable with NANOCLAW_CONTEXT_DUMP=1.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComponentEntry {
  chars?: number;
  schema_chars?: number;
  est_tokens: number;
  tools?: number;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface BuildDumpParams {
  group: string;
  modelConfigured: string;
  modelResolved: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  components: Record<string, ComponentEntry>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  durationMs: number | null;
}

export interface ContextDump {
  event: 'context_dump';
  timestamp: string;
  group: string;
  model_configured: string;
  model_resolved: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  components: Record<string, ComponentEntry>;
  components_est_tokens: number;
  actual: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
    duration_ms: number | null;
    duration: string | null;
    context_window_pct: number | null;
    system_prompt_est_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Pure computation (unit-testable)
// ---------------------------------------------------------------------------

/** Format a duration in milliseconds as a human-readable string. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Estimate token count from character count using the standard chars/4 rule-of-thumb. */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/** Sum est_tokens across all components. */
export function sumComponentTokens(components: Record<string, ComponentEntry>): number {
  return Object.values(components).reduce((sum, c) => sum + c.est_tokens, 0);
}

/**
 * Build the full context dump object from measured inputs and SDK result data.
 * system_prompt_est_tokens is derived as a residual (actual - measured components)
 * and represents the unmeasured claude_code preset overhead.
 */
export function buildDump(params: BuildDumpParams): ContextDump {
  const componentsEstTokens = sumComponentTokens(params.components);
  const contextWindowPct =
    params.contextWindow !== null && params.contextWindow > 0
      ? Math.round((params.inputTokens / params.contextWindow) * 1000) / 10
      : null;

  return {
    event: 'context_dump',
    timestamp: new Date().toISOString(),
    group: params.group,
    model_configured: params.modelConfigured,
    model_resolved: params.modelResolved,
    context_window: params.contextWindow,
    max_output_tokens: params.maxOutputTokens,
    components: params.components,
    components_est_tokens: componentsEstTokens,
    actual: {
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cost_usd: params.costUsd,
      duration_ms: params.durationMs,
      duration: params.durationMs !== null ? formatDuration(params.durationMs) : null,
      context_window_pct: contextWindowPct,
      system_prompt_est_tokens: params.inputTokens - componentsEstTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP schema probe (side-effectful, not unit-tested)
// ---------------------------------------------------------------------------

/**
 * Probe a single MCP server: start it, call tools/list, measure schema JSON size, stop.
 * Returns null on failure — non-fatal, probe errors should not block the agent.
 */
async function probeSingleMcp(
  name: string,
  config: McpServerConfig,
  log: (msg: string) => void,
): Promise<{ tools: number; schema_chars: number } | null> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  });
  const client = new Client({ name: 'nanoclaw-probe', version: '1.0.0' });

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('connect timeout')), 10_000),
      ),
    ]);

    const result = await Promise.race([
      client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('listTools timeout')), 10_000),
      ),
    ]);

    const schemaChars = JSON.stringify(result.tools).length;
    log(`[context-dump] mcp_${name}: ${result.tools.length} tools, ${schemaChars} chars`);
    return { tools: result.tools.length, schema_chars: schemaChars };
  } catch (err) {
    log(`[context-dump] mcp_${name} probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    try { await transport.close(); } catch { /* ignore */ }
  }
}

/**
 * Probe all configured MCP servers sequentially and return per-server schema measurements.
 * Runs sequentially to avoid spawning too many subprocesses at once.
 */
export async function probeSchemas(
  mcpServers: Record<string, McpServerConfig>,
  log: (msg: string) => void,
): Promise<Record<string, ComponentEntry>> {
  const result: Record<string, ComponentEntry> = {};

  for (const [name, config] of Object.entries(mcpServers)) {
    const probe = await probeSingleMcp(name, config, log);
    if (probe) {
      result[`mcp_${name}`] = {
        tools: probe.tools,
        schema_chars: probe.schema_chars,
        est_tokens: estimateTokens(probe.schema_chars),
      };
    }
  }

  return result;
}
