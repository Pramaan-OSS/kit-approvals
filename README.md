# Requests and approvals

Employees submit expense, purchase and leave requests. Approvers decide in order; finance records approved expense payouts. Private receipts, comments and a state-change history stay with each request.

Use Node 24.18.0 and pnpm 11.15.1. Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Configure DATABASE_URL, SESSION_SECRET (32+ characters), PRAMAAN_PROJECT_ID and APP_ORIGIN. For local HTTP set APP_COOKIE_SECURE=false. Run `node scripts/migrate.mjs`, then `pnpm dev --port 3530`. The platform owner pass opens `/owner`; public signup is disabled.

Invite employees, approvers and finance in Approval settings. Set routes per request type and annual leave allowances. The second approver is used only above the configured amount threshold. A person cannot submit a route that asks them to approve their own work.

Employee CSV has one `email` column. Import creates invitations; accounts are created when accepted. The accountant export includes approved and paid expense lines and escapes spreadsheet formulas. Receipts and notifications need platform modules; when email is off, invitation links can be shared manually.

See KIT.md for extension points, limits and local gates. Tests and the headless walk clear a disposable database; never run them against company data. MIT, Copyright (c) 2026 Sudo Sapient; source notices in NOTICE.md.

The kit carries no browser tools. To run `node scripts/walk.mjs`, install `@playwright/test` 1.64.1 outside the kit and set `WALK_BROWSER_MODULE` to its `index.mjs`.
