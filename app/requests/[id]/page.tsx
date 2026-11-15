"use client";
import { use, useState } from "react";
import { useResource } from "../../../lib/pramaan/client";
import { send } from "../../parts";
import { amount, type Detail, type Snapshot } from "../../types";
export default function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params),
    { data, error, reload } = useResource<Detail>(`/api/requests?id=${id}`),
    { data: config } = useResource<Snapshot>("/api/requests");
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function post(input: object) {
    setBusy(true);
    try {
      const r = await send<{ message: string }>("/api/requests", { ...input, id });
      setMessage(r.message);
      reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data || !config)
    return (
      <main className="workspace">
        <h1>Request</h1>
        <p>{error?.message ?? "Loading…"}</p>
      </main>
    );
  const r = data.request,
    editable = r.submitter_id === data.user.id && ["draft", "changes"].includes(r.phase),
    next = data.steps.find((s) => s.round === r.round && !s.decision);
  return (
    <main className="workspace">
      <h1>{r.title}</h1>
      <p>
        {r.type_name} · {r.status_name} ·{" "}
        {r.kind === "leave"
          ? `${r.leave_days} days in ${r.leave_year}`
          : `Total ${amount(r.total)}`}
      </p>
      <p role="status">{message}</p>
      {editable && (
        <section>
          <h2>Edit request</h2>
          <form
            key={data.audit.length}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const lines = data.lines.map((l) => ({
                amount: f.get(`amount-${l.id}`),
                category_id: f.get(`category-${l.id}`),
                spent_on: f.get(`date-${l.id}`),
              }));
              if (f.get("extra_amount"))
                lines.push({
                  amount: f.get("extra_amount"),
                  category_id: f.get("extra_category"),
                  spent_on: f.get("extra_date"),
                });
              void post({
                action: "save",
                title: f.get("title"),
                leave_year: f.get("leave_year"),
                leave_days: f.get("leave_days"),
                lines,
                values: config.fields
                  .filter((v) => v.type_id === r.type_id)
                  .map((v) => ({ field_id: v.id, value: f.get(v.id) })),
              });
            }}
          >
            <label>
              Title
              <input name="title" defaultValue={r.title} required maxLength={160} />
            </label>
            {r.kind === "leave" ? (
              <>
                <label>
                  Leave year
                  <input
                    name="leave_year"
                    type="number"
                    defaultValue={r.leave_year ?? 2026}
                    required
                  />
                </label>
                <label>
                  Leave days
                  <input
                    name="leave_days"
                    type="number"
                    defaultValue={r.leave_days ?? 1}
                    required
                  />
                </label>
              </>
            ) : (
              <>
                {data.lines.map((l, i) => (
                  <fieldset key={l.id}>
                    <legend>Line {i + 1}</legend>
                    <label>
                      Amount {i + 1}
                      <input name={`amount-${l.id}`} defaultValue={amount(l.amount)} required />
                    </label>
                    <label>
                      Category {i + 1}
                      <select name={`category-${l.id}`} defaultValue={l.category_id}>
                        {config.categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Date {i + 1}
                      <input
                        name={`date-${l.id}`}
                        type="date"
                        defaultValue={l.spent_on.slice(0, 10)}
                        required
                      />
                    </label>
                  </fieldset>
                ))}
                <fieldset>
                  <legend>Add a line (optional)</legend>
                  <label>
                    Extra amount
                    <input name="extra_amount" />
                  </label>
                  <label>
                    Extra category
                    <select aria-label="Extra category" name="extra_category">
                      {config.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Extra date
                    <input
                      name="extra_date"
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                    />
                  </label>
                </fieldset>
              </>
            )}
            {config.fields
              .filter((f) => f.type_id === r.type_id)
              .map((f) => (
                <label key={f.id}>
                  {f.name}
                  <input
                    name={f.id}
                    required={f.required}
                    maxLength={2000}
                    defaultValue={data.values.find((v) => v.field_id === f.id)?.value ?? ""}
                  />
                </label>
              ))}
            <button disabled={busy} type="submit">
              Save changes
            </button>
          </form>
          <button type="button" disabled={busy} onClick={() => void post({ action: "submit" })}>
            Submit request
          </button>
        </section>
      )}
      <section>
        <h2>Request details</h2>
        {data.lines.map((l, i) => (
          <p key={l.id}>
            Line {i + 1} · {amount(l.amount)} ·{" "}
            {config.categories.find((c) => c.id === l.category_id)?.name} ·{" "}
            {l.spent_on.slice(0, 10)}
          </p>
        ))}
        {data.values.map((v) => (
          <p key={v.field_id}>
            {config.fields.find((f) => f.id === v.field_id)?.name}: {v.value}
          </p>
        ))}
      </section>
      <section>
        <h2>Receipts</h2>
        <p>PDF, PNG or JPEG, up to 5 MB each. File storage must be switched on.</p>
        {data.receipts.map((f) => (
          <p key={f.id}>
            <a href={`/api/receipts/${f.id}`}>{f.name}</a>
          </p>
        ))}
        {editable && (
          <label>
            Upload receipt
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setBusy(true);
                try {
                  const response = await fetch(
                    `/api/receipts?request=${id}&name=${encodeURIComponent(file.name)}`,
                    { method: "POST", body: file },
                  );
                  const result = await response.json();
                  if (!response.ok) throw Error(result.error);
                  setMessage(result.message);
                  reload();
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        )}
      </section>
      <section>
        <h2>Approval steps</h2>
        {!data.steps.length && <p>No route yet. Submit the request to begin.</p>}
        {data.steps.map((s) => (
          <p key={s.id}>
            Round {s.round}, step {s.position} · {s.email} · {s.decision ?? "Waiting"}{" "}
            {s.reason && `· ${s.reason}`}
          </p>
        ))}
        {r.phase === "pending" &&
          next?.approver_id === data.user.id &&
          r.submitter_id !== data.user.id && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void post({ action: "decide", decision: "approve" })}
              >
                Approve
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void post({
                    action: "decide",
                    decision: f.get("decision"),
                    reason: f.get("reason"),
                  });
                }}
              >
                <label>
                  Decision
                  <select aria-label="Decision" name="decision">
                    <option value="changes">Send back for changes</option>
                    <option value="reject">Reject</option>
                  </select>
                </label>
                <label>
                  Reason
                  <textarea name="reason" required maxLength={2000} />
                </label>
                <button type="submit" disabled={busy}>
                  Record decision
                </button>
              </form>
            </>
          )}
        {data.user.role === "finance" && r.kind === "expense" && r.phase === "approved" && (
          <button type="button" disabled={busy} onClick={() => void post({ action: "paid" })}>
            Mark paid
          </button>
        )}
      </section>
      <section>
        <h2>Comments</h2>
        {data.comments.map((c) => (
          <p key={c.id}>{c.body}</p>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void post({ action: "comment", body: f.get("body") });
          }}
        >
          <label>
            Comment
            <textarea name="body" required maxLength={4000} />
          </label>
          <button type="submit" disabled={busy}>
            Add comment
          </button>
        </form>
      </section>
      <section>
        <h2>History</h2>
        {data.audit.map((a) => (
          <p key={a.id}>
            {a.event} · {a.actor} · {new Date(a.created_at).toLocaleString()}
          </p>
        ))}
      </section>
    </main>
  );
}
