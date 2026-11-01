import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { TABLE_PLAN } from '../src/lite-import/merge-tables.js';
import { IdMaps, remapJson } from '../src/lite-import/merge-remap.js';

describe('Lite merge table coverage', () => {
  it('handles every table of the migrated core schema (merged, or skipped with a reason)', () => {
    const db = openDb(':memory:');
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    db.close();
    // A new migration added a table: decide in TABLE_PLAN (merge-tables.ts) how a Lite merge treats it.
    const unhandled = tables.filter((t) => !(t in TABLE_PLAN));
    expect(unhandled).toEqual([]);
    // and the plan names no table that does not exist (a renamed table would hide here)
    expect(Object.keys(TABLE_PLAN).filter((t) => !tables.includes(t))).toEqual([]);
    for (const [table, how] of Object.entries(TABLE_PLAN))
      if ('skip' in how) expect(how.skip.length, table).toBeGreaterThan(10);
  });
});

describe('remapJson', () => {
  const maps = new IdMaps(4);
  maps.users.set(1, 11);
  maps.agents.set(2, 22);
  maps.documents.set(3, 33);
  maps.phrases.set(5, 55);
  maps.safetyItems.set(6, 66);

  it('rewrites chat, message, user, agent, inbox and item ids and drops token ids', () => {
    const out = JSON.parse(
      remapJson(
        JSON.stringify({
          chatJid: 'a@s.whatsapp.net',
          from: 'b@s.whatsapp.net',
          to: 3,
          messageId: 'X1',
          agentId: 2,
          assignedTo: 1,
          previous: 9,
          inboxId: 1,
          inboxIds: [1, 2],
          documentId: 3,
          phraseId: 5,
          itemId: 6,
          tokenId: 7,
          reason: 'x',
        }),
        maps,
      ),
    );
    expect(out).toEqual({
      chatJid: 'a@s.whatsapp.net#4',
      from: 'b@s.whatsapp.net#4',
      to: 3,
      messageId: 'X1#4',
      agentId: 22,
      assignedTo: 11,
      previous: 9,
      inboxId: 4,
      inboxIds: [4, 2],
      documentId: 33,
      phraseId: 55,
      itemId: 66,
      tokenId: null,
      reason: 'x',
    });
  });

  it('leaves values it cannot read as they are', () => {
    expect(remapJson('not json', maps)).toBe('not json');
    expect(remapJson('[1]', maps)).toBe('[1]');
    expect(JSON.parse(remapJson('{"chatJid":"x#2","messageId":"y#3"}', maps))).toEqual({
      chatJid: 'x#2',
      messageId: 'y#3',
    });
    expect(maps.chat(null)).toBeNull();
    expect(maps.message('bad#x')).toBeNull();
    expect(maps.user('1')).toBeNull();
  });
});
