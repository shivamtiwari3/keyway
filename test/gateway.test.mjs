// Functional tests for the Keyway gateway: starts a mock OpenAI-compatible
// provider and drives the real gateway against it. No dependencies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const PORT = 18998;
let mock, mockPort, gw;

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      }
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          if (parsed.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hello ' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'from mock' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-mock',
            choices: [{ message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    mock.listen(0, '127.0.0.1', () => { mockPort = mock.address().port; resolve(); });
  });
}

function waitHealth(ms = 5000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = async () => {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return resolve(); } catch {}
      if (Date.now() > end) return reject(new Error('gateway did not start'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

before(async () => {
  await startMock();
  const cfgPath = path.join(os.tmpdir(), `keyway-test-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    host: '127.0.0.1', port: PORT, api: 'openai', providerName: 'Mock',
    upstream: `http://127.0.0.1:${mockPort}`, apiKey: 'test',
    defaultModel: 'mock-model', models: ['claude-sonnet-4-5'],
    modelMap: { 'claude-sonnet-4-5': 'mock-model' }, log: false,
  }));
  gw = spawn(process.execPath, [path.join(ROOT, 'gateway.mjs')], {
    env: { ...process.env, KEYWAY_CONFIG: cfgPath }, stdio: 'ignore',
  });
  await waitHealth();
});

after(() => { gw?.kill(); mock?.close(); });

const call = (body, host) => fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(host ? { host } : {}) },
  body: JSON.stringify(body),
});

test('health is ok', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('translates OpenAI response to Anthropic (non-stream)', async () => {
  const r = await call({ model: 'claude-sonnet-4-5', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.content[0].text, 'hello from mock');
  assert.equal(j.usage.input_tokens, 3);
});

test('translates streaming SSE to Anthropic events', async () => {
  const r = await call({ model: 'claude-sonnet-4-5', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"hello "/);
  assert.match(text, /event: message_stop/);
});

test('count_tokens is answered locally', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages/count_tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello there' }] }),
  });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).input_tokens > 0);
});

test('rejects a non-loopback Host (DNS rebinding guard)', async () => {
  // fetch() overrides Host, so use a raw request to spoof it.
  const status = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', host: 'evil.example.com' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end(JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] }));
  });
  assert.equal(status, 403);
});
