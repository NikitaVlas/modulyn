// «Браузер» для интеграционных тестов: cookies раздельно по хостам (как без атрибута Domain), Origin, формы.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export const host = label => label + '.localhost:8080';
export const origin = label => 'http://' + host(label);
export const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

export class Browser {
  constructor(port) { this.port = port; this.jars = new Map(); this.ip = randomIp(); }
  jar(h) { if (!this.jars.has(h)) this.jars.set(h, new Map()); return this.jars.get(h); }
  cookieHeader(h) { return [...this.jar(h)].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(h, setCookies = []) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';').map(s => s.trim());
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      const expired = attrs.some(a => /^max-age=0$/i.test(a)) || attrs.some(a => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date());
      if (expired || value === '') this.jar(h).delete(name); else this.jar(h).set(name, value);
    }
  }
  get(label, path, opts = {}) { return this.send('GET', label, path, opts); }
  post(label, path, body = {}, opts = {}) { return this.send('POST', label, path, { origin: origin(label), json: body, ...opts }); }
  patch(label, path, body = {}, opts = {}) { return this.send('PATCH', label, path, { origin: origin(label), json: body, ...opts }); }
  send(method, label, path, { json, form, origin: o, headers = {}, noCookies = false } = {}) {
    const h = host(label);
    let payload;
    const hdrs = { Host: h, 'X-Forwarded-For': this.ip, ...headers };
    if (json !== undefined) { payload = JSON.stringify(json); hdrs['content-type'] = 'application/json'; }
    if (form !== undefined) { payload = new URLSearchParams(form).toString(); hdrs['content-type'] = 'application/x-www-form-urlencoded'; }
    if (o) hdrs.Origin = o;
    // Как браузер: длина тела всегда указана (для DELETE Node иначе отправит тело без длины и без chunked).
    if (payload !== undefined) hdrs['content-length'] = String(Buffer.byteLength(payload));
    const cookie = noCookies ? '' : this.cookieHeader(h);
    if (cookie) hdrs.Cookie = cookie;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: this.port, method, path, headers: hdrs }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          this.store(h, res.headers['set-cookie']);
          let parsed; try { parsed = JSON.parse(body); } catch { parsed = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Полный переход app → компания: start → issue → complete (пересылка) → finish. */
  async enter(slug) {
    const start = await this.get(slug, '/api/auth/handoff/start');
    if (start.status !== 303) return start;
    const issueUrl = new URL(start.headers.location);
    const issue = await this.get('app', issueUrl.pathname + issueUrl.search);
    if (issue.status !== 200) return issue;
    const field = (body, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(body)?.[1];
    const relay = await this.send('POST', slug, '/api/auth/handoff/complete', {
      origin: origin('app'), form: { code: field(issue.body, 'code'), state: field(issue.body, 'state') }, noCookies: true,
    });
    assert.equal(relay.status, 200);
    return this.send('POST', slug, '/api/auth/handoff/finish', {
      origin: origin(slug), form: { code: field(relay.body, 'code'), state: field(relay.body, 'state') },
    });
  }
}

/** Ссылка из последнего письма на адрес (почта в тестах — SMTP_URL=memory:). path: 'invite' или 'reset-password'. */
export function mailToken(outbox, email, path = 'invite') {
  const mail = [...outbox].reverse().find(m => m.to === email);
  if (!mail) return null;
  return new RegExp(`/${path}#([A-Za-z0-9_-]+)`).exec(mail.text)?.[1] ?? null;
}
