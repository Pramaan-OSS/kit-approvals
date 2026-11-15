import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/export/route";
import { GET as receiptGet } from "../../app/api/receipts/[id]/route";
import { POST as upload } from "../../app/api/receipts/route";
import { GET, POST } from "../../app/api/requests/route";
import { POST as configPost } from "../../app/api/settings/route";
import type { User } from "../accounts";
import { database } from "../runtime";
import { parseCsv } from "./csv";
import {
  comment,
  decide,
  deliver,
  detail,
  exportExpenses,
  money,
  paid,
  saveRequest,
  settings,
  snapshot,
  submit,
} from "./data";
import { acceptInvite, checkInvite, createInvite } from "./invites";

const db = () => database(),
  origin = "http://localhost:3530",
  secret = "approvals-test-session-secret-at-least-32";
const user = (name: string, role: string): User => ({
  id: randomUUID(),
  email: `${name}@test.invalid`,
  role,
});
const owner = user("owner", "owner"),
  employee = user("employee", "employee"),
  other = user("other", "employee"),
  first = user("first", "approver"),
  second = user("second", "approver"),
  finance = user("finance", "finance");
const expense = "10000000-0000-4000-8000-000000000001",
  purchase = "10000000-0000-4000-8000-000000000002",
  leave = "10000000-0000-4000-8000-000000000003",
  category = "30000000-0000-4000-8000-000000000001",
  purpose = "20000000-0000-4000-8000-000000000001";
const tokens: Record<string, string> = {},
  fake = { send: async () => ({ status: "not-sent" as const }) };
