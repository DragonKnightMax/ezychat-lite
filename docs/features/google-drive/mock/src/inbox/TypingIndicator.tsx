import { useTranslation } from 'react-i18next';
import type { TypingEntry } from '../api/socket';

/** "Alice is typing…" for other agents working on the same chat. */
export function TypingIndicator({
  entries,
  meId,
}: {
  entries: TypingEntry[];
  meId: number | null;
}) {
  const { t } = useTranslation('inbox');
  const others = entries.filter((e) => e.userId !== meId);
  if (others.length === 0) return null;
  const names = others.map((e) => e.displayName);
  const text =
    names.length === 1
      ? t('typing.one', { name: names[0] })
      : names.length === 2
        ? t('typing.two', { first: names[0], second: names[1] })
        : t('typing.many', { count: names.length });
  return (
    <div
      className="flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s] motion-reduce:animate-none" />
        <span className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
      </span>
      <span className="truncate">{text}</span>
    </div>
  );
}
