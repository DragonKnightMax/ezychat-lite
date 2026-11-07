import type { Message } from '@ezychat/shared';

/** How long an answer waits for the voice notes of its batch to be transcribed. */
export const AI_VOICE_WAIT_MS = 30_000;
export const VOICE_NOTE_PREFIX = '[voice note]';
/** The AI could not listen to this voice note (engine off, failed, too long, unsupported). */
export const VOICE_NOTE_UNTRANSCRIBED = '[voice note — not transcribed]';
const LINE_CHARACTERS = 2000;

/** A customer voice note with a usable transcript. */
export function isTranscribed(message: Message): boolean {
  return (
    message.type === 'audio' && message.transcriptStatus === 'ok' && !!message.transcript?.trim()
  );
}

/** What the customer said in a message: its text, or a voice note's transcript. */
export function customerText(message: Message): string {
  if (message.body) return message.body;
  return isTranscribed(message) ? message.transcript! : '';
}

/** Marks a customer's message WhatsApp delivered as forwarded: someone else's words, not theirs. */
export const FORWARDED_PREFIX = '[forwarded]';

/**
 * One conversation line for the model. Transcripts are customer data like any text. A customer's
 * forwarded message starts with `[forwarded] `, so the agent does not read it as their own words.
 */
export function conversationLine(message: Message): string {
  const line = messageLine(message);
  return message.forwarded && !message.fromMe ? `${FORWARDED_PREFIX} ${line}` : line;
}

function messageLine(message: Message): string {
  if (message.type === 'image')
    return `[image]${message.body?.trim() ? ` ${message.body.slice(0, LINE_CHARACTERS)}` : ''}`;
  if (message.type === 'audio' && !message.fromMe)
    return isTranscribed(message)
      ? `${VOICE_NOTE_PREFIX} ${message.transcript!.trim().slice(0, LINE_CHARACTERS)}`
      : VOICE_NOTE_UNTRANSCRIBED;
  return message.body?.slice(0, LINE_CHARACTERS) ?? `[${message.type} message]`;
}