function request(u?: User, input?: object, path = "/api/requests") {
  return new Request(origin + path, {
    method: input ? "POST" : "GET",
    headers: {
      origin,
      "content-type": "application/json",
      ...(u ? { cookie: `app_session=${tokens[u.id]}` } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}
async function draft(u = employee, amount = "600.00", type = expense) {
  return saveRequest(u, {
    type_id: type,
    title: "Company request",
    lines: type === leave ? [] : [{ amount, category_id: category, spent_on: "2026-11-14" }],
    leave_year: 2026,
    leave_days: 3,
    values: [
      {
        field_id: type === expense ? purpose : "20000000-0000-4000-8000-000000000002",
        value: "Work trip",
      },
    ],
  });
}
async function pending(u = employee, amount = "600.00", type = expense) {
  const r = await draft(u, amount, type);
  await submit(u, r);
  return r;
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw Error("Tests require disposable Postgres.");
  process.env.SESSION_SECRET = secret;
  process.env.APP_COOKIE_SECURE = "false";
  process.env.APP_ORIGIN = origin;
  process.env.PRAMAAN_MODULES_DIR = `${process.cwd()}/.scratch/no-modules`;
  await db().query("TRUNCATE app_users CASCADE");
  for (const u of [owner, employee, other, first, second, finance]) {
    await db().query("INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,$4)", [
      u.id,
      u.email,
      "unused",
      u.role,
    ]);
    const token = randomBytes(32).toString("hex");
    tokens[u.id] = token;
    await db().query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '1 hour')", [
      createHmac("sha256", secret).update(token).digest("hex"),
      u.id,
    ]);
  }
  for (const type of [expense, purchase, leave])
    await settings(owner, {
      action: "rule",
      type_id: type,
      threshold: "500",
      first_id: first.id,
      second_id: second.id,
    });
});
afterAll(async () => {
  await db().end();
});
describe("Server rules and isolation", () => {
  it("requires sign-in and same-origin writes", async () => {
    expect((await GET(request())).status).toBe(401);
    const r = request(employee, { action: "save" });
    r.headers.set("origin", "https://elsewhere.invalid");
    expect((await POST(r)).status).toBe(403);
  });
  it("calculates exact totals ignoring browser totals and status", async () => {
    const r = await saveRequest(employee, {
      type_id: expense,
      title: "Two lines",
      total: 1,
      phase: "approved",
      lines: [
        { amount: "0.10", category_id: category, spent_on: "2026-01-01" },
        { amount: "0.20", category_id: category, spent_on: "2026-01-02" },
      ],
      values: [{ field_id: purpose, value: "Office" }],
    });
    const d = await detail(employee, r.id);
    expect(d.request.total).toBe("30");
    expect(d.request.phase).toBe("draft");
  });
  it("rejects negative or imprecise amounts and invalid calendar dates", async () => {
    for (const v of ["-1", "NaN", "1.001", "1e6"]) expect(() => money(v)).toThrow();
    await expect(
      saveRequest(employee, {
        type_id: expense,
        title: "Date",
        lines: [{ amount: "3", category_id: category, spent_on: "2026-02-30" }],
        values: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("requires row-backed type fields", async () => {
    await expect(
      saveRequest(employee, {
        type_id: expense,
        title: "Missing purpose",
        lines: [{ amount: "3", category_id: category, spent_on: "2026-01-01" }],
        values: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("isolates employee lists, detail, comments, edits, receipt reads and uploads", async () => {
    const r = await draft();
    expect((await snapshot(other)).requests.some((x) => x.id === r.id)).toBe(false);
    for (const work of [
      () => detail(other, r.id),
      () => comment(other, { id: r.id, body: "Sneak" }),
      () => saveRequest(other, { id: r.id, title: "Sneak", lines: [] }),
    ])
      await expect(work()).rejects.toMatchObject({ status: 404 });
    expect((await GET(request(other, undefined, `/api/requests?id=${r.id}`))).status).toBe(404);
    const receipt = randomUUID();
    await db().query("INSERT INTO approval_receipts(id,request_id,name) VALUES($1,$2,$3)", [
      receipt,
      r.id,
      "private.pdf",
    ]);
    expect(
      (await receiptGet(request(other), { params: Promise.resolve({ id: receipt }) })).status,
    ).toBe(404);
    const req = new Request(`${origin}/api/receipts?request=${r.id}&name=private.pdf`, {
      method: "POST",
      headers: { origin, cookie: `app_session=${tokens[other.id]}` },
      body: "bytes",
    });
    expect((await upload(req)).status).toBe(404);
  });
  it("hides pending expenses and approved purchases from finance", async () => {
    const r = await pending();
    await expect(detail(finance, r.id)).rejects.toMatchObject({ status: 404 });
    const p = await pending(employee, "100", purchase);
    await decide(first, { ...p, decision: "approve" });
    await expect(detail(finance, p.id)).rejects.toMatchObject({ status: 404 });
  });
  it("routes high expenses through two approvers in order and pays exactly once", async () => {
    const r = await pending();
    await expect(decide(second, { ...r, decision: "approve" })).rejects.toMatchObject({
      status: 403,
    });
    await decide(first, { ...r, decision: "approve" });
    expect((await detail(employee, r.id)).request.phase).toBe("pending");
    await expect(paid(finance, r)).rejects.toMatchObject({ status: 404 });
    await decide(second, { ...r, decision: "approve" });
    expect((await detail(employee, r.id)).request.phase).toBe("approved");
    await expect(paid(owner, r)).rejects.toMatchObject({ status: 403 });
    await paid(finance, r);
    await expect(paid(finance, r)).rejects.toMatchObject({ status: 409 });
    const marks = (await detail(employee, r.id)).audit.filter((a) => a.event === "Marked paid");
    expect(marks.map((a) => a.actor)).toEqual([finance.email]);
  });
  it("lets finance pay their own approved expense and records who did", async () => {
    const r = await pending(finance);
    await decide(first, { ...r, decision: "approve" });
    await decide(second, { ...r, decision: "approve" });
    await paid(finance, r);
    const d = await detail(finance, r.id);
    expect(d.request.phase).toBe("paid");
    expect(d.audit.find((a) => a.event === "Marked paid")?.actor).toBe(finance.email);
  });
  it("uses one approver at the exact threshold", async () => {
    const r = await pending(employee, "500");
    expect((await detail(employee, r.id)).steps).toHaveLength(1);
    await decide(first, { ...r, decision: "approve" });
    expect((await detail(employee, r.id)).request.phase).toBe("approved");
  });
  it("routes using fresh lines after waiting for a concurrent edit", async () => {
    const r = await draft(employee, "10.00");
    const edit = await db().connect();
    let submitting: ReturnType<typeof submit> | undefined;
    try {
      await edit.query("BEGIN");
      await edit.query("SELECT id FROM approval_requests WHERE id=$1 FOR UPDATE", [r.id]);
      await edit.query("UPDATE approval_lines SET amount=60000 WHERE request_id=$1", [r.id]);
      submitting = submit(employee, r);
      // Observe the blocked submit in Postgres rather than relying on a timing guess.
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const activity = await db().query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.id FROM approval_requests%' AND pid<>pg_backend_pid()",
        );
        if (activity.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await edit.query("COMMIT");
      await submitting;
      expect((await detail(employee, r.id)).steps).toHaveLength(2);
    } finally {
      await edit.query("ROLLBACK");
      edit.release();
      await submitting?.catch(() => {});
    }
  });
  it("records one decision on simultaneous approve clicks", async () => {
    const r = await pending(employee, "10");
    const results = await Promise.allSettled([
      decide(first, { ...r, decision: "approve" }),
      decide(first, { ...r, decision: "approve" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const d = await detail(employee, r.id);
    expect(d.steps.filter((s) => s.decision)).toHaveLength(1);
    expect(d.audit.filter((a) => a.event.startsWith("Approved step"))).toHaveLength(1);
  });
  it("blocks self-routing and self-approval even with a malformed route", async () => {
    const r = await draft(first);
    await expect(submit(first, r)).rejects.toMatchObject({ status: 403 });
    await db().query(
      "UPDATE approval_requests SET phase='pending',status_id='40000000-0000-4000-8000-000000000002',round=1 WHERE id=$1",
      [r.id],
    );
    await db().query(
      "INSERT INTO approval_steps(id,request_id,round,position,approver_id) VALUES($1,$2,1,1,$3)",
      [randomUUID(), r.id, first.id],
    );
    await expect(decide(first, { ...r, decision: "approve" })).rejects.toMatchObject({
      status: 403,
    });
  });
  it("requires a rejection reason and freezes decided requests", async () => {
    const r = await pending();
    await expect(decide(first, { ...r, decision: "reject", reason: "" })).rejects.toMatchObject({
      status: 400,
    });
    await decide(first, { ...r, decision: "reject", reason: "Outside policy" });
    expect((await detail(employee, r.id)).request.phase).toBe("rejected");
    await expect(
      saveRequest(employee, { ...r, title: "Rewrite", lines: [] }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("supports changes and resubmission with a new ordered round", async () => {
    const r = await pending();
    await decide(first, { ...r, decision: "changes", reason: "Clarify purpose" });
    await saveRequest(employee, {
      ...r,
      title: "Revised request",
      lines: [{ amount: "700", category_id: category, spent_on: "2026-11-14" }],
      values: [{ field_id: purpose, value: "Clarified" }],
    });
    await submit(employee, r);
    const d = await detail(employee, r.id);
    expect(d.request.round).toBe(2);
    expect(d.steps.filter((s) => s.round === 2)).toHaveLength(2);
    await expect(decide(second, { ...r, decision: "approve" })).rejects.toMatchObject({
      status: 403,
    });
  });
  it("serializes leave approvals against the same annual balance", async () => {
    await settings(owner, { action: "balance", user_id: employee.id, year: 2026, days: 5 });
    const a = await pending(employee, "0", leave),
      b = await pending(employee, "0", leave);
    const results = await Promise.allSettled([
      decide(first, { ...a, decision: "approve" }),
      decide(first, { ...b, decision: "approve" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await db().query(
          "SELECT sum(leave_days)::int AS days FROM approval_requests WHERE submitter_id=$1 AND phase='approved' AND leave_year=2026",
          [employee.id],
        )
      ).rows[0].days,
    ).toBe(3);
    await expect(
      settings(owner, { action: "balance", user_id: employee.id, year: 2026, days: 2 }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("requires an annual allowance before leave approval", async () => {
    const r = await pending(other, "0", leave);
    await expect(decide(first, { ...r, decision: "approve" })).rejects.toMatchObject({
      status: 400,
    });
  });
  it("protects role grants and all settings from non-owners", async () => {
    for (const u of [employee, first, finance])
      expect(
        (
          await configPost(
            request(u, { action: "invite", email: "hack@test.invalid", role: "owner" }),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await configPost(
          request(owner, { action: "invite", email: "hack@test.invalid", role: "owner" }),
        )
      ).status,
    ).toBe(400);
  });
  it("renames settings but refuses removal of used values", async () => {
    const r = await draft();
    for (const [kind, row] of [
      ["type", expense],
      ["field", purpose],
      ["category", category],
      ["status", "40000000-0000-4000-8000-000000000001"],
    ])
      await expect(
        settings(owner, { action: "remove-setting", kind, id: row }),
      ).rejects.toMatchObject({ status: 409 });
    await settings(owner, {
      action: "setting",
      kind: "status",
      id: "40000000-0000-4000-8000-000000000001",
      name: "Preparing",
    });
    expect((await detail(employee, r.id)).request.phase).toBe("draft");
    await settings(owner, {
      action: "setting",
      kind: "status",
      id: "40000000-0000-4000-8000-000000000001",
      name: "Draft",
    });
  });
  it("escapes CSV formulas and restricts accountant exports", async () => {
    const r = await pending(employee, "11");
    await decide(first, { ...r, decision: "approve" });
    await db().query("UPDATE approval_requests SET title='  =SUM(1,2)' WHERE id=$1", [r.id]);
    const csv = await exportExpenses(finance);
    expect(csv).toContain(`"'  =SUM(1,2)"`);
    expect(csv).toContain("11.00");
    expect((await exportRoute(request(employee))).status).toBe(403);
    expect((await exportRoute(request())).status).toBe(401);
  });
  it("validates quoted CSV, headers and duplicates before importing", async () => {
    expect(parseCsv('email\r\n"one@test.invalid"\r\n')).toEqual([["one@test.invalid"]]);
    for (const csv of ["name\na", 'email\n"open', "email\na,b"])
      expect(() => parseCsv(csv)).toThrow();
    expect(
      (
        await configPost(
          request(owner, { action: "import", csv: "email\na@test.invalid\na@test.invalid" }),
        )
      ).status,
    ).toBe(400);
  });
  it("invites every role and refuses spent and expired tokens", async () => {
    for (const role of ["employee", "approver", "finance"] as const) {
      const invite = await createInvite(
        fake,
        { email: `invite-${role}@test.invalid`, role, invitedBy: owner.id },
        origin,
        "Approvals",
      );
      const token = invite.link?.split("#")[1];
      expect((await checkInvite(token)).role).toBe(role);
      await acceptInvite(token, "Approvals-test-123", 12);
      await expect(checkInvite(token)).rejects.toMatchObject({ status: 410 });
      expect(
        (await db().query("SELECT role FROM app_users WHERE email=$1", [invite.email])).rows[0]
          .role,
      ).toBe(role);
    }
    const invite = await createInvite(
      fake,
      { email: "expired@test.invalid", role: "employee", invitedBy: owner.id },
      origin,
      "Approvals",
    );
    await db().query(
      "UPDATE approvals_invites SET expires_at=now()-interval '1 second' WHERE email=$1",
      [invite.email],
    );
    await expect(checkInvite(invite.link?.split("#")[1])).rejects.toMatchObject({ status: 410 });
  });
  it("queues lifecycle emails using stable retry keys", async () => {
    const r = await pending();
    await decide(first, { ...r, decision: "approve" });
    await decide(second, { ...r, decision: "approve" });
    const rows = (await db().query("SELECT * FROM approval_mail WHERE request_id=$1", [r.id])).rows;
    expect(rows.map((m) => m.subject)).toEqual(
      expect.arrayContaining([
        "Request submitted",
        "A request needs your approval",
        "Request decided",
      ]),
    );
    expect(rows).toHaveLength(4);
    const seen = new Set<string>();
    await deliver({
      send: async (_message, key) => {
        seen.add(key);
        return { status: "sent" };
      },
    });
    await deliver({
      send: async (_message, key) => {
        seen.add(key);
        return { status: "sent" };
      },
    });
    const initial = seen.size;
    await deliver({
      send: async (_message, key) => {
        seen.add(key);
        return { status: "sent" };
      },
    });
    expect(seen.size).toBe(initial);
  });
  it("reports file storage off and keeps no false receipt record", async () => {
    const r = await draft();
    const req = new Request(`${origin}/api/receipts?request=${r.id}&name=receipt.pdf`, {
      method: "POST",
      headers: { origin, cookie: `app_session=${tokens[employee.id]}` },
      body: "receipt",
    });
    const response = await upload(req);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("isn't switched on");
    expect((await detail(employee, r.id)).receipts).toHaveLength(0);
  });
});
