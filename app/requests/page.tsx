"use client";
import Link from "next/link";
import { useState } from "react";
import { useResource } from "../../lib/pramaan/client";
import { send } from "../parts";
import { amount, type Snapshot } from "../types";
export default function Requests() {
  const { data, error } = useResource<Snapshot>("/api/requests");
  const [typeId, setTypeId] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  if (!data)
    return (
      <main className="workspace">
        <h1>Requests</h1>
        <p>{error?.message ?? "Loading…"}</p>
      </main>
    );
  const chosen = data.types.find((t) => t.id === (typeId || data.types[0]?.id));
  return (
    <main className="workspace">
      <p className="eyebrow">Clear decisions, one step at a time</p>
      <h1>Requests</h1>
      <p>
        Employees see their own requests. Approvers see requests routed to them. Finance sees
        approved expenses.
      </p>
      <p role="status">{message}</p>
      <section>
        <h2>New request</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            try {
              const r = await send<{ id: string }>("/api/requests", {
                action: "save",
                type_id: chosen?.id,
                title: f.get("title"),
                leave_year: f.get("leave_year"),
                leave_days: f.get("leave_days"),
                lines:
                  chosen?.kind === "leave"
                    ? []
                    : [
                        {
                          amount: f.get("amount"),
                          category_id: f.get("category_id"),
                          spent_on: f.get("spent_on"),
                        },
                      ],
                values: data.fields
                  .filter((v) => v.type_id === chosen?.id)
                  .map((v) => ({ field_id: v.id, value: f.get(v.id) })),
              });
              location.assign(`/requests/${r.id}`);
            } catch (e) {
              setMessage((e as Error).message);
              setBusy(false);
            }
          }}
        >
          <label>
            Request type
            <select
              aria-label="Request type"
              value={chosen?.id ?? ""}
              onChange={(e) => setTypeId(e.target.value)}
            >
              {data.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input name="title" required maxLength={160} />
          </label>
          {chosen?.kind === "leave" ? (
            <>
              <label>
                Leave year
                <input
                  name="leave_year"
                  type="number"
                  min="2000"
                  max="2200"
                  defaultValue={new Date().getFullYear()}
                  required
                />
              </label>
              <label>
                Leave days
                <input name="leave_days" type="number" min="1" max="366" required />
              </label>
            </>
          ) : (
            <>
              <label>
                Amount
                <input name="amount" inputMode="decimal" required />
              </label>
              <label>
                Category
                <select aria-label="Category" name="category_id">
                  {data.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Date
                <input
                  name="spent_on"
                  type="date"
                  required
                  defaultValue={new Date().toISOString().slice(0, 10)}
                />
              </label>
            </>
          )}
          {data.fields
            .filter((f) => f.type_id === chosen?.id)
            .map((f) => (
              <label key={f.id}>
                {f.name}
                <input name={f.id} required={f.required} maxLength={2000} />
              </label>
            ))}
          <button disabled={busy} type="submit">
            Save draft
          </button>
        </form>
      </section>
      <section>
        <h2>Your queue</h2>
        {!data.requests.length ? (
          <p>No requests yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Type</th>
                  <th>Employee</th>
                  <th>Total / days</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/requests/${r.id}`}>{r.title}</Link>
                    </td>
                    <td>{r.type_name}</td>
                    <td>{r.submitter_email}</td>
                    <td>
                      {r.kind === "leave"
                        ? `${r.leave_days} days (${r.leave_year})`
                        : amount(r.total)}
                    </td>
                    <td>{r.status_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section>
        <h2>Leave allowance</h2>
        {data.balances.length ? (
          data.balances.map((b) => (
            <p key={`${b.user_id}-${b.year}`}>
              {b.email} · {b.year} · {b.days} days per year
            </p>
          ))
        ) : (
          <p>No allowance set. Ask the owner to add it before leave is approved.</p>
        )}
      </section>
      {["owner", "finance"].includes(data.user.role) && (
        <a href="/api/export">Export approved expenses</a>
      )}
    </main>
  );
}
