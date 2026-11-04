#!/usr/bin/env node
// JSON Schema of one AI agent template list entry (schemaVersion 1), generated from the zod contract
// `AgentTemplateEntry` in packages/shared/src/template-list.ts. The publishing repo
// (anchorsprint/ezychat-connectors, folder templates/) keeps a copy as schema/template-v1.json and
// checks every assembled template against it (docs/features/template-store/publisher/).
//
// Run from the repository root:
//   npx tsx scripts/template-schema.mjs > <ezychat-connectors>/schema/template-v1.json
// (it only prints; it never writes a file).
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AgentTemplateEntry } from '@ezychat/shared';
import { closeObjects } from './connector-schema.mjs';

export const SCHEMA_ID = 'https://dl.ezychat.ai/templates/schema/template-v1.json';

/** The schema object (input shape: fields with a default are optional). */
export function templateSchema() {
  const schema = z.toJSONSchema(AgentTemplateEntry, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
  closeObjects(schema);
  return {
    $schema: schema.$schema,
    $id: SCHEMA_ID,
    title: 'EzyChat AI agent template (schemaVersion 1)',
    description:
      'One entry of the EzyChat template list. Generated from the app contract by scripts/template-schema.mjs in ezychat-lite; do not edit by hand.',
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')),
  };
}

export const schemaText = () => `${JSON.stringify(templateSchema(), null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(schemaText());
}
