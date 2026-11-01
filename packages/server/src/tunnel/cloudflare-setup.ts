import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  CloudflareCreateBody,
  CloudflareDomain,
  type CloudflareSetupStatus,
  type TunnelStatus,
  type TunnelMode,
} from '@ezychat/shared';
import type { AppContext } from '../context.js';
import { errors, HttpError } from '../http/errors.js';
import {
  CloudflareApi,
  CloudflareApiError,
  CloudflareCredentials,
  decodeCloudflareCertificate,
} from './cloudflare-api.js';
import {
  TUNNEL_HOSTNAME_KEY,
  TUNNEL_MODE_KEY,
  TUNNEL_TOKEN_KEY,
  type TunnelService,
} from './manager.js';
import { readLines, stopChild } from './process.js';

export const CLOUDFLARE_AUTH_KEY = 'cloudflare_auth';
export const CLOUDFLARE_DOMAINS_KEY = 'cloudflare_domains';
export const CLOUDFLARE_OWNED_KEY = 'cloudflare_owned_tunnels';
export const CLOUDFLARE_MANAGED_KEY = 'cloudflare_managed_tunnel';
const Identifier = z.string().regex(/^[a-f0-9]{32}$/i);
const Hostname = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i);
const Zone = z.object({
  id: Identifier,
  name: Hostname,
  status: z.string(),
  account: z.object({ id: Identifier, name: z.string().nullable() }),
});
const Tunnel = z.object({
  id: z.string().uuid(),
  name: z.string(),
  config_src: z.enum(['cloudflare', 'local']),
  deleted_at: z.string().nullable().optional(),
});
const Owned = z.object({ id: z.string().uuid(), accountID: Identifier, name: z.string() });
const Managed = Owned.extend({
  hostname: Hostname,
  zoneID: Identifier,
  port: z.number(),
  tokenHash: z.string(),
});
/** Saved shapes of `CLOUDFLARE_OWNED_KEY` entries and `CLOUDFLARE_MANAGED_KEY` (Lite import reads them). */
export { Owned as CloudflareOwnedTunnel, Managed as CloudflareManagedTunnel };
const Record = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
});
const LOGIN_TIMEOUT_MS = 8 * 60 * 1000;

