import { readEnvFile } from './env.js';

/**
 * Cheap liveness probe for the local model backend.
 *
 * Hits the read-only `/api/tags` endpoint (bypasses the OllamaProxy model
 * lock, returns 502 when the upstream is down). Used as a pre-flight before
 * spawning an agent container: if the backend is unreachable — e.g. the laptop
 * is asleep / lid closed — spawning would just hang for the full container
 * timeout producing no output, so callers should defer instead.
 *
 * @param ollamaHost Override host; defaults to OLLAMA_HOST env (or Ollama's default port).
 * @param fetchFn Injectable for tests.
 * @param timeoutMs Probe timeout.
 */
export async function isOllamaReachable(
  ollamaHost?: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<boolean> {
  const host =
    ollamaHost ||
    readEnvFile(['OLLAMA_HOST']).OLLAMA_HOST ||
    'http://localhost:11434';
  try {
    const res = await fetchFn(`${host}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
