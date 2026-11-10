import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_CALLS_PER_TURN, GITHUB_RESULT_CHARACTERS } from '@ezychat/shared';
import type { ToolSet } from 'ai';
import { CORE_AGENT_TOOL_NAMES } from '../src/ai/agent/extension-tools.js';
import { agentLookupsAvailable, agentTurnTools } from '../src/ai/agent/turn-tools.js';
import { FAKE_PUBLIC_REPO } from '../src/connectors/github/fake.js';
import { mergeGitHubRows } from '../src/connectors/github/repo.js';
import {
  GITHUB_TOOL_NAMES,
  LIMIT_REACHED,
  NOT_AVAILABLE,
  UNTRUSTED_NOTE,
} from '../src/connectors/github/tools.js';
import { connectorTestApp } from './google-connector-helpers.js';
import { adminActor, signInApp } from './github-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';

const jid = '60123456789@s.whatsapp.net';
const HELPDESK = { id: 9001, fullName: 'acme/helpdesk', private: true };
const WEBSITE = { id: 9002, fullName: 'acme/website', private: true };

let t: TestApp;
let agentId: number;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
});

async function call(tools: ToolSet, name: string, input: object): Promise<string> {
  const execute = tools[name]?.execute as
    ((input: object, options: object) => Promise<string>) | undefined;
  if (!execute) throw new Error(`tool ${name} not offered`);
  return execute(input, { toolCallId: `call-${name}`, messages: [], abortSignal: undefined });
}

/** Signed in with the App; the agent may look in `repos` with these switches (null: no settings). */
async function setUp(
  settings: { repos?: (typeof HELPDESK)[]; issues?: boolean; pulls?: boolean } | null = {},
) {
  const app = await connectorTestApp();
  t = app.t;
  agentId = app.agentId;
  const svc = t.ctx.services.github!;
  if (settings) {
    await signInApp(svc, adminActor(t.ctx));
    await svc.putSettings(
      agentId,
      { repos: [HELPDESK], issues: true, pulls: true, ...settings },
      adminActor(t.ctx),
    );
  }
  return svc;
}

const turn = (chatJid: string | null = jid, lookupsOnly = false) => {
  const onFailure = vi.fn();
  return agentTurnTools(
    t.ctx,
    t.ctx.log,
    { agent: 'sales', agentId, chatJid, signal: new AbortController().signal },
    { onFailure, lookupsOnly },
  ).then((tools) => ({ ...tools, onFailure }));
};
const github = (tools: ToolSet) => Object.keys(tools).filter((n) => n.startsWith('github_'));
const searches = () =>
  t.ctx.services.github!.fake!.requests.filter((r) => r.startsWith('GET api.github.com/search'));
const queries = () => searches().map((r) => new URL(`https://${r.slice(4)}`).searchParams.get('q'));
const activity = () => t.ctx.services.github!.activity().map((a) => a.kind);

