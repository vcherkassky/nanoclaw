import fs from 'fs';

/**
 * Preload that replaces undici's global dispatcher with one that has no
 * headers/body timeout (see /app/undici-no-timeout.cjs). Without it, Node's
 * fetch gives up after 300 s without response headers, which a cold
 * long-prompt prefill on the local model can exceed.
 */
export const UNDICI_PRELOAD_PATH = '/app/undici-no-timeout.cjs';

/**
 * Node args for the Claude Code CLI process. The SDK deletes NODE_OPTIONS
 * from the CLI's environment, so the Dockerfile's NODE_OPTIONS preload
 * doesn't reach it; pass the preload explicitly instead.
 */
export function claudeCodeExecutableArgs(exists: (p: string) => boolean = fs.existsSync): string[] {
  return exists(UNDICI_PRELOAD_PATH) ? ['--require', UNDICI_PRELOAD_PATH] : [];
}
