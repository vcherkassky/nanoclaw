import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

import { readEnvFile } from './env.js';
import { _clearTranscriptionCache, transcribeAudio } from './transcription.js';

function mockOllamaWavResponse(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { content } }],
    }),
    text: vi.fn().mockResolvedValue(''),
  });
}

describe('transcribeAudio', () => {
  beforeEach(() => {
    _clearTranscriptionCache();
    vi.mocked(readEnvFile).mockReturnValue({
      OLLAMA_HOST: 'http://localhost:11434',
    });
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    vi.mocked(readFileSync).mockReturnValue(Buffer.from('fake-wav-bytes'));
    vi.mocked(unlinkSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', undefined);
  });

  it('returns the transcript on a successful Ollama response', async () => {
    vi.stubGlobal('fetch', mockOllamaWavResponse('Hello world'));
    const result = await transcribeAudio('/tmp/sample.oga');
    expect(result).toBe('Hello world');
  });

  it('sends an OpenAI-compat input_audio content block with format wav', async () => {
    const fetchMock = mockOllamaWavResponse('ok');
    vi.stubGlobal('fetch', fetchMock);
    await transcribeAudio('/tmp/x.oga');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemma4:e4b');
    const userMsg = body.messages[0];
    expect(userMsg.role).toBe('user');
    const audioBlock = userMsg.content.find(
      (b: { type: string }) => b.type === 'input_audio',
    );
    expect(audioBlock).toBeDefined();
    expect(audioBlock.input_audio.format).toBe('wav');
    expect(audioBlock.input_audio.data).toBe(
      Buffer.from('fake-wav-bytes').toString('base64'),
    );
  });

  it('honours TRANSCRIPTION_MODEL from env', async () => {
    vi.mocked(readEnvFile).mockReturnValue({
      OLLAMA_HOST: 'http://localhost:11434',
      TRANSCRIPTION_MODEL: 'other-audio-model',
    });
    const fetchMock = mockOllamaWavResponse('ok');
    vi.stubGlobal('fetch', fetchMock);
    await transcribeAudio('/tmp/x.oga');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('other-audio-model');
  });

  it('returns null when ffmpeg conversion fails', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('ffmpeg: command not found');
    });
    const result = await transcribeAudio('/tmp/x.oga');
    expect(result).toBeNull();
  });

  it('returns null when Ollama is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    const result = await transcribeAudio('/tmp/x.oga');
    expect(result).toBeNull();
  });

  it('returns null on Ollama API error (non-2xx)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('boom'),
      }),
    );
    const result = await transcribeAudio('/tmp/x.oga');
    expect(result).toBeNull();
  });

  it('returns null when response has no transcript content', async () => {
    vi.stubGlobal('fetch', mockOllamaWavResponse(''));
    const result = await transcribeAudio('/tmp/x.oga');
    expect(result).toBeNull();
  });

  it('caches the transcript across repeated calls for the same path', async () => {
    const fetchMock = mockOllamaWavResponse('cached transcript');
    vi.stubGlobal('fetch', fetchMock);

    const first = await transcribeAudio('/tmp/same.oga');
    const second = await transcribeAudio('/tmp/same.oga');

    expect(first).toBe('cached transcript');
    expect(second).toBe('cached transcript');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does NOT cache null results (so transient failures can be retried)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue(''),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'recovered' } }],
        }),
        text: vi.fn().mockResolvedValue(''),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = await transcribeAudio('/tmp/transient.oga');
    const second = await transcribeAudio('/tmp/transient.oga');

    expect(first).toBeNull();
    expect(second).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
