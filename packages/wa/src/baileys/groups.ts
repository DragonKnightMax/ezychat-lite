import type { GroupMetadata } from 'baileys';
import type { WaGroupInfo, WaGroupParticipant } from '../types.js';
import { normalizeContactJid } from './contact-aliases.js';
import { mapGroupSettings } from './group-admin.js';

const ROLE: Record<string, WaGroupParticipant['role']> = {
  superadmin: 'superadmin',
  admin: 'admin',
};

/** Map Baileys group metadata to our shape. Members carry no names; only what WhatsApp sent. */
export function mapGroupMetadata(meta: GroupMetadata): WaGroupInfo {
  const participants: WaGroupParticipant[] = [];
  const seen = new Set<string>();
  for (const p of meta.participants ?? []) {
    const id = normalizeContactJid(p.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const isLid = id.endsWith('@lid');
    const phoneJid = isLid ? normalizeContactJid(p.phoneNumber) : id;
    const lidJid = isLid ? id : normalizeContactJid(p.lid);
    participants.push({
      jid: id,
      phoneJid: phoneJid && !phoneJid.endsWith('@lid') ? phoneJid : null,
      lidJid: lidJid && lidJid.endsWith('@lid') ? lidJid : null,
      username: typeof p.username === 'string' && p.username ? p.username : null,
      role: ROLE[String(p.admin ?? '')] ?? 'member',
    });
  }
  const created = Number(meta.creation);
  return {
    jid: meta.id,
    name: meta.subject || null,
    description: meta.desc || null,
    createdAt: Number.isFinite(created) && created > 0 ? created * 1000 : null,
    // The WhatsApp ID first: the creator's number may later belong to someone else.
    ownerJid: normalizeContactJid(meta.owner) ?? normalizeContactJid(meta.ownerPn),
    size: Math.max(Number(meta.size) || 0, participants.length),
    participants,
    settings: mapGroupSettings(meta),
  };
}

/** The About text from a Baileys `fetchStatus` result; null when hidden or unset. */
export function aboutFromStatusResult(list: unknown): string | null {
  // A timed-out query resolves to undefined instead of throwing: a failure, never "no About".
  if (!Array.isArray(list)) throw new Error('About query returned no result');
  const status = (list[0] as { status?: { status?: unknown } } | undefined)?.status?.status;
  return typeof status === 'string' && status.trim() ? status : null;
}
