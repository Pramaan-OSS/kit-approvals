import { viewer } from "../../../lib/approvals/access";
import { exportExpenses } from "../../../lib/approvals/data";
import { handle } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(
    async () =>
      new Response(await exportExpenses(await viewer(request)), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="approved-expenses.csv"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      }),
  );
}
