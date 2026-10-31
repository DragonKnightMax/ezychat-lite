// Shared helpers of the Dev Build check scripts: PASS/FAIL lines and a cookie-keeping API client.
// Never calls a model or a real WhatsApp number; the scripts point it at a local Dev Build.

/** One line of text for a log: control characters (new lines included) become spaces. */
export const oneLine = (value) => String(value).replace(/\p{Cc}+/gu, ' ');

/** PASS/FAIL lines and the number of failures. */
export function checker() {
  let failed = 0;
  const check = (ok, step, detail = '') => {
    if (!ok) failed++;
    const extra = detail === '' ? '' : '  (' + oneLine(detail) + ')';
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + step + extra);
  };
  const finish = () => {
    console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
    process.exit(failed ? 1 : 0);
  };
  return { check, finish };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** An eval check against a baseline run's result for the same key: '', ▲ fixed or ▼ REGRESSED. */
export function changeMark(baseline, key, ok) {
  if (!baseline.has(key) || baseline.get(key) === ok) return '';
  return ok ? '  ▲ fixed' : '  ▼ REGRESSED';
}

/** `api(method, '/path', body)` against `<base>/api`, keeping the session cookie; `reset()` signs out. */
export function apiClient(base) {
  let cookie = '';
  async function api(method, path, body) {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: {
        origin: base,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  api.reset = () => {
    cookie = '';
  };
  return api;
}

/** Calls `probe` once a second until it returns a truthy value or `ms` passes; returns the last value. */
export async function poll(probe, ms) {
  const end = Date.now() + ms;
  let value = await probe();
  while (!value && Date.now() < end) {
    await wait(1000);
    value = await probe();
  }
  return value;
}

/**
 * `api(method, path, body)` for one browser-like session (its own cookie) against the local Dev Build
 * at `base`: plain path segments only, never a URL outside it. Answers `{ status, json }`.
 */
export function cookieSession(base) {
  const api = apiClient(base);
  return (method, path, body) => {
    if (!/^(\/[\w%@.:?=&-]+)+$/.test(path) || path.split('/').some((p) => p === '..' || p === '.'))
      throw new Error(`Unexpected API path: ${path}`);
    if (new URL(`/api${path}`, base).origin !== base)
      throw new Error('Refusing a link outside the local Dev Build');
    return api(method, path, body);
  };
}

/**
 * A check session against e2e/agents-devbuild.ts (mock model, fake WhatsApp): refuses any other
 * server, then gives the API, PASS/FAIL lines and `signInAdmin()` (first-run admin `checker`).
 */
export async function devbuildClient(port) {
  const BASE = `http://127.0.0.1:${port}`;
  const health = await fetch(BASE + '/api/health');
  if (health.headers.get('x-agents-devbuild') !== 'mock-ai')
    throw new Error('Run this only against e2e/agents-devbuild.ts (mock model)');
  const api = cookieSession(BASE);
  const { check, finish } = checker();
  return {
    BASE,
    api,
    check,
    finish,
    wait,
    code: (r) => r.json?.error?.code ?? r.json?.error,
    async signInAdmin() {
      const admin = { username: 'checker', displayName: 'Checker', password: 'check-pass-123' };
      if ((await api('GET', '/setup/status')).json.needsSetup)
        await api('POST', '/setup/admin', admin);
      const login = await api('POST', '/auth/login', {
        username: admin.username,
        password: admin.password,
      });
      check(login.status === 200, 'admin signs in');
    },
  };
}
