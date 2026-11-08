// Proposed (mobile-redesign): a living reference of the "Calm Desk" design system
// (docs/design-system.md), at /design-system in the mock, no sign-in needed. It renders the real
// CSS tokens (read from index.css at runtime) and the real components, in light or dark (the
// switch at the top), plus the mobile patterns with the mock screens that show them.
// A reference page for the team and the owner (English only); it is not a screen of the app.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  MessageSquarePlus,
  Moon,
  Plus,
  Sun,
  Tag,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Banner, EmptyState, ResponsiveDialog, StatusDot } from '@/components/app';
import { SearchField } from '@/components/app/SearchField';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { ChatAvatar } from '../inbox/ChatAvatar';
import { InboxChip } from '../inbox/InboxChip';
import { InboxSwatch } from '../inbox/mobile/InboxSwitcherSheet';
import { FilterChip } from '../inbox/mobile/MobileListHeader';

type TokenMap = Record<string, string>;

/** The token values exactly as index.css declares them, for light (`:root`) and dark. */
function readTokens(): { light: TokenMap; dark: TokenMap } {
  const light: TokenMap = {};
  const dark: TokenMap = {};
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    const visit = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) {
          const target =
            rule.selectorText === ':root'
              ? light
              : /^:root\[data-theme=["']dark["']\]$/.test(rule.selectorText)
                ? dark
                : null;
          if (!target) continue;
          for (const name of Array.from(rule.style))
            if (name.startsWith('--')) target[name] = rule.style.getPropertyValue(name).trim();
        } else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    visit(rules);
  }
  return { light, dark };
}

const COLOUR_GROUPS: { title: string; tokens: [string, string][] }[] = [
  {
    title: 'Surfaces and text',
    tokens: [
      ['--background', 'App background'],
      ['--surface', 'Cards, panes, list, inbound bubble'],
      ['--muted', 'Hover, secondary surfaces, skeletons'],
      ['--foreground', 'Primary text'],
      ['--muted-foreground', 'Secondary text, icons'],
      ['--border', 'Dividers'],
      ['--input', 'Control outlines (≥ 3:1)'],
    ],
  },
  {
    title: 'Accent',
    tokens: [
      ['--primary', 'Primary action, selection, FAB'],
      ['--primary-foreground', 'Text on primary'],
      ['--accent', 'Selected row, chip, sheet row'],
      ['--accent-foreground', 'Text on accent'],
      ['--ring', 'Focus ring'],
      ['--unread', 'Unread badge, unread time'],
    ],
  },
  {
    title: 'Messages and notes',
    tokens: [
      ['--outbound', 'Outbound bubble'],
      ['--note', 'Internal note card'],
      ['--note-border', 'Internal note border'],
      ['--note-foreground', 'Internal note text'],
    ],
  },
  {
    title: 'States',
    tokens: [
      ['--success', 'Connected, delivered, Resolve swipe'],
      ['--warning', 'Connecting, pending'],
      ['--danger', 'Failed, destructive'],
      ['--info', 'Information banners'],
      ['--overlay', 'Behind sheets and dialogs'],
    ],
  },
];