export interface CloudflareSetupService {
  status(): CloudflareSetupStatus;
  login(): Promise<CloudflareSetupStatus>;
  cancelLogin(): Promise<CloudflareSetupStatus>;
  refresh(): Promise<CloudflareSetupStatus>;
  create(body: z.infer<typeof CloudflareCreateBody>, actorId: number): Promise<TunnelStatus>;
  reconcileOrigin(): Promise<void>;
  shutdown(): Promise<void>;
}
export interface CloudflareSetupDeps {
  ctx: AppContext;
  tunnel: TunnelService;
  binPath: () => string | null;
  spawn?: typeof spawn;
  fetch?: typeof fetch;
}
interface LoginAttempt {
  child: ChildProcess;
  dir: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class CloudflareSetup implements CloudflareSetupService {
  private state: CloudflareSetupStatus['state'];
  private loginUrl: string | null = null;
  private error: string | null = null;
  private attempt: LoginAttempt | null = null;
  private generation = 0;
  private changing = false;
  private starting: Promise<CloudflareSetupStatus> | null = null;
  private work: Promise<unknown> | null = null;
  private finishing: Promise<void> | null = null;
  private closed = false;
  private readonly root: string;
  private readonly log;

  constructor(private readonly deps: CloudflareSetupDeps) {
    this.root = resolve(deps.ctx.config.dataDir, 'cloudflare');
    this.log = deps.ctx.log.child({ mod: 'cloudflare' });
    this.state = this.credentials() ? 'connected' : 'signed_out';
  }
  private credentials(): CloudflareCredentials | null {
    try {
      const value = this.deps.ctx.settings.getSecret(CLOUDFLARE_AUTH_KEY);
      return value ? CloudflareCredentials.parse(JSON.parse(value)) : null;
    } catch {
      return null;
    }
  }
  private api(credentials = this.credentials()): CloudflareApi {
    if (!credentials) throw errors.validation('Sign in to Cloudflare first.');
    return new CloudflareApi(credentials, this.log, this.deps.fetch);
  }
  private owned(): z.infer<typeof Owned>[] {
    return z.array(Owned).parse(this.deps.ctx.settings.get(CLOUDFLARE_OWNED_KEY, []));
  }
  private managed(): z.infer<typeof Managed> | null {
    return Managed.nullable().parse(this.deps.ctx.settings.get(CLOUDFLARE_MANAGED_KEY, null));
  }
  status(): CloudflareSetupStatus {
    const managed = this.managed();
    return {
      state: this.state,
      loginUrl: this.loginUrl,
      error: this.error,
      domains: z
        .array(CloudflareDomain)
        .parse(this.deps.ctx.settings.get(CLOUDFLARE_DOMAINS_KEY, [])),
      busy:
        this.changing || this.starting !== null || this.attempt !== null || this.finishing !== null,
      managed: managed ? { id: managed.id, name: managed.name, hostname: managed.hostname } : null,
    };
  }
  login(): Promise<CloudflareSetupStatus> {
    if (this.starting) return this.starting;
    const pending = this.beginLogin();
    this.starting = pending;
    const clear = () => {
      if (this.starting === pending) this.starting = null;
    };
    void pending.then(clear, clear);
    return pending;
  }
  private async beginLogin(): Promise<CloudflareSetupStatus> {
    if (this.closed) throw errors.conflict('Cloudflare setup is shutting down.');
    if (this.changing) throw errors.conflict('Finish the current Cloudflare setup first.');
    if (this.attempt || this.finishing) return this.status();
    const bin = this.deps.binPath();
    if (!bin || !isAbsolute(bin))
      throw new HttpError(
        503,
        'cloudflare_unavailable',
        'Cloudflare setup is not available on this computer. Reinstall the desktop app to restore cloudflared.',
      );
    this.state = 'signing_in';
    this.error = null;
    this.loginUrl = null;
    const generation = ++this.generation;
    const dir = join(this.root, `login-${randomUUID()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (generation !== this.generation || this.closed) {
      await this.clean(dir);
      throw errors.conflict('Cloudflare sign-in was cancelled.');
    }
    // cloudflared login writes to the child's home, not --origincert. Never touch the user's
    // existing .cloudflared account. PATH/cwd isolation also leaves opening the link to the UI.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        ![
          'home',
          'userprofile',
          'path',
          'tunnel_token',
          'tunnel_origin_cert',
          'tunnel_config',
          'tunnel_login_url',
          'tunnel_callback_url',
        ].includes(key.toLowerCase())
      )
        env[key] = value;
    }
    env.HOME = dir;
    env.USERPROFILE = dir;
    env.PATH = dir;
    let child: ChildProcess;
    try {
      child = (this.deps.spawn ?? spawn)(bin, ['tunnel', '--config=', '--no-autoupdate', 'login'], {
        cwd: dir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      await this.clean(dir);
      this.state = 'error';
      this.error = 'Cloudflare sign-in could not start. Please try again.';
      throw new HttpError(503, 'cloudflare_login', this.error);
    }
    const timer = setTimeout(() => {
      void this.cancelLogin().then(() => {
        if (!this.closed) {
          this.state = 'error';
          this.error = 'Cloudflare sign-in expired. Please start again.';
        }
      });
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
    this.attempt = { child, dir, generation, timer };
    const onLine = (line: string) => {
      if (generation !== this.generation || this.closed) return;
      for (const match of line.matchAll(
        /https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s<>"']+/g,
      )) {
        const url = new URL(match[0]);
        if (
          url.origin === 'https://dash.cloudflare.com' &&
          url.pathname === '/argotunnel' &&
          !url.username &&
          !url.password
        ) {
          this.loginUrl = url.href;
          this.state = 'awaiting_approval';
        }
      }
    };
    readLines(child.stdout, onLine);
    readLines(child.stderr, onLine);
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      const pending = this.finishLogin(dir, generation, code);
      this.finishing = pending;
      void pending.finally(() => {
        if (this.finishing === pending) this.finishing = null;
      });
    };
    child.once('error', () => finish(null));
    child.once('close', finish);
    this.log.info({ phase: 'login_started' }, 'Cloudflare sign-in started');
    return this.status();
  }
  private async finishLogin(dir: string, generation: number, code: number | null): Promise<void> {
    const current = () => generation === this.generation && !this.closed;
    try {
      if (!current()) return;
      if (this.attempt?.generation === generation) {
        clearTimeout(this.attempt.timer);
        this.attempt = null;
      }
      if (code !== 0) throw new Error();
      const pem = await readFile(join(dir, '.cloudflared', 'cert.pem'), 'utf8');
      const credentials = decodeCloudflareCertificate(pem);
      const domains = await this.loadDomains(credentials);
      if (!current()) return;
      this.deps.ctx.settings.setSecret(CLOUDFLARE_AUTH_KEY, JSON.stringify(credentials));
      this.deps.ctx.settings.set(CLOUDFLARE_DOMAINS_KEY, domains);
      this.state = 'connected';
      this.loginUrl = null;
      this.error = null;
      this.log.info(
        { phase: 'login_connected', domainCount: domains.length },
        'Cloudflare sign-in completed',
      );
    } catch {
      if (current()) {
        this.state = 'error';
        this.loginUrl = null;
        this.error =
          'Cloudflare sign-in was not completed. Please start again and approve your domain in Cloudflare.';
        this.log.warn({ phase: 'login_failed' }, 'Cloudflare sign-in failed');
      }
    } finally {
      await this.clean(dir);
    }
  }
  async cancelLogin(): Promise<CloudflareSetupStatus> {
    ++this.generation;
    if (this.starting) await this.starting.catch(() => undefined);
    const attempt = this.attempt;
    this.attempt = null;
    if (attempt) {
      clearTimeout(attempt.timer);
      await stopChild(attempt.child);
      await this.clean(attempt.dir);
    }
    if (this.finishing) await this.finishing;
    this.state = this.credentials() ? 'connected' : 'signed_out';
    this.error = null;
    this.loginUrl = null;
    return this.status();
  }
  private async loadDomains(
    credentials: CloudflareCredentials,
  ): Promise<z.infer<typeof CloudflareDomain>[]> {
    const api = this.api(credentials);
    const selected = (await api.request(`/zones/${credentials.zoneID}`, Zone, 'read your domain'))
      .result;
    if (selected.account.id !== credentials.accountID)
      throw errors.validation(
        'Cloudflare returned a domain in a different account. Please sign in again.',
      );
    const zones = new Map<string, z.infer<typeof Zone>>();
    if (selected.status === 'active') zones.set(selected.id, selected);
    try {
      for (let page = 1; page <= 100; page++) {
        const result = await api.request(
          `/zones?account.id=${credentials.accountID}&status=active&per_page=50&page=${page}`,
          z.array(Zone).max(50),
          'list your domains',
        );
        for (const zone of result.result)
          if (zone.account.id === credentials.accountID && zone.status === 'active')
            zones.set(zone.id, zone);
        if (page >= result.pages) break;
      }
    } catch {
      this.log.info(
        { phase: 'domains_selected_only' },
        'Cloudflare domain list limited to the authorised domain',
      );
    }
    return [...zones.values()]
      .map((zone) => ({
        id: zone.id,
        name: zone.name.toLowerCase(),
        accountName: zone.account.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  refresh(): Promise<CloudflareSetupStatus> {
    return this.runExclusive(() => this.refreshNow());
  }
  private async refreshNow(): Promise<CloudflareSetupStatus> {
    try {
      const credentials = this.credentials();
      if (!credentials) throw errors.validation('Sign in to Cloudflare first.');
      const domains = await this.loadDomains(credentials);
      this.deps.ctx.settings.set(CLOUDFLARE_DOMAINS_KEY, domains);
      this.state = 'connected';
      this.error = null;
      return this.status();
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof HttpError ? err.message : 'Could not refresh Cloudflare domains.';
      throw err;
    }
  }
  private config(hostname: string) {
    return {
      config: {
        ingress: [
          { hostname, service: `http://127.0.0.1:${this.deps.ctx.config.port}`, originRequest: {} },
          { service: 'http_status:404' },
        ],
      },
    };
  }
  create(input: z.infer<typeof CloudflareCreateBody>, actorId: number): Promise<TunnelStatus> {
    return this.runExclusive(() => this.createNow(input, actorId));
  }
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(errors.conflict('Cloudflare setup is shutting down.'));
    if (this.status().busy)
      return Promise.reject(errors.conflict('Finish the current Cloudflare setup first.'));
    this.changing = true;
    const pending = (async () => operation())().finally(() => {
      this.changing = false;
    });
    this.work = pending;
    return pending;
  }
  /** Startup restoration shares the same gate and shutdown tracking as administrator changes. */
  restore(): Promise<void> {
    return this.runExclusive(async () => {
      try {
        await this.reconcileOrigin();
      } catch {
        this.log.warn(
          { phase: 'origin_update_failed' },
          'Could not update the Cloudflare origin port',
        );
      }
      if (!this.closed) await this.deps.tunnel.restore();
    });
  }
  private async dnsRecords(api: CloudflareApi, zoneID: string, hostname: string) {
    return (
      await api.request(
        `/zones/${zoneID}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
        z.array(Record).max(100),
        'check this address',
      )
    ).result;
  }
  private async verifyTunnel(api: CloudflareApi, target: z.infer<typeof Owned>) {
    const existing = (
      await api.request(
        `/accounts/${target.accountID}/cfd_tunnel/${target.id}`,
        Tunnel,
        'verify your tunnel',
      )
    ).result;
    if (
      existing.id !== target.id ||
      existing.name !== target.name ||
      existing.deleted_at ||
      existing.config_src !== 'cloudflare'
    )
      throw errors.conflict('The saved Cloudflare tunnel has changed. Choose another tunnel name.');
  }
  private async configureTunnel(
    api: CloudflareApi,
    target: z.infer<typeof Owned>,
    hostname: string,
  ) {
    await api.request(
      `/accounts/${target.accountID}/cfd_tunnel/${target.id}/configurations`,
      z.object({ config: z.unknown() }).passthrough(),
      'connect the address',
      'PUT',
      this.config(hostname),
    );
  }
  private async createNow(
    input: z.infer<typeof CloudflareCreateBody>,
    actorId: number,
  ): Promise<TunnelStatus> {
    const body = CloudflareCreateBody.parse(input);
    if (!this.deps.binPath())
      throw new HttpError(
        503,
        'cloudflare_unavailable',
        'Reinstall the desktop app to restore Cloudflare access.',
      );
    const credentials = this.credentials();
    if (!credentials) throw errors.validation('Sign in to Cloudflare first.');
    if (!this.status().domains.some((zone) => zone.id === body.domainId))
      throw errors.validation('Choose a domain from your Cloudflare account.');
    this.error = null;
    try {
      const api = this.api(credentials);
      const zone = (await api.request(`/zones/${body.domainId}`, Zone, 'verify your domain'))
        .result;
      if (zone.account.id !== credentials.accountID || zone.status !== 'active')
        throw errors.validation(
          'This domain is not active in your Cloudflare account. Choose another domain or finish its Cloudflare setup.',
        );
      const hostname = Hostname.parse(`${body.subdomain}.${zone.name.toLowerCase()}`);
      const base = `/accounts/${credentials.accountID}/cfd_tunnel`;
      const owned = this.owned();
      let target = owned.find(
        (t) => t.accountID === credentials.accountID && t.name === body.tunnelName,
      );
      const records = await this.dnsRecords(api, zone.id, hostname);
      const isExpected = (record: z.infer<typeof Record>, id: string) =>
        record.name.toLowerCase().replace(/\.$/, '') === hostname &&
        record.type === 'CNAME' &&
        record.content.toLowerCase().replace(/\.$/, '') === `${id}.cfargotunnel.com` &&
        record.proxied === true;
      if (records.length && (!target || records.some((record) => !isExpected(record, target!.id))))
        throw errors.conflict(
          'This address is already in use. Choose another address so your existing website stays unchanged.',
        );
      const sameName = (
        await api.request(
          `${base}?name=${encodeURIComponent(body.tunnelName)}&is_deleted=false`,
          z.array(Tunnel),
          'check the tunnel name',
        )
      ).result;
      if (sameName.some((t) => t.name === body.tunnelName && (!target || t.id !== target.id)))
        throw errors.conflict('That tunnel name is already in use. Choose another name.');
      if (target) {
        await this.verifyTunnel(api, target);
      } else {
        if (owned.length >= 50)
          throw errors.conflict(
            'This app has already created 50 tunnels. Reuse an existing app tunnel name.',
          );
        const created = (
          await api.request(base, Tunnel, 'create the tunnel', 'POST', {
            name: body.tunnelName,
            config_src: 'cloudflare',
          })
        ).result;
        if (
          created.name !== body.tunnelName ||
          created.deleted_at ||
          created.config_src !== 'cloudflare'
        )
          throw new CloudflareApiError(502, 'create the tunnel');
        target = { id: created.id, accountID: credentials.accountID, name: body.tunnelName };
        // Persist ownership before the remaining steps: retry can resume after a DNS/API failure.
        this.deps.ctx.settings.set(CLOUDFLARE_OWNED_KEY, [...owned, target]);
      }
      // Recheck DNS after tunnel creation; never overwrite any existing DNS record.
      const latestRecords = await this.dnsRecords(api, zone.id, hostname);
      if (latestRecords.some((record) => !isExpected(record, target!.id)))
        throw errors.conflict('This address is already in use. Choose another address.');
      const runtimeToken = (
        await api.request(
          `${base}/${target.id}/token`,
          z.string().min(10).max(16384),
          'prepare the tunnel',
        )
      ).result;
      if (!latestRecords.length) {
        const created = (
          await api.request(`/zones/${zone.id}/dns_records`, Record, 'create the address', 'POST', {
            type: 'CNAME',
            name: hostname,
            content: `${target.id}.cfargotunnel.com`,
            proxied: true,
            ttl: 1,
          })
        ).result;
        if (!isExpected(created, target.id))
          throw new CloudflareApiError(502, 'create the address');
      }
      // Keep a working tunnel's old ingress until the new DNS record is safely created.
      await this.configureTunnel(api, target, hostname);
      const managed = {
        ...target,
        hostname,
        zoneID: zone.id,
        port: this.deps.ctx.config.port,
        tokenHash: tokenHash(runtimeToken),
      };
      this.deps.ctx.settings.set(CLOUDFLARE_MANAGED_KEY, managed);
      const status = await this.deps.tunnel.start(
        { mode: 'named', token: runtimeToken, hostname },
        actorId,
      );
      this.log.info(
        { phase: 'provisioned', tunnelId: target.id, hostname, port: managed.port },
        'Cloudflare address configured',
      );
      return status;
    } catch (err) {
      this.log.warn(
        { phase: 'provision_failed', code: err instanceof HttpError ? err.code : 'unexpected' },
        'Cloudflare setup failed',
      );
      if (err instanceof HttpError) throw err;
      throw new HttpError(
        502,
        'cloudflare_setup',
        'Cloudflare setup could not finish. Please try again.',
      );
    }
  }
  async reconcileOrigin(): Promise<void> {
    const managed = this.managed();
    const credentials = this.credentials();
    const runtimeToken = this.deps.ctx.settings.getSecret(TUNNEL_TOKEN_KEY);
    if (
      !managed ||
      !credentials ||
      managed.accountID !== credentials.accountID ||
      managed.port === this.deps.ctx.config.port ||
      this.deps.ctx.settings.get<TunnelMode>(TUNNEL_MODE_KEY, 'off') !== 'named' ||
      !runtimeToken ||
      tokenHash(runtimeToken) !== managed.tokenHash ||
      this.deps.ctx.settings.get<string | null>(TUNNEL_HOSTNAME_KEY, null) !== managed.hostname
    )
      return;
    const api = this.api(credentials);
    await this.verifyTunnel(api, managed);
    await this.configureTunnel(api, managed, managed.hostname);
    this.deps.ctx.settings.set(CLOUDFLARE_MANAGED_KEY, {
      ...managed,
      port: this.deps.ctx.config.port,
    });
    this.log.info(
      { phase: 'origin_updated', port: this.deps.ctx.config.port },
      'Cloudflare origin port updated',
    );
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.cancelLogin();
    await this.work?.catch(() => undefined);
  }
  private async clean(dir: string): Promise<void> {
    const target = resolve(dir);
    if (
      !target.startsWith(this.root + sep) ||
      !/^login-[a-f0-9-]+$/.test(target.slice(this.root.length + 1))
    )
      throw new Error('Invalid Cloudflare login cleanup path');
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      this.log.warn(
        { phase: 'login_cleanup_failed' },
        'Could not remove temporary Cloudflare login files',
      );
    }
  }
}
