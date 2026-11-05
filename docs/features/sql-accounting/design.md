# SQL Account connector (SQL Accounting by eStream Software)

Status: **confirmed by the owner 2026-11-05** (see Confirmation); built on this branch (beta, untested against a real SQL Account API). Branch
`feat/sql-accounting-connector` from `main` `4d07b20` (0.1.76). Mock: [mock/index.html](mock/index.html) (run it with
`run.ts`, see [mock/README.md](mock/README.md)).

## Owner request (2026-11-05, Jazz, via the main EzyChat session)

Add a SQL Accounting connector (SQL Account by eStream Software, Malaysia). It supports **only companies that have SQL
Account's API Link enabled**; the connector page says so plainly and checks it at connect time (a clear "API Link not
enabled / not reachable" state, never a workaround such as reading the database file). Look-ups on by default once
connected, writes off by default behind the guard model; a customer only ever sees their own records; fake API server
for `--fake-wa`, tests and e2e; logs and audit carry ids, tool, ok and ms only.

Owner context (Jazz Brain): Anchor Sprint built SQL ↔ WMS integrations before (PO/SO/DO/invoice/payment, 2024-12,
"SQL–WMS integration: PO polling and inbound document APIs"); on 2025-07-27 Jazz noted "SQL Account has no API" (Fruitable
proposal, ODBC posting unverified); on 2026-04-12 SQL **Cloud** integration for Lintasan Setia was "still unverified" (no
vendor confirmation). The API researched below is newer than the 2025 note (minimum version 5.2025.1038.875).

## Research: what SQL Account's API offers (sources, read 2026-11-05)