const PATTERNS: { id: string; title: string; rule: string; shots: string[] }[] = [
  {
    id: 'app-bar',
    title: 'App bar and number switcher',
    rule: 'One 56 px bar: where you are (the title, which switches number), then at most two icons.',
    shots: [
      '01-list-m360-light',
      '02-inbox-switcher-m360-light',
      '03-switched-catering-m360-light',
    ],
  },
  {
    id: 'chips',
    title: 'Filter chips above a list',
    rule: 'One scrolling row of single-tap filters; counts only where they help.',
    shots: [
      '04-chip-unread-m360-light',
      '05-tag-filter-sheet-m360-light',
      '06-tag-filtered-m360-light',
    ],
  },
  {
    id: 'fab',
    title: 'Floating action button',
    rule: 'One per screen, for the screen’s main “create” action, bottom right.',
    shots: ['08-new-chat-sheet-m360-light', '09-fab-compact-on-scroll-m360-light'],
  },
  {
    id: 'sheets',
    title: 'Bottom sheets, dialogs, pages',
    rule: 'Pick or act on one thing → sheet; confirm → dialog; long form or reading → page.',
    shots: [
      '15-assign-sheet-m360-light',
      '16-chat-tags-sheet-m360-light',
      '19-chat-more-sheet-m360-light',
    ],
  },
  {
    id: 'gestures',
    title: 'Swipe and press and hold',
    rule: 'A shortcut only: every gesture action is also in a visible menu, and undoable.',
    shots: [
      '10-swipe-assign-m360-light',
      '11-swipe-assigned-toast-m360-light',
      '13-row-actions-m360-light',
    ],
  },
  {
    id: 'header',
    title: 'Detail header with chips',
    rule: 'Identity and the one main action in the row; the chat’s facts as chips under it.',
    shots: [
      '14-chat-header-m360-light',
      '18-chat-tags-saved-m360-light',
      '20-group-header-m360-light',
    ],
  },
  {
    id: 'states',
    title: 'Empty, one number, desktop',
    rule: 'Hide what does not apply (one number: no switcher); desktop keeps its own layout.',
    shots: [
      '21-lite-one-number-m360-light',
      '22-agent-one-number-m360-light',
      '30-desktop-list-desktop-light',
    ],
  },
];

