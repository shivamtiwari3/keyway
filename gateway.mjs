#!/usr/bin/env node
// Minimal loopback gateway for Claude Desktop. BYOK: works with any
// Anthropic-compatible OR OpenAI-compatible upstream.
//
//   api: "anthropic" -> transparent pass-through to {upstream}/v1/messages
//   api: "openai"    -> Anthropic Messages API <-> OpenAI Chat Completions
//
// Claude Desktop sends opaque `keyway/<hex>` ids (it rejects '/' and '.'),
// which are hex-decoded back to the real provider model id.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.KEYWAY_CONFIG || path.join(DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const HOST = cfg.host || '127.0.0.1';
const PORT = cfg.port || 8788;
let UPSTREAM = (cfg.upstream || '').replace(/\/+$/, '');
let API = ['auto', 'anthropic', 'openai'].includes(cfg.api) ? cfg.api : 'auto';
const MODELS = (cfg.models || []).map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
const DEFAULT_MODEL = cfg.defaultModel || MODELS[0];
const MODEL_MAP = cfg.modelMap || {};
const AUTH_HEADER = cfg.authHeader || 'Authorization';
const AUTH_SCHEME = cfg.authScheme === undefined ? 'Bearer ' : cfg.authScheme;
const LOG = cfg.log !== false;
const SAFE_PREFIX = 'keyway/';
const STREAM_USAGE = cfg.streamUsage !== false;
const REQUEST_TIMEOUT_MS = Number(cfg.timeoutMs || 600000);
const PROBE_TIMEOUT_MS = Number(cfg.probeTimeoutMs || 8000);

function loadKey() {
  if (process.env.PROVIDER_API_KEY) return process.env.PROVIDER_API_KEY.trim();
  if (cfg.apiKey) return cfg.apiKey;
  if (cfg.apiKeyFile) {
    const p = cfg.apiKeyFile.replace(/^~/, os.homedir());
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  }
  return '';
}
const KEY = loadKey();

const log = (...a) => { if (LOG) console.error(new Date().toISOString(), '[gateway]', ...a); };

function decodeSafeId(model) {
  if (typeof model !== 'string' || !model.startsWith(SAFE_PREFIX)) return null;
  try { return Buffer.from(model.slice(SAFE_PREFIX.length), 'hex').toString('utf8') || null; } catch { return null; }
}
function resolveModel(model) {
  if (!model) return DEFAULT_MODEL;
  return MODEL_MAP[model] || decodeSafeId(model) || DEFAULT_MODEL;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// -------------------- Anthropic -> OpenAI --------------------

function stringifyToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : JSON.stringify(b))).join('\n');
  return JSON.stringify(content);
}
function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source) {
      if (b.source.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      else if (b.source.type === 'url') parts.push({ type: 'image_url', image_url: { url: b.source.url } });
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = Array.isArray(body.system) ? body.system.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : String(body.system);
    if (sys) messages.push({ role: 'system', content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string' || msg.content == null) {
      messages.push({ role: msg.role, content: msg.content == null ? '' : msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      const out = { role: 'assistant', content: textParts.length ? textParts.join('') : null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else {
      const toolMessages = [];
      const contentParts = [];
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'tool_result') toolMessages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: stringifyToolResult(b.content) });
        else if (b.type === 'text' || b.type === 'image') contentParts.push(b);
      }
      messages.push(...toolMessages);
      if (contentParts.length) {
        const c = toOpenAIContent(contentParts);
        if (!(typeof c === 'string' && c === '')) messages.push({ role: 'user', content: c });
      }
    }
  }
  const out = { model: resolveModel(body.model), messages, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, stream: !!body.stream };
  if (body.stop_sequences && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } } }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'auto') out.tool_choice = 'auto';
      else if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'none') out.tool_choice = 'none';
      else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  if (out.stream && STREAM_USAGE) out.stream_options = { include_usage: true };
  return out;
}
function mapStop(reason) {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'end_turn';
}
function openAIToAnthropic(resp, requestedModel) {
  const choice = (resp.choices && resp.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content.length) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = { _raw: tc.function && tc.function.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: tc.function ? tc.function.name : '', input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const u = resp.usage || {};
  return { id: 'msg_' + crypto.randomBytes(12).toString('hex'), type: 'message', role: 'assistant', model: requestedModel, content, stop_reason: mapStop(choice.finish_reason), stop_sequence: null, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
}

async function streamOpenAIToAnthropic(upstream, res, requestedModel) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_' + crypto.randomBytes(12).toString('hex'), type: 'message', role: 'assistant', model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let blockIndex = -1;
  let openType = null;
  const toolMap = new Map();
  let stopReason = 'end_turn';
  let inputTokens = 0, outputTokens = 0;

  const closeBlock = () => { if (openType !== null) { send('content_block_stop', { type: 'content_block_stop', index: blockIndex }); openType = null; } };
  const startBlock = (type, extra) => { closeBlock(); blockIndex += 1; openType = type; send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: Object.assign({ type }, extra || {}) }); };

  function handle(json) {
    if (json.usage) { if (json.usage.prompt_tokens) inputTokens = json.usage.prompt_tokens; if (json.usage.completion_tokens) outputTokens = json.usage.completion_tokens; }
    const choice = (json.choices && json.choices[0]) || {};
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length) {
      if (openType !== 'text') startBlock('text', { text: '' });
      send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const oi = tc.index == null ? 0 : tc.index;
        if (!toolMap.has(oi) || openType !== 'tool_use' || blockIndex !== toolMap.get(oi)) {
          startBlock('tool_use', { id: tc.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: (tc.function && tc.function.name) || '', input: {} });
          toolMap.set(oi, blockIndex);
        }
        const args = tc.function && tc.function.arguments;
        if (args) send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: args } });
      }
    }
    if (choice.finish_reason) stopReason = mapStop(choice.finish_reason);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { handle(JSON.parse(payload)); } catch {}
    }
  }
  closeBlock();
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

