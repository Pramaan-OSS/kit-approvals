"use client";
import { type FormEvent, useState } from "react";
import { useResource } from "../../lib/pramaan/client";
import { send } from "../parts";
import { amount, type Named, type Snapshot } from "../types";

type Invite = { email: string; link?: string; delivery: string };
export default function Settings() {
  const { data, error, reload } = useResource<Snapshot>("/api/settings");
  const [message, setMessage] = useState(""),
    [invites, setInvites] = useState<Invite[]>([]),
    [busy, setBusy] = useState(false);
  async function post(input: object) {
    setBusy(true);
    setMessage("");
    try {
      const r = await send<{
        message?: string;
        email?: string;
        link?: string;
        delivery?: string;
        invites?: Invite[];
      }>("/api/settings", input);
      setMessage(r.message ?? (r.email ? `Invite ready for ${r.email}.` : "Saved."));
      setInvites(
        r.invites ??
          (r.email ? [{ email: r.email, link: r.link, delivery: r.delivery ?? "not-sent" }] : []),
      );
      reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form =
    (action: string, extra: object = {}) =>
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void post({
        action,
        ...Object.fromEntries(f),
        required: f.get("required") === "on",
        ...extra,
      });
    };
  if (!data)
    return (
      <main className="workspace">
        <h1>Approval settings</h1>
        <p>{error?.message ?? "Loading…"}</p>
      </main>
    );
  const typeSelect = (name = "type_id") => (
    <label>
      Request type
      <select aria-label="Request type" name={name}>
        {data.types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
  const lists: [string, Named[]][] = [
    ["type", data.types],
    ["field", data.fields],
    ["category", data.categories],
    ["status", data.statuses],
  ];
  return (
    <main className="workspace">
      <h1>Approval settings</h1>
      <p role="status">{message}</p>
      {invites.map((i) => (
        <p key={i.email}>
          {i.email} ·{" "}
          {i.delivery === "sent" ? "Invite emailed." : "Email is unavailable or unconfirmed."}{" "}
          {i.link && <a href={i.link}>Open invite for {i.email}</a>}
        </p>
      ))}
      <section>
        <h2>People</h2>
        <button type="button" disabled={busy} onClick={() => void post({ action: "retry-email" })}>
          Retry queued notices
        </button>
        {data.users.map((u) => (
          <p key={u.id}>
            {u.email} · {u.role}
          </p>
        ))}
        <form onSubmit={form("invite")}>
          <label>
            Invite email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select aria-label="Role" name="role">
              <option value="employee">Employee</option>
              <option value="approver">Approver</option>
              <option value="finance">Finance</option>
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Invite person
          </button>
        </form>
        <p>
          Employee CSV: one column named email, one address per row. Up to 50 rows; each person
          receives an invite.
        </p>
        <label>
          Employees CSV
          <input
            type="file"
            accept=".csv"
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await post({ action: "import", csv: await f.text() });
            }}
          />
        </label>
      </section>
      <section>
        <h2>Routing rules</h2>
        <p>
          Amounts are in the company currency. Above the threshold, the second approver follows the
          first when one is set. Leave routes use the first approver.
        </p>
        {data.rules.map((r) => (
          <p key={r.type_id}>
            {data.types.find((t) => t.id === r.type_id)?.name}: first{" "}
            {data.users.find((u) => u.id === r.first_id)?.email}, over {amount(r.threshold)} →{" "}
            {data.users.find((u) => u.id === r.second_id)?.email ?? "one approver"}
          </p>
        ))}
        <form onSubmit={form("rule")}>
          {typeSelect()}
          <label>
            Threshold
            <input name="threshold" defaultValue="500.00" required />
          </label>
          <label>
            First approver
            <select aria-label="First approver" name="first_id" required>
              <option value="">Choose a person</option>
              {data.users
                .filter((u) => u.role === "approver")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Second approver
            <select aria-label="Second approver" name="second_id">
              <option value="">One approver only</option>
              {data.users
                .filter((u) => u.role === "approver")
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Save route
          </button>
        </form>
      </section>
      <section>
        <h2>Leave balances</h2>
        {data.balances.map((b) => (
          <p key={`${b.user_id}-${b.year}`}>
            {b.email}: {b.days} days in {b.year}
          </p>
        ))}
        <form onSubmit={form("balance")}>
          <label>
            Employee
            <select aria-label="Employee" name="user_id">
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Year
            <input name="year" type="number" defaultValue={new Date().getFullYear()} required />
          </label>
          <label>
            Annual days
            <input name="days" type="number" min="0" max="366" required />
          </label>
          <button type="submit" disabled={busy}>
            Save balance
          </button>
        </form>
      </section>
      {lists.map(([kind, rows]) => (
        <section key={kind}>
          <h2>
            {
              {
                type: "Request types",
                field: "Type fields",
                category: "Categories",
                status: "Statuses",
              }[kind as "type"]
            }
          </h2>
          <p>
            Rename values freely. Values in use cannot be removed. A status keeps its purpose when
            renamed.
          </p>
          {rows.map((v) => (
            <form key={v.id} onSubmit={form("setting", { kind, id: v.id })}>
              <span>
                {v.kind ??
                  v.phase ??
                  (v.type_id ? data.types.find((t) => t.id === v.type_id)?.name : "")}
              </span>
              <label>
                Rename {v.name}
                <input name="name" defaultValue={v.name} required maxLength={80} />
              </label>
              <button type="submit" disabled={busy}>
                Save {v.name}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void post({ action: "remove-setting", kind, id: v.id })}
              >
                Remove {v.name}
              </button>
            </form>
          ))}
          <form onSubmit={form("setting", { kind })}>
            <label>
              New {kind} name
              <input name="name" required maxLength={80} />
            </label>
            {kind === "type" && (
              <label>
                Type purpose
                <select aria-label="Type purpose" name="mode">
                  <option value="expense">Expense</option>
                  <option value="purchase">Purchase</option>
                  <option value="leave">Leave</option>
                </select>
              </label>
            )}
            {kind === "field" && (
              <>
                {typeSelect()}
                <label>
                  Required
                  <input name="required" type="checkbox" />
                </label>
              </>
            )}
            {kind === "status" && (
              <label>
                Status purpose
                <select aria-label="Status purpose" name="phase">
                  {["draft", "pending", "changes", "approved", "rejected", "paid"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" disabled={busy}>
              Add {kind}
            </button>
          </form>
        </section>
      ))}
    </main>
  );
}
