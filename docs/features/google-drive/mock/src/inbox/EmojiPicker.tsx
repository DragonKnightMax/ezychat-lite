import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smile } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchField } from '@/components/app/SearchField';
import enInbox from '@/i18n/locales/en/inbox.json';

const CATEGORIES = ['All', 'Faces', 'Gestures', 'Hearts', 'Work'] as const;
type Category = (typeof CATEGORIES)[number];
const CATEGORY_KEYS = {
  All: 'emoji.category.all',
  Faces: 'emoji.category.faces',
  Gestures: 'emoji.category.gestures',
  Hearts: 'emoji.category.hearts',
  Work: 'emoji.category.work',
} as const satisfies Record<Category, string>;
type EmojiKey = keyof (typeof enInbox)['emoji']['names'];
/** [symbol, name key, category, English search keywords]. Names are translated; search also matches English. */
const EMOJI: readonly (readonly [string, EmojiKey, Category, string?])[] = [
  ['😀', 'grinningFace', 'Faces', 'happy smile'],
  ['😊', 'smilingFace', 'Faces', 'happy thank you'],
  ['😂', 'tearsOfJoy', 'Faces', 'laugh funny'],
  ['🤣', 'rollingOnTheFloorLaughing', 'Faces', 'funny lol'],
  ['😉', 'winkingFace', 'Faces'],
  ['😍', 'heartEyes', 'Faces', 'love'],
  ['🥰', 'smilingFaceWithHearts', 'Faces', 'love'],
  ['😎', 'sunglassesFace', 'Faces', 'cool'],
  ['🤔', 'thinkingFace', 'Faces', 'question'],
  ['😅', 'smilingFaceWithSweat', 'Faces', 'relief'],
  ['😔', 'pensiveFace', 'Faces', 'sad sorry'],
  ['😢', 'cryingFace', 'Faces', 'sad sorry'],
  ['😭', 'loudlyCryingFace', 'Faces', 'sad'],
  ['😮', 'surprisedFace', 'Faces', 'wow'],
  ['🙃', 'upsideDownFace', 'Faces'],
  ['🤗', 'huggingFace', 'Faces', 'hug'],
  ['👍', 'thumbsUp', 'Gestures', 'yes good approve okay'],
  ['👎', 'thumbsDown', 'Gestures', 'no'],
  ['👋', 'wavingHand', 'Gestures', 'hello bye'],
  ['🙏', 'foldedHands', 'Gestures', 'thanks thank you please pray'],
  ['👌', 'okHand', 'Gestures', 'okay'],
  ['👏', 'clappingHands', 'Gestures', 'well done congratulations'],
  ['🙌', 'raisedHands', 'Gestures', 'celebrate'],
  ['🤝', 'handshake', 'Gestures', 'agreement deal'],
  ['💪', 'flexedBiceps', 'Gestures', 'strong'],
  ['✌️', 'victoryHand', 'Gestures', 'peace'],
  ['❤️', 'redHeart', 'Hearts', 'love'],
  ['🧡', 'orangeHeart', 'Hearts', 'love'],
  ['💛', 'yellowHeart', 'Hearts', 'love'],
  ['💚', 'greenHeart', 'Hearts', 'love'],
  ['💙', 'blueHeart', 'Hearts', 'love'],
  ['💜', 'purpleHeart', 'Hearts', 'love'],
  ['🤍', 'whiteHeart', 'Hearts', 'love'],
  ['💕', 'twoHearts', 'Hearts', 'love'],
  ['✅', 'checkMark', 'Work', 'done yes confirmed complete'],
  ['❌', 'crossMark', 'Work', 'no cancel'],
  ['❓', 'questionMark', 'Work', 'help'],
  ['⚠️', 'warning', 'Work', 'attention'],
  ['📌', 'pushpin', 'Work', 'important'],
  ['📦', 'package', 'Work', 'delivery order shipping'],
  ['🚚', 'deliveryTruck', 'Work', 'shipping'],
  ['📍', 'locationPin', 'Work', 'address place'],
  ['📅', 'calendar', 'Work', 'date appointment'],
  ['⏰', 'alarmClock', 'Work', 'time reminder'],
  ['📞', 'telephone', 'Work', 'call phone'],
  ['💬', 'speechBalloon', 'Work', 'chat message'],
  ['💰', 'moneyBag', 'Work', 'payment price'],
  ['🎉', 'partyPopper', 'Work', 'congratulations celebrate'],
  ['🎂', 'birthdayCake', 'Work', 'birthday'],
  ['🎁', 'gift', 'Work', 'present'],
  ['🌟', 'glowingStar', 'Work', 'great excellent'],
  ['🔥', 'fire', 'Work', 'hot'],
];
const englishName = (key: EmojiKey) => enInbox.emoji.names[key];