function Section({
  id,
  title,
  lead,
  children,
}: Readonly<{ id: string; title: string; lead?: string; children: React.ReactNode }>) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4 border-t pt-8">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {lead && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function Specimen({
  label,
  children,
  className,
}: Readonly<{ label: string; children: React.ReactNode; className?: string }>) {
  return (
    <div className={cn('min-w-0 rounded-xl border bg-surface p-4', className)}>
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export function DesignSystemPage() {
  const { resolvedTheme, setTheme } = useTheme();
  const [tokens, setTokens] = useState<{ light: TokenMap; dark: TokenMap }>({
    light: {},
    dark: {},
  });
  const [sheet, setSheet] = useState(false);
  const [chip, setChip] = useState('all');
  const [on, setOn] = useState(true);
  useEffect(() => setTokens(readTokens()), []);
  const radius = useMemo(
    () => [
      ['rounded-sm', '6 px', 'Inputs, small chips'],
      ['rounded-md', '8 px', 'Menu items'],
      ['rounded-lg', '10 px', 'Buttons, cards, sheet rows (--radius)'],
      ['rounded-xl', '16 px', 'Cards on phones, sheets, bubbles, FAB (rounded-2xl)'],
      ['rounded-full', 'pill', 'Filter chips, avatars, badges'],
    ],
    [],
  );

  return (
    <div className="min-h-dvh bg-background text-foreground" data-testid="design-system">
      <header className="sticky top-0 z-20 border-b bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
          <Button asChild variant="ghost" size="icon-touch" aria-label="Back to the app">
            <Link to="/">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              Calm Desk design system
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              EzyChat Lite and Enterprise · living reference
            </p>
          </div>
          <Button
            variant="outline"
            size="touch"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            data-testid="ds-theme"
          >
            {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
            <span className="max-sm:sr-only">{resolvedTheme === 'dark' ? 'Light' : 'Dark'}</span>
          </Button>
        </div>
        <nav
          className="mx-auto flex max-w-5xl gap-2 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none]"
          aria-label="Sections"
        >
          {['colour', 'type', 'space', 'components', 'mobile', 'editions'].map((id) => (
            <a
              key={id}
              href={`#${id}`}
              className="inline-flex h-9 shrink-0 items-center rounded-full border bg-surface px-3.5 text-sm text-muted-foreground"
            >
              {
                {
                  colour: 'Colour',
                  type: 'Type',
                  space: 'Space, radius, elevation',
                  components: 'Components',
                  mobile: 'Mobile patterns',
                  editions: 'Editions',
                }[id]
              }
            </a>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        <p className="max-w-2xl text-[15px] text-muted-foreground">
          Quiet, dense and work-focused: neutral surfaces, colour only where it means something
          (unread, assignment, state, connection), and a clear line between what the customer sees
          and what only the team sees. The rules live in <code>docs/design-system.md</code>; this
          page renders them with the real CSS and components.
        </p>

        <Section
          id="colour"
          title="Colour tokens"
          lead="Values are read from index.css at runtime. The swatch shows the current theme; both values are listed."
        >
          <div className="grid gap-4 md:grid-cols-2">
            {COLOUR_GROUPS.map((group) => (
              <div key={group.title} className="min-w-0 rounded-xl border bg-surface">
                <p className="border-b px-4 py-2.5 text-sm font-semibold">{group.title}</p>
                <ul className="divide-y">
                  {group.tokens.map(([name, use]) => (
                    <li key={name} className="flex items-center gap-3 px-4 py-2.5">
                      <span
                        className="size-9 shrink-0 rounded-lg border"
                        style={{ background: `var(${name})` }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <code className="block text-sm">{name}</code>
                        <span className="block truncate text-xs text-muted-foreground">{use}</span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[11px] leading-4 text-muted-foreground">
                        <span className="block">{tokens.light[name] ?? '–'}</span>
                        <span className="block">{tokens.dark[name] ?? '–'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Right column: light value, then dark value. Never use a hex or Tailwind palette colour
            in feature code; use the token classes (<code>bg-primary</code>,{' '}
            <code>text-muted-foreground</code>).
          </p>
        </Section>

        <Section
          id="type"
          title="Type"
          lead="Inter, self-hosted. Inputs are at least 16 px on phones so iOS does not zoom."
        >
          <div className="divide-y rounded-xl border bg-surface">
            {[
              ['text-xl font-semibold', '20 / semibold', 'Screen and app-bar titles'],
              ['text-lg font-semibold', '18 / semibold', 'Sheet and card titles'],
              ['text-base', '16', 'Inputs, phone body'],
              ['text-[15px] font-medium', '15 / medium', 'List names, sheet rows'],
              ['text-sm', '14', 'Body, chips, previews'],
              ['text-[13px]', '13', 'Dense desktop lists'],
              ['text-xs', '12', 'Meta: times, numbers, hints'],
            ].map(([cls, size, use]) => (
              <div key={cls} className="flex items-baseline gap-4 px-4 py-3">
                <span className={cn('min-w-0 flex-1 truncate', cls)}>Kopi Apong Catering</span>
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">
                  {size}
                </span>
                <span className="hidden w-48 shrink-0 text-xs text-muted-foreground sm:block">
                  {use}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="space"
          title="Space, radius, elevation, touch"
          lead="4 px grid. Touch targets are at least 44 px; a 36 px chip extends its hit area to 44 px."
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Specimen label="Spacing (4 px grid)">
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <span key={n} className="flex flex-col items-center gap-1">
                  <span className="bg-primary/30" style={{ width: n * 4, height: 32 }} />
                  <span className="font-mono text-[11px] text-muted-foreground">{n * 4}</span>
                </span>
              ))}
            </Specimen>
            <Specimen label="Radius">
              {radius.map(([cls, size, use]) => (
                <span key={cls} className="flex flex-col items-center gap-1" title={use}>
                  <span className={cn('size-12 border-2 border-primary bg-primary/10', cls)} />
                  <span className="font-mono text-[11px] text-muted-foreground">{size}</span>
                </span>
              ))}
            </Specimen>
            <Specimen label="Elevation (only these)">
              <span className="flex h-14 w-24 items-center justify-center rounded-lg border bg-surface text-xs shadow-sm">
                shadow-sm
              </span>
              <span className="flex h-14 w-24 items-center justify-center rounded-lg border bg-surface text-xs shadow-lg">
                shadow-lg
              </span>
            </Specimen>
          </div>
          <Specimen label="Touch targets">
            <span className="relative flex size-11 items-center justify-center rounded-lg border-2 border-dashed border-primary/50">
              <span className="text-[10px] text-muted-foreground">44</span>
            </span>
            <Button size="icon-touch" variant="ghost" aria-label="Icon button">
              <UserRound />
            </Button>
            <Button size="touch">Touch button</Button>
            <span className="text-xs text-muted-foreground">
              Shrink only for precise pointers (<code>pointer-fine:</code>), never by width alone.
            </span>
          </Specimen>
        </Section>

        <Section id="components" title="Components and states">
          <Specimen label="Button: variants">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
          </Specimen>
          <Specimen label="Button: sizes">
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="touch">
              <CheckCircle2 />
              Resolve
            </Button>
            <Button size="icon-touch" variant="outline" aria-label="Add">
              <Plus />
            </Button>
          </Specimen>
          <Specimen label="Filter chip (new): off, on, with count; tag chip with clear">
            {['all', 'unread', 'mine'].map((id) => (
              <FilterChip
                key={id}
                selected={chip === id}
                onClick={() => setChip(id)}
                count={id === 'unread' ? 8 : undefined}
              >
                {{ all: 'All', unread: 'Unread', mine: 'Mine' }[id]}
              </FilterChip>
            ))}
            <FilterChip selected={false} onClick={() => setChip('tag')}>
              <Tag className="size-4" />
              Tag
            </FilterChip>
          </Specimen>
          <Specimen label="Badge, number chip, number badge, status">
            <Badge>3</Badge>
            <Badge variant="secondary">VIP</Badge>
            <Badge variant="outline">
              <UserRound />
              Daniel
            </Badge>
            <InboxChip inbox={{ name: 'Catering', tone: 'warning' }} />
            <InboxChip inbox={{ name: 'Online orders', tone: 'info' }} />
            <InboxSwatch
              inbox={{ name: 'Kopi Apong', tone: 'primary' }}
              solid
              className="size-6 text-[10px]"
            />
            <StatusDot tone="success" label="Connected" />
            <StatusDot tone="warning" label="Connecting" />
            <StatusDot tone="danger" label="Phone offline" />
          </Specimen>
          <div className="grid gap-4 md:grid-cols-2">
            <Specimen label="Inputs">
              <div className="w-full space-y-3">
                <SearchField
                  value=""
                  onChange={() => {}}
                  label="Search chats"
                  placeholder="Search name or number"
                />
                <Input placeholder="Phone number" inputMode="tel" className="h-11 text-base" />
                <label className="flex items-center justify-between gap-3 text-sm">
                  Team members can start new chats
                  <Switch checked={on} onCheckedChange={setOn} />
                </label>
              </div>
            </Specimen>
            <Specimen label="List row (anatomy)">
              <div className="w-full overflow-hidden rounded-lg border">
                {[
                  ['Farah Aziz', 'Can you do 30 pax on Saturday?', 3, 'warning'],
                  ['Kopi Lovers Club', 'A team member will reply soon.', 0, 'primary'],
                ].map(([name, preview, unread, tone]) => (
                  <div
                    key={name as string}
                    className="flex min-h-16 items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                  >
                    <span className="relative shrink-0">
                      <ChatAvatar name={name as string} seed={name as string} size="lg" />
                      <InboxSwatch
                        inbox={{ name: 'Catering', tone: tone as 'warning' }}
                        solid
                        className="absolute -bottom-0.5 -right-1 size-5 rounded-md border-2 border-surface text-[9px]"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            'flex-1 truncate text-[15px]',
                            unread ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {name}
                        </span>
                        <span
                          className={cn(
                            'text-xs',
                            unread ? 'font-semibold text-unread' : 'text-muted-foreground',
                          )}
                        >
                          13:44
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {preview}
                        </span>
                        {(unread as number) > 0 && (
                          <Badge className="min-w-5 bg-unread px-1.5 text-[11px] font-bold text-primary-foreground">
                            {unread}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </Specimen>
          </div>
          <Specimen label="Sheet, dialog, toast">
            <Button
              variant="outline"
              size="touch"
              onClick={() => setSheet(true)}
              data-testid="ds-sheet"
            >
              Open sheet
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="touch">
                  Confirm dialog
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Log out WhatsApp?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Chats stop arriving until someone scans the code again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Log out</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="outline"
              size="touch"
              onClick={() =>
                toast('Nurul Huda resolved', { action: { label: 'Undo', onClick: () => {} } })
              }
            >
              Toast with Undo
            </Button>
            <ResponsiveDialog
              open={sheet}
              onOpenChange={setSheet}
              title="Assigned to"
              description="A bottom sheet on phones, a dialog from 640 px."
            >
              <div className="space-y-0.5 pb-3">
                {['Aisyah (you)', 'Daniel', 'Unassigned'].map((n, i) => (
                  <Button
                    key={n}
                    variant="ghost"
                    className={cn('h-12 w-full justify-start text-[15px]', i === 0 && 'bg-accent')}
                    onClick={() => setSheet(false)}
                  >
                    <UserRound />
                    {n}
                  </Button>
                ))}
              </div>
            </ResponsiveDialog>
          </Specimen>
          <div className="grid gap-4 md:grid-cols-2">
            <Specimen label="Banner (persistent state)">
              <div className="w-full space-y-2">
                <Banner tone="warning" title="WhatsApp is reconnecting">
                  Messages arrive when it is back.
                </Banner>
                <Banner tone="danger" title="Phone offline">
                  Open WhatsApp on the phone.
                </Banner>
              </div>
            </Specimen>
            <Specimen label="Loading and empty">
              <div className="w-full space-y-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-12 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3.5 w-1/2" />
                  </div>
                </div>
                <EmptyState
                  illustration="/illustrations/empty-inbox.png"
                  title="All caught up"
                  description="No chat has unread messages."
                  className="p-4"
                />
              </div>
            </Specimen>
          </div>
          <Specimen label="Floating action button (phones; one per screen)">
            <span className="inline-flex h-14 items-center gap-2 rounded-2xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground shadow-lg">
              <MessageSquarePlus className="size-6" />
              New chat
            </span>
            <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
              <MessageSquarePlus className="size-6" />
            </span>
            <span className="text-xs text-muted-foreground">
              Extended at rest, icon while scrolling down.
            </span>
          </Specimen>
          <Specimen label="Tabs (desktop segmented filters; phones use chips)">
            <Tabs defaultValue="open">
              <TabsList className="h-11!">
                <TabsTrigger value="open">Open</TabsTrigger>
                <TabsTrigger value="resolved">Resolved</TabsTrigger>
              </TabsList>
            </Tabs>
          </Specimen>
        </Section>

        <Section
          id="mobile"
          title="Mobile patterns"
          lead="Below 768 px. Each pattern links to the mock screens that show it; the do / don't rules are in docs/design-system.md → Mobile patterns."
        >
          <div className="space-y-6">
            {PATTERNS.map((p) => (
              <div key={p.id} id={`mobile-${p.id}`} className="rounded-xl border bg-surface p-4">
                <p className="text-[15px] font-semibold">{p.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{p.rule}</p>
                <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
                  {p.shots.map((s) => (
                    <a
                      key={s}
                      href={`/screenshots/${s}.png`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0"
                    >
                      <img
                        src={`/screenshots/${s}.png`}
                        alt={s}
                        loading="lazy"
                        className={cn(
                          'rounded-lg border',
                          s.includes('desktop') ? 'h-64 w-auto' : 'h-64 w-auto',
                        )}
                      />
                      <span className="mt-1 block max-w-40 truncate font-mono text-[10px] text-muted-foreground">
                        {s}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="editions"
          title="Editions"
          lead="One design system for Lite and Enterprise. Enterprise screens use the published @ezychat/web components and these patterns; a missing pattern is added here first."
        >
          <div className="divide-y rounded-xl border bg-surface text-sm">
            {[
              [
                'Lock screen (access gate closed)',
                'Full page: EmptyState layout, one primary action; on phones no app bar, no FAB.',
              ],
              [
                'Licence and upgrade',
                'Admin page with PageHeader + cards; status in the card header (StatusDot); Banner for a licence that ends soon.',
              ],
              [
                'Connectors (custom MCP, own pages)',
                'Gallery cards and one page per connector; Save with SaveBar; secrets as a "saved" line with Replace.',
              ],
              [
                'WhatsApp Business API inbox (wa-cloud)',
                'Same inbox, number switcher row shows "Business API"; window-closed rows and template sheet follow the sheet rules.',
              ],
              [
                'Extension banners and nav',
                'One banner slot (Banner tones); admin nav items with a count or a warning dot; never a new colour.',
              ],
            ].map(([what, how]) => (
              <div key={what} className="grid gap-1 px-4 py-3 sm:grid-cols-[16rem_1fr]">
                <span className="font-medium">{what}</span>
                <span className="text-muted-foreground">{how}</span>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}

export default DesignSystemPage;
