# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Anonymous usage stats (you can turn them off).** EzyChat now counts a few setup steps (installed, admin
  created, WhatsApp linked, AI connected, AI agent on, first message sent) and whether the app was used that day, so
  we can see where new users get stuck. Only a random install code, the app version, Windows or Mac and the step are
  sent, to the EzyChat licence server; never names, numbers, chats, messages, emails or keys. Admins switch it off in
  Settings → General → Privacy or on the last step of the setup wizard.

## [0.1.76] - 2026-11-05

### Changed

- **Faster when you open EzyChat from outside your office.** Over a slow connection (for example the shared link
  through Cloudflare), the inbox now shows your last chat list at once and updates it a moment later. Contact photos
  are kept on your phone and only load again when a contact changes their photo, and files you opened stay on your
  phone for 30 days. In a test with a slow link, the chat list showed in about 1 second instead of 2.7, with half
  the requests. Everything kept on the phone is removed when you sign out, and files that WhatsApp Safety flags or
  is still checking are never kept.

### Fixed

- **Reset admin password from the tray works when EzyChat runs as a background service.** Before, it set a new
  password but did not show it, so you could not sign in. It now waits and shows the new password.

## [0.1.75] - 2026-11-04

### Added

- **New AI agent templates without an app update.** The business-template gallery now also reads a signed template
  library from EzyChat's servers when it opens, so new templates (and fixes to existing ones) arrive without
  installing a new version. The templates built into the app stay available offline, and the gallery says when the
  library was last updated. A template still only fills the boxes after you click Apply.
- **Manage WhatsApp groups from Group info.** EzyChat admins can rename a group, edit its description, add one
  member at a time (with a ban-risk note; when the person's privacy settings refuse, a Send invite button sends them a
  private invite), remove members, make or remove group admins, copy or reset the invite link, change the group's
  settings (only admins send, only admins edit info, who can add members, approve new members) and approve or reject
  join requests, without switching to the phone. Only what the connection supports is shown, the linked number must
  be a group admin, adds are limited to 20 a day and 6 an hour per number, and Settings lists the recent changes
  made in EzyChat. Team members see Group info read-only.
- **Claims agent template.** The business-template gallery of the AI agent page has a new category, Team and
  operations, with a Claims agent: it records claims that members post in your WhatsApp groups to the Claims tab of
  Google Sheets, replies "Recorded ✅" with the key values, asks for missing details, reads receipts and PDFs, stays
  quiet on other messages and never approves or promises payment. Applying it fills the name, instructions and
  hand-off rules and adds a "Claim rules" Business context item to fill in. A new agent made from it answers in groups
  only; an existing agent shows which switches to change.

### Fixed

