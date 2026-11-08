import { copyFileSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PRIMARY_INBOX_ID, parseChatKey, waMessageId } from '../inboxes/keys.js';

/** Replaces anything outside [a-zA-Z0-9_-] with '_' (prevents path traversal / odd file names). */
export function sanitizeSegment(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return out || '_';
}

/**
 * The folder of a chat key, relative to the media root. Inbox 1 keeps today's
 * `<sanitized JID>`; another inbox gets `inbox-<id>/<sanitized JID>` (a sanitized JID always holds
 * `_` for its `@`, so it never equals `inbox-<id>`): the same JID in two inboxes never shares files.
 */
export function chatMediaDir(chatKey: string): string {
  const { inboxId, waJid } = parseChatKey(chatKey);
  const dir = sanitizeSegment(waJid);
  return inboxId === PRIMARY_INBOX_ID ? dir : `inbox-${inboxId}/${dir}`;
}

/**
 * Stores media files under `<root>/<chat folder>/<sanitized msg id>.<ext>` (chatMediaDir; the
 * message id without its inbox suffix, unique inside the inbox's folder).
 * Paths returned by save() are relative to root (stored in messages.media_path).
 */
export class MediaStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  /** `chatJid` / `msgId`: the stored chat key and message key (or a `local-` id). */
  save(chatJid: string, msgId: string, buf: Buffer, ext: string): string {
    const rel = this.relFor(chatJid, msgId, ext);
    mkdirSync(join(this.root, chatMediaDir(chatJid)), { recursive: true });
    // a new file, never a write through a hard link another message's copy shares
    rmSync(join(this.root, rel), { force: true });
    writeFileSync(join(this.root, rel), buf);
    return rel;
  }

  /**
   * Stores a stored file again for another message (a forwarded copy): a hard link where the file
   * system allows it (no extra space; Baileys' media cache then uploads it once per number), else a
   * full copy. Each message owns its own entry, so deleting one never removes another's file.
   */
  copy(chatJid: string, msgId: string, sourceRel: string, ext: string): string {
    const src = this.abs(sourceRel);
    const rel = this.relFor(chatJid, msgId, ext);
    const dest = join(this.root, rel);
    mkdirSync(join(this.root, chatMediaDir(chatJid)), { recursive: true });
    rmSync(dest, { force: true });
    try {
      linkSync(src, dest);
    } catch {
      copyFileSync(src, dest);
    }
    return rel;
  }

  /**
   * Moves a private file from outside the store (an MCP upload or link download) in as this message's
   * file without reading it into memory: a rename on the same disk, else a copy, and the source is
   * removed either way.
   */
  adopt(chatJid: string, msgId: string, absSource: string, ext: string): string {
    const rel = this.relFor(chatJid, msgId, ext);
    const dest = join(this.root, rel);
    mkdirSync(join(this.root, chatMediaDir(chatJid)), { recursive: true });
    rmSync(dest, { force: true });
    try {
      renameSync(absSource, dest);
    } catch {
      copyFileSync(absSource, dest);
      rmSync(absSource, { force: true });
    }
    return rel;
  }

  private relFor(chatJid: string, msgId: string, ext: string): string {
    const dir = chatMediaDir(chatJid);
    const cleanExt =
      ext
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 10)
        .toLowerCase() || 'bin';
    // a `local-` id is not a message key: its clientId part may hold any character, '#' too
    const file = msgId.startsWith('local-') ? msgId : waMessageId(msgId);
    return `${dir}/${sanitizeSegment(file)}.${cleanExt}`;
  }

  /** Absolute path of a stored relative path; throws if it escapes the root. */
  abs(rel: string): string {
    const p = resolve(this.root, rel);
    if (p !== this.root && !p.startsWith(this.root + sep))
      throw new Error('media path escapes store root');
    return p;
  }
}
