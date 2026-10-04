import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { claudeCodeExecutableArgs, UNDICI_PRELOAD_PATH } from './undici-preload.js';

const runnerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const containerDir = path.resolve(runnerDir, '..');

describe('undici no-timeout preload', () => {
  it('passes --require <preload> to the Claude Code process when the preload exists', () => {
    expect(claudeCodeExecutableArgs(() => true)).toEqual(['--require', UNDICI_PRELOAD_PATH]);
  });

  it('passes nothing when the preload is missing (e.g. an older image)', () => {
    expect(claudeCodeExecutableArgs(() => false)).toEqual([]);
  });

  it('ships the preload where the image expects it', () => {
    // COPY agent-runner/ ./ (WORKDIR /app) puts it at /app/<name>; it must
    // not live under src/, which container-runner mounts over.
    expect(UNDICI_PRELOAD_PATH).toBe('/app/undici-no-timeout.cjs');
    expect(fs.existsSync(path.join(runnerDir, 'undici-no-timeout.cjs'))).toBe(true);
  });

  it('loads the preload for every node process in the image', () => {
    const dockerfile = fs.readFileSync(path.join(containerDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^ENV NODE_OPTIONS="--require \/app\/undici-no-timeout\.cjs"$/m);
    // Set after the build steps so npm install/tsc at build time are unaffected
    expect(dockerfile.indexOf('ENV NODE_OPTIONS')).toBeGreaterThan(dockerfile.indexOf('RUN npm run build'));
  });

  it('pins undici to the major bundled with the image Node (22.x ships undici 6)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(runnerDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.undici).toMatch(/^6\.\d+\.\d+$/);
  });
});
