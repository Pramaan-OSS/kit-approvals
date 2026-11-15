import { AccountError } from "../../../lib/accounts";
import { viewer } from "../../../lib/approvals/access";
import {
  comment,
  decide,
  deliver,
  detail,
  paid,
  saveRequest,
  snapshot,
  submit,
} from "../../../lib/approvals/data";
import { handle, readBody, reply } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const user = await viewer(request);
    const id = new URL(request.url).searchParams.get("id");
    return reply(id ? await detail(user, id) : await snapshot(user));
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const user = await viewer(request),
      input = await readBody(request);
    const work =
      input.action === "save"
        ? saveRequest
        : input.action === "submit"
          ? submit
          : input.action === "decide"
            ? decide
            : input.action === "paid"
              ? paid
              : input.action === "comment"
                ? comment
                : null;
    if (!work) throw new AccountError(400, "Choose a request action.");
    const result = await work(user, input);
    return reply({ ...result, message: await deliver() });
  });
}
