import { AccountError } from "../../../lib/accounts";
import { ownerOnly, viewer } from "../../../lib/approvals/access";
import { parseCsv } from "../../../lib/approvals/csv";
import { deliver, settings, snapshot } from "../../../lib/approvals/data";
import { createInvite, unclaimed } from "../../../lib/approvals/invites";
import { email } from "../../../lib/approvals/words";
import { emailDoor } from "../../../lib/email";
import { handle, readBody, reply } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const user = await viewer(request);
    ownerOnly(user);
    return reply(await snapshot(user));
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const user = await viewer(request);
    ownerOnly(user);
    const input = await readBody(request);
    if (input.action === "retry-email") return reply({ message: await deliver() });
    const origin = process.env.APP_ORIGIN ?? new URL(request.url).origin;
    if (input.action === "invite") {
      const role = input.role;
      if (role !== "employee" && role !== "approver" && role !== "finance")
        throw new AccountError(400, "Choose an invited role.");
      return reply(
        await createInvite(
          emailDoor,
          { email: input.email, role, invitedBy: user.id },
          origin,
          "Requests and approvals",
        ),
      );
    }
    if (input.action === "import") {
      const addresses = parseCsv(input.csv).map((r) => email(r[0]));
      if (new Set(addresses).size !== addresses.length)
        throw new AccountError(400, "Each email must appear once.");
      for (const address of addresses) await unclaimed(address);
      const invites = [];
      for (const address of addresses)
        invites.push(
          await createInvite(
            emailDoor,
            { email: address, role: "employee", invitedBy: user.id },
            origin,
            "Requests and approvals",
          ),
        );
      return reply({
        message: `Imported ${invites.length} employees. They must accept their invites to sign in.`,
        invites,
      });
    }
    return reply(await settings(user, input));
  });
}
