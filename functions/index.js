// 배포용 챗봇 중계 함수: 로컬 server.js와 같은 일을 Firebase Cloud Functions가 대신한다.
// API 키는 코드에 두지 않고 Secret Manager(ANTHROPIC_API_KEY)에서 읽는다.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2048;
const CUT_MARK = '\u0001CUT'; // 길이 제한으로 잘렸을 때 화면에 알리는 표시 (server.js와 같은 약속)

/* 비용 보호 ① 요청 모양 제한 */
const MAX_MESSAGES = 40, MAX_CHARS = 60000;
/* 비용 보호 ② 사용자(IP)별 호출 한도. 함수 인스턴스마다 따로 세는 간이 방식이라 완전하지는 않다. */
const PER_MINUTE = 10, PER_DAY = 120;
const hits = new Map(); // ip -> { min: [시각...], day: 'YYYY-MM-DD', n: 오늘 횟수 }

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || 'unknown';
}
function limited(ip) {
  const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
  if (hits.size > 5000) hits.clear(); // 메모리가 무한히 커지지 않게
  const h = hits.get(ip) || { min: [], day: today, n: 0 };
  if (h.day !== today) { h.day = today; h.n = 0; }
  h.min = h.min.filter((t) => now - t < 60000);
  if (h.min.length >= PER_MINUTE || h.n >= PER_DAY) { hits.set(ip, h); return true; }
  h.min.push(now); h.n++; hits.set(ip, h);
  return false;
}
function badRequest(res, code) { res.status(400).json({ code: code || 'bad_request' }); }

exports.chat = onRequest(
  {
    region: 'asia-northeast3', // 서울
    secrets: [ANTHROPIC_API_KEY],
    maxInstances: 3, // 동시에 늘어나는 서버 수를 제한해 비용 폭주를 막는다
    timeoutSeconds: 60,
    memory: '256MiB',
    cors: false // 같은 사이트(Hosting)에서만 부르므로 CORS를 열지 않는다
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ code: 'method' }); return; }
    const key = ANTHROPIC_API_KEY.value();
    if (!key) { res.status(500).json({ code: 'no_key' }); return; }
    if (limited(clientIp(req))) { res.status(429).json({ code: 'rate_limited' }); return; }

    const body = req.body || {};
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return badRequest(res);
    let chars = 0;
    for (const m of messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return badRequest(res);
      chars += m.content.length;
    }
    if (chars > MAX_CHARS) { res.status(413).json({ code: 'prompt_too_large' }); return; }
    const clean = messages.map((m) => ({ role: m.role, content: m.content }));

    const ctl = new AbortController();
    res.on('close', () => ctl.abort()); // 브라우저가 연결을 끊으면(중지 버튼) API 호출도 멈춘다
    let api;
    try {
      api = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, messages: clean })
      });
    } catch (e) { res.status(502).json({ code: 'network' }); return; }

    if (!api.ok) {
      const map = { 401: 'bad_key', 403: 'bad_key', 429: 'rate_limited', 413: 'prompt_too_large' };
      let detail = '';
      try { detail = (JSON.parse(await api.text()).error || {}).message || ''; } catch (e) { /* 무시 */ }
      console.error('Claude API 오류', api.status, detail);
      res.status(api.status >= 500 ? 502 : api.status).json({ code: map[api.status] || 'api_error' });
      return;
    }

    res.status(200);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
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
          } catch (e) { /* 한 줄이 깨져도 계속 */ }
        }
      }
    } catch (e) { /* 연결이 끊긴 경우 */ }
    res.end();
  }
);
