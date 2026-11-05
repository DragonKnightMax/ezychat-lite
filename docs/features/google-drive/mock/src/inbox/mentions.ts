import type { GroupMember } from '@ezychat/shared';

/**
 * Proposed (group-mentions): tagging group members in the composer.
 *
 * The box shows a tag as `@Name` (what the teammate picked); on send each tag still in the text
 * becomes WhatsApp's own form, `@<number>` (the user part of the member's address), and its
 * address goes in `mentions`. A tag whose name was edited is plain text again.
 */
export interface DraftTag {
  /** What the box shows after `@`. */
  label: string;
  /** The member's address as the group lists it (phone-number JID or WhatsApp ID). */
  jid: string;
}

/** Most members one message may tag (the server's `MAX_MESSAGE_MENTIONS`). */
export const MAX_TAGS = 50;

/** The `@query` being typed right before the caret (start of text or after a space), else null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,40})$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

/** The name a member is tagged by: saved/WhatsApp name, else username, else +number. */
export function memberLabel(m: Pick<GroupMember, 'name' | 'username' | 'phone' | 'jid'>): string {
  const name = m.name?.trim() || m.username?.trim();
  if (name) return name;
  if (m.phone) return `+${m.phone}`;
  return m.jid.split('@')[0]!;
}

/**
 * Members to offer for `query` (case-insensitive): a word of the name, the username or the number
 * starts with it. The linked number itself is never offered. Named members first, A–Z.
 */
export function filterMembers(members: GroupMember[], query: string): GroupMember[] {
  const q = query.trim().toLowerCase().replace(/^\+/, '');
  const named = (m: GroupMember) => (m.name || m.username ? 0 : 1);
  return members
    .filter((m) => !m.isMe)
    .filter((m) => {
      if (!q) return true;
      const words = [
        ...(m.name ?? '').toLowerCase().split(/\s+/),
        (m.name ?? '').toLowerCase(),
        (m.username ?? '').toLowerCase(),
        m.phone ?? '',
      ];
      return words.some((w) => w && w.startsWith(q));
    })
    .sort(
      (a, b) => named(a) - named(b) || memberLabel(a).localeCompare(memberLabel(b), undefined, {}),
    );
}

/** Puts `@Label ` in place of the `@query` being typed; returns the new text and caret. */
export function insertTag(
  text: string,
  start: number,
  caret: number,
  member: GroupMember,
): { text: string; caret: number; tag: DraftTag } {
  const label = memberLabel(member);
  const inserted = `@${label} `;
  const after = text.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
  return {
    text: text.slice(0, start) + inserted + after,
    caret: start + inserted.length,
    tag: { label, jid: member.jid },
  };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text and mentions to send: each tag still written as `@Label` (a whole tag, not followed by
 * a letter or digit) becomes `@<number>`; tags the teammate edited away are dropped.
 */
export function toWhatsApp(text: string, tags: DraftTag[]): { text: string; mentions: string[] } {
  let out = text;
  const mentions: string[] = [];
  // Longest names first, so "@Mei Ling Tan" is never read as "@Mei Ling".
  for (const tag of [...tags].sort((a, b) => b.label.length - a.label.length)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escape(tag.label)}(?![\\p{L}\\p{N}_])`, 'gu');
    const digits = tag.jid.split('@')[0]!.split(':')[0]!;
    let found = false;
    out = out.replace(re, (_m, lead: string) => {
      found = true;
      return `${lead}@${digits}`;
    });
    if (found && !mentions.includes(tag.jid) && mentions.length < MAX_TAGS) mentions.push(tag.jid);
  }
  return { text: out, mentions };
}
