import { AccountError } from "../../../../lib/accounts";
import { viewer } from "../../../../lib/approvals/access";
import { scoped, transaction } from "../../../../lib/approvals/data";
import { storage } from "../../../../lib/approvals/storage";
import { id } from "../../../../lib/approvals/words";
import { handle } from "../../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await viewer(request),
      receiptId = id((await context.params).id);
    const receipt = await transaction(async (tx) => {
      const row = (await tx.query("SELECT * FROM approval_receipts WHERE id=$1", [receiptId]))
        .rows[0];
      if (!row) throw new AccountError(404, "That receipt couldn't be found.");
      await scoped(tx, user, row.request_id);
      return row;
    });
    const stored = await storage("GET", `approvals/${receipt.id}`);
    if (!stored.ok) throw new AccountError(503, stored.message);
    return new Response(new Uint8Array(stored.body), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(receipt.name)}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
