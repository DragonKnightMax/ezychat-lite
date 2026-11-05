import { useContext, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { initials } from '../lib/format';
import { ProfileImageContext } from './ProfileImageContext';

/** Token-only fallback tints, picked by a stable seed so a contact keeps its colour. */
const TINTS = [
  'bg-accent text-accent-foreground',
  'bg-muted text-muted-foreground',
  'bg-note text-note-foreground',
  'bg-info/15 text-info',
  'bg-success/15 text-success',
  'bg-primary/15 text-primary',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const SIZES = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-12 text-base',
} as const;

export function ChatAvatar({
  name,
  src,
  seed,
  size = 'md',
  className,
}: {
  name: string;
  src?: string | null;
  seed?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { ready, revision } = useContext(ProfileImageContext);
  const imageSrc =
    src && revision && src.startsWith('/api/chats/')
      ? `${src}${src.includes('?') ? '&' : '?'}connection=${revision}`
      : src;
  return (
    <Avatar className={cn(SIZES[size], className)} aria-hidden="true" title={name}>
      <ProfileImage
        key={`${src}:${revision}:${ready}`}
        name={name}
        src={ready ? imageSrc : null}
        seed={seed}
      />
    </Avatar>
  );
}

function ProfileImage({ name, src, seed }: { name: string; src?: string | null; seed?: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      {/* Native lazy loading avoids Radix's eager image preloader querying every chat at once. */}
      {src && failed !== src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
          className={cn('absolute inset-0 size-full object-cover', loaded !== src && 'invisible')}
        />
      )}
      {(loaded !== src || failed === src || !src) && (
        <AvatarFallback className={cn('font-semibold', TINTS[hash(seed ?? name) % TINTS.length])}>
          {initials(name) || <UserRound className="size-[55%]" aria-hidden="true" />}
        </AvatarFallback>
      )}
    </>
  );
}