- **Fix English no longer suggests the same fix again or adds the text twice.** After you apply a grammar fix
  (for example a full stop), the next check no longer offers it again, and a word that needs two changes ("check
  email" → "check your email.") gets one suggestion instead of two that added the word twice.

## [0.1.73] - 2026-11-04

### Added

- **Record claims, invoices and more into Google Sheets.** In Google Sheets settings, each tab of the spreadsheet is
  now Off, Read or Add rows for each AI agent, with a Refresh button after you edit the sheet. The agent's own
  instructions say what to record and where (for example "save each claim to the tab Claims"); EzyChat fills in date,
  name, WhatsApp number, group and source, and saves only values the person wrote or sent. The old "Add leads" keeps
  working as a tab on Add rows.
- **The AI reads PDFs.** Invoices, claim forms and receipts sent as PDF (or photos, up to 10 for agents that save
  rows) are read by the AI agent. Word, Excel and ZIP files are not opened.
- **Groups can read every message.** A group can be set to "Reads every message": the agent sees each member message
  and follows its instructions (save a claim, ask for a missing detail or stay quiet) without being tagged. Add
  several groups to one agent at once from its page.
- **Several AI agents per WhatsApp number (Enterprise).** One agent answers direct chats; others work in the groups
  you give them, for example a claims agent for every branch group.
- **Send feedback from the app.** Anyone signed in can tell the EzyChat team about a problem, an idea or a question
  from the account menu, Admin → Help & feedback, About or the error panel ("Report this problem"), with up to 3
  pictures, PDFs, text files or short videos and, in the desktop app, a screenshot of the window. Email is required so
  we can reply. App details (version, computer, connection status) are included unless you untick them, and the last
  lines of the app log only when you tick it; "See what is sent" shows both. Phone numbers, emails, names and message
  text are removed from the log first. Nothing is sent until you press Send. This replaces Request a feature and Report
  an issue in the menus; the GitHub link is inside the form.
- **Open PDFs and photos inside EzyChat.** Tap a PDF a customer sent and it opens in the app, page by page, with zoom.
  No more saving it first and opening it somewhere else. Photos sent as files open in the photo preview too.
  Download is still one tap away, and other files download as before.

- **Suggest reply and Summarise with Ezy in group chats.** The two AI buttons under the message box now show in
  WhatsApp groups too, not only in one-to-one chats. Suggested replies answer the latest question in the group and
  see members by name, never by phone number. Nothing is sent until you press Send.

### Fixed

- **The AI agent answers in a group after someone deletes a message there.** After a member deleted a message for
  everyone, the AI could fail to answer when tagged in that group, until the deleted message was far enough back.
- **No more random "can't reach" errors on networks without working IPv6.** On some home and office networks
  the computer gets IPv6 addresses but cannot use them. EzyChat then sometimes waited 10 seconds and showed that
  it could not reach a service (for example the licence server), while the browser worked. EzyChat now tries
  IPv4 first and uses IPv6 only when IPv4 fails.

## [0.1.72] - 2026-11-03

### Fixed

- **macOS: in-app updates and the background service work.** On a Mac, installing an update or changing the
  background service stopped with "Node.util.isObject is not a function". The Mac password prompt now uses a
  maintained component. Macs install this version once from the download page; later updates work in the app.

## [0.1.71] - 2026-11-03

### Added

- **AI assistants can send PDF and Word files.** With **Can send WhatsApp messages**, an AI assistant connected
  through MCP can now send a PDF or Word (.docx) file of up to 5 MB, with a caption, into an existing chat, for
  example a quotation or your terms. The customer gets it as a WhatsApp document with the name you chose. Other
  file types are refused, whatever their name.
- **Google Sheets connector (Beta).** Admin → Connectors → **Google Sheets**: sign in with Google, choose a
  spreadsheet in Google's own file picker (EzyChat can open only the sheets you choose) and pick a tab. With
  **Answer questions from the sheet**, the AI agent answers prices, stock, opening hours or FAQ questions from that
  tab. Turn on **Save interested customers (leads)** and choose a second tab, and the AI adds each customer who says
  what they want to buy as one row (date, name, WhatsApp number, email, request) so your team can follow up; a
  question alone is not a lead, and the AI never takes the order or the payment. At most one row a day per
  customer, never from a group. It never changes or deletes existing rows, and a formula a customer types is saved
  as plain text. Google Sheets has its own Google sign-in, separate from Google Calendar.

## [0.1.70] - 2026-11-02

### Fixed

- **Linking WhatsApp no longer gets stuck on a spinner.** Showing the QR code (or a new one) could hang on
  "Waiting for the QR code" when the WhatsApp version lookup was slow to answer. The QR code now shows at once; the
  lookup runs in the background and is used from the next connection.

## [0.1.69] - 2026-11-02

### Added

- **AI assistants can send images.** A connected AI assistant (MCP) with **Can send WhatsApp messages** has a new
  `send_image` tool: it sends a JPEG, PNG or WebP photo (up to 5 MB, from a public https link or as a file) with an
  optional caption into an existing chat, with the same limits, approval and "via AI assistant" mark as text replies.
- **Reports per WhatsApp number.** With two or more numbers, Admin → Reports has an inbox choice next to the period:
  **All inboxes** shows every number together (as before), or pick one number to see only its customers, replies,
  AI hand-offs and WhatsApp Safety findings.
- **Edit and delete messages.** Hover a message you sent (or press and hold it on a phone) and choose **Edit** to
  fix the text or caption within 15 minutes: the customer sees it marked "Edited", and **Edited** in the inbox lists
  the earlier versions. **Delete** removes it for everyone within 2 days; admins can also **Delete for me**, which
  hides a message for the whole team and on the linked phone. Admins can change messages sent from the phone or by
  the AI agent; agents change their own. When a customer edits or deletes a message, the inbox now shows it too
  ("Edited", or "… deleted this message"); admins can still open the original. The AI agent ignores deleted
  messages and answers the edited text. Linked-phone inboxes only (the WhatsApp Business API cannot edit or
  delete).

### Fixed

- **Retry no longer sends a message twice.** WhatsApp sometimes reports an error for a message it already took (in a
  group, often only one member's phone could not take it). EzyChat showed it as not sent, and Retry sent a second
  copy. Retry now sends it again as the same message, so phones that already have it do not show it twice. In a group
  the message says "Some members may not have received this" instead, and it clears by itself as soon as a member
  receives or reads it.
- **One customer, same details in every inbox.** With two or more WhatsApp numbers, a customer who chats with
  both now shows the same saved name, company, email, other phone and address in each inbox: an edit in one
  inbox updates the other, and a new chat of a known customer starts with their details. Tags stay per inbox.

## [0.1.68] - 2026-11-01

### Fixed

- **Move to EzyChat Enterprise when EzyChat Lite runs as a background service.** Enterprise said "No EzyChat Lite
  data on this PC", because the service keeps its data in a protected folder. It now says that EzyChat Lite runs as a
  background service and offers **Allow and continue**: Windows asks once, EzyChat Lite's own "Remove service" step
  moves the data to Lite's folder, and the import continues as usual. If Windows does not allow it, nothing changes
  and the page shows how to do it in EzyChat Lite.
- **Remove service no longer stops halfway.** When the target folder already holds data, "Remove service" now
  refuses before it touches the service, instead of removing the service and then leaving the data where it was.

## [0.1.67] - 2026-11-01

### Added

- **Move to EzyChat Enterprise in one step.** Your team keeps everything when you upgrade: the same WhatsApp link
  (no new QR scan), chats and media, teammates and their passwords, AI agents, settings and remote access.
  - **In EzyChat Lite:** Upgrade → **Install EzyChat Enterprise** downloads the installer, checks it and starts it
    (only in the desktop app on the computer that runs EzyChat).
  - **In EzyChat Enterprise:** the first screen offers **Bring from EzyChat Lite**. It asks you to close EzyChat Lite,
    copies your data and starts on Lite's address, so phones and bookmarks keep working. Sign in with your Lite
    password. Lite's data stays on the computer, untouched.
  - **Already on Enterprise?** Admin → Inboxes → **Add a number from EzyChat Lite** brings a Lite number in as one more
    inbox, with its chats, customers, team and AI agent. A checklist helps Lite's team sign in at the new address.
  - **EzyChat Lite afterwards** shows "This WhatsApp number now runs in EzyChat Enterprise" instead of starting, so the
    number is never answered twice. **Use EzyChat Lite again** is there if you need it.
  - When EzyChat's address changed, Settings → Integrations shows the new address for AI assistants (Claude, ChatGPT).

## [0.1.66] - 2026-11-01

### Added

- **Tag people in WhatsApp groups.** In a group chat, type `@` in the reply box and pick a member from **Tag a
  member** (type a few letters of their name or number to filter). The member gets a real WhatsApp tag and a
  notification, just as when you tag them from your phone, and EzyChat shows their name in the message. Tagging works
  on numbers linked with the WhatsApp app; the WhatsApp Business API does not support tags yet, so its groups show no
  picker.

- **WhatsApp Safety.** EzyChat checks every message customers send for risky files and scams, such as the fake
  "statement of account" ZIP that hides a program, fake bank links and password-locked files.
  - **In the chat:** a flagged message shows a short warning. Your team checks a file before downloading it.
  - **Locked files:** a dangerous file is locked for your team until an admin unlocks it.
  - **Admin → Safety:** who sent it, from which number, why it was flagged and who on the team downloaded it. You can
    mark it safe, report the number as a scam, block it, or delete the file.
  - **AI check:** your AI connection (if you have one) helps spot scams the rules miss. It reads the message and file
    names, never the file.
  - **Auto-block:** off by default. It blocks only new numbers that send a hidden program. A customer you know is
    warned as possibly hacked instead.
  - **Reports:** a new WhatsApp Safety section counts dangerous files, scam messages, risky downloads, blocked numbers
    and false alarms.
- **AI agents that answer only in groups.** Each AI agent has a new **Answer direct chats** switch (on by default).
  Turn it off and keep **Answer in groups** on, and the agent answers only when tagged or quoted in the groups you
  switched on; direct chats stay with your team. The direct chats it was handling go back to the team, and it cannot be
  assigned a direct chat while the switch is off. WhatsApp Business API inboxes have no groups, so the switch is not
  shown there.
- **"?" tips for new words.** A small **?** beside API key, model, Business context, hand-over rules, phone access,
  LAN, AI assistant access, access tokens, connectors and the setup steps says in one or two sentences what each one
  is. The API key tips also link to the page where you get a key and show the steps when asked. Each tip links to
  the full guide in your language.

### Fixed

- **The AI agent follows your hand-over rules.** A request to book a consultation, meeting, demo or call is now
  treated as a sales conversation: the agent asks what the customer needs instead of handing the chat over, and
  your "never hand over" rules win over the agent's built-in reasons (except safety ones). The agent only says a
  team member will help when it really hands the chat over.
- **No more "Does that answer your question?" after every answer.** Each AI agent page has a new **Closing chats**
  card with the switch "Ask if the question is answered". It is off for every agent: the agent adds no check-in
  line and never closes a chat. When it is on, a "yes" that carries new information (for example "yes, we are in
  Malaysia") no longer closes the chat, and the agent never writes "I will close this chat now".
- **A message in a chat the AI handed over says so.** Its notification now reads "<name> is waiting for a
  teammate" until someone in the team replies, instead of looking like a routine message.
- **A "thanks" after the AI closed a chat is acknowledged and closed again.** When a customer only says thanks
  after the AI agent resolved the chat, the AI now reacts with a thumbs up (or replies "👍" where reactions are not
  available) and resolves the chat again, instead of leaving an open chat that nobody answers. A new question, or a
  teammate who acted in the chat, keeps it open as before.
- **No Windows Firewall question at start.** Since 0.1.65 the free-port check asked Windows Firewall for network
  access on every start. The app now checks only the address it really uses, so the question shows only when
  LAN access is on.
- **A reply from your phone no longer leaves a chat stuck with the AI.** When you answer from the WhatsApp phone in a
  chat that the AI agent holds, the AI now returns the chat to the team and stays out of it, so new customer messages
  reach your team again. Chats that an earlier version left stuck are returned to the team when the app starts. Assign
  a chat to the AI again to let it answer the newest message.

## [0.1.65] - 2026-10-30

### Changed

- **The app picks a free port by itself.** When another program already uses the port of EzyChat (7420, or 7440 for
  Enterprise), the app now starts on the next free port and keeps it, instead of stopping with "The server did not
  start". Teammates who open the inbox on the local network use the new address shown in the app.

## [0.1.64] - 2026-10-30

### Added

- **Ask Ezy.** Ask questions about your chats, customers and inbox in plain words, from the **Ask Ezy** button
  in the inbox and in Admin, or from a chat ("Summarise with Ezy"). Ezy answers with short text and, where it
  helps, number cards, bar charts, a busy-hours chart, a list of chats or a customer summary, and always says
  what it read. Admins can also ask Ezy to improve the AI agent: it suggests changes to the instructions,
  hand-off rules or Business context with a before/after test, and nothing changes until you press **Apply**
  (with **Undo**). Team members see only the chats of their own inboxes and get a message they can send to
  their admin. Ezy uses your AI connection (ChatGPT, OpenAI or Claude) and never sends messages to customers.

## [0.1.63] - 2026-10-30

### Added

- **Fix English.** While you type an English reply, spelling mistakes are underlined in red at once and grammar
  mistakes in blue after a short pause. Hover a word (or tap it on a phone) to fix it, or press **Fix** (or
  Ctrl+J) to fix them all, with **Undo**. Spelling uses a British English dictionary built into the app (about
  0.2 MB, downloaded once): it is free and works without AI. Grammar uses your AI connection. Numbers, prices,
  names, links and Malaysian chat words (lah, ya, nasi lemak) are never changed, Malay and Chinese messages are
  not checked, and nothing changes or is sent without you. Words the dictionary does not know (product and
  place names) can be added to the team's word list; words of your Business context count too. Admins switch
  it in Settings → AI; it is off after the update, on for new installs.

### Fixed

- **Retry on an AI reply that WhatsApp rejected now sends it.** Before, Retry always failed with "AI reply
  cancelled because chat ownership changed", although nobody had taken the chat.

## [0.1.62] - 2026-10-28

### Added

- **Files and text in and out of the app.** Drag files from your desktop onto a chat, paste a screenshot or
  files copied in Explorer or Finder into the message box, or pick several files at once: they wait above the
  message box (with a preview, size and Remove) until you press **Send**, go out in the order you added them, and
  the text you typed becomes the first file's caption. Files over 64 MB and more than 10 at a time are refused
  before uploading. Business context takes a dropped file too. Out of the app: **Copy text** on every message
  (hover, or press and hold on a phone), **Copy image** in the image viewer, and drag an image or document from
  a chat to your desktop or a folder to save it. The desktop app now has a right-click menu: Cut, Copy, Paste,
  Paste as plain text, Select all, spelling suggestions, Copy image, Save image as… and Copy link address.

## [0.1.61] - 2026-10-28

### Added

- **AI agents in WhatsApp groups.** Turn on **Answer in groups (when tagged or quoted)** on an AI agent's page and switch on the groups it may answer. The AI answers only when a member tags your number or quotes a message the AI sent, quoting the member; every other group message gets no reply. It only looks things up in groups, never takes the group chat, and hands over with "A team member will reply soon." After 10 answers in a row without a teammate, it pauses in that group.

- **Beta mark for connectors.** A connector can show **Beta** on its card and page, with a short note above Connect. Google Calendar is Beta while Google reviews the sign-in: the note explains the warning Google shows when you sign in. The mark goes away by itself when the connector list drops it, with no update.

### Fixed

- The grey text no longer repeats what you typed. When you type "hi what", it shows only the rest (" would you like to know?"), with the space in the right place, so Tab gives a correct sentence.

## [0.1.60] - 2026-10-27

### Added

- **Connectors.** Admin → Connectors is a gallery of systems your AI agents can use, each with its own page
  (overview, settings and activity). Connectors that are not ready yet show **Vote for this connector**, which
  opens a WhatsApp chat with the EzyChat team; the app itself counts nothing.
- **Google Calendar: free times and bookings.** Sign in with Google (no link to paste), choose the calendar and
  booking hours per AI agent, and the AI offers free times from that calendar. With **Book appointments** on
  (off by default) it adds the event once the customer confirms one of the offered times; EzyChat checks the time
  is still free just before it books. The chat shows "AI checked free times" and "AI booked …", Try it never
  books, and the AI never cancels or moves a booking (it hands those chats to your team). The **Bookings** tab
  lists the upcoming and recent bookings the AI made, each with **Open chat** and **Open in Google Calendar**.
  Each booking has the customer's name, phone and email: the AI takes them from the saved contact and the
  WhatsApp name and number, and asks the customer only for what is missing (usually the email).
  **Open Google Calendar** is also on the connector's Overview.
- **New connectors without an app update.** EzyChat downloads a signed connector list when it starts and when you
  open Admin → Connectors (**Check for new connectors**). It checks the signature before it uses the list and keeps
  the last good copy, so the gallery also works offline. A connector that needs a newer EzyChat says so, and one
  that leaves the list keeps working, marked **No longer available**.
- **Partner connectors.** Connect a partner's system by signing in on its page, with an API key or with your
  account details; secrets stay encrypted on your computer. Per AI agent you choose what the AI may do: look-ups
  start on, tools that change data start off. EzyChat enforces each connector's rules (for example "ask the
  customer to confirm first" and daily limits), and Try it never changes data.
- **Reports for admins.** Admin → Reports shows how busy your WhatsApp is and how fast your team and AI
  answer, for the last 7, 30 or 90 days: new customers, messages from customers, first reply time, new
  customers missed (no reply within 1 hour), chats still waiting after the AI handed them to the team (with
  **Open chats**), and chats the AI answered, each compared with the period before. Charts show your busy
  days, your busy times (day by hour), messages and new customers per day, why the AI handed chats over (with a
  link to fill the Business context) and each team member's replies. Every chart can be shown as a table.
  Everything is counted on your own computer; nothing is sent anywhere. AI assistants connected through MCP see
  new and missed customers and the waiting chats in `get_stats`.

## [0.1.59] - 2026-10-26

### Added

- **Instant grey text from your team's phrase list.** The AI builds a list of the phrases your team really
  writes, from your business context, the AI instructions and the team's sent replies, in each language the
  team uses. While you type, a matching phrase shows in grey at once, with no AI call; the AI completion runs
  only when no phrase matches. Tab moves a phrase up the list, Esc moves it down. The list updates by itself
  (when the app starts, after business context changes, after every 30 team replies and weekly), at most 24
  AI calls a day, and stops while reply suggestions are off. Admins see, add, edit and delete phrases in
  Settings → AI → Phrase list. Customer names and phone numbers never go into a phrase.
- **Model for suggestions** in Settings → AI: Fast (recommended), the same model as the AI connection, or any
  model of the connection, for Suggest reply, the grey text and the phrase list.

### Fixed

- **AI completions now appear while you type.** With ChatGPT sign-in, the grey text used your main
  model and often took longer than the 3-second limit, so nothing showed. Suggest reply and completions
  now use a fast model (ChatGPT: GPT-6 Luna when your account has it; OpenAI key: GPT-4.1 mini; Claude:
  Claude Haiku). Completions read only the last messages of the chat and what you type, so they are
  quicker; Suggest reply still uses your business context. Grey text also appears when you stop inside
  a word, and it stays while you type the same letters.

## [0.1.58] - 2026-10-26

### Added

- **AI reply suggestions.** In a direct chat, press **Suggest reply** to get two drafts that answer the
  customer in two different ways; tap one to put it in the message box, edit it and send it. When you
  type yourself, the AI completes your sentence in grey text: press Tab (or tap **Accept suggestion**)
  to use it. Drafts use only facts from the chat and your business context, and the AI never sends
  anything. Admins turn it on or off for the team in Settings → AI; after this update it starts off.

## [0.1.57] - 2026-10-25

### Fixed

- **Linking a phone from Admin → Inboxes no longer shows a page error.** The phone-number pairing box
  was placed inside the inbox form, which browsers do not allow; it now sits below the form.

### Added

- **Ready for the WhatsApp Business API (EzyChat Enterprise).** The core now lets an edition add other
  ways to connect a WhatsApp number next to the linked phone. For such a number, the conversation shows how
  long the 24-hour reply window stays open, and after it closes the team sends an approved template
  (**Send a template**, with its variables and a preview) until the customer writes again. The AI agent
  hands such a chat to the team when the window has closed. EzyChat Lite itself still links one phone by QR
  code, unchanged.

## [0.1.56] - 2026-10-25

### Fixed

- **Phone notifications no longer go missing.** When the AI handed a chat to a teammate, or a new
  message arrived, the phone got no notification if the same person also had EzyChat open somewhere
  else (for example the desktop app in the tray, or a browser tab). Now every phone and browser with
  notifications turned on gets the notification.

## [0.1.55] - 2026-10-25

### Added

- **Business templates for AI agents:** on the AI agent page, click **Browse templates** to open a
  gallery of 17 ready-made agents (for example clinic, dental clinic, restaurant, bakery, car workshop,
  home services, property agent, online shop and tuition centre). Search or pick a category, select your
  business and click **Apply template**: the agent gets a name, a type, instructions and hand-off rules
  made for that business, and Save adds a Business context item with lines to fill in. You can change
  everything before you save.

### Changed

- The **Upgrade to Enterprise** link carries a campaign tag, so the website can count visits that come
  from the app. The app itself still sends no data.

## [0.1.54] - 2026-10-25

### Changed

- **Settings → Integrations is clearer:** one card, **Connect an AI app**, shows the recommended way for
  claude.ai, ChatGPT and Claude Desktop as three steps (no token needed). Access tokens are now only under
  **For developer tools** (Claude Code, Gemini CLI, Cursor, scripts). The list is called **Connected apps**
  and shows whether each app signed in or uses a token; **Remove** disconnects one.

## [0.1.53] - 2026-10-25

### Added

- **Connect claude.ai, ChatGPT or Claude Desktop without a token:** turn on AI assistant access in
  Settings → Integrations, copy the connector address and add it as a custom connector in your AI app.
  The app opens EzyChat: sign in and click **Approve**. The connection shows in the Access tokens list,
  where you can let it send messages or disconnect it. claude.ai and ChatGPT need Phone access (the
  tunnel) turned on, because they connect from the internet.

## [0.1.52] - 2026-10-25

### Added

- **Upgrade to Enterprise:** where EzyChat Lite reaches its limits (one AI agent on Members and on the
  AI agent page, one WhatsApp number on Admin → WhatsApp), a short note explains what EzyChat Enterprise
  adds, with an **Upgrade to Enterprise** button that opens ezychat.ai in your browser. Admins also find
  it in the account menu, and everyone in About.

### Changed

- The desktop app runs on a newer engine (Electron 45 with a newer Chromium), and the server and inbox use
  updated libraries (React, fastify, password hashing). These bring the latest security and stability fixes;
  nothing changes in how you use the app.

## [0.1.51] - 2026-10-24

### Added

- **See customers' emoji reactions.** When someone reacts to a message on WhatsApp (for example 👍 or ❤️), the emoji now shows under that message in EzyChat, as on the phone. Group chats show each emoji and how many people reacted. Click or tap the emojis to see who reacted with what. A changed or removed reaction updates at once.
- **React to messages from EzyChat.** Move the pointer over a message and select the 🙂 button (on a phone, press and hold the message), then select an emoji: 👍 ❤️ 😂 😮 😢 🙏, or **+** for 40 more. The customer sees the reaction from your business number. WhatsApp allows one reaction per number, so your team shares it: a new emoji replaces the current one, and the same emoji again removes it. The reaction list shows which teammate reacted. While WhatsApp is not connected, the emojis are turned off.

### Fixed

- **Customer name from WhatsApp.** Customer details now show the customer's WhatsApp name when your team has not saved a name, marked "Name from WhatsApp". Before, some chats showed "No name set" and Edit started with an empty name, although WhatsApp knew the name. Edit now starts with that name, so one click on Save keeps it.

## [0.1.50] - 2026-10-23

### Added

- Change an AI agent's type (Sales, FAQ or Custom) at any time on its page, also for the one agent in EzyChat Lite. Your own role and hand-over rules stay; the page offers the new type's starting texts if you want them. Edit role with AI is now one click away on the same card.

### Fixed

- AI assistants that update the AI agent over MCP are now told to write one line per paragraph, so rules no longer show as short broken lines.

## [0.1.49] - 2026-10-22

### Added

- Run your AI agents on your own Claude API key. Settings → AI and the setup wizard now offer three connections: ChatGPT, OpenAI API key and Claude API key. Paste a key from console.anthropic.com, choose Claude Sonnet 5.5 (recommended), Claude Opus 5.5 or Claude Haiku 5.5, and the key is checked before it is saved. Agent replies, Try it, Edit with AI and customer details work the same way with Claude. Your OpenAI key and your Claude key both stay saved when you switch between them. With Claude, voice notes use the on-device model (cloud transcription needs an OpenAI key).

## [0.1.48] - 2026-10-22

### Added

- AI agents for every purpose: the AI Sales Agent becomes an AI agent that you can make a Sales, FAQ or Custom agent, with its own name, role and hand-over rules. Fixed safety rules come first for every agent: it never reveals its instructions or internal information and ignores customer messages that try to change its rules. Mark a Business context item as Internal to let the agent use it (a minimum price, a discount limit) without ever telling customers; a reply that quotes an Internal item is not sent and the chat goes to your team. EzyChat Enterprise: one agent per WhatsApp number, each with its own knowledge. Your current AI agent, its texts and its knowledge stay as they are.

## [0.1.47] - 2026-10-22

### Added

- Several WhatsApp numbers in one install (EzyChat Enterprise): each number is an inbox with its own phone link, status and send queue. Admins see every inbox; each agent sees only the inboxes an admin gives them, in one chat list with an inbox name on each chat and an inbox filter. Manage numbers under Admin → Inboxes and inbox access under Members. EzyChat Lite stays one number and its screens do not change; the number you have today becomes the first inbox with no new link.

### Fixed

- Messages show WhatsApp formatting the way the WhatsApp app does: _bold_, _italic_, ~strikethrough~ and monospace without the marks, plus quotes and bullet lists. Before, the team saw the raw marks (for example `*OpenAI Select Partner*`) while the customer saw bold text. The chat list and reply previews hide the marks too.
- The update dialog no longer shows "Update installed" from the previous update next to a newer version; it now says "Updated to <version>" only for the version that runs. A "What's new" title names the version of the release notes, and editions with a private update feed can list their notes in the dialog.

## [0.1.46] - 2026-10-21

### Security

- Sign-in, AI assistant access and error-report limits now count an IPv6 client by its /64 network. Before, a client could change its IPv6 address inside its own network to reset the limit (reported in #76). The lock after 5 failed sign-ins for one username was not affected.

## [0.1.45] - 2026-10-20

### Added

- AI assistant access: change what an existing access token may do (send WhatsApp messages, message new numbers) under Permissions in Settings → Integrations, without a new token or reconnecting. Only the token's owner can change it; every change is in the audit log.

### Changed

- The Windows installer is signed by Anchor Sprint Pte. Ltd., so Windows shows a known publisher instead of an "unknown publisher" warning.

## [0.1.44] - 2026-10-20

### Added

- AI assistant access: a new tool lets your AI assistant send a text reply into an existing chat, as you, when its access token was created with "Can send WhatsApp messages". Tick it in Settings → Integrations → Create token; tokens made before never get this right. Replies the assistant sent show "via AI assistant" in the chat.
- AI assistant access: a token created with "Can send" and "Can also message new numbers" may also start a chat with a number that is not in the inbox, after WhatsApp confirms the number (up to 20 new numbers a day). WhatsApp can ban a number that messages people who did not ask for it: the assistant gets this warning with the tool and with every result. The inbox shows a warning above a chat the assistant started until the customer writes back.
- The AI assistant connection now names the edition you run (for example EzyChat Enterprise).

### Fixed

- Group chats: when someone tags your own WhatsApp account, the message shows your account's name instead of a long number.
- A message that arrived while a chat was still opening could stay hidden until you refreshed; it now shows.

## [0.1.43] - 2026-10-20

### Fixed

- Desktop app: email links (for example "Email support") and web links in the app window open your mail app or browser again; before, a click did nothing.

## [0.1.42] - 2026-10-20

### Fixed

- Desktop shell for other editions: the start page, tray, dialogs and Status & Service window now show the edition's own name instead of "EzyChat Lite", and an edition can use its own default port (`defaultPort`), so it starts on a computer where EzyChat Lite already runs.

## [0.1.41] - 2026-10-19

### Fixed

- The AI Sales Agent no longer hands a chat to the team when the customer only says "ok" or "thanks": it now stays silent and keeps the chat. A malformed AI answer is asked for once more before a hand-over, and the log names the kind of failure.

## [0.1.40] - 2026-10-19

### Added

- The desktop shell is published as `@ezychat/desktop` (`startDesktop(product)`), so other editions can
  build their own installer on it. The Lite app itself does not change.

## [0.1.39] - 2026-10-19

### Fixed

- AI replies use WhatsApp formatting: bold text (such as a product name) no longer shows an extra star at each end.

## [0.1.38] - 2026-10-18

### Added

- An AI member with look-up tools from an edition can answer and be turned on without Business context; it calls the look-ups before handing over.
- Editions can pause the app (access gate), show a slim bar and a lock screen, add cards to the desktop window, replace the app's links and use the EzyChat logo files. Lite itself does not use these. The desktop update texts now say "the update server" instead of GitHub.
- Extensions can give the AI Sales Agent extra look-up tools. A failed look-up hands the chat to the team (reason: a look-up in a connected system failed), and the conversation shows "AI looked up …" lines.
- The core is published as `@ezychat/*` packages so other editions can build on it. Your data, settings and sign-in stay as they are after the update.

### Changed

- The AI logs how long each reply took (no message text), to find slow replies.
- README: how to open the app on macOS the first time, until the app is notarized.

## [0.1.37] - 2026-10-16

### Changed

- **First-time setup is simpler.** Enter your business name, your name (the username is filled in for you) and one password, link WhatsApp, then set up the AI assistant: describe your business, sign in with ChatGPT (recommended) or use an OpenAI API key, and turn it on. You can skip the AI step. The last screen links to Add teammates and Phone access.
- New installs suggest **Sign in with ChatGPT** for the AI connection. The app says plainly that this sign-in is unofficial and can stop working; an OpenAI API key is the alternative.
- Admins see a short **Getting started** card on the empty inbox (AI assistant, Teammates, Phone access). Finished items disappear, and the card can be hidden in that browser.
- The **Sales Agent** page lets you connect the AI right on the page. AI instructions and hand-off rules are under a closed **Advanced** section.
- **Settings → AI** lists Sign in with ChatGPT first, tests an OpenAI API key before saving it, and shows a "Set up the Sales Agent" link once the connection works. A key that OpenAI rejects is not saved; for other test failures you can choose **Save anyway**. Voice messages and Customer enrichment are under "More AI features".
- The admin menu item **Cloudflare** is now **Phone access** (same page).

### Fixed

- **Settings → AI:** clicking the "Recommended" badge on the ChatGPT option now selects it.

## [0.1.36] - 2026-10-15

### Fixed

- **macOS (Apple Silicon):** EzyChat Lite no longer opens as "damaged and can't be opened". The app is now signed (ad-hoc), so macOS shows the usual unidentified-developer prompt instead (System Settings → Privacy & Security → Open Anyway).
- Sales Agent handovers now notify the assigned teammate, or the active human team when no teammate is available. Existing desktop notification settings and offline push delivery are respected; the alert opens the handed-over conversation.

## [0.1.35] - 2026-10-14

### Added

- **Customer enrichment:** an optional background AI service fills clear names, companies, emails and addresses from new direct-chat text messages, independently of Sales Agent replies. Settings → AI controls it; Audit shows the average evidence score in Details with a per-field breakdown and source conversation. Staff edits, ambiguous evidence and unavailable connections prevent stale updates.

## [0.1.34] - 2026-10-14

### Fixed

- Reopening the inbox PWA or restoring its network connection promptly reconnects a dropped live connection without waiting for the next retry timer. The reconnect warning remains visible until the connection is restored.

## [0.1.33] - 2026-10-13

### Fixed

- Group @mentions show known contact names instead of WhatsApp ID (LID) digits in messages, inbox previews and notifications, including older messages when the identity is unambiguous. Mention metadata is retained across restarts; unknown tags, emails and URLs stay unchanged.

## [0.1.32] - 2026-10-12

### Added

- **Voice notes:** with the message box empty, tap the mic to record a voice note. Delete it, listen back with Review, or send it straight away; it arrives in WhatsApp as a real voice note (up to 5 minutes). Works in the desktop app, on this computer's browser and through your remote access link (https); on a plain LAN link (http) the mic is greyed out with the reason, and a blocked microphone shows how to allow it.

## [0.1.31] - 2026-10-12

### Added

- **Group info:** tap a group's name in the chat header to see its members as WhatsApp lists them: member count, admins, search by name, number or username, and an Admins filter. Open a member to see their number (when WhatsApp shares it), username and About text, then open your existing chat with them, or start one after a reminder not to message people who don't expect it. Names come from WhatsApp, so members who haven't messaged yet may show only a number; the list is view-only and can't be exported.

### Changed

- Tapping a direct chat's name in the header opens the Customer panel.
- Avatars use letters only for initials; numbers, WhatsApp IDs and emoji-only names show a person icon.
- "Request a feature" in the account menu now opens the feedback form on ezychat.ai in your language, with your EzyChat Lite version filled in, so you can send a feature request, bug report or question without a GitHub account.

## [0.1.30] - 2026-10-10

### Added

- **Peak times and who replies, for AI assistants (MCP):** a new read-only `get_activity` tool
  gives customer messages, new conversations and team replies per hour and weekday (business time
  zone), a weekday × hour heat map of new conversations, how long customers waited for a first
  reply, and per team member, the AI Sales Agent and the phone: messages per hour and reply times.

### Fixed

- **Audit log names the AI assistant:** a change an AI assistant made through an access token now
  shows the token's name in the Who column, with its owner below, instead of only the owner's name.
  Earlier entries and revoked tokens are named too.

## [0.1.29] - 2026-10-10

### Added

- **AI assistants can review and refine the AI Sales Agent (MCP):** a connected assistant (Claude
  Code, Claude Desktop, Gemini CLI…) can now read the Sales Agent's instructions, hand-off rules and
  business context, see hand-off statistics per reason and per day (`get_stats`), test a customer
  message against the saved or a draft setup (`try_ai_reply`, uses your AI connection), and change
  the instructions, hand-off rules or business context text (`update_ai_setup`). Changes take effect
  right away; every version is kept (`get_ai_setup_history`, including changes made in the app) and
  every change is in the audit log with the token and the reason. Uploaded files, the AI connection
  and turning the agent on or off stay app-only. Available to every admin token.

### Fixed

- **Settings → Preferences (desktop app):** the Notifications description no longer squeezes into a
  narrow column; the switch sits on the right like Appearance and the desktop note goes underneath. The
  note now names the app correctly ("allow EzyChat Lite").

## [0.1.28] - 2026-10-09

### Added

- **Reply to a message:** hover a message and click **Reply** (on a phone, swipe it right or press and
  hold), type, and send. WhatsApp shows your reply quoting that message, just like replies customers
  send. It works for text and attachments, for customer and team messages, and for older messages too.
  Esc or ✕ cancels; switching chats clears it.

## [0.1.27] - 2026-10-09

### Added

- **AI assistant access (MCP, read-only):** Admin → Settings → Integrations lets an admin switch on
  access and create personal access tokens (expire in 30, 90 or 365 days, or never; revocable). Any
  MCP client that accepts a URL and an Authorization header (Claude Code, Gemini CLI, Codex CLI,
  Cursor, VS Code…) then connects through the tunnel (`/mcp`) and can list and read chats, assignment
  history, notes and messages, and get inbox statistics. It cannot send, assign or change anything.
  Off by default; refused on the plain-HTTP LAN. ChatGPT and claude.ai connectors need OAuth sign-in,
  which is not supported yet.

## [0.1.26] - 2026-10-08

### Added

- **Edit with AI** on the AI member page: describe a change to the AI instructions or the hand-off
  rules in your own words ("hand refund requests to a person", "use a warmer tone") and review the
  suggested text as a before/after, showing only what changes. Apply fills the box; nothing is saved
  until you press Save. The AI changes as little as possible and leaves the text unchanged when a
  request is unclear or already covered.

### Fixed

- Dialogs now dim the page behind them again in current Chrome (the backdrop colour was drawn
  transparent).

## [0.1.25] - 2026-10-08

### Added

- **The AI can look things up while it answers:** when a customer refers to something said long
  ago, the AI reads further back in the chat instead of guessing (for example an order number from
  earlier in the conversation). With a very large Business context it searches it, and searches
  again with other words when the first try doesn't answer the question. Short questions are
  answered as quickly as before.

### Changed

- The AI Sales Agent now runs on the Vercel AI SDK (both ChatGPT sign-in and API key). Replies are
  never retried silently, and errors still never show what OpenAI sent back.

## [0.1.24] - 2026-10-07

### Added

- **The AI knows who it is talking to:** when your team has saved a customer's details, the AI
  Sales Agent greets them by name and doesn't ask again for a company or address you already have.
  It never reads back their email, phone or address unprompted, and your tags stay internal: the AI
  never sees them.

## [0.1.23] - 2026-10-07

### Added

- **Customer details:** every teammate can save a customer's name, company, email, other phone,
  address and tags from the chat (**Customer** button next to Notes). The name shows across the inbox
  with the WhatsApp name kept underneath, search finds these details, the inbox can be filtered by tag,
  and the customer's name also shows on their messages in group chats. A new profile starts from what
  WhatsApp knows (name prefilled), and a read-only **From WhatsApp** section shows the WhatsApp name,
  the name saved on your phone, the number, and — for admins — the WhatsApp ID.

### Changed

- Inbox polish: the Mine / Unassigned / All tabs keep their own row (no clipped labels with a tag
  filter), owner chips carry a person icon, phones show one tag plus "+N" so the message preview has
  room, and the Audit page describes customer-detail changes in words.

- Admin and account screens are calmer and more consistent:
  - **Audit log**: every action has a readable name (including AI, Business context and voice
    changes), details read like "Chat: +60123… · Changed name, tags" with member names instead of
    ids, and **Hide sign-ins** filters out routine sign-ins (failed sign-ins stay visible).
  - **Cloudflare**: the connection status sits in the "How your team connects" card; there is no
    more greyed-out "Remote access is off" button, and the disconnect note only shows while connected.
  - **WhatsApp**: each action has its own row with a short explanation; Log out comes last in red
    text (still confirmed), and Take over only appears when the session was opened elsewhere.
  - **Members**: a turned-off AI member shows a neutral "Off" (disabled members are grey, not red),
    the list shows the date someone was added without the time, and Edit buttons line up.
  - **Quick replies**: Delete moved into each reply's "…" menu, like Members.
  - **Settings**: one Save pattern everywhere — Save at the end of the form, pinned to the bottom
    with an "Unsaved" marker while you have edits. Port and history fields explain when to change
    them; a saved OpenAI key shows as "saved" with **Replace**, and the API model moved under
    **Advanced**. "This device" is now **Preferences**, with Language in its own "Your account"
    card. Maintenance is now **End of day** without the red danger frame (resolving chats can be
    undone).
  - **AI member page**: a short description, plain section titles (no step numbers), a smaller
    instructions box with a "Using the recommended instructions" note.
  - **Admin menu**: Back to inbox is at the top; support links are folded into **Help & feedback**.
  - **Sign in and Change password**: the main button stays enabled and explains missing fields,
    passwords have a show/hide button, and the page footer keeps just the version and Report an issue.
  - The **Dev Build** marker is a small tab at the top centre, so it no longer covers buttons.
  - Disabled buttons are grey instead of faded teal, and the selected tab is easier to see in
    light mode.

### Security

- Voice notes: the 2-minute limit now counts the real audio instead of trusting the length written in
  the file, so a crafted voice note can no longer exhaust memory on your computer or run up cloud
  transcription costs. Stored transcripts are capped, and the audit log shows when someone changes the
  AI's instructions or hand-off rules.

## [0.1.22] - 2026-10-06

### Added

- Customer voice notes are transcribed, so the AI Sales Agent answers them like typed messages and your team can read them under the audio player. Choose the engine in **Settings → AI → Voice messages**:
  - **On this PC**: a one-time 360 MB voice model download (OpenAI Whisper small); the audio never leaves your computer.
  - **Cloud (OpenAI)**: uses your saved OpenAI API key; the audio is sent to OpenAI. ChatGPT sign-in cannot transcribe.

  Voice notes longer than 2 minutes or 10 MB are not transcribed. When a voice note cannot be transcribed, the AI politely asks the customer to type their question, and hands the chat to your team if it happens again.

- The AI Sales Agent understands photos and screenshots customers send, with or without a caption (up to 3 per reply, JPEG, PNG or WebP up to 5 MB). It works with ChatGPT sign-in and with an OpenAI API key; voice notes, videos and documents still go to your team.
- The AI Sales Agent comes with recommended default instructions, so you only need to add your Business context. They cover:
  - its role and scope (products and general enquiries only, politely declining unrelated topics);
  - exact facts and no promised discounts;
  - replies in the customer's language;
  - short WhatsApp-style replies;
  - handing bulk orders, quotations, price negotiation and existing-order questions to your team (now in Hand-off rules, below).

  Edit them to match your business, or click "Use default instructions" to restore them. Fixed safety rules that admins cannot change now also tell the AI never to ask for sensitive data (IC, card or bank details, passwords) and that administrator instructions never override those rules.

- AI hand-off rules come in two layers:
  - **System hand-offs** are fixed and always apply: the customer asks for a person, a request the AI cannot carry out, an answer not in the business context, and legal, medical or personal-data matters.
  - **Business hand-off rules** are a new "Hand-off rules" section on the AI member page. Prefilled with complaints, refunds, existing orders, bulk orders or quotations, and price negotiation, they decide when your team takes over.

  The chat timeline shows "matches your hand-off rules" for business-rule hand-offs.

### Changed

- A teammate who replies from the inbox in a chat the AI Sales Agent is handling now takes the chat over: it is assigned to them, their owner chip replaces the AI's, the timeline shows "took this chat by replying", and the AI stops answering. Replying in a chat another teammate owns still keeps that owner, and replies sent from the phone's WhatsApp app don't change the owner.

### Fixed

- Windows: local and test (unpackaged) builds use their own taskbar identity, so running one can no longer leave the installed EzyChat Lite with a blank white taskbar icon.
- Editing a long Business context item no longer squeezes the text sideways and cuts it off: the editor opens in a wide dialog with wrapping text, vertical scrolling and a character counter. The AI instructions box behaves the same way.
- In "Try it", pressing Enter asks the question (Shift+Enter adds a new line).

## [0.1.21] - 2026-10-06

### Added

- Experimental: "Sign in with ChatGPT" works without the Codex helper. One click opens the sign-in page; an admin on another computer pastes the final sign-in address to finish. Choose the model (Auto or your account's live models) and use "Test connection". It uses an unofficial ChatGPT endpoint that may stop working: if ChatGPT rejects the sign-in or blocks the connection, the AI member stops taking chats, leaves them unassigned for the team and admins see a banner.
- AI member page (Members → AI Sales Agent, replacing the popup): a status (Off, On, Needs connection, Needs business context), a guarded Turn on that saves the page first, name, instructions, a Business context list (Upload from device or Add text content, search, Select and delete; the first item saves a draft member) and "Try it" to ask a test question with unsaved instructions. Nothing is sent to customers.
- Local and test builds are marked "Dev Build": the desktop window and tray title show it for unpackaged builds, and the inbox shows a badge and a "[Dev Build]" tab title when the server runs with `--mode dev`.

### Changed

- Settings → AI edits the AI connection in place (no popup): an API key / ChatGPT switch, the model dropdown, Test connection and one Save with an "Unsaved" marker.
- Installers no longer include the Codex helper (about 140 MB smaller); ChatGPT mode signs in directly.
- The AI Sales Agent hands a chat to the team as soon as the customer wants something done that it cannot do (place, change or cancel an order, book, pay), after answering the known facts, and never closes such a chat. The chat timeline and Try it show why the AI handed over.
- Admin Settings is split into General, AI, This device and Maintenance tabs; theme and language use compact one-row switches.
- The AI Sales Agent closes a chat when the customer confirms in their own words (and stops asking after two confirmations), answers order and delivery-slot questions with the known facts instead of handing off, and "Try it" shows its decision (Answer, Asked if resolved, Would resolve, Would hand off).
- The AI Sales Agent is configured with just AI instructions and Business context. Business context is a list of items, uploaded files and text content you add, like a project knowledge panel; existing notes and FAQs become one 'Business context' item. Turning it on needs at least one context item; instructions alone are not enough.
- The AI Sales Agent knows the current date, weekday and time (Asia/Kuala_Lumpur by default, or the `ai_timezone` setting), so it can answer "open today?" or "tomorrow at 3pm". Its prompt is laid out with a stable per-install cache key, so providers can reuse cached prompt prefixes.
- The AI Sales Agent sends all business knowledge when it fits (up to 40,000 characters) and finds Chinese, Japanese and Korean questions in larger knowledge; a saved ChatGPT model that is no longer available falls back to Auto.

### Fixed

- Chats for the same person under phone number and WhatsApp ID are merged: one inbox row per
  customer, with all messages, notes, history, unread counts and AI Sales Agent state together.
  Existing duplicates are merged when the server starts after the update (a backup named
  `app-premerge-YYYYMMDD-HHMMSS.db` is written first and kept 30 days); new messages then go to the
  right chat automatically. Replies, including the AI Sales Agent's, go to the address the customer
  last used. When WhatsApp has not revealed a customer's number, the chat shows "Phone number hidden"
  instead of an internal ID. Old links and notifications open the merged chat.
- Windows in-app updates now record the result ("Update installed"), remove the downloaded installer and reopen the app; the background helper used to exit before it ran.
- After a Windows restart the app no longer stays on "service not running" while the background service is still starting: it waits for a delayed auto-start and opens the inbox as soon as the service answers.

## [0.1.20] - 2026-10-05

### Added

- One AI Sales Agent can answer unassigned direct customer chats after 10 seconds using
  business notes, FAQs and uploaded PDF, DOCX, Markdown or text documents. Humans can take
  over or resolve chats; AI resolves only after customer confirmation and hands unanswered
  questions to an idle online agent, or returns them to the unassigned inbox.
- Admin Settings → AI configures one shared OpenAI API or ChatGPT sign-in connection and
  model. Admin Members → Add AI member manages the Sales Agent and its business knowledge.
- AI configuration and member controls follow the selected English, Malay or Simplified
  Chinese interface language.
- Language setting: English, Bahasa Melayu and 简体中文 (Simplified Chinese). Members choose a
  language from the Account menu and it follows them to every device; the sign-in and setup
  screens have a language picker and otherwise follow the browser language. Dates, numbers,
  error messages and push notifications use the chosen language; the desktop tray, dialogs and
  status window follow the operating-system language. Malay and Chinese translations are an
  initial draft pending native-speaker review.

### Fixed

- Switching AI connection modes resets the model to the new provider's default. Unsupported
  ChatGPT models are rejected before saving or interrupting active AI chats.

## [0.1.19] - 2026-10-05

### Added

- Admin Settings → Inbox offers a confirmed action to resolve every open chat for the whole
  team, release assignees, and record the reset in the audit log while keeping messages.

## [0.1.18] - 2026-10-05

### Changed

- Maintenance release that verifies the in-app update path from 0.1.17 (download, checksum,
  service restart). No functional changes.

## [0.1.17] - 2026-10-04

### Improved

- New **Keep EzyChat Lite in the system tray** option in the desktop's Status & Service window
  (on by default). Closing the window keeps the app in the tray for quick access and desktop
  notifications; untick it to quit on close while the background service keeps the inbox running.

### Changed

- The Windows program is now `EzyChat Lite.exe`, installed in `Program Files\EzyChat Lite`. Data,
  accounts and the WhatsApp link are unchanged. Updating from 0.1.16 or earlier is a one-time
  manual install (see `docs/updating.md`); in-app updates work again from this version.

## [0.1.16] - 2026-10-04

### Security

- Bound the memory used to rate-limit the public browser-error endpoint, so a client rotating
  through many addresses (for example over IPv6 via the tunnel) cannot grow it without limit.
- Recheck credentials, live sessions and admin permissions after password hashing so in-flight
  requests cannot bypass password recovery, account disabling or session revocation.
- Keep unknown named-tunnel hostnames restricted to validated loopback proxy requests, including
  Socket.IO; reject malformed proxy IP headers and forwarded first-admin setup requests.
- Restrict privileged desktop controls to the current bundled status window and its main frame;
  block unrelated frames, redirects and unused camera/microphone permissions.
- Require protected Program Files installations for Windows background services and privileged
  password recovery. Reject user-writable runtimes and filesystem links before modifying data.
- Remove ordinary-user ACLs from the macOS service's root-owned runtime copy and reject privileged
  installation or recovery from development builds without a packaged app bundle.
- Use secure browser randomness for generated member passwords, allowing manual entry when it
  is unavailable. Remove inline styles from the desktop status page's security policy.
- Redact WhatsApp download keys and credentials from new logs and existing support-log exports;
  omit unstructured export records while preserving the original local logs.

### Improved

- The first teammate to reply to an unassigned chat becomes its owner, so the chat list shows who
  is handling each customer. Replies never take over a chat someone else owns.
- Resolving a chat releases its owner: when the customer writes again, the chat reopens
  unassigned and alerts the whole team. Chats you own get an accent outline on their owner chip.
- Download and verify updates inside installed Windows and Mac hosts, show progress and prompt
  with Restart and update. Coordinate app/service shutdown, replace both Mac runtime copies,
  restart an installed service, verify its build, and reopen the desktop as the original user.
  Keep rollback copies for failed installations and display the result after relaunch.
- Keep the host's update suggestion visible and dismissible until reviewed; avoid transient toast
  animations hiding the Review update action during startup.
- Explain the manual background-service update steps for Windows and Mac, and report the actual
  running server build even when service configuration retains an older installation version.
- Rename the app and repository to EzyChat Lite, reuse the official EzyChat icon across desktop
  and mobile, and update sharing and release links. Preserve existing accounts, chat data and
  background-service identity during upgrades.
- Explain the open-source rewrite's origins and publish a roadmap covering the team inbox,
  optional BYOK sales agents, a light CRM and future business workflows.
- Detect newer published GitHub releases on the hosting desktop at startup and every 12 hours.
  Suggest an update with release notes, preview labels and matching Windows/Mac downloads;
  add manual checks in About and the tray's Status & Service page. Phones, browsers and
  client-only desktops have no update workflow or alerts. Installation remains user initiated.
- Compact member cards on phones and tablets: group role and status badges, place accessible
  Edit and More actions beside the name, and show the added date as secondary information.
  Keep Add member beside the page title to reduce scrolling.

### Fixed

- Match WhatsApp phone-number and internal contact IDs so saved names reach the correct chats.
  Recover existing local mappings on reconnect, backfill imported names, and keep saved names
  through partial contact updates without changing messages, assignments or conversation status.

## [0.1.9] - 2026-10-03

### Improved

- Add a clear inbox-account Log out action to the admin sidebar and mobile drawer. Signing out
  keeps the shared WhatsApp connection and team data intact.
- Tidy the admin footer with aligned notification and navigation controls, a compact build row,
  separate support links and a shared desktop/mobile layout that scrolls on short screens.
- Introduce a playful app icon with two smiling chat teammates across desktop, browser and PWA;
  keep the original artwork, PNG exports and Windows ICO in `design/app-icon/`.
- Deliver public web assets with build-time gzip and Brotli, keeping fresh-build checks for HTML
  and the service worker and long-lived caching only for fingerprinted assets.
- Render only changed chat rows during inbox updates and coalesce overlapping next-page requests.
- Consolidate Cloudflare query state, provisioning guards and child-process utilities to reduce
  duplication and keep startup restoration coordinated with admin actions and shutdown.
- Rename Tunnel to Cloudflare and guide setup through browser sign-in, authorised domain selection,
  an address preview and a friendly tunnel name. Configure DNS automatically without replacing existing websites.
- Share the free app from the Account menu with LinkedIn, Facebook, Instagram and device sharing,
  a ready-made message and an image card; sharing uses the public project link.
- Open the project's feature-request form from the Account menu or sign-in screen.
- Add a searchable emoji picker and a growing message box with a subtle scrollbar.
- Clear Admin access, separate Open/Resolved chat filters, filter-reset actions, and a visible inbox build version.
- Search members and quick replies; improve mobile type, light-theme contrast, and audit-log action labels.
- Label Notes and provide a Quick replies button that preserves drafts.
- Add per-device Light, Dark and System appearance settings in Settings and the Account menu.
- Load available WhatsApp profile images on demand with initials for private or unavailable photos.

### Fixed

- Refresh inbox data when the live connection first opens, including updates that arrived
  between the initial page load and the socket connection.
- Show a saved Cloudflare address summary after setup, distinguish connecting from connected,
  require an explicit address edit, and prevent unnecessary reconnects. Clarify that disconnecting
  Cloudflare stops the public link while keeping local access, messages and the saved domain.
- Preserve unsaved settings when background requests refresh their defaults.
- Serialize desktop service changes and password resets, including actions from the tray.
- Recover from a missing system Node process without getting stuck; ignore stale child exits and
  health checks after a replacement server starts.
- Remove server process and signal handlers on shutdown so repeated starts do not retain old servers.
- Keep dialogs scrollable in short landscape viewports, wrap long member names in dialog titles,
  show readable cards on small tablets, and prevent wide tables from hiding columns.
- Make the LAN switch padding and dialog/menu close controls usable as 44px touch targets.
- Wait for WhatsApp before requesting contact photos, and retry them after reconnecting instead of
  keeping the initials fallback for the rest of the session.
- Desktop notification registration now uses native system notifications instead of the unavailable
  Chromium push service. Background alerts preserve chat assignment and open the conversation on click.
- Log browser push registration failures with the failing stage for diagnosis.
- Isolate cloudflared from unrelated user configuration that caused Quick Tunnel URLs to return 404.
  Show Running only after the tunnel connects to Cloudflare.

### Added

- First public preview installers for Windows x64 and macOS Intel/Apple Silicon, with native
  packaged-server checks for first-time setup, password verification and session logout.
- Monorepo scaffold (npm workspaces), tooling, CI, and open-source project files.
- Shared zod schemas for every REST and Socket.IO payload (`@wa-team-inbox/shared`).
- `WaAdapter` interface with a Baileys implementation (QR linking, history sync, reconnect,
  logout/relink/take-over, media download) and a `FakeWaAdapter` for tests and development.
- Server (Fastify + Socket.IO + SQLite): first-run admin setup, users and roles, argon2 passwords,
  hashed cookie sessions, login rate limiting and lockout, audit log.
- Shared inbox: chats with assignment, open/resolved status, unread counts and search; internal
  notes and system events; quick replies.
- Messaging: text, quoted replies, media in and out (images, video, audio, documents), groups,
  typing indicators, delivery/read status, a persistent per-chat send queue with retry.
- Realtime updates over Socket.IO and web push notifications (VAPID) routed to the assignee or all users.
- Remote access: Cloudflare quick tunnel and named tunnel (bundled `cloudflared`), optional LAN mode.
- Admin area: members, WhatsApp status and QR, tunnel, settings (port, LAN, history days), audit log,
  log download.
- Nightly local backups of the database and WhatsApp session (7 kept); daily rotated logs.
- Security hardening: Host allowlist (DNS rebinding), Origin checks, strict CSP and security headers,
  loopback-only setup, safe inline media allowlist with sandbox CSP, push endpoint SSRF guard.
- React PWA (installable, mobile responsive down to 360px) with the "Calm Desk" design system on shadcn/ui.
- Electron desktop app for Windows and macOS: tray, status window, standalone server supervision,
  boot-time OS service (WinSW / launchd) with data migration, admin password reset from the tray.
- Packaging with electron-builder (Windows NSIS installer, macOS dmg for x64 and arm64; unsigned).
- Playwright end-to-end tests on desktop, Pixel 7 and iPhone 14 viewports.
- Documentation: architecture overview, manual release test checklist, contributor guide.

## [0.1.1] - 2026-10-03

### Fixed

- Admin menu links now open the selected section directly instead of appending it to the current URL.
  Invalid admin URLs recover to Members without an endless redirect loop.
