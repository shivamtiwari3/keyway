#!/usr/bin/env node
// Fake OpenAI-compatible provider for manually testing Keyway end to end with
// Claude Desktop, without a real API key. Replies with a canned, streamed
// message that echoes what you typed.
//
//   node test/fake-provider.mjs [port]      (default 11500)
//
// Then install Keyway with endpoint http://127.0.0.1:11500/v1, any key.
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.FAKE_PORT || 11500);
process.title = 'Keyway fake provider';

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  }
  return '';
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"not found"}}');
    }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const said = lastUserText(body.messages).slice(0, 200);
    const text = `Hello from Keyway's fake provider — the gateway works on ${process.platform}. ` +
      `Model "${body.model}" received your message: "${said}"`;
    console.log(new Date().toISOString(), body.stream ? 'stream' : 'json', body.model, JSON.stringify(said));

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const words = text.split(/(?<= )/);
    let i = 0;
    const tick = setInterval(() => {
      if (i < words.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`);
        return;
      }
      clearInterval(tick);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: words.length } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 40);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake provider on http://127.0.0.1:${PORT}/v1 — close this window to stop`));
