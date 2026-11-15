import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The kit carries the starter's package.json, which has no browser tools: point WALK_BROWSER_MODULE at an installed
// @playwright/test (its index.mjs) to run this walk.
const browserModule = process.env.WALK_BROWSER_MODULE;
const { chromium, expect } = await import(
  browserModule ? pathToFileURL(browserModule).href : "@playwright/test"
);

import { Pool } from "pg";
import { startFakeDoor } from "./fake-door.mjs";

const origin = "http://127.0.0.1:3530",
  secret = randomBytes(32).toString("hex"),
  project = "approvals-walk";
if (!process.env.DATABASE_URL)
  throw Error("Use a disposable DATABASE_URL; the walk clears its records.");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
mkdirSync(".evidence", { recursive: true });
const results = [];
let app,
  browser,
  timer,
  door,
  debugPage,
  peak = 0,
  browserPeak = 0,
  browserServer;
function pass(overrides = {}) {
  const now = Math.floor(Date.now() / 1000),
    body = Buffer.from(
      JSON.stringify({
        v: 1,
        role: "owner",
        project,
        iat: now,
        exp: now + 60,
        nonce: randomBytes(18).toString("base64url"),
        ...overrides,
      }),
    ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
async function api(page, input, path = "/api/requests") {
  const response = await page
    .context()
    .request.post(origin + path, { headers: { origin }, data: input });
  return { status: response.status(), body: await response.json() };
}
const people = [];
async function activate(person) {
  for (const other of people)
    if (other !== person && !other.page.isClosed()) await other.page.close();
  if (person.page.isClosed()) person.page = await person.context.newPage();
  debugPage = person.page;
  return person.page;
}
const ok = (r) => {
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body;
};
async function openOwner(page, token = pass()) {
  await page.goto(`${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole("heading", { name: "Owner area" })).toBeVisible();
}
async function invite(owner, email, role) {
  debugPage = owner;
  await owner.goto(`${origin}/settings`);
  await owner.getByLabel("Invite email", { exact: true }).fill(email);
  await owner.getByLabel("Role", { exact: true }).selectOption(role);
  await owner.getByRole("button", { name: "Invite person", exact: true }).click();
  const link = owner.getByRole("link", { name: `Open invite for ${email}`, exact: true });
  await expect(link).toBeVisible();
  return link.getAttribute("href");
}
async function accept(link, email) {
  const context = await browser.newContext(),
    page = await context.newPage();
  debugPage = page;
  await page.goto(link);
  await page.getByLabel("Choose a password", { exact: true }).fill("Approvals-walk-123");
  await page.getByLabel("Type it again").fill("Approvals-walk-123");
  await page.getByRole("button", { name: "Accept invite", exact: true }).click();
  await expect(page.getByText(`Signed in as ${email}`, { exact: false })).toBeVisible();
  const person = { context, page };
  people.push(person);
  await page.close();
  return person;
}
async function create(person, title, type = "Expense", value = "600.00") {
  const page = await activate(person);
  await page.goto(`${origin}/requests`);
  await page.getByLabel("Request type", { exact: true }).selectOption({ label: type });
  await page.getByLabel("Title", { exact: true }).fill(title);
  if (type === "Leave") {
    await page.getByLabel("Leave year", { exact: true }).fill("2026");
    await page.getByLabel("Leave days", { exact: true }).fill(value);
  } else {
    await page.getByLabel("Amount", { exact: true }).fill(value);
    await page
      .getByLabel(type === "Expense" ? "Business purpose" : "Supplier", { exact: true })
      .fill("Work travel");
  }
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return page.url().split("/").at(-1);
}
async function submit(page) {
  await page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByText("Awaiting approval", { exact: false }).first()).toBeVisible();
}
async function approve(person, id) {
  const page = await activate(person);
  await page.goto(`${origin}/requests/${id}`);
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
}
try {
  await db.query("TRUNCATE app_users,app_owner_passes CASCADE");
  await db.query("DELETE FROM approval_fields WHERE id::text NOT LIKE '20000000-0000-4000-8000-%'");
  await db.query("DELETE FROM approval_types WHERE id::text NOT LIKE '10000000-0000-4000-8000-%'");
  await db.query(
    "DELETE FROM approval_categories WHERE id::text NOT LIKE '30000000-0000-4000-8000-%'",
  );
  await db.query(
    "DELETE FROM approval_statuses WHERE id::text NOT LIKE '40000000-0000-4000-8000-%'",
  );
  door = await startFakeDoor(`${process.cwd()}/.scratch/walk-door`);
  door.state.emailOn = false;
  app = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", "3530", "-H", "127.0.0.1"],
    {
      env: {
        ...process.env,
        SESSION_SECRET: secret,
        PRAMAAN_PROJECT_ID: project,
        APP_ORIGIN: origin,
        APP_COOKIE_SECURE: "false",
        PRAMAAN_MODULES_DIR: `${process.cwd()}/.scratch/walk-door`,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  timer = setInterval(() => {
    try {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((x) => x.trim().split(/\s+/u).map(Number));
      const pids = new Set([app.pid]);
      for (let old = -1; old !== pids.size; ) {
        old = pids.size;
        for (const [pid, ppid] of rows) if (pids.has(ppid)) pids.add(pid);
      }
      if (browserServer) {
        const browserPids = new Set([browserServer.process().pid]);
        for (let old = -1; old !== browserPids.size; ) {
          old = browserPids.size;
          for (const [pid, ppid] of rows) if (browserPids.has(ppid)) browserPids.add(pid);
        }
        browserPeak = Math.max(
          browserPeak,
          Math.ceil(
            rows.filter(([pid]) => browserPids.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) /
              1024,
          ),
        );
      }
      peak = Math.max(
        peak,
        Math.ceil(
          rows.filter(([pid]) => pids.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024,
        ),
      );
    } catch {}
  }, 150);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) throw Error("Server did not start.");
  browserServer = await chromium.launchServer({ headless: true });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const ownerContext = await browser.newContext(),
    owner = await ownerContext.newPage();
  debugPage = owner;
  const token = pass();
  await openOwner(owner, token);
  expect(
    (
      await ownerContext.request.get(
        `${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`,
        { maxRedirects: 0 },
      )
    ).status(),
  ).toBeGreaterThanOrEqual(400);
  expect(
    (
      await ownerContext.request.get(
        `${origin}/api/account/owner-pass?token=${encodeURIComponent(pass({ project: "another-company" }))}`,
        { maxRedirects: 0 },
      )
    ).status(),
  ).toBeGreaterThanOrEqual(400);
  for (const bad of [
    pass({ iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 }),
    `${pass()}forged`,
  ]) {
    expect(
      (
        await ownerContext.request.get(
          `${origin}/api/account/owner-pass?token=${encodeURIComponent(bad)}`,
          { maxRedirects: 0 },
        )
      ).status(),
    ).toBeGreaterThanOrEqual(400);
  }
  await owner.getByLabel("Owner email").fill("owner@approvals.test");
  await owner.getByLabel("Password", { exact: true }).fill("Approvals-owner-123");
  await owner.getByRole("button", { name: "Save sign-in", exact: true }).click();
  await expect(
    owner.getByText("Saved. You can now sign in with this email and password."),
  ).toBeVisible();
  results.push("owner-pass-replay-project-expiry-forgery-and-credentials");
  await owner.goto(`${origin}/requests`);
  await expect(owner.getByText("No requests yet.")).toBeVisible();
  await owner.screenshot({ path: ".evidence/empty.png", fullPage: true });
  const manifest = JSON.parse(readFileSync("pramaan.kit.json", "utf8"));
  for (const journey of manifest.journeys.filter((j) => j.status === "ships-working")) {
    const context = journey.role === "visitor" ? await browser.newContext() : ownerContext,
      page = context === ownerContext ? owner : await context.newPage();
    debugPage = page;
    const checklist = JSON.parse(readFileSync(journey.checklist, "utf8"));
    console.log(`Journey ${journey.id}`);
    for (const item of checklist.items)
      for (const step of item.steps) {
        if (step.enterAs) await openOwner(page);
        else if (step.goto) await page.goto(origin + step.goto);
        else if (step.fill) await page.getByLabel(step.fill, { exact: true }).fill(step.value);
        else if (step.select)
          await page.getByLabel(step.select, { exact: true }).selectOption({ label: step.option });
        else if (step.click)
          await page.getByRole("button", { name: step.click, exact: true }).click();
        else if (step.expectText)
          await expect(page.getByText(step.expectText, { exact: false }).first()).toBeVisible();
        else if (step.expectAbsent)
          await expect(page.getByLabel(step.expectAbsent, { exact: true })).toHaveCount(0);
        else throw Error(`Unknown step ${JSON.stringify(step)}`);
      }
    results.push(journey.id);
    if (context !== ownerContext) await context.close();
  }
  const employeeLink = await invite(owner, "employee@approvals.test", "employee"),
    employee = await accept(employeeLink, "employee@approvals.test");
  const first = await accept(
    await invite(owner, "first@approvals.test", "approver"),
    "first@approvals.test",
  );
  const second = await accept(
    await invite(owner, "second@approvals.test", "approver"),
    "second@approvals.test",
  );
  const finance = await accept(
    await invite(owner, "finance@approvals.test", "finance"),
    "finance@approvals.test",
  );
  const replay = await employee.context.request.post(`${origin}/api/invites`, {
    headers: { origin },
    data: { action: "check", token: employeeLink.split("#")[1] },
  });
  expect(replay.status()).toBe(410);
  await owner.goto(`${origin}/settings`);
  await owner.getByLabel("Employees CSV", { exact: true }).setInputFiles({
    name: "employees.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("email\nother@approvals.test\n"),
  });
  await expect(owner.getByRole("status")).toContainText("Imported 1 employees.");
  const otherLink = await owner
    .getByRole("link", { name: "Open invite for other@approvals.test", exact: true })
    .getAttribute("href");
  const other = await accept(otherLink, "other@approvals.test");
  results.push("all-roles-join-and-sign-in", "invite-replay", "employee-csv-import");
  const users = (await db.query("SELECT id,email FROM app_users")).rows,
    byEmail = (email) => users.find((u) => u.email === email).id;
  await owner.goto(`${origin}/settings`);
  for (const type of ["Expense", "Purchase", "Leave"]) {
    await owner.getByLabel("Request type", { exact: true }).first().selectOption({ label: type });
    await owner.getByLabel("Threshold", { exact: true }).fill("500.00");
    await owner
      .getByLabel("First approver", { exact: true })
      .selectOption(byEmail("first@approvals.test"));
    await owner
      .getByLabel("Second approver", { exact: true })
      .selectOption(byEmail("second@approvals.test"));
    await owner.getByRole("button", { name: "Save route", exact: true }).click();
    await expect(owner.getByRole("status")).toHaveText("Saved.");
  }
  await owner
    .getByLabel("Employee", { exact: true })
    .selectOption(byEmail("employee@approvals.test"));
  await owner.getByLabel("Year", { exact: true }).fill("2026");
  await owner.getByLabel("Annual days", { exact: true }).fill("5");
  await owner.getByRole("button", { name: "Save balance", exact: true }).click();
  await expect(owner.getByRole("status")).toHaveText("Saved.");
  for (const u of [employee, first, second, finance])
    expect((await u.context.request.get(`${origin}/api/settings`)).status()).toBe(403);
  door.state.emailOn = true;
  const expense = await create(employee, "Conference expense");
  await employee.page.getByLabel("Upload receipt", { exact: true }).setInputFiles({
    name: "receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 test receipt"),
  });
  await expect(employee.page.getByRole("status")).toHaveText("Receipt uploaded.");
  const receiptHref = await employee.page
    .getByRole("link", { name: "receipt.pdf", exact: true })
    .getAttribute("href");
  expect(await (await employee.context.request.get(origin + receiptHref)).text()).toContain(
    "%PDF-1.4",
  );
  expect((await other.context.request.get(origin + receiptHref)).status()).toBe(404);
  expect((await other.context.request.get(`${origin}/api/requests?id=${expense}`)).status()).toBe(
    404,
  );
  expect(
    (await api(other.page, { action: "comment", id: expense, body: "Forbidden" })).status,
  ).toBe(404);
  const otherList = await (await other.context.request.get(`${origin}/api/requests`)).json();
  expect(otherList.requests.some((r) => r.id === expense)).toBe(false);
  await submit(employee.page);
  expect((await finance.context.request.get(`${origin}/api/requests?id=${expense}`)).status()).toBe(
    404,
  );
  expect(
    (await api(second.page, { action: "decide", id: expense, decision: "approve" })).status,
  ).toBe(403);
  expect(
    (await api(employee.page, { action: "decide", id: expense, decision: "approve" })).status,
  ).toBe(403);
  await approve(first, expense);
  await approve(second, expense);
  await activate(finance);
  await finance.page.goto(`${origin}/requests/${expense}`);
  await finance.page.getByRole("button", { name: "Mark paid", exact: true }).click();
  await expect(finance.page.getByText("Marked paid", { exact: false })).toBeVisible();
  expect(
    door.state.mail.some(
      (m) => m.to === "employee@approvals.test" && m.subject === "Request submitted",
    ),
  ).toBe(true);
  expect(
    door.state.mail.some(
      (m) => m.to === "second@approvals.test" && m.subject === "A request needs your approval",
    ),
  ).toBe(true);
  expect(door.state.mail.some((m) => m.subject === "Request decided")).toBe(true);
  results.push(
    "over-threshold-two-approvers-then-finance",
    "request-and-receipt-isolation",
    "self-approval-refused",
    "lifecycle-emails",
    "receipt-roundtrip",
  );
  const concurrent = await create(employee, "Duplicate approval", "Expense", "20");
  await submit(employee.page);
  const double = await Promise.all([
    api(first.page, { action: "decide", id: concurrent, decision: "approve" }),
    api(first.page, { action: "decide", id: concurrent, decision: "approve" }),
  ]);
  expect(double.filter((r) => r.status === 200)).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM approval_steps WHERE request_id=$1 AND decision IS NOT NULL",
        [concurrent],
      )
    ).rows[0].n,
  ).toBe(1);
  results.push("concurrent-double-click-one-decision");
  const returned = await create(employee, "Needs correction", "Expense", "50");
  await submit(employee.page);
  await activate(first);
  await first.page.goto(`${origin}/requests/${returned}`);
  await first.page.getByLabel("Reason", { exact: true }).fill("Explain the business purpose");
  await first.page.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(first.page.getByText("Changes requested", { exact: false }).first()).toBeVisible();
  await activate(employee);
  await employee.page.goto(`${origin}/requests/${returned}`);
  await employee.page.getByLabel("Business purpose", { exact: true }).fill("Customer meeting");
  await employee.page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(employee.page.getByRole("status")).toHaveText("Saved.");
  await submit(employee.page);
  await approve(first, returned);
  results.push("return-edit-resubmit");
  const reject = await create(employee, "Rejected expense", "Expense", "25");
  await submit(employee.page);
  await activate(first);
  await first.page.goto(`${origin}/requests/${reject}`);
  await first.page.getByLabel("Decision", { exact: true }).selectOption("reject");
  await first.page.getByLabel("Reason", { exact: true }).fill("Outside expense policy");
  await first.page.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(first.page.getByText("Rejected", { exact: false }).first()).toBeVisible();
  results.push("reject-with-reason");
  const leave = await create(employee, "First leave", "Leave", "3");
  await submit(employee.page);
  await approve(first, leave);
  const excess = await create(employee, "Excess leave", "Leave", "3");
  await submit(employee.page);
  await activate(first);
  await first.page.goto(`${origin}/requests/${excess}`);
  await first.page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(first.page.getByRole("status")).toHaveText(
    "This request exceeds the employee's remaining leave balance.",
  );
  results.push("leave-balance-enforced");
  const self = await create(first, "Self routed");
  await first.page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(first.page.getByRole("status")).toContainText(
    "A submitter cannot approve their own request.",
  );
  results.push("self-routing-refused");
  const purchase = await create(employee, "Office purchase", "Purchase", "75");
  await submit(employee.page);
  await approve(first, purchase);
  expect(
    (await finance.context.request.get(`${origin}/api/requests?id=${purchase}`)).status(),
  ).toBe(404);
  results.push("purchase-approval-finance-isolation");
  await db.query("UPDATE approval_requests SET title='=SUM(1,2)' WHERE id=$1", [expense]);
  const csv = await finance.context.request.get(`${origin}/api/export`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain(`"'=SUM(1,2)"`);
  expect((await employee.context.request.get(`${origin}/api/export`)).status()).toBe(403);
  results.push("accountant-csv-formula-escaped");
  await owner.goto(`${origin}/settings`);
  await owner.getByRole("button", { name: "Remove General", exact: true }).click();
  await expect(owner.getByRole("status")).toHaveText("This value is in use and cannot be removed.");
  await owner.getByLabel("Rename Awaiting approval", { exact: true }).fill("In review");
  await owner.getByRole("button", { name: "Save Awaiting approval", exact: true }).click();
  await expect(owner.getByRole("status")).toHaveText("Saved.");
  await owner.getByLabel("Rename In review", { exact: true }).fill("Awaiting approval");
  await owner.getByRole("button", { name: "Save In review", exact: true }).click();
  await expect(owner.getByRole("status")).toHaveText("Saved.");
  results.push("editable-status-and-in-use-list-protection");
  door.state.filesOn = false;
  await activate(first);
  await first.page.goto(`${origin}/requests/${self}`);
  await first.page
    .getByLabel("Upload receipt", { exact: true })
    .setInputFiles({ name: "off.pdf", mimeType: "application/pdf", buffer: Buffer.from("test") });
  await expect(first.page.getByRole("status")).toContainText("isn't switched on");
  door.state.emailOn = false;
  ok(await api(employee.page, { action: "comment", id: expense, body: "Payout received" }));
  // A fresh submission queues mail and clearly reports the disabled module.
  await create(employee, "Notice off", "Expense", "5");
  await employee.page.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(employee.page.getByRole("status")).toContainText(
    "Email is unavailable or unconfirmed",
  );
  results.push("files-and-email-off-plainly-reported");
  const visitor = await browser.newContext();
  expect((await visitor.request.get(`${origin}/api/requests`)).status()).toBe(401);
  expect((await visitor.request.get(origin + receiptHref)).status()).toBe(401);
  expect(
    (
      await visitor.request.post(`${origin}/api/account/signup`, {
        headers: { origin },
        data: { email: "public@approvals.test", password: "Approvals-public-123", role: "owner" },
      })
    ).status(),
  ).toBeGreaterThanOrEqual(400);
  results.push("signed-out-and-public-signup-closed");
  await activate(employee);
  await employee.page.goto(`${origin}/requests`);
  await expect(
    employee.page.getByRole("heading", { name: "Your queue", exact: true }),
  ).toBeVisible();
  await employee.page.screenshot({ path: ".evidence/requests-desktop.png", fullPage: true });
  await employee.page.setViewportSize({ width: 390, height: 844 });
  await employee.page.screenshot({ path: ".evidence/requests-mobile.png", fullPage: true });
  expect(
    await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await activate(employee);
  await employee.page.goto(`${origin}/requests/${expense}`);
  await employee.page.screenshot({ path: ".evidence/request-mobile.png", fullPage: true });
  expect(
    await employee.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await owner.screenshot({ path: ".evidence/settings.png", fullPage: true });
  results.push("desktop-and-mobile-layout");
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify({ passed: results, appPeakMiB: peak, browserPeakMiB: browserPeak }, null, 2),
  );
  console.log(`Walk: ${results.length} checks passed; app peak ${peak} MiB`);
} catch (error) {
  if (debugPage && !debugPage.isClosed()) {
    console.error(await debugPage.locator("body").innerText());
    await debugPage.screenshot({ path: ".evidence/walk-failure.png", fullPage: true });
  }
  throw error;
} finally {
  clearInterval(timer);
  await browser?.close();
  await browserServer?.close();
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await new Promise((r) => app.once("exit", r));
  }
  await door?.close();
  await db.end();
}
