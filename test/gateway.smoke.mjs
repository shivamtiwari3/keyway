#!/usr/bin/env node
// End-to-end smoke test for gateway.mjs against fake upstreams. No dependencies.
//
//   node test/gateway.smoke.mjs
//
// Spins up a fake OpenAI-compatible and a fake Anthropic-compatible provider,
// runs the gateway against each, and checks translation, streaming, tool calls
// and model mapping.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-test-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}
function listen(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const portOf = (s) => s.address().port;

// ---------- fake OpenAI provider ----------
const openaiSeen = [];
const openai = await listen(async (req, res) => {
  const body = await readBody(req);
  openaiSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
  if (req.url === '/v1/messages') { res.writeHead(404); return res.end(); } // not Anthropic
  if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
  if (req.url !== '/chat/completions') { res.writeHead(404); return res.end(); }
  const j = JSON.parse(body);
  const wantsTool = Array.isArray(j.tools) && j.tools.length;
  if (!j.stream) {
    const message = wantsTool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Mumbai"}' } }] }
      : { role: 'assistant', content: 'hello from openai' };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message, finish_reason: wantsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (wantsTool) {
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'get_weather', arguments: '{"ci' } }] } }] });
    chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Pune"}' } }] } }] });
    chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    chunk({ choices: [{ delta: { content: 'hel' } }] });
    chunk({ choices: [{ delta: { content: 'lo' } }] });
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  }
  chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  res.write('data: [DONE]\n\n');
  res.end();
});

// ---------- fake Anthropic provider ----------
const anthropicSeen = [];
const anthropic = await listen(async (req, res) => {
  const body = await readBody(req);
  anthropicSeen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
  if (req.url !== '/v1/messages') { res.writeHead(404); return res.end(); }
  const j = JSON.parse(body);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'hello from anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
});

// ---------- gateway runner ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keyway-smoke-'));
const children = [];

async function startGateway(name, port, cfg) {
  const cfgPath = path.join(tmp, name + '.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ host: '127.0.0.1', port, apiKey: KEY, log: false, ...cfg }));
  const child = spawn(process.execPath, [path.join(ROOT, 'gateway.mjs')], { env: { ...process.env, KEYWAY_CONFIG: cfgPath, PROVIDER_API_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) return base; } catch {}
    await sleep(100);
  }
  throw new Error(`gateway ${name} did not start:\n${stderr}`);
}

const post = (base, body) => fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer keyway-local' }, body: JSON.stringify(body) });

function parseSSE(text) {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const ev = /^event: (.*)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    return { event: ev && ev[1], data: data && JSON.parse(data[1]) };
  });
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name, e]); }
}

const basePort = 18000 + Math.floor(Math.random() * 2000);
try {
  const oa = await startGateway('openai', basePort, {
    upstream: `http://127.0.0.1:${portOf(openai)}`, api: 'auto',
    defaultModel: 'gpt-test', models: [{ name: 'claude-sonnet-4-5' }], modelMap: { 'claude-sonnet-4-5': 'gpt-test' },
  });

  await test('health reports detected openai mode', async () => {
    await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
    const h = await (await fetch(oa + '/health')).json();
    assert.equal(h.api, 'openai');
  });

  await test('answers client connectivity checks (HEAD /api/hello)', async () => {
    const r = await fetch(oa + '/api/hello', { method: 'HEAD' });
    assert.equal(r.status, 200);
  });

  await test('/v1/models lists advertised routes', async () => {
    const j = await (await fetch(oa + '/v1/models')).json();
    assert.deepEqual(j.data.map((m) => m.id), ['claude-sonnet-4-5']);
  });

  await test('non-streaming text: translation + model map + auth', async () => {
    const r = await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 50, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.type, 'message');
    assert.equal(j.content[0].text, 'hello from openai');
    assert.equal(j.stop_reason, 'end_turn');
    assert.equal(j.usage.input_tokens, 7);
    const sent = openaiSeen.filter((s) => s.url === '/chat/completions').at(-1);
    assert.equal(sent.body.model, 'gpt-test');
    assert.equal(sent.auth, `Bearer ${KEY}`);
    assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'be brief' });
  });

  await test('non-streaming tool call', async () => {
    const r = await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'weather?' }], tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }] });
    const j = await r.json();
    assert.equal(j.stop_reason, 'tool_use');
    assert.equal(j.content[0].type, 'tool_use');
    assert.deepEqual(j.content[0].input, { city: 'Mumbai' });
  });

  await test('tool_result round-trip becomes OpenAI tool message', async () => {
    await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 50, messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Mumbai' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '31C' }] },
    ] });
    const sent = openaiSeen.filter((s) => s.url === '/chat/completions').at(-1).body.messages;
    assert.equal(sent[1].tool_calls[0].function.name, 'get_weather');
    assert.deepEqual(sent[2], { role: 'tool', tool_call_id: 'call_1', content: '31C' });
  });

  await test('streaming text emits Anthropic SSE sequence', async () => {
    const r = await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const events = parseSSE(await r.text());
    assert.deepEqual(events.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join(''), 'hello');
    assert.equal(events.find((e) => e.event === 'message_delta').data.usage.output_tokens, 2);
  });

  await test('streaming tool call emits input_json_delta', async () => {
    const r = await post(oa, { model: 'claude-sonnet-4-5', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'weather?' }], tools: [{ name: 'get_weather', input_schema: { type: 'object' } }] });
    const events = parseSSE(await r.text());
    const start = events.find((e) => e.event === 'content_block_start');
    assert.equal(start.data.content_block.type, 'tool_use');
    assert.equal(start.data.content_block.name, 'get_weather');
    const json = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { city: 'Pune' });
    assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  });

  const an = await startGateway('anthropic', basePort + 1, {
    upstream: `http://127.0.0.1:${portOf(anthropic)}`, api: 'auto',
    defaultModel: 'real-model', models: [{ name: 'claude-opus-4-5' }], modelMap: { 'claude-opus-4-5': 'real-model' },
  });

  await test('anthropic pass-through rewrites model and swaps auth', async () => {
    const r = await post(an, { model: 'claude-opus-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.content[0].text, 'hello from anthropic');
    const sent = anthropicSeen.at(-1);
    assert.equal(sent.body.model, 'real-model');
    assert.equal(sent.auth, `Bearer ${KEY}`);
    const h = await (await fetch(an + '/health')).json();
    assert.equal(h.api, 'anthropic');
  });

  await test('keyway/<hex> ids decode to provider model', async () => {
    const id = 'keyway/' + Buffer.from('some/model.v2').toString('hex');
    await post(an, { model: id, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(anthropicSeen.at(-1).body.model, 'some/model.v2');
  });
} finally {
  for (const c of children) c.kill();
  openai.close(); anthropic.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [status, name, err] of results) {
  console.log(`${status === 'ok' ? '✓' : '✗'} ${name}`);
  if (err) { failed++; console.log('   ', err.message); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
