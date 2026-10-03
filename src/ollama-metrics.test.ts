import { describe, expect, it } from 'vitest';

import {
  extractInferenceStats,
  OllamaMetrics,
  StreamStatsTail,
} from './ollama-metrics.js';

describe('extractInferenceStats', () => {
  it('reads native Ollama counters and converts durations from ns to s', () => {
    expect(
      extractInferenceStats({
        done: true,
        prompt_eval_count: 120,
        eval_count: 40,
        total_duration: 3_000_000_000,
        load_duration: 1_500_000_000,
        prompt_eval_duration: 250_000_000,
        eval_duration: 1_000_000_000,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      loadSeconds: 1.5,
      promptEvalSeconds: 0.25,
      evalSeconds: 1,
    });
  });

  it('reads OpenAI-compatible usage', () => {
    expect(
      extractInferenceStats({
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('reads Anthropic usage, counting cached input tokens as input', () => {
    expect(
      extractInferenceStats({
        type: 'message',
        usage: {
          input_tokens: 5,
          cache_read_input_tokens: 12,
          output_tokens: 16,
        },
      }),
    ).toEqual({ inputTokens: 17, outputTokens: 16 });
  });

  it('reads Anthropic usage nested in a message_start event', () => {
    expect(
      extractInferenceStats({
        type: 'message_start',
        message: { usage: { input_tokens: 9, output_tokens: 0 } },
      }),
    ).toEqual({ inputTokens: 9, outputTokens: 0 });
  });

  it('returns null when no stats are present', () => {
    expect(extractInferenceStats({ done: false, message: {} })).toBeNull();
    expect(extractInferenceStats(null)).toBeNull();
    expect(extractInferenceStats('nope')).toBeNull();
  });
});

describe('StreamStatsTail', () => {
  const enc = new TextEncoder();

  it('finds the final NDJSON stats line', () => {
    const tail = new StreamStatsTail();
    tail.push(enc.encode('{"done":false,"message":{"content":"hi"}}\n'));
    tail.push(
      enc.encode('{"done":true,"eval_count":7,"prompt_eval_count":3}\n'),
    );
    expect(tail.finish()).toMatchObject({ inputTokens: 3, outputTokens: 7 });
  });

  it('handles a stats line split across chunks with no trailing newline', () => {
    const tail = new StreamStatsTail();
    tail.push(enc.encode('{"done":false}\n{"done":true,"eval_'));
    tail.push(enc.encode('count":9,"prompt_eval_count":2}'));
    expect(tail.finish()).toMatchObject({ inputTokens: 2, outputTokens: 9 });
  });

  it('parses SSE usage chunks and ignores [DONE]', () => {
    const tail = new StreamStatsTail();
    tail.push(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
    tail.push(
      enc.encode(
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6}}\n\ndata: [DONE]\n\n',
      ),
    );
    expect(tail.finish()).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it('merges Anthropic SSE events, later events winning per field', () => {
    const tail = new StreamStatsTail();
    tail.push(
      enc.encode(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
      ),
    );
    tail.push(
      enc.encode(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
      ),
    );
    // Real Anthropic message_delta carries only output_tokens
    tail.push(
      enc.encode(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":16}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      ),
    );
    expect(tail.finish()).toEqual({ inputTokens: 20, outputTokens: 16 });
  });

  it('returns null when the stream carries no stats', () => {
    const tail = new StreamStatsTail();
    tail.push(enc.encode('{"done":false}\n{"done":true}\n'));
    expect(tail.finish()).toBeNull();
  });
});

describe('OllamaMetrics', () => {
  it('renders recorded metrics in Prometheus text format', async () => {
    const m = new OllamaMetrics({ getCurrentModel: () => 'gemma4:26b' });
    m.recordRequest({ path: '/api/chat', model: 'gemma4:26b', status: 200 }, 2);
    m.recordLockWait('gemma4:26b', 0.5);
    m.recordEviction('old', 'gemma4:26b');
    m.recordUpstreamError('/api/chat');
    m.recordInference('gemma4:26b', {
      inputTokens: 100,
      outputTokens: 50,
      loadSeconds: 3,
      promptEvalSeconds: 0.2,
      evalSeconds: 2,
    });

    const text = await m.scrape();

    expect(text).toMatch(
      /ollama_proxy_requests_total\{[^}]*path="\/api\/chat"[^}]*\} 1/,
    );
    expect(text).toContain('ollama_proxy_request_duration_count');
    expect(text).toContain('ollama_proxy_lock_wait_duration_sum');
    expect(text).toMatch(
      /ollama_proxy_evictions_total\{from_model="old",to_model="gemma4:26b"\} 1/,
    );
    expect(text).toMatch(/ollama_proxy_upstream_errors_total\{[^}]*\} 1/);
    expect(text).toMatch(/ollama_proxy_loaded_model\{model="gemma4:26b"\} 1/);
    expect(text).toMatch(
      /gen_ai_client_token_usage_sum\{[^}]*gen_ai_token_type="input"[^}]*\} 100/,
    );
    expect(text).toMatch(
      /gen_ai_client_token_usage_sum\{[^}]*gen_ai_token_type="output"[^}]*\} 50/,
    );
    expect(text).toMatch(/ollama_eval_tokens_per_second_sum\{[^}]*\} 25/);
    expect(text).toMatch(/ollama_load_duration_sum\{[^}]*\} 3/);
    expect(text).toMatch(/ollama_prompt_eval_duration_sum\{[^}]*\} 0\.2/);

    await m.shutdown();
  });

  it('labels unknown paths as "other"', async () => {
    const m = new OllamaMetrics({ getCurrentModel: () => null });
    m.recordRequest({ path: '/random/junk/123', status: 404 }, 0.01);
    m.recordUpstreamError('/nope');
    const text = await m.scrape();
    expect(text).toMatch(
      /ollama_proxy_requests_total\{path="other",status="404"\} 1/,
    );
    expect(text).toMatch(
      /ollama_proxy_upstream_errors_total\{path="other"\} 1/,
    );
    expect(text).not.toContain('/random/junk');
    await m.shutdown();
  });

  it('omits the loaded-model series when nothing is loaded', async () => {
    const m = new OllamaMetrics({ getCurrentModel: () => null });
    expect(await m.scrape()).not.toMatch(/ollama_proxy_loaded_model\{/);
    await m.shutdown();
  });

  it('skips tokens/sec when eval duration is zero or missing', async () => {
    const m = new OllamaMetrics({ getCurrentModel: () => null });
    m.recordInference('x', { inputTokens: 1, outputTokens: 1 });
    m.recordInference('x', { inputTokens: 1, outputTokens: 1, evalSeconds: 0 });
    expect(await m.scrape()).not.toMatch(/ollama_eval_tokens_per_second_count/);
    await m.shutdown();
  });
});
