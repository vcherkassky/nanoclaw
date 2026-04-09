import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock env.js so we control OLLAMA_HOST / OLLAMA_CLASSIFIER_MODEL per test
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import { readEnvFile } from './env.js';
import {
  classifyEmail,
  sanitizeEmail,
  type SanitizedEmail,
} from './email-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSanitized(overrides?: Partial<SanitizedEmail>): SanitizedEmail {
  return {
    id: 'abc123',
    from: 'sender@example.com',
    subject: 'Hello',
    body: 'Plain email body.',
    ...overrides,
  };
}

/** Build a mock fetch that returns the given Ollama /api/chat body */
function mockOllamaResponse(
  messageContent: string,
  toolCalls?: Array<{ function: { name: string; arguments: unknown } }>,
) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      message: {
        content: messageContent,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
    }),
    text: vi.fn().mockResolvedValue(''),
  });
}

// ---------------------------------------------------------------------------
// sanitizeEmail
// ---------------------------------------------------------------------------

describe('sanitizeEmail', () => {
  it('returns sanitized fields for a well-formed email', () => {
    const result = sanitizeEmail(
      'abc123',
      'Test User <Test@Example.COM>',
      'Hello World',
      'Plain text body.',
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe('abc123');
    expect(result!.from).toBe('test@example.com'); // lowercased
    expect(result!.subject).toBe('Hello World');
    expect(result!.body).toBe('Plain text body.');
  });

  it('normalises bare email addresses to lowercase', () => {
    const result = sanitizeEmail('x1', 'SENDER@EXAMPLE.COM', 'S', 'B');
    expect(result!.from).toBe('sender@example.com');
  });

  it('returns null for an email ID with invalid characters', () => {
    expect(sanitizeEmail('abc/def', 'a@b.com', 'S', 'B')).toBeNull();
    expect(sanitizeEmail('abc def', 'a@b.com', 'S', 'B')).toBeNull();
    expect(sanitizeEmail('', 'a@b.com', 'S', 'B')).toBeNull();
  });

  it('returns null when sender email cannot be extracted', () => {
    expect(sanitizeEmail('id1', 'not-an-email', 'S', 'B')).toBeNull();
    expect(sanitizeEmail('id1', '', 'S', 'B')).toBeNull();
  });

  it('strips HTML tags from body', () => {
    const result = sanitizeEmail(
      'id1',
      'a@b.com',
      'S',
      '<b>Bold</b> and <a href="x">link</a> text.',
    );
    expect(result!.body).not.toContain('<b>');
    expect(result!.body).not.toContain('<a');
    expect(result!.body).toContain('Bold');
    expect(result!.body).toContain('link');
  });

  it('strips javascript: schemes from body', () => {
    const result = sanitizeEmail(
      'id1',
      'a@b.com',
      'S',
      'Click javascript:alert(1) here',
    );
    expect(result!.body).not.toContain('javascript:');
  });

  it('strips onload= event handlers from body', () => {
    const result = sanitizeEmail('id1', 'a@b.com', 'S', 'onload=evil() stuff');
    expect(result!.body).not.toContain('onload=');
  });

  it('strips non-printable ASCII from subject', () => {
    const result = sanitizeEmail('id1', 'a@b.com', 'Hello\x00World', 'B');
    expect(result!.subject).not.toContain('\x00');
    expect(result!.subject).toContain('HelloWorld');
  });

  it('caps subject at 255 characters', () => {
    const long = 'A'.repeat(300);
    const result = sanitizeEmail('id1', 'a@b.com', long, 'B');
    expect(result!.subject.length).toBe(255);
  });

  it('caps body at 8000 characters', () => {
    const long = 'A'.repeat(9000);
    const result = sanitizeEmail('id1', 'a@b.com', 'S', long);
    expect(result!.body.length).toBeLessThanOrEqual(8000);
  });
});

// ---------------------------------------------------------------------------
// classifyEmail
// ---------------------------------------------------------------------------

describe('classifyEmail', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classifier-test-'));
    vi.stubGlobal('fetch', undefined);
    // Default: OLLAMA_HOST set, no model override (auto-detect)
    vi.mocked(readEnvFile).mockReturnValue({ OLLAMA_HOST: 'http://localhost:11434' });
    // Reset the module-level model cache between tests by reimporting is complex;
    // instead we always supply OLLAMA_CLASSIFIER_MODEL in tests that need it
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: configure env with a fixed model and host
  function setEnv(
    model = 'test-model',
    host = 'http://localhost:11434',
  ) {
    vi.mocked(readEnvFile).mockReturnValue({
      OLLAMA_HOST: host,
      OLLAMA_CLASSIFIER_MODEL: model,
    });
  }

  it('returns safe: true for a valid SAFE response', async () => {
    setEnv();
    vi.stubGlobal('fetch', mockOllamaResponse('{"is_safe":true,"reason":"SAFE"}'));

    const result = await classifyEmail(makeSanitized());
    expect(result).toEqual({ safe: true });
  });

  it('returns safe: false for PROMPT_INJECTION verdict', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('{"is_safe":false,"reason":"PROMPT_INJECTION"}'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, reason: 'PROMPT_INJECTION' });
  });

  it('returns safe: false for MALICIOUS_CONTENT verdict', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('{"is_safe":false,"reason":"MALICIOUS_CONTENT"}'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, reason: 'MALICIOUS_CONTENT' });
  });

  it('treats UNSURE as unsafe (false-positive bias)', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('{"is_safe":true,"reason":"UNSURE"}'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, reason: 'UNSURE' });
  });

  it('returns safe: false when honeypot tool call is detected', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('', [
        {
          function: {
            name: 'signal_unsafe',
            arguments: { reason: 'PROMPT_INJECTION', description: 'test' },
          },
        },
      ]),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, type: 'tool_call' });
  });

  it('returns safe: false when response is not valid JSON', async () => {
    setEnv();
    vi.stubGlobal('fetch', mockOllamaResponse('Sorry, I cannot classify this.'));

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, type: 'validation_failure' });
  });

  it('strips markdown code fences before parsing JSON', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('```json\n{"is_safe":true,"reason":"SAFE"}\n```'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toEqual({ safe: true });
  });

  it('strips YAML front matter (---) before parsing JSON', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('---\n{"is_safe":true,"reason":"SAFE"}'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toEqual({ safe: true });
  });

  it('returns safe: false when JSON schema is invalid (missing is_safe)', async () => {
    setEnv();
    vi.stubGlobal('fetch', mockOllamaResponse('{"reason":"SAFE"}'));

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, type: 'validation_failure' });
  });

  it('returns safe: false when reason is not a valid enum value', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('{"is_safe":true,"reason":"EVERYTHING_FINE"}'),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ safe: false, type: 'validation_failure' });
  });

  it('returns retry: true when Ollama is unreachable', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ retry: true });
  });

  it('returns retry: true when Ollama returns a non-OK status', async () => {
    setEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue('Service Unavailable'),
      }),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ retry: true });
  });

  it('returns retry: true when no Ollama model is available', async () => {
    // No OLLAMA_CLASSIFIER_MODEL; /api/tags returns empty list
    vi.mocked(readEnvFile).mockReturnValue({ OLLAMA_HOST: 'http://localhost:11434' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ models: [] }),
      }),
    );

    const result = await classifyEmail(makeSanitized());
    expect(result).toMatchObject({ retry: true });
  });

  it('writes to quarantine log on honeypot trigger', async () => {
    setEnv();
    // Point store dir to tmp
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.stubGlobal(
      'fetch',
      mockOllamaResponse('', [
        { function: { name: 'signal_unsafe', arguments: { reason: 'PROMPT_INJECTION' } } },
      ]),
    );

    await classifyEmail(makeSanitized({ id: 'quarantine-test-id' }));

    const logPath = path.join(tmpDir, 'store', 'email-quarantine.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[0]);
    expect(event.email_id).toBe('quarantine-test-id');
    expect(event.type).toBe('tool_call');
  });

  it('writes to quarantine log on validation failure', async () => {
    setEnv();
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.stubGlobal('fetch', mockOllamaResponse('not json at all'));

    await classifyEmail(makeSanitized({ id: 'bad-json-id' }));

    const logPath = path.join(tmpDir, 'store', 'email-quarantine.jsonl');
    const event = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(event.email_id).toBe('bad-json-id');
    expect(event.type).toBe('validation_failure');
  });

  it('does NOT write to quarantine log for safe emails', async () => {
    setEnv();
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.stubGlobal('fetch', mockOllamaResponse('{"is_safe":true,"reason":"SAFE"}'));

    await classifyEmail(makeSanitized());

    const logPath = path.join(tmpDir, 'store', 'email-quarantine.jsonl');
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
