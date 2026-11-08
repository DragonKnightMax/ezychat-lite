# Design System — "Calm Desk"

The single design system for **EzyChat Lite and EzyChat Enterprise** (production web screens, the desktop shell
and status page, feature mocks, extension screens, screenshots and generated images). Enterprise has no design
system of its own: it uses the published `@ezychat/web` components and these rules (see [Editions](#editions)).
A living reference that renders the real tokens and components, light and dark, is the mock page
[`/design-system`](features/mobile-redesign/mock/src/design-system/DesignSystemPage.tsx) (run the
[mobile-redesign mock](features/mobile-redesign/mock/README.md), open `http://localhost:7489/design-system`).

EzyChat is a tool people keep open all day to answer customers. The design language is
**quiet, dense, and work-focused**: neutral surfaces, colour only where it carries meaning
(unread, assignment, status, connection state), and clear separation between what the customer
sees and what only the team sees.

## Principles

1. **Meaningful colour only.** Neutral slate UI; the teal accent marks primary actions, selection,
   and focus. Semantic colours mark state. Never decorative colour.
2. **Internal ≠ external.** Internal notes are amber cards, system events are centred chips,
   customer-visible bubbles are neutral (inbound) or teal-tinted (outbound). Nothing internal
   may look like a message bubble.
3. **Mobile is first-class.** Most agents use a phone via the tunnel. Every screen works at 360px, and the
   inbox has its own phone layout below 768 px ([Mobile patterns](#mobile-patterns)).
4. **Compose, don't hand-build.** Feature code composes components from `src/components/ui`.
   No raw `<button>`, ad-hoc modals, or one-off colour classes in feature code.
5. **Not WhatsApp.** No WhatsApp green, logo, or chat-wallpaper imitation (trademark + clarity).

## Foundations

### Stack

| Concern           | Choice                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Primitives        | [shadcn/ui](https://ui.shadcn.com) (Radix UI) — source lives in `apps/web/src/components/ui/` |
| Variants          | `class-variance-authority` + `tailwind-merge` via `cn()` in `src/lib/utils.ts`                |
| Icons             | `lucide-react` (stroke 1.75, 16/20px)                                                         |
| Toasts            | `sonner` (top centre on desktop, bottom centre above the composer / FAB on phones)            |
| Mobile sheets     | `vaul` (Drawer)                                                                               |
| Command / pickers | `cmdk` (quick-reply picker, chat switcher)                                                    |

### Colour tokens (CSS variables in `src/index.css`, mapped into Tailwind 4 `@theme`)

| Token                    | Light                                 | Dark                  | Use                                    |
| ------------------------ | ------------------------------------- | --------------------- | -------------------------------------- |
| `--background`           | slate-50 `#F8FAFC`                    | `#0B1220`             | app background                         |
| `--surface`              | white                                 | `#111827`             | cards, panes, inbound bubble           |
| `--muted`                | slate-100                             | `#1F2937`             | hover, secondary surfaces              |
| `--muted-foreground`     | slate-600 `#475569`                   | slate-400             | secondary text                         |
| `--foreground`           | slate-900                             | slate-100             | primary text                           |
| `--border`               | slate-200                             | `#243042`             | dividers                               |
| `--input`                | `#8696AB`                             | slate-500 `#64748B`   | control outlines                       |
| `--accent` / `--primary` | teal-700 `#0F766E`                    | teal-500 `#14B8A6`    | primary actions, selection, focus ring |
| `--primary-foreground`   | white                                 | `#04201D`             | text on primary                        |
| `--outbound`             | teal-50 `#F0FDFA`                     | `#0F2E2B`             | outbound bubble                        |
| `--note`                 | amber-50 `#FFFBEB` / border amber-300 | `#2B2111` / amber-700 | internal notes                         |
| `--success`              | green-700 `#15803D`                   | green-500             | delivered/read, connected              |
| `--warning`              | amber-800 `#92400E`                   | amber-400             | connecting, pending                    |
| `--danger`               | red-600                               | red-500               | failed, logged out, destructive        |
| `--info`                 | sky-700 `#0369A1`                     | sky-400               | informational banners                  |
| `--unread`               | teal-700 `#0F766E`                    | teal-400              | unread badge                           |
| `--overlay`              | black 50 %                            | black 50 % (same)     | behind sheets and dialogs              |

Number (inbox) colours reuse the state tones as **identity** only: `primary`, `warning`, `info`, `success` tint the
number chip (`InboxChip`) and fill the small number badge on a photo (`InboxSwatch solid`, text `background`). They
never mean "warning" or "success" there, so never pair them with a state word.

### Language

All UI text goes through `t()` (react-i18next); see [`docs/i18n.md`](i18n.md). Members pick
English, Bahasa Melayu or 简体中文 under Account menu → Language (saved to their account); the
sign-in and setup screens show a compact language picker. Languages are listed by their native
name. Design for the longest language: Malay labels run ~30% longer than English, so prefer short
labels, allow wrapping or truncation in tight rows, and check every screen at 360px in Malay.

### Writing (owner rule)

The reader is a **business owner or their staff, not an engineer**. Write so they understand at a glance.

- **Few words.** A label is 1–3 words; a hint is one short sentence; a card description is at most two. Cut
  anything the screen already shows. Lead with what happens to them ("Blocks the number"), not how it works.
- **Plain words.** Say "file", "number", "blocked", "your team"; not "payload", "JID", "MIME", "quarantine
  folder", "hash", "API". Name a business result, not a mechanism.
- **Tip for anything technical.** When a setting needs a concept the owner may not know (AI connection, tunnel,
  API key, Business API, auto-block), keep the label plain and put the explanation behind `<InfoTip>`
  (`components/app`): what it is, why it matters, what to do — three short lines at most.
- **Say what to do next.** Warnings and errors end with the one action that fixes it ("Ask an admin to release
  it").
- **Numbers and names over adjectives.** "3 files blocked this week", not "many threats detected". No fear words
  or exclamation marks.

### Appearance preference

Light, Dark, and System are available in the Account menu for every member and under
Settings → Preferences → This device (Language sits in the separate "Your account" card there,
because it is saved to the account rather than the device). System is the default and follows operating-system changes.
The choice applies immediately and is stored per browser/device (`wati.theme` in local storage),
with updates synchronized between tabs. It does not change another member's appearance or require
Save settings. If storage is unavailable, the choice still applies for the current session.

`src/lib/theme.tsx` resolves the preference to `data-theme="light"` or `"dark"` on the document root.
Both CSS tokens and Tailwind's `dark:` variant use that resolved value, so manual Light overrides
a dark OS and manual Dark overrides a light OS. Before JavaScript loads, CSS falls back to the OS.
Keep the explicit dark tokens and the media-query fallback identical when adjusting the palette.

### Type

Inter (self-hosted via `@fontsource-variable/inter`), fallback system UI stack.
Scale: 12 (meta), 13 (dense lists), 14 (body, chips), 15 (list names and sheet rows on phones), 16 (inputs,
mobile body), 18/20 (titles; 20 semibold for the phone app bar).
Inputs are **≥16px** on mobile to avoid iOS zoom.

### Spacing, radius, elevation, motion

- 4px grid (Tailwind default scale).
- Radius (Tailwind classes as `index.css` defines them): `rounded-sm` 6px (inputs), `rounded-md` 8px (menu items),
  `rounded-lg` = `--radius` 10px (buttons, cards, sheet rows), `rounded-xl` 16px (cards on phones, sheets, bubbles;
  the FAB uses `rounded-2xl`), `rounded-full` (filter chips, avatars, badges). (An earlier version of this file
  called 16px `--radius-lg`; `index.css` maps `--radius-lg` to `--radius`.)
- Elevation: `shadow-sm` (cards), `shadow-lg` (popovers, dialogs, the FAB) — nothing else.
- Motion: 150ms ease-out; respect `prefers-reduced-motion`.
- Touch targets ≥ 44px on touch devices (`size="touch"` / `"icon-touch"` button sizes / `min-h-11`). A control
  may draw smaller (a 36px filter chip) only if its hit area reaches 44px (`after:absolute after:-inset-y-1`).
  Shrink dense desktop rows only for precise pointers (`md:pointer-fine:min-h-8`), never by
  breakpoint alone: tablets are touch screens at `md` widths.

## Components (all in `src/components/ui`)

Button (variants: default, secondary, outline, ghost, destructive, link; sizes: sm, default, lg, icon, touch),
Input, Textarea, Label, Form field wrapper, Select, Checkbox, Switch, RadioGroup, Tabs, Badge,
Avatar, Card, Dialog, AlertDialog (confirmations), Sheet / Drawer (mobile), DropdownMenu, Popover,
Tooltip, Command, ScrollArea, Separator, Skeleton, Sonner Toaster, Table (+ responsive card list),
EmptyState (illustration + title + action), StatusDot (wa/tunnel states), Banner (info/warning/danger).

App-level composites live in `src/components/app/` (e.g. `ChatAvatar`, `AssigneeSelect`,
`MessageStatusIcon`, `ConnectionBadge`, `PageHeader`, `ResponsiveTable`, `ResponsiveDialog`).
Proposed with the mobile redesign (added when the phone layout is built): `FilterChip`, the number switcher sheet,
`AssignSheet`, `TagSheet`, `ChatRowActions` (swipe + press and hold) and the New chat FAB.

## Patterns

- **Page headers** use `PageHeader`: title, one-line description, actions top-right (they wrap
  below the title on phones). Every admin page has a description.
- **Saving forms** use `SaveBar` (`admin/adminUi.tsx`): Save sits at the end of the form,
  right-aligned (full width on phones); while there are edits it sticks to the bottom of the
  screen with an "Unsaved" marker. Don't place Save buttons elsewhere.
- **Row actions** (members, quick replies): one visible Edit button, everything else (including
  Delete) in a "…" `DropdownMenu`. Rows without a menu keep its slot so buttons line up.
- **Action lists** (e.g. WhatsApp): one row per action — what it does on the left, the button on
  the right (stacked on phones), least disruptive first; irreversible ones last, as outline
  buttons with `text-danger`, always confirmed with `AlertDialog`.
- **Danger styling** (red frames, destructive buttons) is only for irreversible actions.
  Reversible bulk actions (resolve all chats) use normal styling. A switched-off item (AI member
  Off, disabled member) is neutral (`Badge variant="secondary"`), never red.
- **Disabled buttons**: filled variants turn `bg-muted text-muted-foreground`; never leave a
  faded teal button. Prefer keeping a form's primary action enabled and explaining missing
  fields on submit (sign-in, change password). Don't show a disabled button as a status label.
- **Secrets** (API keys, tokens) are never shown: a saved one appears as a read-only "saved"
  line with **Replace**; raw technical options (model ids) sit behind an "Advanced" disclosure.
- **Status** belongs in the header of the card it describes (`StatusDot`), not a separate card.
- **Tabs**: the selected tab (default variant) is a white `surface` segment with an `input`
  border (≥3:1 against the track). Tab rows that may overflow at 360px scroll sideways
  (`overflow-x-auto` with `scroll-px-4`).
- **Confirmations** use `AlertDialog` (logout WhatsApp, reset password, reply to someone else's chat).
- **Feedback** uses toasts for success/failure of actions; inline `Banner` for persistent state
  (WhatsApp disconnected, tunnel error, LAN over HTTP).
- **Tags** (direct chats and groups) are `secondary` pills: plain in list rows (no room for an icon), with the tag
  icon in the chat header strip and the Tags row of Customer details / Group info. Every place that edits tags opens
  the same Tags editor (bottom sheet on phones, dialog on desktop): search or type to add, tick to keep, **Done**.
  Never a coloured or bordered tag, and never a second way to edit them. — mobile-redesign `14-chat-header`,
  `24-group-tags-saved`, `25-group-info-tags`, `32-desktop-group-info-tags`
- **Empty states** use `EmptyState` with an illustration from `public/illustrations/`.
- **Loading** uses `Skeleton` rows, not spinners, for lists.
- **Upload progress** of a file this browser sends sits at the top of its pending bubble, above the file's
  "Uploading …" placeholder: a thin `Progress` bar (`h-1.5`, primary on muted, labelled "Uploading 42%") with the
  percentage in `text-xs text-muted-foreground` beside it, gone when the upload ends; the bubble then shows the usual
  pending clock. Don't use a spinner or a toast for it, and don't block the
  composer. A size refusal (WhatsApp's limit, the tunnel's 100 MB) is said before uploading as an error toast that
  names the limit and where it works, and in the failed bubble with the same words. — screenshots in
  `docs/features/mcp-file-upload/screens/`
- **Small screens:** Dialog → Drawer (bottom sheet) below `sm` (`ResponsiveDialog`); tables → stacked cards below
  `lg`; admin side nav → top Tabs/Sheet below `md`; the inbox switches to its phone layout below `md` (768px, see
  [Mobile patterns](#mobile-patterns)). Filters that are segmented tabs on desktop are chips on phones.
- Dialogs and confirmations fit within `100dvh` with room at the edges and scroll when necessary.
  Long names wrap in titles. Wide tables allow scrolling instead of clipping columns.

## Mobile patterns

For phones (below 768 px, the width at which the inbox becomes one column). Every rule has a mock screen in
[`features/mobile-redesign/mock/screenshots`](features/mobile-redesign/mock/screenshots) (`<shot>-m360-light.png`;
390 px, dark, Malay and Chinese variants beside it). Desktop keeps its own layout; never let a phone pattern leak
into it. The owner made these the rules for both editions on 2026-11-07; the app follows them once the mobile redesign is
built (the mock shows each one).

### App bar and number switcher

- **Do** use one 56 px bar: the title says where you are, then at most two icons (search, account). With 2+
  WhatsApp numbers the title is the number switcher ("All numbers ▾" / the number's name and phone), opening a
  bottom sheet with each number's unread chats and connection; a dot on the title marks unread chats on other
  numbers. Admins get "Manage numbers" at the bottom of the sheet. — `01-list`, `02-inbox-switcher`,
  `03-switched-catering`
- **Don't** spend a full-width select or a row on something most people never change, show the switcher with
  one number (Lite, a one-number agent: plain "Inbox", `21-lite-one-number`, `22-agent-one-number`), or put a
  labelled "Admin" button in the bar (Admin settings is in the account menu).

### FAB (floating action button)

- **Do** use one FAB per screen, for that screen's main _create_ action (the chat list: **New chat**), bottom right
  above the safe area, 56 px, `bg-primary`, `rounded-2xl`, `shadow-lg`; labelled at rest, icon only while the list
  scrolls down; give the list bottom padding so the last row clears it. Same permission as the action
  (hidden when the user may not start chats). — `01-list`, `08-new-chat-sheet`, `09-fab-compact-on-scroll`
- **Don't** add a second FAB, use it for navigation or a destructive action, show it on a detail screen (the chat
  has its composer), or show it on desktop.

### Filter chips above lists

- **Do** put list filters in one horizontally scrolling row of 36 px pills (`FilterChip`, 44 px hit area): one
  single-choice group (All · Unread · Mine · Unassigned · Groups), then pickers that open a sheet (Tag ▾, which
  shows the chosen value with an × to clear) and toggles (Resolved). Show a count only where it drives action
  (Unread). Selected = `bg-primary/10 text-primary border-primary/30`. — `04-chip-unread`, `05-tag-filter-sheet`,
  `06-tag-filtered`
- **Don't** stack segmented tabs, selects and buttons into several rows above a list, wrap chips onto a second
  line, or use colour other than the selected state.

### Bottom sheets, dialogs and full-screen pages

- **Do** use a bottom sheet (`ResponsiveDialog`, a Drawer below 640 px) to pick from a list or act on one item:
  number switcher, assignee, tags, row actions, ⋮ more. Rows are 48 px+, icon + label, a check for the current
  choice; a sheet that edits several values ends with one full-width primary button (**Done**); one that picks a
  single value closes on tap. — `15-assign-sheet`, `16-chat-tags-sheet`, `17-chat-tags-create`, `19-chat-more-sheet`
- **Do** use `AlertDialog` to confirm something irreversible, and a full page for long forms or reading
  (Admin, Customer details, Group info).
- **Don't** open a desktop popover or dropdown on a phone, stack a sheet on a sheet (replace it: More → Assign), or
  put a long form in a sheet.

### Swipe and press and hold

- **Do** treat gestures as shortcuts: swipe a chat row right = **Assign to me**, left = **Resolve** (Reopen in the
  Resolved list); reveal the action's label and colour under the row (`primary`, `success`), act past 72 px,
  confirm with a bottom toast that has **Undo**. Press and hold (or the context menu) opens a sheet with _every_
  row action, the swipe ones included. — `10-swipe-assign`, `11-swipe-assigned-toast`, `12-swipe-resolve`,
  `13-row-actions`
- **Don't** make a gesture the only way to an action, use a swipe for something that cannot be undone, or react
  to a vertical scroll (decide the direction after 10 px; `touch-action: pan-y`).

### Detail header with chips

- **Do** keep the detail header to one 56 px row (back, photo + name + one subtitle line that opens the details,
  the one main action, ⋮) and put the item's facts under it as a scrolling chip strip: who handles it (▾ opens
  the assign sheet; dashed when unassigned), tags with **+ Tag**, Notes with its count, the group's AI badge.
  The main action may drop its label below 375 px (it keeps an accessible name). — `14-chat-header`,
  `18-chat-tags-saved`, `20-group-header`
- **Don't** wrap header actions onto a second row of selects and icon-only buttons, or cram badges into the
  subtitle.

### Selection and action bar

- **Do** (phase 2) enter selection by pressing and holding a row and then tapping more rows; the app bar becomes a
  contextual bar (× · "3 selected" · actions) with the same actions as the row sheet; leaving it is × or Back.
- **Don't** add checkboxes to every row by default, or keep the FAB visible while selecting.

### Composer and keyboard

- **Do** pin the composer to the bottom inside the safe area (`safe-bottom`), keep inputs ≥ 16px, let the visible
  viewport shrink with the keyboard so the newest message and the box stay visible; keep the reply tools in one
  row (phase 2: emoji and attach inside the field, one ✦ button for Quick replies, Suggest reply and Fix English).
  Toasts sit above the composer on phones (`18-chat-tags-saved`).
- **Don't** let the keyboard cover the box, put toasts at the top of a phone screen, or add rows under the box.

### Bottom navigation vs menu

- **Do** reach rarely used destinations (Admin settings, language, theme, About and the version, sign out) from
  the account menu in the app bar while there are fewer than three everyday destinations.
- **Don't** add a bottom navigation bar for two items; propose one (Chats · Reports · Admin · Me) only when three
  or more destinations are used daily, and only with the owner's confirmation (2026-11-07: no bottom bar).

### Empty states

- **Do** use `EmptyState` per filter with a reason and the way out ("All caught up — No chat has unread
  messages." · **Show all open chats**); on phones the first-run Getting started card sits in the empty list.
- **Don't** show a blank list or an error-coloured message for "nothing here".

### Pull to refresh

- **Do** rely on live updates (Socket.IO) for lists; a manual refresh, if ever added, is pull-to-refresh on the
  list only, with the standard spinner.
- **Don't** add a refresh button, or let the browser's own pull-to-refresh reload the app
  (`overscroll-contain` on scrolling lists).

### Back behaviour

- **Do** make Back (button, Android back, iOS edge swipe) close the top sheet or dialog first, then search, then
  go from a chat to the list (history pop when the chat was opened from the list, replace for deep links).
- **Don't** trap Back, or leave a chat by Back into a reopened sheet.

## Editions

Enterprise follows this file through the published `@ezychat/web` components and its extension slots; it never
adds tokens, colours or one-off styles. A pattern Enterprise needs is added here in a Lite PR first.

| Enterprise screen                        | Shared pattern                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Lock screen (access gate closed)         | `lockScreen` full page in the `EmptyState` layout, one primary action; no app bar, chips or FAB                            |
| Licence, upgrade, trial                  | Admin page: `PageHeader`, cards with status in the header (`StatusDot`), `Banner` before it ends                           |
| Connectors (custom MCP, own pages)       | Gallery cards → one page per connector, `SaveBar`, secrets as a "saved" line with **Replace**                              |
| WhatsApp Business API inbox (wa-cloud)   | Same inbox and number switcher ("· Business API" under the name); window-closed rows; template picker as a sheet on phones |
| Extension banners, admin nav, agent rows | One banner slot (`Banner` tones), nav items with a count or a warning dot, rows in the agent page's card style             |

## Brand assets (`apps/web/public`, `apps/desktop/build`)

App icon: the official EzyChat headset parrot on a green gradient tile (the same mark on the
sign-in screen, desktop window, installer, PWA and sharing card); no third-party logo. The tile's
green belongs to the brand mark only — UI colour stays on the tokens above (teal accent).
Source, provenance and reproducible exports live in `design/app-icon/` (see `docs/brand.md`).
Generated variants: `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon.png`, `favicon.ico`, desktop `icon.ico` / `icon.icns` / tray template images.
Illustrations (empty inbox, no results, link WhatsApp, tunnel, welcome) share one flat style:
teal + slate palette, thin line work, no people's faces, no brand logos.

## Rules for contributors (enforced)

- ESLint `no-restricted-syntax` blocks raw `<button>`, `<dialog>`, `<select>` in `src/**`
  outside `src/components/ui/**`.
- No hard-coded hex colours or Tailwind palette colours (e.g. `bg-emerald-600`) outside
  `src/index.css` and `src/components/ui/**` — use token classes (`bg-primary`, `text-muted-foreground`).
- New UI primitive → add it via `npx shadcn@latest add <name>` and adjust to tokens.
- A new token, component, variant or pattern is added to this file (rule with a do/don't and a mock screen) in the
  same PR that first uses it; a change that contradicts this file updates it first and needs the owner's
  confirmation.
