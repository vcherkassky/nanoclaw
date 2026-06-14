/**
 * Audio transcription via a local Ollama audio-capable model.
 *
 * Defaults to gemma4:e4b (override with TRANSCRIPTION_MODEL in .env).
 * Converts input to 16kHz mono WAV with ffmpeg first, since Ollama's audio
 * decoder only accepts WAV. Posts to the OpenAI-compatible endpoint with
 * an input_audio content block — the native /api/chat does not accept audio.
 *
 * Returns the transcript on success, or null on any failure (ffmpeg missing,
 * Ollama unreachable, schema mismatch). Callers should fall back to the
 * raw file-path placeholder when null is returned.
 */
import { execFileSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_MODEL = 'gemma4:e4b';
const TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio. Just the transcript, nothing else.';

const cache = new Map<string, string>();

export async function transcribeAudio(
  filePath: string,
): Promise<string | null> {
  const cached = cache.get(filePath);
  if (cached) return cached;

  const env = readEnvFile(['OLLAMA_HOST', 'TRANSCRIPTION_MODEL']);
  const host = env.OLLAMA_HOST || 'http://localhost:11434';
  const model = env.TRANSCRIPTION_MODEL || DEFAULT_MODEL;

  const wavPath = join(
    tmpdir(),
    `transcribe_${process.pid}_${Date.now()}_${basename(filePath)}.wav`,
  );

  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', wavPath],
      { stdio: 'pipe' },
    );
  } catch (err) {
    logger.warn(
      {
        filePath,
        err: err instanceof Error ? err.message : String(err),
      },
      'Transcription: ffmpeg conversion failed',
    );
    return null;
  }

  let audioB64: string;
  try {
    audioB64 = readFileSync(wavPath).toString('base64');
  } catch (err) {
    logger.warn(
      { filePath, err: err instanceof Error ? err.message : String(err) },
      'Transcription: failed to read WAV',
    );
    return null;
  } finally {
    try {
      unlinkSync(wavPath);
    } catch {
      /* tmp cleanup best-effort */
    }
  }

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_INSTRUCTION },
          {
            type: 'input_audio',
            input_audio: { data: audioB64, format: 'wav' },
          },
        ],
      },
    ],
  };

  const startMs = Date.now();
  let response: Response;
  try {
    response = await fetch(`${host}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    logger.warn(
      {
        filePath,
        err: err instanceof Error ? err.message : String(err),
      },
      'Transcription: Ollama unreachable',
    );
    return null;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.warn(
      { filePath, status: response.status, text },
      'Transcription: Ollama API error',
    );
    return null;
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    logger.warn({ filePath }, 'Transcription: invalid JSON from Ollama');
    return null;
  }

  const transcript = data.choices?.[0]?.message?.content?.trim();
  if (!transcript) {
    logger.warn({ filePath }, 'Transcription: empty response');
    return null;
  }

  cache.set(filePath, transcript);
  logger.info(
    {
      filePath,
      model,
      length: transcript.length,
      elapsedMs: Date.now() - startMs,
    },
    'Transcription: success',
  );
  return transcript;
}

export function _clearTranscriptionCache(): void {
  cache.clear();
}
