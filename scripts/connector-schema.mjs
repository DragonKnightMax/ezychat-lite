#!/usr/bin/env node
// JSON Schema of one connector list entry (schemaVersion 1), generated from the zod contract
// `ConnectorEntry` in packages/shared/src/connector-list.ts. The public repo
// anchorsprint/ezychat-connectors keeps a copy as schema/connector-v1.json and checks every
// connector.yaml against it (plus the same cross-field checks the contract's superRefine does).
//
// Run from the repository root (npx passes --conditions=ezychat-source from .npmrc, so
// @ezychat/shared resolves to its TypeScript source):
//   npx tsx scripts/connector-schema.mjs > <ezychat-connectors>/schema/connector-v1.json
// (it only prints; it never writes a file).
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConnectorEntry } from '@ezychat/shared';

export const SCHEMA_ID = 'https://dl.ezychat.ai/connectors/schema/connector-v1.json';

/** Objects that list their properties get `additionalProperties: false`, so a typo fails in CI. */
export function closeObjects(node) {
  if (Array.isArray(node)) return node.forEach(closeObjects);
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object' && node.properties && node.additionalProperties === undefined)
    node.additionalProperties = false;
  for (const value of Object.values(node)) closeObjects(value);
}

/** The schema object (input shape: fields with a default are optional). */
export function connectorSchema() {
  const schema = z.toJSONSchema(ConnectorEntry, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
  closeObjects(schema);
  return {
    $schema: schema.$schema,
    $id: SCHEMA_ID,
    title: 'EzyChat connector entry (schemaVersion 1)',
    description:
      'One entry of the EzyChat connector list. Generated from the app contract by scripts/connector-schema.mjs in ezychat-lite; do not edit by hand.',
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')),
  };
}

export const schemaText = () => `${JSON.stringify(connectorSchema(), null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(schemaText());
}
