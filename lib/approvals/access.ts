import { AccountError, type User } from "../accounts";
import { accountRuntime } from "../runtime";
export async function viewer(request: Request) {
  const user = await accountRuntime().requireUser(request);
  if (!["owner", "employee", "approver", "finance"].includes(user.role))
    throw new AccountError(403, "This account has no access to requests.");
  return user;
}
export function ownerOnly(user: User) {
  if (user.role !== "owner") throw new AccountError(403, "Only the owner can do this.");
}
export const SCOPE = `(r.submitter_id=$1 OR $2='owner' OR ($2='approver' AND EXISTS(SELECT 1 FROM approval_steps s WHERE s.request_id=r.id AND s.approver_id=$1)) OR ($2='finance' AND t.kind='expense' AND r.phase IN ('approved','paid')))`;