// -------------------- forwarding --------------------

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade', 'authorization', 'x-api-key', 'accept-encoding']);

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (KEY) h[AUTH_HEADER] = `${AUTH_SCHEME}${KEY}`;
  return h;
}

// --- backend capability detection ---
// The user only supplies endpoint + key. We figure out whether the endpoint
// speaks the Anthropic or OpenAI API and normalize the base URL, once.
let detectPromise = null;
const modeResolved = () => API === 'anthropic' || API === 'openai';

// fetch() only says "fetch failed"; the useful part (ENOTFOUND, ECONNREFUSED,
// a TLS certificate error from HTTPS-scanning antivirus, ...) is in e.cause.
function netError(e) {
  const c = e && e.cause;
  return c ? `${e.message} (${c.code || c.message || c})` : String(e && e.message || e);
}

async function fetchTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(timer); }
}

// A live Anthropic endpoint answers 200/400/413/422 to POST /v1/messages.
// 401/403 mean "auth failed", not "endpoint speaking Anthropic" — so they must
// NOT be treated as success (this was a false-positive that broke OpenAI hosts).
const ANTHROPIC_ALIVE = new Set([200, 400, 413, 422]);

async function detectMode(force = false) {
  if (modeResolved() && !force) return;
  const u = UPSTREAM.replace(/\/+$/, '');
  const headers = authHeaders();
  const probeModel = DEFAULT_MODEL || 'claude-sonnet-4-5';
  for (const base of [u, u + '/anthropic']) {
    try {
      const r = await fetchTimeout(base + '/v1/messages', {
        method: 'POST',
        headers: { ...headers, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: probeModel, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }, PROBE_TIMEOUT_MS);
      if (ANTHROPIC_ALIVE.has(r.status)) {
        API = 'anthropic'; UPSTREAM = base;
        log(`detected api=anthropic @ ${base} (probe ${r.status})`);
        return;
      }
    } catch {}
  }
  for (const base of [u, u + '/v1']) {
    try {
      const r = await fetchTimeout(base + '/models', { headers }, PROBE_TIMEOUT_MS);
      if (r.ok) {
        API = 'openai'; UPSTREAM = base;
        log(`detected api=openai @ ${base} (probe ${r.status})`);
        return;
      }
    } catch {}
  }
  API = 'openai'; UPSTREAM = u;
  log(`detection inconclusive; assuming api=openai @ ${u}`);
}
async function ensureMode() {
  if (modeResolved()) return;
  if (!detectPromise) detectPromise = detectMode();
  await detectPromise;
}

async function forwardAnthropic(req, res, pathname, search, body) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  Object.assign(headers, authHeaders());
  if (body.length) headers['content-length'] = Buffer.byteLength(body);
  let streaming = false;
  try { streaming = JSON.parse(body.toString('utf8')).stream === true; } catch {}
  const opts = { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body };
  let upstream;
  try {
    upstream = streaming ? await fetch(UPSTREAM + pathname + search, opts)
                         : await fetchTimeout(UPSTREAM + pathname + search, opts, REQUEST_TIMEOUT_MS);
  } catch (e) { log('upstream unreachable', netError(e)); return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'Could not reach ' + UPSTREAM + ': ' + netError(e) } }); }
  const out = {};
  for (const [k, v] of upstream.headers) if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k.toLowerCase())) out[k] = v;
  res.writeHead(upstream.status, out);
  if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

