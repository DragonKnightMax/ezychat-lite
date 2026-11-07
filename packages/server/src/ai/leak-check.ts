/** Shortest verbatim run of an Internal item that counts as a leak. */
export const AI_LEAK_MIN_RUN = 40;

/** Collapse every whitespace run to one space and lower-case, so spacing and case tricks still match. */
const normalise = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * True when the reply holds a run of at least `minRun` characters copied from one of the Internal
 * items (after whitespace collapse and lower-casing on both sides). Such a reply is never sent.
 * Runs on every AI reply: each `minRun`-long window of the reply is indexed once, then each window of
 * the Internal texts (at most 10,000 characters per agent) is a set look-up, not a search of the whole
 * reply (a 4,000-character reply against 10,000 Internal characters: about 1 ms instead of 10 ms).
 */
export function findLeak(
  reply: string,
  internalTexts: readonly string[],
  minRun = AI_LEAK_MIN_RUN,
): boolean {
  const haystack = normalise(reply);
  if (haystack.length < minRun) return false;
  const windows = new Set<string>();
  for (let start = 0; start + minRun <= haystack.length; start++)
    windows.add(haystack.slice(start, start + minRun));
  for (const raw of internalTexts) {
    const text = normalise(raw);
    for (let start = 0; start + minRun <= text.length; start++)
      if (windows.has(text.slice(start, start + minRun))) return true;
  }
  return false;
}
