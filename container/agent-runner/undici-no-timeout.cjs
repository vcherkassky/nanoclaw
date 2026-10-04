// Preloaded into node processes in the agent container (NODE_OPTIONS in the
// Dockerfile, plus executableArgs for the Claude Code CLI, whose env the SDK
// strips of NODE_OPTIONS).
//
// Node's built-in fetch uses undici's default global dispatcher, which has a
// 300 s headersTimeout and bodyTimeout. Ollama sends no headers until prompt
// prefill is done, so a cold long prompt dies at 300 s ("fetch failed").
// Install a dispatcher without those timeouts before anything else runs.
// Built-in fetch and any bundled undici (Claude Code's cli.js) both read this
// global symbol and only install their own default when it is unset.
//
// `undici` is pinned in package.json to the major bundled with the image's
// Node (Node 22 ships undici 6) so the dispatcher interface matches.
'use strict';

try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
} catch (err) {
  // Never stop the process from starting; it just keeps Node's defaults
  process.stderr.write(
    `[undici-no-timeout] preload failed, keeping default timeouts: ${err && err.message}\n`,
  );
}