// Report provider errors in Anthropic shape, keeping the provider's own message.
// A 404 is sent on as 400: Claude Desktop treats any gateway 404 as "model does
// not exist" and hides the message, which is misleading when the provider is
// complaining about something else (wrong URL, bad request, retired model).
function sendUpstreamError(res, status, text) {
  let detail = text;
  try { const j = JSON.parse(text); detail = (j.error && (j.error.message || j.error)) || j.message || text; } catch {}
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error'
    : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
  // 413 likewise: Claude clients show "Request too large (max 32MB)" for any 413,
  // but providers use it for token/rate limits (e.g. Groq's tokens-per-minute cap).
  const out = status === 404 || status === 413 ? 400 : status;
  return sendJson(res, out, { type: 'error', error: { type, message: `${cfg.providerName || 'Provider'} returned HTTP ${status}: ${String(detail).slice(0, 500)}` } });
}

async function forwardOpenAI(req, res, body, requestedModel) {
  let openaiBody;
  try { openaiBody = anthropicToOpenAI(JSON.parse(body.toString('utf8'))); }
  catch (e) { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Bad request: ' + e.message } }); }

  const url = `${UPSTREAM}/chat/completions`;
  const call = (b) => {
    const opts = { method: 'POST', headers: authHeaders(), body: JSON.stringify(b) };
    return b.stream ? fetch(url, opts) : fetchTimeout(url, opts, REQUEST_TIMEOUT_MS);
  };
  let upstream;
  try {
    upstream = await call(openaiBody);
    // Some providers reject stream_options; retry once without it.
    if (!upstream.ok && upstream.status === 400 && openaiBody.stream_options) {
      const t = await upstream.text().catch(() => '');
      if (/stream_options|include_usage|unknown|unrecognized/i.test(t)) {
        log('retrying without stream_options');
        delete openaiBody.stream_options;
        upstream = await call(openaiBody);
      } else {
        log('upstream 400', t.slice(0, 300));
        return sendUpstreamError(res, 400, t);
      }
    }
  } catch (e) { log('upstream unreachable', netError(e)); return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'Could not reach ' + UPSTREAM + ': ' + netError(e) } }); }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    log('upstream', upstream.status, text.slice(0, 300));
    return sendUpstreamError(res, upstream.status, text);
  }
  if (openaiBody.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    try { await streamOpenAIToAnthropic(upstream, res, requestedModel); } catch (e) { log('stream error', e.message); try { res.end(); } catch {} }
    return;
  }
  let json;
  try { json = await upstream.json(); } catch (e) { return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'Bad upstream JSON: ' + e.message } }); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(openAIToAnthropic(json, requestedModel)));
}

// -------------------- server --------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;
  log(req.method, p);

  if (p === '/health') return sendJson(res, 200, { ok: true, api: API, providerName: cfg.providerName || 'Provider', upstream: UPSTREAM, models: MODELS });
  // Connectivity checks from Claude clients (e.g. `HEAD /api/hello`).
  if ((req.method === 'HEAD' || req.method === 'GET') && (p === '/' || p === '/api/hello')) return sendJson(res, 200, { ok: true });
  if (p === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, { object: 'list', data: MODELS.map((id) => ({ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' })) });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/v1/messages/count_tokens' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(body.length / 4)) });
  }
  if (p === '/v1/messages' && req.method === 'POST') {
    const body = await readBody(req);
    await ensureMode();
    let requestedModel = DEFAULT_MODEL, realModel = DEFAULT_MODEL;
    try { requestedModel = JSON.parse(body.toString('utf8')).model || DEFAULT_MODEL; } catch {}
    realModel = resolveModel(requestedModel);
    if (API === 'anthropic') {
      // rewrite model to the real provider id before pass-through
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (realModel !== j.model) { log('model map', j.model, '->', realModel); j.model = realModel; }
        delete j.modelDiscoveryEnabled;
        return forwardAnthropic(req, res, p, url.search, Buffer.from(JSON.stringify(j)));
      } catch { return forwardAnthropic(req, res, p, url.search, body); }
    }
    log('model map', requestedModel, '->', realModel, '(openai)');
    return forwardOpenAI(req, res, body, requestedModel);
  }
  return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: `No route for ${req.method} ${p}` } });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log(`port ${PORT} already in use — another gateway running?`);
  else log('server error:', e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  api=${API}`);
  log(`upstream ${UPSTREAM}`);
  log(`key ${KEY ? 'loaded' : 'MISSING'}`);
  log(`models ${MODELS.join(', ')}`);
  if (!KEY) log('WARNING: no API key configured');
  ensureMode().catch(() => {}); // resolve api mode so /health is accurate
});
