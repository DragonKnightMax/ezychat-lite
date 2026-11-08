import { readFileSync } from 'node:fs';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError, errors } from '../http/errors.js';
import { inboxOfKey } from '../inboxes/keys.js';
import { inboxMaxBytes } from '../inboxes/media-limits.js';
import { VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_SECONDS } from '../messages/voice-note.js';
import { IncompleteError, uploadStore } from '../uploads/store.js';

/** Multipart framing and the small fields around the file, allowed above the file's own limit. */
const FRAMING_BYTES = 64 * 1024;

export interface ReceivedMedia {
  file: { path: string; size: number; fileName: string };
  fields: Record<string, string>;
  /** The bytes of a small file (a voice note), or a 400 for a large one. */
  readVoiceNote(): Buffer;
  /** Removes the file unless the send moved it into the media store. */
  discard(): void;
}

/**
 * The composer's `POST /chats/:jid/media` body: the `file` part is streamed to a private file (never
 * held in memory) up to the largest file the chat's WhatsApp number takes (`mediaLimits`), within the
 * free disk space; there is no size cap of our own. The other parts are the small form fields.
 */
export async function receiveMediaUpload(
  ctx: AppContext,
  req: FastifyRequest,
  jid: string,
  userId: number,
): Promise<ReceivedMedia> {
  if (!req.isMultipart()) throw errors.validation('Expected multipart/form-data');
  const store = uploadStore(ctx);
  const maxBytes = inboxMaxBytes(ctx, inboxOfKey(jid));
  const length = Number(req.headers['content-length']);
  const declaredLength = Number.isFinite(length) ? Math.max(0, length - FRAMING_BYTES) : undefined;
  const fields: Record<string, string> = {};
  let file: ReceivedMedia['file'] | null = null;
  try {
    const fileSize = maxBytes === undefined ? Number.POSITIVE_INFINITY : maxBytes + 1;
    for await (const part of req.parts({ limits: { fileSize, files: 1, fields: 10 } })) {
      if (part.type !== 'file') {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      } else if (part.fieldname !== 'file' || file) {
        part.file.resume();
      } else {
        const saved = await store.writeTemp(`user:${userId}`, part.file, {
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(declaredLength === undefined ? {} : { declaredLength }),
        });
        file = { ...saved, fileName: part.filename || 'file' };
      }
    }
  } catch (err) {
    if (file) store.discard(file.path);
    if (err instanceof IncompleteError)
      throw new HttpError(
        400,
        'upload_incomplete',
        'The upload stopped before the whole file arrived.',
      );
    throw err;
  }
  if (!file) throw errors.validation('file is required');
  const received = file;
  return {
    file: received,
    fields,
    readVoiceNote() {
      if (received.size > VOICE_NOTE_MAX_BYTES)
        throw errors.validation(
          `A voice note must be Ogg/Opus audio of at most ${VOICE_NOTE_MAX_SECONDS / 60} minutes`,
        );
      return readFileSync(received.path);
    },
    discard: () => store.discard(received.path),
  };
}
