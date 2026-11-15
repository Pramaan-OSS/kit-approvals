# Requests and approvals

## Where things live

One company per Next.js app; Node 24.18.0 and pnpm 11.15.1. Records are individual Postgres rows.

- `app/page.tsx`: invited-account sign-in and links by role.
- `app/invite/page.tsx`: one-time invite acceptance and sign-in.
- `app/requests/page.tsx`: scoped request list, new draft and annual leave allowances.
- `app/requests/[id]/page.tsx`: lines, type field values, receipts, decisions, comments and history; edit returned requests here.
- `app/settings/page.tsx`: owner-only invitations, employee CSV import, routing, leave balances, seeded types, fields, categories and statuses.
- `app/owner/page.tsx`: owner-pass landing and owner credentials.
- `app/password-reset/page.tsx`, `app/reset-password/`: starter-owned recovery flow.
- `app/shell.tsx`, `app/parts.tsx`, `app/types.ts`: role navigation, JSON form sender and shared view shapes.
- `app/api/account/[action]/route.ts`: the unchanged starter account handler.
- `app/api/requests/route.ts`: scoped list/detail; save, submit, decide, mark paid and comment.
- `app/api/settings/route.ts`: owner-only settings, invites, imports and email retry.
- `app/api/receipts/route.ts`, `app/api/receipts/[id]/route.ts`: bounded private uploads and authorized attachment downloads.
- `app/api/export/route.ts`: owner/finance export of approved and paid expense lines; spreadsheet formulas escaped.
- `app/api/health/route.ts`, `app/api/pramaan/password-reset/route.ts`: health and recovery endpoints.
- `lib/accounts.ts`: portal's reviewed account module, unchanged. Sessions, roles and owner passes belong here.
- `lib/runtime.ts`: one bounded database pool, account options, no public signup.
- `lib/approvals/access.ts`: `viewer`, owner guard and SQL scope. Employees own their rows; approvers see requests ever routed to them; finance sees approved/paid expenses. Scope uses the session, never a browser-provided user id.
- `lib/approvals/data.ts`: transactions, server totals, draft fields and lines, frozen routing per round, ordered decisions, paid recording, leave locking, audit rows, settings and mail queue.
- `lib/approvals/invites.ts`: random 32-byte single-use tokens, hashed storage, seven-day expiry, server-assigned role.
- `lib/approvals/storage.ts`, `lib/email.ts`, `lib/pramaan.ts`: platform module HTTP over its local socket; no vendor SDK or key in the app.
- `lib/approvals/csv.ts`, `lib/approvals/words.ts`, `lib/roles/http.ts`: CSV parser, bounded validation and same-origin JSON reader.
- `lib/pramaan/`, `components/pramaan/password-reset/`: adapted theme and password-reset blocks.
- `src/db/migrations/0001`–`0004`: starter bytes. `0100-approvals.sql`: types, type fields, values, categories, statuses, routes, requests, lines, receipts, steps, comments, audit, allowances, invites and mail queue.
- `scripts/walk.mjs`, `scripts/fake-door.mjs`: headless multi-account walk and test-only platform substitute.
- `lib/approvals/approvals.pg.spec.ts`: database-backed isolation, money, ordered decisions, concurrency, leave, settings, invites, module-off and CSV tests.

## Add a field

Owner-defined request fields are rows in `approval_fields`; add one in Settings, choose the type and whether it is required. Each submitted value is a row in `approval_values`, with matching type enforced by foreign keys. For a structural field, add migration `0101-<name>.sql`, extend the bounded checks in `saveRequest`, add its form control and shared view type, and test validation and employee isolation. Never edit an applied migration or store a workspace as JSON.

## Add a page

Add `app/<page>/page.tsx`, its `pramaan.feature.json` and run `pnpm generate`. Load data through a server route that starts with `viewer`, then `ownerOnly` when appropriate. Request queries must use `SCOPE` or `scoped`; hiding a button is not authorization. Add the navigation for the appropriate roles in `app/shell.tsx` and a permission test.

## Add a role

Roles live in `app_users.role`. Owner comes only from an owner pass; the owner invites employee, approver and finance accounts. Widen the SQL constraint in a new migration, the validated invitation choices and the owner form. Decide its server scope in `access.ts`, then use `requireUser`/the scope guards on every route and test forbidden reads and writes. Never accept an account role from public signup.

## Journeys that ship working

- owner-settings: one-time owner pass opens owner settings.
- invite-person: owner creates an employee invite, shareable if email is off.
- edit-categories: add and remove an unused category; used values are protected.
- request-draft: save a request and see its computed total.
- signed-out: visitors cannot read requests.
- password-reset-off: recovery explains the email requirement.

The headless walk additionally signs in every invited role, imports employees, takes an over-threshold expense through two separate approvers and finance payout, checks self-approval, double clicks, other-employee request/receipt isolation, return/edit/resubmit, rejection, leave limits, editable settings and formula-escaped export. Receipt transfer and lifecycle emails are `needs-capability` and exercised against a test substitute only. Live paid calls are never required.

## Run and check

Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Set `DATABASE_URL`, `SESSION_SECRET` (32+ characters), `PRAMAAN_PROJECT_ID`, `APP_ORIGIN`; use `APP_COOKIE_SECURE=false` for local HTTP only. Run `node scripts/migrate.mjs`, then `pnpm dev --port 3530`. Open the platform owner pass and invite colleagues; configure the three routes before submitting requests. Tests and walk require a disposable database and clear account/request rows.

Local gates: migrate fresh `postgres:16-alpine` capped at 192 MiB and 0.5 CPU, typecheck, lint from clean archive, measured `pnpm test` under 819 MiB, build, contract and block checks, then `node scripts/walk.mjs`. On hosts with many cores, set `CIRCLE_NODE_TOTAL=3 NODE_OPTIONS=--max-old-space-size=819` for the build/check to use two workers and keep local memory within budget. Full container kit CI is run by product-loop when pinning; `kit-ci.json` records local evidence without claiming that run.

Limits: 30 lines, 20 receipts per request, 5 MB per receipt, PDF/PNG/JPEG attachments, 2,000 characters per type field/reason, 4,000 per comment, 50 employee imports per CSV, 500 most recent scoped requests in the list. Money is integer cents and totals are calculated in SQL. Approvals snapshot routes at submission. Leave approval locks the annual allowance before summing approved days; reducing an allowance uses the same lock. All state changes record an audit row in the same transaction. Files are private attachment downloads, never public URLs. Email keeps stable retry keys and the outcome; off or uncertain delivery is stated plainly.