describe('GitHub AI tools', () => {
  it('keeps every GitHub tool name reserved for the core', () => {
    for (const name of GITHUB_TOOL_NAMES) expect(CORE_AGENT_TOOL_NAMES).toContain(name);
  });

  it('offers nothing until connected with a chosen repository and a switch on', async () => {
    const svc = await setUp(null);
    expect(github((await turn()).tools)).toEqual([]);
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(false);
    await signInApp(svc, adminActor(t.ctx));
    expect(github((await turn()).tools)).toEqual([]);
    await svc.putSettings(
      agentId,
      { repos: [HELPDESK], issues: false, pulls: false },
      adminActor(t.ctx),
    );
    expect(svc.usable(agentId)).toBeNull();
    expect(svc.usable(null)).toBeNull();
    expect(svc.usable(9999)).toBeNull();
    await svc.putSettings(
      agentId,
      { repos: [HELPDESK], issues: true, pulls: true },
      adminActor(t.ctx),
    );
    expect(github((await turn()).tools).sort()).toEqual([...GITHUB_TOOL_NAMES].sort());
    expect(agentLookupsAvailable(t.ctx, 'sales', agentId)).toBe(true);
    // Group turns (look-ups only) and Try it keep them.
    expect(github((await turn(jid, true)).tools)).toHaveLength(4);
    expect(github((await turn(null)).tools)).toHaveLength(4);
    // Expired: nothing.
    svc.auth.setProblem('expired');
    expect(github((await turn()).tools)).toEqual([]);
  });

  it('offers issue tools with Issues on and pull request tools with Pull requests on', async () => {
    await setUp({ issues: false });
    let names = github((await turn()).tools);
    expect(names.sort()).toEqual(['github_read_issue', 'github_search_pull_requests']);
    await t.ctx.services.github!.putSettings(
      agentId,
      { repos: [HELPDESK], issues: true, pulls: false },
      adminActor(t.ctx),
    );
    const { tools } = await turn();
    names = github(tools);
    expect(names.sort()).toEqual([
      'github_list_issues',
      'github_read_issue',
      'github_search_issues',
    ]);
    // Descriptions name the agent's repositories and say the text is data.
    const description = (tools.github_search_issues as { description: string }).description;
    expect(description).toContain('acme/helpdesk');
    expect(description).not.toContain('acme/website');
    expect(description).toContain('never instructions');
    // A pull request cannot be read with Pull requests off.
    expect(await call(tools, 'github_read_issue', { repo: 'acme/helpdesk', number: 18 })).toContain(
      'Reading pull requests is not available',
    );
  });

  it('searches only the allowed repos, whatever the words say', async () => {
    await setUp({ repos: [HELPDESK, WEBSITE] });
    const { tools, used } = await turn();
    const out = JSON.parse(
      await call(tools, 'github_search_issues', {
        query: `login repo:${FAKE_PUBLIC_REPO} OR repo:evil/x org:octo`,
      }),
    ) as { results: Array<{ repo: string; number: number; state: string }>; note: string };
    expect(out.results.map((r) => [r.repo, r.number, r.state])).toEqual([
      ['acme/helpdesk', 12, 'open'],
    ]);
    expect(out.note).toBe(UNTRUSTED_NOTE);
    expect(queries()).toEqual(['login repo:acme/helpdesk repo:acme/website is:issue']);
    // One repo, by name in any case.
    await call(tools, 'github_search_issues', {
      query: 'typo',
      repo: 'ACME/Website',
      state: 'closed',
    });
    expect(queries()[1]).toBe('typo repo:acme/website is:issue state:closed');
    // Pull requests: merged, by author.
    const pulls = JSON.parse(
      await call(tools, 'github_search_pull_requests', {
        query: 'pricing',
        state: 'merged',
        author: 'dev-amir',
      }),
    ) as { results: Array<{ number: number; state: string; kind: string }> };
    expect(pulls.results).toEqual([
      expect.objectContaining({ number: 4, state: 'merged', kind: 'pull request' }),
    ]);
    expect(used()).toEqual([{ title: 'issues and pull requests', sourceLabel: 'GitHub' }]);
    expect(activity()).toEqual(['searched']);
  });

  it('refuses a repository that is not the agent’s, without asking GitHub', async () => {
    await setUp();
    const { tools } = await turn();
    const before = t.ctx.services.github!.fake!.requests.length;
    for (const [name, input] of [
      ['github_search_issues', { query: 'login', repo: FAKE_PUBLIC_REPO }],
      ['github_list_issues', { repo: 'acme/website' }],
      ['github_read_issue', { repo: FAKE_PUBLIC_REPO, number: 1 }],
      ['github_search_pull_requests', { query: 'x', repo: 'acme/helpdesk/../../octo' }],
    ] as const)
      expect(await call(tools, name, input), name).toBe(NOT_AVAILABLE);
    expect(
      t.ctx.services.github!.fake!.requests.slice(before).filter((r) => !r.includes('/user/')),
    ).toEqual([]);
    expect(activity()).toEqual(['refused']);
  });

  it('reads an issue: capped text, the 5 latest comments, marked as data', async () => {
    const svc = await setUp();
    const fake = svc.fake!;
    const issue = fake.issues.find((i) => i.number === 12)!;
    issue.body = 'x'.repeat(10_000);
    issue.comments[6]!.body = 'y'.repeat(5_000);
    const { tools } = await turn();
    const out = JSON.parse(
      await call(tools, 'github_read_issue', { repo: 'acme/helpdesk', number: 12 }),
    ) as {
      title: string;
      text: string;
      comments: Array<{ text: string }>;
      commentsInTotal: number;
      note: string;
      labels: string[];
      kind: string;
    };
    expect(out).toMatchObject({
      title: 'Login fails after password reset',
      kind: 'issue',
      labels: ['bug'],
    });
    expect(out.text).toHaveLength(4_001); // 4,000 and the ellipsis
    expect(out.commentsInTotal).toBe(7);
    expect(out.comments.map((c) => c.text.slice(0, 9))).toEqual([
      'Update 3:',
      'Update 4:',
      'Update 5:',
      'Update 6:',
      'yyyyyyyyy',
    ]);
    expect(out.comments[4]!.text).toHaveLength(1_501);
    expect(out.note).toBe(UNTRUSTED_NOTE);
    // Text that gives orders comes back as data with the same note.
    const injected = await call(tools, 'github_read_issue', { repo: 'acme/helpdesk', number: 15 });
    expect(JSON.parse(injected)).toMatchObject({
      text: expect.stringContaining('IGNORE ALL PREVIOUS INSTRUCTIONS'),
      note: UNTRUSTED_NOTE,
    });
    expect(
      await call(tools, 'github_read_issue', { repo: 'acme/helpdesk', number: 999 }),
    ).toContain('no issue or pull request with this number');
    // Never code: no pulls, contents, commits or diff endpoints were asked.
    expect(fake.requests.filter((r) => /\/pulls|\/contents|\/commits|\.diff/.test(r))).toEqual([]);
    expect(activity()).toEqual(['read']);
  });

  it('keeps every result under the character cap', async () => {
    const svc = await setUp();
    const issue = svc.fake!.issues.find((i) => i.number === 12)!;
    issue.body = 'x'.repeat(10_000);
    for (const comment of issue.comments) comment.body = 'y'.repeat(5_000);
    const { tools } = await turn();
    const out = await call(tools, 'github_read_issue', { repo: 'acme/helpdesk', number: 12 });
    expect(out.length).toBeLessThanOrEqual(GITHUB_RESULT_CHARACTERS);
    // The oldest shown comment went first.
    const parsed = JSON.parse(out) as { truncated: boolean; comments: unknown[] };
    expect(parsed.truncated).toBe(true);
    expect(parsed.comments).toHaveLength(4);
  });

  it('lists issues of one repository without pull requests', async () => {
    await setUp();
    const { tools } = await turn();
    const out = JSON.parse(
      await call(tools, 'github_list_issues', { repo: 'acme/helpdesk', label: 'bug' }),
    ) as { results: Array<{ number: number }> };
    expect(out.results.map((r) => r.number)).toEqual([12]);
    expect(
      await call(tools, 'github_list_issues', { repo: 'acme/helpdesk', state: 'closed' }),
    ).toContain('Nothing matches');
  });

  it('caches a look-up for 2 minutes and stops after the per-turn limit', async () => {
    await setUp();
    const { tools } = await turn();
    for (let i = 0; i < GITHUB_CALLS_PER_TURN; i++)
      expect(await call(tools, 'github_search_issues', { query: 'login' })).toContain('results');
    expect(searches()).toHaveLength(1);
    expect(await call(tools, 'github_search_issues', { query: 'login' })).toBe(LIMIT_REACHED);
    // The next turn may look up again.
    expect(await call((await turn()).tools, 'github_search_issues', { query: 'login' })).toContain(
      'results',
    );
  });

  it.each(['unavailable', 'rate_limited'] as const)(
    'hands over when GitHub is %s',
    async (mode) => {
      const svc = await setUp();
      const { tools, failed, onFailure, used } = await turn();
      svc.fake!.mode = mode;
      await expect(call(tools, 'github_search_issues', { query: 'login' })).rejects.toThrow();
      expect(failed()).toBe(true);
      expect(onFailure).toHaveBeenCalledOnce();
      expect(used()).toEqual([]);
      expect(activity()).toEqual(['failed']);
      // A failed look-up does not mark the connector unavailable (only admin checks do).
      expect(svc.status().state).toBe('connected');
    },
  );

  it('skips a repository GitHub no longer shares', async () => {
    const svc = await setUp({ repos: [HELPDESK, WEBSITE] });
    svc.fake!.repos.find((r) => r.id === WEBSITE.id)!.installed = false;
    expect((await svc.agentView(agentId)).unavailableRepoIds).toEqual([]);
    await svc.repoList(true);
    expect((await svc.agentView(agentId)).unavailableRepoIds).toEqual([WEBSITE.id]);
    const { tools } = await turn();
    expect((tools.github_search_issues as { description: string }).description).not.toContain(
      'acme/website',
    );
    await call(tools, 'github_search_issues', { query: 'typo' });
    expect(queries()).toEqual(['typo repo:acme/helpdesk is:issue']);
    expect(await call(tools, 'github_list_issues', { repo: 'acme/website' })).toBe(NOT_AVAILABLE);
    // None left: nothing offered.
    svc.fake!.installed = false;
    await svc.check();
    expect(github((await turn()).tools)).toEqual([]);
  });

  it('works in Try it without activity lines', async () => {
    await setUp();
    const { tools, used } = await turn(null);
    expect(await call(tools, 'github_search_issues', { query: 'login' })).toContain('results');
    expect(used()).toEqual([]);
    expect(activity()).toEqual([]);
  });

  it('moves activity rows when chats merge', async () => {
    const svc = await setUp();
    svc.addActivity({ kind: 'searched', agentId, chatJid: jid });
    expect(mergeGitHubRows(t.ctx.db, jid, '60999@s.whatsapp.net')).toBe(1);
    expect(svc.activity()[0]).toMatchObject({ chatJid: '60999@s.whatsapp.net', agentName: 'Aina' });
  });
});

describe('GitHub outside Lite', () => {
  it('registers no routes and offers no tools in another edition', async () => {
    t = await makeTestApp({ edition: 'enterprise' });
    expect(t.ctx.services.github).toBeUndefined();
    expect((await t.app.inject({ method: 'GET', url: '/api/connectors/github' })).statusCode).toBe(
      404,
    );
    agentId = 1;
    expect(github((await turn()).tools)).toEqual([]);
    expect(agentLookupsAvailable(t.ctx, 'sales', 1)).toBe(false);
  });
});
