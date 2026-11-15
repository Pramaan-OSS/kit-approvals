import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AccountError, type User } from "../accounts";
import { emailDoor, type Mailer } from "../email";
import { database } from "../runtime";
import { ownerOnly, SCOPE } from "./access";
import { csvCell, id, text } from "./words";
export type Input = Record<string, unknown>;
export async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
  const tx = await database().connect();
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
const fail = (message: string, status = 400): never => {
  throw new AccountError(status, message);
};
export function integer(value: unknown, min = 0, max = 1000000000) {
  if (!/^\d+$/u.test(String(value))) return fail("Enter a whole number in range.");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fail("Enter a whole number in range.");
  return n;
}
export function money(value: unknown) {
  const v = String(value);
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(v))
    return fail("Enter an amount with at most two decimal places.");
  const [whole, part = ""] = v.split(".");
  return integer(Number(whole) * 100 + Number(part.padEnd(2, "0")), 0, 100000000);
}
export async function audit(tx: PoolClient, requestId: string, user: User, event: string) {
  await tx.query("INSERT INTO approval_audit(id,request_id,actor_id,event) VALUES($1,$2,$3,$4)", [
    randomUUID(),
    requestId,
    user.id,
    event,
  ]);
}
export async function scoped(tx: PoolClient, user: User, requestId: unknown, lock = false) {
  const args = [user.id, user.role, id(requestId)];
  if (lock) {
    // Take the row lock first, then read lines in a new statement. A draft edit may have
    // committed while the lock was waiting; its new total must choose the route.
    const locked = await tx.query(
      `SELECT r.id FROM approval_requests r JOIN approval_types t ON t.id=r.type_id WHERE ${SCOPE} AND r.id=$3 FOR UPDATE OF r`,
      args,
    );
    if (!locked.rowCount) return fail("That request couldn't be found.", 404);
  }
  const result = await tx.query(
    `SELECT r.*,t.kind,t.name AS type_name,st.name AS status_name,(SELECT coalesce(sum(amount),0)::text FROM approval_lines WHERE request_id=r.id) AS total FROM approval_requests r JOIN approval_types t ON t.id=r.type_id JOIN approval_statuses st ON st.id=r.status_id WHERE ${SCOPE} AND r.id=$3`,
    args,
  );
  if (!result.rows[0]) return fail("That request couldn't be found.", 404);
  return result.rows[0];
}
export async function snapshot(user: User) {
  const db = database();
  const requests = await db.query(
    `SELECT r.*,t.name AS type_name,t.kind,st.name AS status_name,u.email AS submitter_email,(SELECT coalesce(sum(amount),0)::text FROM approval_lines WHERE request_id=r.id) AS total FROM approval_requests r JOIN approval_types t ON t.id=r.type_id JOIN approval_statuses st ON st.id=r.status_id JOIN app_users u ON u.id=r.submitter_id WHERE ${SCOPE} ORDER BY r.created_at DESC LIMIT 500`,
    [user.id, user.role],
  );
  const types = await db.query("SELECT * FROM approval_types ORDER BY name"),
    fields = await db.query("SELECT * FROM approval_fields ORDER BY name"),
    categories = await db.query("SELECT * FROM approval_categories ORDER BY name"),
    statuses = await db.query("SELECT * FROM approval_statuses ORDER BY name");
  const balances = await db.query(
    "SELECT b.*,u.email FROM approval_balances b JOIN app_users u ON u.id=b.user_id WHERE b.user_id=$1 OR $2='owner' ORDER BY year DESC",
    [user.id, user.role],
  );
  const users =
    user.role === "owner"
      ? (
          await db.query(
            "SELECT id,email,role FROM app_users WHERE role IN ('employee','approver','finance') ORDER BY email",
          )
        ).rows
      : [];
  const rules = user.role === "owner" ? (await db.query("SELECT * FROM approval_rules")).rows : [];
  return {
    user,
    requests: requests.rows,
    types: types.rows,
    fields: fields.rows,
    categories: categories.rows,
    statuses: statuses.rows,
    balances: balances.rows,
    users,
    rules,
  };
}
export async function detail(user: User, requestId: unknown) {
  return transaction(async (tx) => {
    const request = await scoped(tx, user, requestId);
    const read = async (table: string, order = "") =>
      (await tx.query(`SELECT * FROM ${table} WHERE request_id=$1 ${order}`, [request.id])).rows;
    return {
      user,
      request,
      lines: await read("approval_lines"),
      values: await read("approval_values"),
      receipts: await read("approval_receipts"),
      steps: (
        await tx.query(
          "SELECT s.*,u.email FROM approval_steps s JOIN app_users u ON u.id=s.approver_id WHERE request_id=$1 ORDER BY round,position",
          [request.id],
        )
      ).rows,
      comments: await read("approval_comments", "ORDER BY created_at"),
      // Who did each step is shown, so finance paying their own expense stays visible.
      audit: (
        await tx.query(
          "SELECT a.*,coalesce(u.email,'The owner') AS actor FROM approval_audit a LEFT JOIN app_users u ON u.id=a.actor_id WHERE a.request_id=$1 ORDER BY a.created_at",
          [request.id],
        )
      ).rows,
    };
  });
}
async function phase(tx: PoolClient, requestId: string, value: string) {
  const status = (
    await tx.query("SELECT id FROM approval_statuses WHERE phase=$1 ORDER BY id LIMIT 1", [value])
  ).rows[0];
  if (!status) return fail("Add a status for this stage in settings first.");
  await tx.query("UPDATE approval_requests SET status_id=$2,phase=$3 WHERE id=$1", [
    requestId,
    status.id,
    value,
  ]);
}
async function queue(tx: PoolClient, r: Input, key: string, recipient: string, subject: string) {
  await tx.query(
    "INSERT INTO approval_mail(id,request_id,dedupe,recipient,subject,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe) DO NOTHING",
    [
      randomUUID(),
      r.id,
      key,
      recipient,
      subject,
      `${subject}: ${r.title}. Sign in to view the request.`,
    ],
  );
}
async function notify(tx: PoolClient, r: Input, event: string) {
  const employee = (await tx.query("SELECT email FROM app_users WHERE id=$1", [r.submitter_id]))
    .rows[0];
  if (employee.email && event !== "next")
    await queue(
      tx,
      r,
      `${r.id}-${r.round}-${event}`,
      employee.email,
      event === "submitted" ? "Request submitted" : "Request decided",
    );
  if (event === "submitted" || event === "next") {
    const next = (
      await tx.query(
        "SELECT u.email,s.id FROM approval_steps s JOIN app_users u ON u.id=s.approver_id WHERE s.request_id=$1 AND s.round=$2 AND s.decision IS NULL ORDER BY position LIMIT 1",
        [r.id, r.round],
      )
    ).rows[0];
    if (next?.email)
      await queue(tx, r, `step-${next.id}`, next.email, "A request needs your approval");
  }
}
export async function deliver(mailer: Mailer = emailDoor) {
  const messages = await database().query(
    "SELECT * FROM approval_mail WHERE delivery<>'sent' ORDER BY id LIMIT 30",
  );
  let off = false;
  for (const m of messages.rows) {
    const sent = await mailer.send({ to: m.recipient, subject: m.subject, text: m.body }, m.dedupe);
    await database().query("UPDATE approval_mail SET delivery=$2 WHERE id=$1", [m.id, sent.status]);
    if (sent.status !== "sent") off = true;
  }
  return off ? "Saved. Email is unavailable or unconfirmed; notices remain queued." : "Saved.";
}
export async function saveRequest(user: User, input: Input) {
  return transaction(async (tx) => {
    let r: { id: string; type_id: string; kind: string };
    if (input.id) {
      const existing = await scoped(tx, user, input.id, true);
      r = existing;
      if (existing.submitter_id !== user.id || !["draft", "changes"].includes(existing.phase))
        return fail("Only your draft or returned request can be changed.", 403);
    } else {
      if (!["employee", "owner", "approver", "finance"].includes(user.role))
        return fail("Sign in to submit.", 403);
      const type = (await tx.query("SELECT * FROM approval_types WHERE id=$1", [id(input.type_id)]))
        .rows[0];
      if (!type) return fail("Choose a request type.");
      const draft = (
        await tx.query("SELECT id FROM approval_statuses WHERE phase='draft' ORDER BY id LIMIT 1")
      ).rows[0];
      if (!draft) return fail("Add a draft status first.");
      r = { id: randomUUID(), type_id: type.id, kind: type.kind };
      await tx.query(
        "INSERT INTO approval_requests(id,type_id,submitter_id,title,status_id) VALUES($1,$2,$3,$4,$5)",
        [r.id, r.type_id, user.id, text(input.title, "a title", 160), draft.id],
      );
    }
    const title = text(input.title, "a title", 160);
    const year = r.kind === "leave" ? integer(input.leave_year, 2000, 2200) : null,
      days = r.kind === "leave" ? integer(input.leave_days, 1, 366) : null;
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (lines.length > 30 || (!lines.length && r.kind !== "leave"))
      return fail("Add between one and thirty request lines.");
    await tx.query("DELETE FROM approval_lines WHERE request_id=$1", [r.id]);
    for (const line of lines) {
      if (!line || typeof line !== "object") return fail("Check the request lines.");
      const l = line as Input;
      const date = text(l.spent_on, "a date", 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date
      )
        return fail("Enter a valid date.");
      await tx.query("INSERT INTO approval_lines VALUES($1,$2,$3,$4,$5)", [
        randomUUID(),
        r.id,
        money(l.amount),
        id(l.category_id),
        date,
      ]);
    }
    const fields = (await tx.query("SELECT * FROM approval_fields WHERE type_id=$1", [r.type_id]))
      .rows;
    const values = Array.isArray(input.values) ? input.values : [];
    await tx.query("DELETE FROM approval_values WHERE request_id=$1", [r.id]);
    for (const f of fields) {
      const v = values.find((v: Input) => v.field_id === f.id)?.value;
      if (f.required || v)
        await tx.query("INSERT INTO approval_values VALUES($1,$2,$3,$4)", [
          r.id,
          r.type_id,
          f.id,
          text(v, f.name, 2000),
        ]);
    }
    await tx.query(
      "UPDATE approval_requests SET title=$2,leave_year=$3,leave_days=$4 WHERE id=$1",
      [r.id, title, year, days],
    );
    await audit(tx, r.id, user, input.id ? "Request edited" : "Draft created");
    return { id: r.id };
  });
}
export async function submit(user: User, input: Input) {
  return transaction(async (tx) => {
    const r = await scoped(tx, user, input.id, true);
    if (r.submitter_id !== user.id || !["draft", "changes"].includes(r.phase))
      return fail("Only your draft or returned request can be submitted.", 409);
    const missing = await tx.query(
      "SELECT 1 FROM approval_fields f WHERE f.type_id=$1 AND f.required AND NOT EXISTS(SELECT 1 FROM approval_values v WHERE v.request_id=$2 AND v.field_id=f.id AND length(trim(v.value))>0)",
      [r.type_id, r.id],
    );
    if (missing.rowCount) return fail("Complete the required request fields.");
    const rule = (await tx.query("SELECT * FROM approval_rules WHERE type_id=$1", [r.type_id]))
      .rows[0];
    if (!rule) return fail("The owner must set an approval route for this type first.");
    const total = Number(r.total);
    if (r.kind !== "leave" && total <= 0) return fail("Add a positive amount before submitting.");
    const approvers = [
      rule.first_id,
      ...(total > Number(rule.threshold) && rule.second_id ? [rule.second_id] : []),
    ];
    if (approvers.includes(user.id))
      return fail(
        "A submitter cannot approve their own request. Ask the owner to change the route.",
        403,
      );
    const valid = await tx.query(
      "SELECT id FROM app_users WHERE id=ANY($1::uuid[]) AND role='approver'",
      [approvers],
    );
    if (valid.rowCount !== approvers.length) return fail("Choose active approvers in settings.");
    r.round += 1;
    await tx.query("UPDATE approval_requests SET round=$2 WHERE id=$1", [r.id, r.round]);
    for (const [i, approver] of approvers.entries())
      await tx.query(
        "INSERT INTO approval_steps(id,request_id,round,position,approver_id) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), r.id, r.round, i + 1, approver],
      );
    await phase(tx, r.id, "pending");
    await audit(tx, r.id, user, "Submitted");
    await notify(tx, r, "submitted");
    return { id: r.id };
  });
}
export async function decide(user: User, input: Input) {
  return transaction(async (tx) => {
    const r = await scoped(tx, user, input.id, true);
    if (r.submitter_id === user.id) return fail("You cannot approve your own request.", 403);
    if (user.role !== "approver") return fail("Only the routed approver can decide.", 403);
    if (r.phase !== "pending") return fail("This request already has a decision.", 409);
    const step = (
      await tx.query(
        "SELECT * FROM approval_steps WHERE request_id=$1 AND round=$2 AND decision IS NULL ORDER BY position LIMIT 1",
        [r.id, r.round],
      )
    ).rows[0];
    if (!step || step.approver_id !== user.id)
      return fail("It is not your turn to approve this request.", 403);
    const decision = String(input.decision);
    if (!["approve", "reject", "changes"].includes(decision)) return fail("Choose a decision.");
    const reason = decision === "approve" ? "" : text(input.reason, "a reason", 2000);
    const remaining = await tx.query(
      "SELECT 1 FROM approval_steps WHERE request_id=$1 AND round=$2 AND position>$3",
      [r.id, r.round, step.position],
    );
    const final = decision === "approve" && !remaining.rowCount;
    if (final && r.kind === "leave") {
      const balance = (
        await tx.query("SELECT * FROM approval_balances WHERE user_id=$1 AND year=$2 FOR UPDATE", [
          r.submitter_id,
          r.leave_year,
        ])
      ).rows[0];
      if (!balance) return fail("The owner must set a leave balance for this employee and year.");
      const used = (
        await tx.query(
          "SELECT coalesce(sum(leave_days),0)::int AS days FROM approval_requests WHERE submitter_id=$1 AND leave_year=$2 AND phase='approved' AND id<>$3",
          [r.submitter_id, r.leave_year, r.id],
        )
      ).rows[0].days;
      if (used + r.leave_days > balance.days)
        return fail("This request exceeds the employee's remaining leave balance.", 409);
    }
    await tx.query(
      "UPDATE approval_steps SET decision=$2,reason=$3,decided_at=now() WHERE id=$1 AND decision IS NULL",
      [step.id, decision, reason],
    );
    if (decision !== "approve" || final)
      await phase(tx, r.id, final ? "approved" : decision === "reject" ? "rejected" : "changes");
    await audit(
      tx,
      r.id,
      user,
      `${decision === "approve" ? "Approved step" : decision === "reject" ? "Rejected" : "Sent back for changes"} ${step.position}${reason ? `: ${reason}` : ""}`,
    );
    if (decision !== "approve" || final) await notify(tx, r, "decided");
    else await notify(tx, r, "next");
    return { id: r.id };
  });
}
export async function paid(user: User, input: Input) {
  return transaction(async (tx) => {
    if (user.role !== "finance") return fail("Only finance can mark an expense paid.", 403);
    const r = await scoped(tx, user, input.id, true);
    if (r.kind !== "expense" || r.phase !== "approved")
      return fail("Only an approved expense can be paid.", 409);
    await phase(tx, r.id, "paid");
    await audit(tx, r.id, user, "Marked paid");
    return { id: r.id };
  });
}
export async function comment(user: User, input: Input) {
  return transaction(async (tx) => {
    const r = await scoped(tx, user, input.id, true);
    await tx.query(
      "INSERT INTO approval_comments(id,request_id,user_id,body) VALUES($1,$2,$3,$4)",
      [randomUUID(), r.id, user.id, text(input.body, "a comment", 4000)],
    );
    return { id: r.id };
  });
}
export async function settings(user: User, input: Input) {
  ownerOnly(user);
  return transaction(async (tx) => {
    const action = String(input.action);
    if (action === "rule") {
      const type = id(input.type_id),
        first = id(input.first_id),
        second = input.second_id ? id(input.second_id) : null;
      if (first === second) return fail("Choose two different approvers.");
      for (const approver of [first, second].filter(Boolean))
        if (
          !(await tx.query("SELECT 1 FROM app_users WHERE id=$1 AND role='approver'", [approver]))
            .rowCount
        )
          return fail("Choose an approver.");
      await tx.query(
        "INSERT INTO approval_rules VALUES($1,$2,$3,$4) ON CONFLICT(type_id) DO UPDATE SET threshold=excluded.threshold,first_id=excluded.first_id,second_id=excluded.second_id",
        [type, money(input.threshold), first, second],
      );
    } else if (action === "balance") {
      const employee = id(input.user_id),
        year = integer(input.year, 2000, 2200),
        days = integer(input.days, 0, 366);
      // Serialize with final approvals, including when the balance row is first created.
      await tx.query("INSERT INTO approval_balances VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [
        employee,
        year,
        days,
      ]);
      await tx.query("SELECT 1 FROM approval_balances WHERE user_id=$1 AND year=$2 FOR UPDATE", [
        employee,
        year,
      ]);
      const used = (
        await tx.query(
          "SELECT coalesce(sum(leave_days),0)::int AS days FROM approval_requests WHERE submitter_id=$1 AND leave_year=$2 AND phase='approved'",
          [employee, year],
        )
      ).rows[0].days;
      if (days < used) return fail("Balance cannot be lower than approved leave.", 409);
      await tx.query("UPDATE approval_balances SET days=$3 WHERE user_id=$1 AND year=$2", [
        employee,
        year,
        days,
      ]);
    } else {
      const tables: Record<string, string> = {
        type: "approval_types",
        field: "approval_fields",
        category: "approval_categories",
        status: "approval_statuses",
      };
      const table = tables[String(input.kind)];
      if (!table) return fail("Choose a settings list.");
      if (action === "remove-setting") {
        try {
          await tx.query(`DELETE FROM ${table} WHERE id=$1`, [id(input.id)]);
        } catch (e) {
          if ((e as { code?: string }).code === "23503")
            return fail("This value is in use and cannot be removed.", 409);
          throw e;
        }
      } else if (action === "setting") {
        const name = text(input.name, "a name", 80);
        if (input.id)
          await tx.query(`UPDATE ${table} SET name=$2 WHERE id=$1`, [id(input.id), name]);
        else if (input.kind === "type") {
          if (!["expense", "purchase", "leave"].includes(String(input.mode)))
            return fail("Choose a type purpose.");
          await tx.query(`INSERT INTO ${table} VALUES($1,$2,$3)`, [randomUUID(), name, input.mode]);
        } else if (input.kind === "field")
          await tx.query(`INSERT INTO ${table} VALUES($1,$2,$3,$4)`, [
            randomUUID(),
            id(input.type_id),
            name,
            input.required === true,
          ]);
        else if (input.kind === "status") {
          if (
            !["draft", "pending", "changes", "approved", "rejected", "paid"].includes(
              String(input.phase),
            )
          )
            return fail("Choose a status purpose.");
          await tx.query(`INSERT INTO ${table} VALUES($1,$2,$3)`, [
            randomUUID(),
            name,
            input.phase,
          ]);
        } else await tx.query(`INSERT INTO ${table} VALUES($1,$2)`, [randomUUID(), name]);
      } else return fail("Choose a settings action.");
    }
    return { message: "Saved." };
  });
}
export async function exportExpenses(user: User) {
  if (!["owner", "finance"].includes(user.role))
    return fail("Only finance or the owner can export expenses.", 403);
  const rows = await database().query(
    "SELECT r.title,u.email,st.name AS status,l.amount,c.name AS category,l.spent_on::text FROM approval_requests r JOIN approval_types t ON t.id=r.type_id JOIN app_users u ON u.id=r.submitter_id JOIN approval_statuses st ON st.id=r.status_id JOIN approval_lines l ON l.request_id=r.id JOIN approval_categories c ON c.id=l.category_id WHERE t.kind='expense' AND r.phase IN ('approved','paid') ORDER BY r.created_at,l.id",
  );
  return [
    "title,employee,status,amount,category,date",
    ...rows.rows.map((r) =>
      [r.title, r.email, r.status, (r.amount / 100).toFixed(2), r.category, r.spent_on]
        .map((v) => csvCell(String(v)))
        .join(","),
    ),
  ].join("\r\n");
}
