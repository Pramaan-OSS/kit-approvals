import { randomUUID } from "node:crypto";
import { AccountError } from "../../../lib/accounts";
import { viewer } from "../../../lib/approvals/access";
import { audit, scoped, transaction } from "../../../lib/approvals/data";
import { storage } from "../../../lib/approvals/storage";
import { text } from "../../../lib/approvals/words";
import { handle, reply } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handle(async () => {
    const user = await viewer(request),
      url = new URL(request.url);
    if (request.headers.get("origin") !== (process.env.APP_ORIGIN ?? url.origin))
      throw new AccountError(403, "Refresh this page and try again.");
    // Authorize before reading bytes or touching the file module.
    return transaction(async (tx) => {
      const r = await scoped(tx, user, url.searchParams.get("request"), true);
      if (r.submitter_id !== user.id || !["draft", "changes"].includes(r.phase))
        throw new AccountError(403, "Add receipts only to your draft or returned request.");
      const count = await tx.query(
        "SELECT count(*)::int AS n FROM approval_receipts WHERE request_id=$1",
        [r.id],
      );
      if (count.rows[0].n >= 20)
        throw new AccountError(400, "Keep at most twenty receipts per request.");
      const name = text(url.searchParams.get("name"), "a file name", 120);
      if (!/^[\p{L}\p{N} ._()-]+\.(pdf|png|jpe?g)$/iu.test(name))
        throw new AccountError(400, "Use a PDF, PNG or JPEG file name.");
      const reader = request.body?.getReader();
      if (!reader) throw new AccountError(400, "Choose a receipt.");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 5 * 1024 * 1024) {
            await reader.cancel();
            throw new AccountError(413, "Receipts must be at most 5 MB.");
          }
          parts.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      if (!size) throw new AccountError(400, "Choose a nonempty receipt.");
      const receipt = randomUUID(),
        stored = await storage("PUT", `approvals/${receipt}`, Buffer.concat(parts));
      if (!stored.ok) throw new AccountError(503, stored.message);
      await tx.query("INSERT INTO approval_receipts(id,request_id,name) VALUES($1,$2,$3)", [
        receipt,
        r.id,
        name,
      ]);
      await audit(tx, r.id, user, "Receipt added");
      return reply({ message: "Receipt uploaded." }, 201);
    });
  });
}
