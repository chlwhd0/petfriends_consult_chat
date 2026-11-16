// 로컬 시험용 중계 서버: .env의 API 키로 Claude API를 호출한다. 외부 패키지 없이 Node 기본 기능만 쓴다.
// 실행: node --env-file=.env server.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const KEY = process.env.ANTHROPIC_API_KEY;
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 4096; // 한국어는 글자당 토큰이 많아 넉넉히 둔다
const CUT_MARK = '\u0001CUT'; // 길이 제한으로 잘렸을 때 화면에 알리는 표시
const HTML = path.join(__dirname, 'public', 'index.html');

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function chat(req, res) {
  if (!KEY) return sendJson(res, 500, { code: 'no_key' });
  let body = '';
  for await (const c of req) body += c;
  let messages;
  try { messages = JSON.parse(body).messages; } catch (e) { return sendJson(res, 400, { code: 'bad_request' }); }
  if (!Array.isArray(messages) || !messages.length) return sendJson(res, 400, { code: 'bad_request' });

  const ctl = new AbortController();
  res.on('close', () => ctl.abort()); // 브라우저가 연결을 끊으면(중지 버튼) API 호출도 멈춘다
  let api;
  try {
    api = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages })
    });
  } catch (e) { return sendJson(res, 502, { code: 'network' }); }

  if (!api.ok) {
    const map = { 401: 'bad_key', 403: 'bad_key', 429: 'rate_limited', 413: 'prompt_too_large' };
    let detail = '';
    try { detail = (JSON.parse(await api.text()).error || {}).message || ''; } catch (e) {}
    console.error('Claude API 오류', api.status, detail);
    return sendJson(res, api.status, { code: map[api.status] || 'api_error' });
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of api.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(ev.delta.text);
          else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') res.write(CUT_MARK);
        } catch (e) {}
      }
    }
  } catch (e) {}
  res.end();
}

http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(HTML).pipe(res);
  }
  if (req.method === 'POST' && req.url === '/api/chat') return chat(req, res);
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log('http://localhost:' + PORT + ' 에서 실행 중 (모델: ' + MODEL + ', 최대 ' + MAX_TOKENS + '토큰)');
  if (!KEY) console.log('경고: .env에 ANTHROPIC_API_KEY가 없어요.');
});