eStream calls it the **SQL Account API** / **SQL Account API Service**; dealers and the owner call it **API Link**. The UI
says "SQL Account API (API Link)" once and then "API service" (the words the admin sees in SQL Account's menu).

**Official sources** (eStream Software):

- S1 eStream docs source, `github.com/eStreamSoftware/docs-sqlacc` at `2954faf` (2026-11-04), published at
  `docs.sql.com.my/sqlacc/integration/sql-account-api/…`:
  `docs/integration/sql-account-api/on-premise-setup.md`, `setup-configuration.md`, `faq.md`, and the screenshots in
  `static/img/integration/sql-account-api/` (the API Service dialog and the Postman collection's variables).
- S2 eStream's own apps that use it: `docs/integration/xstore/setup.md` and `settings.md` (xStore: "Copy the **Access
  Key** and **Secret Key** from SQL Account … then click **Test Connection**"), `docs/usage/xpos/faq.md` (xPOS: API users).
- S3 `sql.com.my/api` and `wiki.sql.com.my/wiki/Restful_API` (eStream). Both answer 403 to automated readers; their
  search snippets say: host `api.sql.my`, "AWS SigV4 based authentication over HTTPS", minimum version 5.2025.1038.875,
  sandbox and credentials through eStream support, objects such as Sales Invoice (`/salesinvoice`), Customer, Stock Item
  (`/stockitem`). Not read in full: **treat as unconfirmed where it goes beyond S1**.

**Independent source** (not eStream, used only to fill gaps and marked as such): S4 `sqlacccountingapi.com/docs`
("Independent REST API Reference for SQL Accounting": authentication, base URL, known issues, customer, stock item,
sales invoice, sales quotation, customer payment pages).

| Topic                      | What is confirmed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Source                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Where it runs              | A Windows service on the customer's SQL Account server: logon screen ⚙ → right-click the company database → **Configure API Service…** → Install → Start. Needs SQL Account **5.2025.1038.875+**, Firebird 3.0.9+, Windows 11 (64-bit recommended), a fixed LAN IP, a **dedicated public IP** and a router **port forward TCP 443 → the server**. SQL Account's own **Test Connection** shows "✅ OK" when it works. One service per company database.                                                                                                                                   | S1                          |
| Host                       | The API Service dialog shows `Host: api.sql.my`. The Postman collection SQL Account generates uses `host = https://<32-hex id>.sql.my` (e.g. `https://13fcdacdc0429dc2f8fa47dddf97c393.sql.my`) and `api_ver = v1.0`. The access key itself reads `<32-hex id>.sql.my/<USER>` (e.g. `13fc…c393.sql.my/SALES`). S4 signs against `api.sql.my` with access key `<key_id>.sql.my/APIUSER`. **Always HTTPS under `sql.my`; which host to call (per-company name or the shared `api.sql.my`) is open (Q2).**                                                                                  | S1, S3, S4                  |
| Authentication             | **AWS Signature v4**: region `ap-southeast-5`, service `sqlaccount`, headers `X-Amz-Date`, `X-Amz-Credential`, `X-Amz-SignedHeaders`, `X-Amz-Signature`, optional `X-Amz-Security-Token` (empty `session_token` variable). The query string is part of the signature (S4: a query added after signing gives 401).                                                                                                                                                                                                                                                                        | S1 (Postman screenshot), S4 |
| Keys                       | Per SQL Account **user**: Tools → Maintain User → (new user, e.g. "APIUser") → More → **API Secret Key** → Generate. Shows **Access key** + **Secret key** once; lost = Revoke + generate. That user can no longer log in to SQL Account. The user's SQL Account permissions apply (assumed; Q6). eStream's xStore asks only for Access Key + Secret Key (no host field).                                                                                                                                                                                                                | S1, S2                      |
| Resources                  | Postman collection folders (S1 screenshot): Agent, Account, Stock Item, Stock Group, Stock Batch, Stock Received/Issue/Adjustment/Transfer, Item Template, Location, Customer Invoice, Invoice, Delivery Order, Customer Payment, Customer Deposit, Customer Credit/Debit Note, Customer Refund, Customer Contra, Sales Cancelled Note, Cash Sales, Purchase Order/Invoice, Supplier, Supplier Payment, Job Order, Currency, Payment Method, Company Category, … Each has GET list, GET one, POST, PUT, DELETE.                                                                          | S1                          |
| Paths and paging           | `GET {{host}}/agent?offset=0` → `{"pagination":{"offset":0},"data":[…]}`. **At most 50 records per GET.** Three read forms: `/purchaseinvoice/?docno=PI-00001` (list, master fields, filter by any master field); `/purchaseinvoice/*?docno=PI-00001&code=400-A0001` (one record with details, filter by indexed fields `code`, `docdate`, `docno`, `postdate`, `eiv_utc`); `/purchaseinvoice/{dockey}`. Writes: PUT needs `updatecount` + 1 ("Record has been changed by another user").                                                                                                | S1 (faq.md)                 |
| Field names                | Customer `code`, `companyname`, `creditterm`, `creditlimit`, `agent`, `area`; stock item `code`, `description`, `refprice`, `stockcontrol`, `barcode`; documents `dockey`, `docno`, `docdate`, `code` (= customer code), `sdsdocdetail[]` (`itemcode`, `qty`, `uom`, `unitprice`, `amount`). Wildcards (`description=*Cable*`) and date ranges need 5.2025.1061.890+. POST returns 200, DELETE returns plain text `OK`, an empty POST body crashes the service. **Customer phone fields, outstanding amount and stock balance fields are not documented anywhere we can read (Q3, Q4).** | S4 only                     |
| Rate limits                | None published. Only the 50-records-per-GET cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S1                          |
| Licensing / price          | Not stated in any source we can read. Unknown whether the API Service is a paid module, part of a plan, or free from 5.2025.1038.875 (Q1).                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                           |
| SQL Cloud (eStream-hosted) | Not documented. The setup guide covers on-premise only (port forward). Whether a SQL Cloud company can turn on the API Service is unknown (Q5; Lintasan Setia uses SQL Cloud).                                                                                                                                                                                                                                                                                                                                                                                                           | —                           |

What this means for EzyChat: **no LAN host and no plain http are needed.** The API is always reached over HTTPS at a
public `*.sql.my` name (eStream terminates or relays TLS for that name), exactly the way eStream's own xStore reaches it.
The connector therefore keeps the strict outgoing-request rules of the partner connectors (https only, no private
address, no redirects) and adds a host allowlist of `sql.my` names.

## Decision: where it lives (core, built in)

**Core built-in connector** in `packages/server/src/connectors/sql-account/`, like Google Sheets and Google Calendar.
Lite and Enterprise both get it (AGENTS.md: every ready connector is core; only the custom MCP connector is Enterprise).
The connector list entry `sql-account` (today `coming_soon`) becomes `kind: builtin`, `builtinId: sql-account` in
`builtin-list.json` and, in a separate PR, in `anchorsprint/ezychat-connectors` (owner or release step).

Why not the partner MCP engine: SQL Account speaks REST + SigV4, not MCP. Using the MCP engine would mean a hosted MCP
server (ours or a partner's) holding every customer's accounting keys: a new party in the trust chain and a cloud hop for
data that never needs to leave the customer's PC and their SQL server. Built in, the keys stay encrypted on the
customer's EzyChat computer and EzyChat talks to SQL Account directly. What it reuses from the partner engine:
`connectors/mcp/net.ts` (https only, private/loopback/CGNAT/metadata addresses refused on the address actually dialled,
time limit, size cap; here **redirects off**), the guard checks of `connectors/mcp/guards.ts` (`confirmFirst`,
`fromCustomer`, `valueFrom`, limits; fail closed), the encrypted-settings pattern and the Activity table shape.

## Connection

- Admin → Connectors → **SQL Account** → **Connect**: two fields, **Access key** and **Secret key** (as xStore), plus
  an **Advanced** "Host" field filled from the access key (`https://<id>.sql.my`) and editable only to another `sql.my`
  name (Q2). Above the form, a plain notice: "Works only when your SQL Account has the API service (API Link) turned on:
  SQL Account 5.2025.1038.875 or newer, the API service running on your SQL server, and port 443 forwarded to it. Ask
  your SQL Account dealer if you are not sure." with a 4-step "How to turn it on" list and an InfoTip on "API service".
- Validation before any request: access key matches `^[0-9a-f]{32}\.sql\.my/[A-Za-z0-9_.-]{1,30}$` (Q2: confirm the
  form); host is `https:`, port 443 or none, hostname `api.sql.my` or `<32 hex>.sql.my`, nothing else (no IP literal,
  no path, no user info). The secret is never sent anywhere but in the SigV4 signature.
- **Test connection** = one signed `GET /agent?offset=0` (the request eStream's own Postman collection uses; read-only,
  small). Outcomes, each a state on the page:

| Result                                                        | State shown                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 200 with `{pagination, data}`                                 | **Connected** (company host, key end `…c393/SALES`, last checked)                                                                   |
| DNS has no answer for the host                                | **API service not set up**: "SQL Account has no API service for this key. Turn on the API service in SQL Account (steps)."          |
| Connection refused / timed out / TLS error / 502–504          | **Can't reach your SQL server**: "The API service is not running, the SQL server is off, or port 443 is not forwarded."             |
| Host resolves to a private, loopback or reserved address      | **Can't reach your SQL server** with "The address is on a private network; EzyChat only connects over the internet." (no bypass)    |
| 401 / 403                                                     | **Keys not accepted**: "Check the access key and secret key, or generate new ones in SQL Account (Maintain User → API Secret Key)." |
| 404 on the path, or an answer that is not the documented JSON | **API service too old or not enabled**: "Needs SQL Account 5.2025.1038.875 or newer with the API service."                          |
| Answer over 1 MB, redirect, or anything else                  | **Can't use this answer** (logged as `sql_unexpected`, never retried in a loop)                                                     |

- After connecting, the same check runs on page open and every 30 minutes while an agent uses it; a failure flips the
  page state and the AI stops using the connector (it hands over chats that need it with `lookup_failed`), like an
  expired Google sign-in. **Disconnect** deletes the keys.
- Storage: `sql_account_connection` encrypted setting (`{host, accessKey, secretKey}`, AES via `secret.key`), never
  returned; the API returns `{host, keyEnd: '…c393/SALES', state, checkedAt, version?}`. Admins only
  (`/api/connectors/sql-account/*`, `requireAdmin`, Origin check). Audit `sql_account.connect` / `.disconnect` /
  `.agent_settings` / `.customer_link` with ids and field names only.
- Requests: `node:https` through the `net.ts` guard, 10 s each, 1 MB answer cap, no redirects, `Accept:
application/json`, at most 4 pages (200 records) per look-up, **30 requests a minute per install** (our own budget;
  none is published), one request at a time per install (the service is a desktop program on the customer's server).

## What the AI can do (per AI agent)

**Access per object (owner request 2026-11-05: "control read or write on which api/object").** Settings → per AI
agent (the agent picker of the connector page, as Google Calendar/Sheets) shows one row per SQL Account object with
**Off / Read / Read + create**, the same pattern as Google Sheets' per-tab Off / Read / Add rows. The AI gets a tool
only for what is switched on; the server checks the same table before every request (a tool whose object was switched
off meanwhile is refused, fail closed). **Update and delete are never offered** for any object (no PUT/DELETE in the
client at all). Create is offered only where the core has guards for it.

| Object (SQL Account path)                                                                | Whose records       | Choices                    | Default once connected | Columns the AI may see (allowlist; everything else dropped server-side)                        |
| ---------------------------------------------------------------------------------------- | ------------------- | -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Stock item (`/stockitem`)                                                                | everyone            | Off / Read                 | **Read**               | code, description, selling price (`refprice`, if "Show price"), In stock / Out of stock or qty |
| Customer (`/customer`)                                                                   | the chat's own only | Off / Read                 | Off                    | code, company name, credit term (never credit limit or control account)                        |
| Sales invoice (`/salesinvoice`)                                                          | the chat's own only | Off / Read                 | **Read**               | number, date, due date, total, unpaid (Q3), cancelled                                          |
| Quotation (`/salesquotation`)                                                            | the chat's own only | Off / Read / Read + create | **Read**               | number, date, total, lines (item, qty, price)                                                  |
| Sales order (`/salesorder`)                                                              | the chat's own only | Off / Read                 | **Read**               | number, date, total, status                                                                    |
| Delivery order (`/deliveryorder`)                                                        | the chat's own only | Off / Read                 | **Read**               | number, date, status                                                                           |
| Customer payment (`/customerpayment`)                                                    | the chat's own only | Off / Read                 | Off                    | number, date, amount, invoices paid                                                            |
| Everything else (purchases, suppliers, journals, accounts, stock adjustments, agents, …) | —                   | not offered                | —                      | —                                                                                              |

Choices with "create" for more objects (sales order, customer) are a later step after Q9; the table is data
(`SQL_OBJECTS` in `connectors/sql-account/objects.ts`), so adding a row is one entry with its path, scope, choices and
column allowlist. Two display settings per agent: **Show selling price** (on) and **Stock shown as** In stock / Out of
stock (default) or exact quantity. Never cost price.

The tools the AI receives, built from that table:

| Tool (AI)                           | Offered when                                        | What it does                                                                                                               | SQL Account call                                                          |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `sql_check_stock` {query}           | Stock item = Read                                   | Item price and availability (columns per the allowlist and display settings).                                              | `GET /stockitem?offset=0&description=*q*` (and `code=q`)                  |
| `sql_my_account`                    | Customer or Sales invoice = Read, chat matched      | The chat's own customer: name/term (Customer) and unpaid invoices with the total (Sales invoice). No argument.             | `GET /customer/<code>`, `GET /salesinvoice?offset=0&code=<code>` (Q3)     |
| `sql_document_status` {type, docNo} | any own-record document object = Read, chat matched | One of the customer's own documents; `type` limited to the objects on Read. Another customer's number answers "not found". | `GET /<type>/*?docno=<docNo>&code=<code>` (server adds `code`)            |
| `sql_my_payments`                   | Customer payment = Read, chat matched               | The customer's recent payments (last 10).                                                                                  | `GET /customerpayment?offset=0&code=<code>`                               |
| `sql_create_quotation` {items}      | Quotation = Read + create, chat matched             | Creates a **quotation** for the chat's own customer after the customer confirms the summary.                               | `POST /salesquotation` (`dockey 0`, `docno ""`, `code`, `sdsdocdetail[]`) |

Rules the server enforces (not the prompt):

- **Own records only.** The own-record tools take no customer argument. The server reads the
  chat's matched customer code (below) and adds it to every request; it then checks every returned record's `code`
  equals it and drops anything else (fail closed). A document number the customer types is used only together with
  their own code.
- **No match = hand over.** A direct chat with no single matched customer gets no own-record tools; when the customer
  asks for their balance or a document, the agent hands over with reason `sql_no_customer` ("A team member will check
  your account."). The team links the chat (below). **The AI never asks the customer for their customer code and never
  uses one they type.**
- **Groups**: only `sql_check_stock` (a group turn is look-ups only, and one member's records are never shown in a
  group).
- **Try it** (admin test) runs look-ups against SQL Account but never writes; own-record tools there use a test customer
  the admin picks in the Try it box (Q7), else answer "Try it has no customer".
- **Quotation guards** (`sql_create_quotation`, off by default): `confirmFirst` (a newer customer message after the
  agent showed the full summary: items, quantities, prices, total), item codes only from a `sql_check_stock` result in
  this chat (`valueFrom`), quantities written by the customer (`fromCustomer`), prices always from SQL Account (the AI
  never sets `unitprice`), at most 20 lines, **2 quotations per chat per day** and **20 per agent per day**, never
  twice for the same confirmation message, never PUT or DELETE (no edit, cancel or undo). The result gives the
  quotation number to tell the customer; anything else hands over.
- Failure of any call (timeout, 5xx, 401, unexpected JSON) ends the turn and hands over with `lookup_failed`, like
  other connectors; 401 also flips the connection to **Keys not accepted**.

## Matching a chat to a SQL Account customer

In order; the first that gives **exactly one** customer wins. Never a name or company-name match.

1. **Linked by a teammate**: the chat's customer has a saved **SQL Account customer code** (stored per customer
   profile, table `sql_account_links`: `profile_id`, `customer_code`, `linked_by`, `linked_at`). Set from the
   connector's **Customers** tab (and, Q8, from the chat's customer panel). The server checks the code exists in SQL
   Account before saving. Audited with the profile id only.
2. **Phone number** (setting "Match by phone number", on by default, Q4): the chat's WhatsApp number, and the saved
   other phone, normalised to digits with Malaysia's `60` prefix (a leading `0` becomes `60`), equal to a phone or
   mobile number of **exactly one** SQL Account customer. Two or more customers with that number = no match ("Several
   customers have this number: link one"). Kept as a phone → code index refreshed every 6 hours and on Refresh (paged
   50 at a time, at most 2,000 customers, Q4); the numbers stay in memory and are never logged.
3. Otherwise **not matched**: the Customers tab lists the chat as "Not matched" with **Link**.

A link or match is re-checked at the start of each turn that uses an own-record tool; a code that no longer exists, or
a phone that now matches several customers, is treated as not matched.

## Logs, audit, Activity

- Log line per call `mod: 'sql-account'`: `{tool, agentId, chatId (internal), ok, status, ms, pages}`. Never amounts,
  names, phone numbers, item names, document numbers or the answer body. Connection checks log `{state, ms}`.
- Activity tab (admins): when, agent, chat (link), tool title ("Checked stock", "Checked balance", "Checked a document",
  "Created a quotation"), result (Done / Refused + reason / Failed). A created quotation shows its SQL Account `dockey`
  (internal id) only. Chat line `ai_tool_used` {title, sourceLabel: 'SQL Account'} ("AI looked up SQL Account").
- Audit rows as listed under Connection; never key values (key end only on connect).

## Fake SQL Account API (dev, tests, e2e)

`connectors/sql-account/fake.ts`: an in-process fake answering the same paths with the same envelopes (`{pagination,
data}`, 50-record pages, `/*?docno=&code=` single form, POST quotation → `{dockey}`), verifying a real SigV4 signature
with a fixed test key. Used by unit tests (through an injected `fetch`), and with `--mode dev --fake-wa` when no real
key is saved (dev routes `POST /api/dev/fake-sql-account/scenario` {ok | no_dns | unreachable | bad_keys | old_version |
private_ip} and `GET /api/dev/fake-sql-account/quotations`). Tests and e2e never call a real SQL server; the fetch guard
in tests refuses any host outside the fake.

## Web

Admin → Connectors gallery: **SQL Account** moves from Coming soon to ready (Accounting). Page `/admin/connectors/sql-account`
with the shared connector layout: **Overview** (what it does, requirements notice, privacy), **Connection** (connect form,
state, Test connection, Disconnect), **Settings** (agent picker; per agent: look-ups switches, price/stock display,
Create quotations switch with its guard summary; Match by phone), **Customers** (search chats, Linked / Matched by phone
/ Several customers / Not matched, Link / Change / Unlink), **Activity**. All texts `t()` in en/ms/zh-CN, InfoTips for
"API service", "access key", "port 443", "customer code". Works at 360 px. The AI agent page's Connectors card lists SQL
Account like the others.

## Mock (this proposal)

Cloned from the latest owner-confirmed mock **group-management** (`docs/features/group-management/mock`, git revision
`26116d59b3b9ca31b202163dc599cb96b1bf6f5e`, confirmed 2026-11-04) with `git archive`; screenshots not copied. Every
inherited flow is unchanged. Intentional changes (the rest is verified unchanged against that revision, see
`mock/reference.json`):

- added `mock/sql-account.ts` (stand-in server routes and fake API data), `mock/src/mock/sqlAccount.ts`,
  `mock/src/admin/SqlAccountPage.tsx`, `mock/sql-account-shots.mjs`;
- changed `mock/proposal.ts` (registers it), `mock/connector-list.ts` (`sql-account` is `builtin`),
  `mock/src/admin/ConnectorDetailPage.tsx` and `ConnectorsGalleryPage.tsx` (route and card), `mock/run.ts` (temp folder
  name), `mock/reference.json`, `mock/README.md`, the three `admin.json` catalogs (`mockSql.*`).

Screen/state checklist: gallery card (ready, not connected / connected / problem) · Overview with requirements ·
Connect form (empty, invalid key, testing) · each failure state (not set up, can't reach, private address, keys not
accepted, too old) · Connected · Settings per agent (object access table defaults, Quotation on Read + create with guards, an object Off) · Customers (linked, matched by
phone, several, not matched; Link dialog with code check) · Activity (done, refused, failed) · Try a question (Mock only:
balance for a linked chat, balance for an unmatched chat → hand-over, stock, quotation with confirmation) · 360 px and
1280 px · light and dark.

Retention: adding this folder makes six; the oldest, **in-app-feedback** (creation 28, revision of its last commit on
`main`: `f3eaf7bcf7792fb4e058103b9bd9f93e9fcc4ed6`), is removed in this change and stays in git history.

## Open questions for the owner

- **Q1 Licence.** Is the SQL Account API Service a paid module or included from 5.2025.1038.875? (No public source.)
  Proposal: the page says "may need a licence from your dealer" until confirmed.
- **Q2 Host.** Call `https://<id>.sql.my` (eStream's Postman collection) or `https://api.sql.my` (the API Service dialog
  and S4)? Proposal: derive `<id>.sql.my` from the access key, allow only these two forms, confirm with one real key.
- **Q3 Outstanding amount.** Which field/endpoint gives the unpaid amount of an invoice (`/salesinvoice` field,
  `/customerinvoice`, or a report)? Needs the Postman collection a real SQL Account generates (the 2026-04 Lintasan Setia
  note has an `APICollection.zip` that may be it). Until then `sql_my_account` lists invoices and amounts only.
- **Q4 Phone match.** Which customer fields hold phone/mobile (branch details?), and can the list be read in 50-record
  pages for an index? If not readable, phone match is dropped and only teammate links remain.
- **Q5 SQL Cloud.** Does a SQL Cloud (eStream-hosted) company get the API Service? If not, the page says "Not available
  for SQL Cloud yet".
- **Q6 API user rights.** Does the API user's SQL Account access right limit what the API returns? Proposal: the setup
  steps tell the admin to give the API user read rights plus "Sales Quotation: New" only.
- **Q7 Try it** with a test customer code picker (admins only) — yes/no.
- **Q8** Also show "SQL Account customer" with Link in the chat's customer panel in v1, or Customers tab only? Proposal:
  Customers tab in v1, panel row next.
- **Q9 Writes.** v1 offers "Read + create" only for **Quotation** (Off by default everywhere). Should Sales order (and
  Customer, for a new customer) also get "Read + create" in v1? Invoices, delivery orders and payments: never from the AI.
- **Q11 Object list.** Is the object table above the right set and are the defaults right (Customer payment and
  Customer off, the rest Read)? Should an install-wide ceiling exist above the per-agent table (e.g. "no agent may read
  invoices")? Proposal: per agent only, like Google Sheets.
- **Q10** Need a real test company (sandbox key from eStream support or a client's test database) before release: the
  build will be "untested against a real SQL Account API".

## Answers to the open questions (owner 2026-11-05: "3. Yes, can u research it")

The owner confirmed the design as proposed and asked for the questions to be researched instead of answered:

- **Q1 Licence:** treated as a **paid add-on**. Reseller listing "SQL API" at RM 1,000 per company per year, unlimited
  users, plus SST (`sql.agile.my/shop/sql-api/`, read 2026-11-05; `sql-accounting.software/product/sql-api/` lists the
  product without a readable price). No official eStream price page is readable. The page says "needs SQL Account's API
  module (a paid add-on from your SQL dealer)".
- **Q2 Host:** as proposed: `https://<id>.sql.my` from the access key; only that form or `api.sql.my` is accepted.
- **Q3 Outstanding amount (superseded by the Postman collection below):** no field is confirmed in any public source (`docamt` exists, an unpaid amount does not).
  v1 shows each invoice's number, date and total only; `sql_my_account` says it has no balance and tells the AI to
  hand over for "how much do I owe". **Open item:** confirm the field with the Postman collection a real SQL Account
  downloads (setup-configuration.md "Download Postman Collection").
- **Q4 Phone match:** eStream's docs keep a customer's mobile on Maintain Customer (`docs/miscellaneous/whatsapp-share.md`:
  "Insert Mobile on Maintain Customer") and branch details in `AR_CustomerBranch`
  (`docs/usage/tool/fast-report/guide.md`). The API's field names are not documented, so the server reads any field
  named phone/mobile/tel in the customer list (also nested branch rows). When the list carries none, the page says
  "Your SQL Account does not send phone numbers to EzyChat: link customers by hand" (`phoneMatch: unavailable`).
- **Q5 SQL Cloud:** not confirmed anywhere; the page says "SQL Cloud: ask your dealer whether the API module is
  available" and claims no support.
- **Q6–Q9, Q11:** as proposed (per-agent access only, no install-wide ceiling; create only for quotations; Customers tab
  in v1; Try it has no customer).
- **Q10:** no test company: the connector ships as **beta** and is "untested against a real SQL Account API".

## More evidence (main session, 2026-11-05)

- **Host (Q2), official:** eStream's own screenshots `static/img/integration/sql-account-api/setup-configuration/4.png`
  (Access Key `13fcdacdc0429dc2f8fa47dddf97c393.sql.my/SALES` = `<32 hex>.sql.my/<SQL user>`) and `postman-2.png`
  (Postman variables `host https://<32 hex>.sql.my`, `api_ver v1.0`, `region ap-southeast-5`, `service sqlaccount`, empty
  `session_token`); SQL Account's Test Connection and the first Postman step are `GET Agent`. So the connect form has
  Access key + Secret key only and the host comes from the key.
- **Shared host, third party (not eStream):** `techmanstudies-ai/excel-sync` `sql_api_sync/Get_Sales_Invoice.py` calls
  `https://api.sql.my/salesinvoice` with the same keys (AWS4Auth `ap-southeast-5` / `sqlaccount`), pages with
  `?offset=N&limit=50` and reads `{"data":[…]}` with lower-case fields (`docdate`). Both host shapes are accepted (exact
  shapes only); EzyChat calls the per-company host from the key.
- **Customer phones, third party:** `JJasXS/eQuotation` (`api/services/customer_payload.py`) uses `phone1`, `phone2`,
  `mobile`, `email`, `attention` on the customer branch, marked "TODO confirm against official docs" there. The phone
  index reads any phone/mobile/tel field, also on nested branch rows, so it covers this shape; the customer list is
  pageable (Q4).
- **Independent reference** `sqlacccountingapi.com/docs` (S4, owner-shared): customer, sales invoice and customer payment
  fields as recorded above; no paid/outstanding field; "posting an empty JSON body crashes the backend". The client
  therefore never sends a document without a customer code, a `YYYY-MM-DD` date and at least one complete line
  (`completeDocument`, tested).
- **v2 option (not built):** unpaid ≈ invoice `docamt` − Σ customer-payment allocations (`sdsdocdetail[].fromdocno` = the
  invoice, `fromdoctype` "SI") − credit notes and contra. Enable only after checking against a real SQL Account
  (Postman collection or a test company); until then balance questions are handed over.

## Official Postman collection (owner, 2026-11-05)

Source: eStream SQL Account API Postman collection `APICollection-20260528.json` (285 requests, 81 folders, placeholders
only), provided by the owner; not committed (vendor file, licence unknown). Field presence in live GET answers is still
**per official collection, untested live**.

- **Host:** collection variable `host = https://api.sql.my` (with `api_ver v1.0`, `region ap-southeast-5`, `service
sqlaccount`, auth `awsv4`). EzyChat now calls `https://api.sql.my` for every key (`SQL_API_HOST`); a saved per-company
  `<32 hex>.sql.my` host stays accepted.
- **Q3 answered:** the accounts-receivable invoice `/customerinvoice` carries `docamt`, `paymentamt`, `outstanding`,
  `duedate`, `cancelled`, `status`; `/customer` carries `outstanding` (the customer's balance), `creditlimit`,
  `overduelimit`, `creditterm`, `agingon`. The sales document `/salesinvoice` has no paid or outstanding field.
  → New object **Customer invoices (amount owed)** (`customerinvoice`, own records, Off by default like payments):
  `sql_my_account` returns each unpaid invoice (number, date, due date, total, paid, still owed) and, with Customer
  details on, `customer.outstanding` as "still owed" (never the credit limit). The AI says amounts exactly as given with
  "as recorded in our accounts on" + `asOf` (business time zone) and never works out an amount. With neither object on,
  the tool says it has no balance and the AI hands over (unchanged).
- **Q4 answered:** phones are on `customer.sdsbranch[]` (`phone1`, `phone2`, `mobile`, `email`, `attention`,
  `branchname`), which only the single-customer read returns (a list answer has master fields only, eStream FAQ). The
  phone index therefore reads the list, then each customer, in the background at most one every 4 s (15 a minute,
  leaving half the 30-a-minute budget to the AI), once a day and right after connecting; numbers stay in memory.
  Status `phoneMatch: building` until the first phone is read; a chat not matched yet is handed over meanwhile.
- **Fake API** follows these shapes (lower-case fields, `sdsbranch[]`, `/customerinvoice`, `sdsknockoff[]` on payments,
  stock `balsqty`/`uom`/`refprice`).
- Mock: the access table gains the row (`mock/screenshots/sql-17-access-amount-owed-*.png`) and Try a question answers
  "How much do I still owe?" with the amounts as recorded (`sql-18-try-amount-owed-*.png`).

## Implementation notes (differences from the proposal)

- Links are keyed by chat (`sql_account_links.chat_jid`, moved by `chats/merge.ts`), not by profile id.
- Quotation create is two tools: `sql_quotation_preview` (items only from a `sql_check_stock` result in this chat in the
  last 24 h, quantities the customer wrote as numbers, prices read again from SQL Account; stores a draft) and
  `sql_create_quotation` {draftId} (needs an AI reply after the draft and a newer customer message, each message used
  once, 2 per chat and 20 per agent a day, never in a group or Try it).
- Document numbers are sent upper case together with the customer code (`/<type>?docno=&code=`); the `/*?` single
  form is not used.
- SigV4 is our own (no dependency), pinned by AWS's official `get-vanilla` test vectors; the header form is used.
- Lite → Enterprise import merges agent settings, links and activity; drafts and seen items are skipped (expire in a day).

## Confirmation

Owner (Jazz) in the main session, 2026-11-05 ~10:15 UTC, relayed verbatim by session_01J4pmGkCf1Mvdepudm8WQAd:
"3. Yes,can u research it", read as: design and mock confirmed as proposed, open questions researched (above).