/** Small, local-only emoji picker. Search never leaves the device. */
export function EmojiPicker({
  disabled,
  onOpen,
  onPick,
}: {
  disabled?: boolean;
  onOpen(): void;
  onPick(emoji: string): void;
}) {
  const { t } = useTranslation('inbox');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const picked = useRef(false);
  const titleId = useId();
  const normalized = query.trim().toLowerCase();
  const matches = EMOJI.filter(([symbol, key, emojiCategory, keywords = '']) => {
    if (!normalized) return category === 'All' || category === emojiCategory;
    const haystack = `${symbol} ${englishName(key)} ${t(`emoji.names.${key}`)} ${keywords}`;
    return haystack.toLowerCase().includes(normalized);
  });

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) {
          picked.current = false;
          setQuery('');
          setCategory('All');
          onOpen();
        }
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-touch"
          disabled={disabled}
          aria-label={t('emoji.insert')}
          title={t('emoji.insert')}
          className="rounded-full text-muted-foreground"
        >
          <Smile className="size-5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        aria-labelledby={titleId}
        onCloseAutoFocus={(e) => {
          // Composer restores the caret after insertion. Do not steal it back.
          if (picked.current) e.preventDefault();
        }}
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden p-3"
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {t('emoji.title')}
        </h2>
        <SearchField
          value={query}
          onChange={setQuery}
          label={t('emoji.search')}
          placeholder={t('emoji.searchPlaceholder')}
        />
        <div
          className="flex shrink-0 flex-wrap gap-1"
          role="group"
          aria-label={t('emoji.categories')}
        >
          {CATEGORIES.map((item) => (
            <Button
              key={item}
              variant={category === item && !normalized ? 'secondary' : 'ghost'}
              size="sm"
              className="min-h-11 px-2"
              aria-pressed={category === item && !normalized}
              onClick={() => {
                setCategory(item);
                setQuery('');
              }}
            >
              {t(CATEGORY_KEYS[item])}
            </Button>
          ))}
        </div>
        <div
          role="group"
          aria-label={t('emoji.choices')}
          className="emoji-scroll grid min-h-0 grid-cols-6 gap-1 overflow-y-auto overscroll-contain"
          onKeyDown={(e) => {
            const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -6, ArrowDown: 6 }[e.key];
            if (offset == null) return;
            const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
            const index = buttons.indexOf(e.target as HTMLButtonElement);
            if (index < 0) return;
            e.preventDefault();
            buttons[Math.max(0, Math.min(buttons.length - 1, index + offset))]?.focus();
          }}
        >
          {matches.map(([symbol, key]) => (
            <Button
              key={symbol}
              variant="ghost"
              size="icon-touch"
              className="w-full text-2xl"
              aria-label={t(`emoji.names.${key}`)}
              title={t(`emoji.names.${key}`)}
              onClick={() => {
                picked.current = true;
                onPick(symbol);
                setOpen(false);
              }}
            >
              <span aria-hidden="true">{symbol}</span>
            </Button>
          ))}
        </div>
        {matches.length === 0 && (
          <p role="status" className="py-3 text-sm text-muted-foreground">
            {t('emoji.empty')}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
