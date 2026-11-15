import { AccountError } from "../accounts";
export function parseCsv(source: unknown) {
  if (typeof source !== "string" || source.length > 12000)
    throw new AccountError(400, "Import a CSV file up to 12,000 characters.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let n = 0; n < source.length; n++) {
    const c = source[n];
    if (c === '"') {
      if (quoted && source[n + 1] === '"') {
        cell += '"';
        n++;
      } else if (!quoted && cell !== "") throw new AccountError(400, "Check CSV quotes.");
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.replace(/\r$/u, ""));
      cell = "";
      if (c === "\n") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new AccountError(400, "Close the CSV quotes.");
  row.push(cell.replace(/\r$/u, ""));
  if (row.some(Boolean)) rows.push(row);
  const header = rows.shift();
  if (header?.join(",") !== "email")
    throw new AccountError(400, "Use the employee CSV header shown on this page.");
  if (!rows.length || rows.length > 50 || rows.some((r) => r.length !== 1))
    throw new AccountError(400, "Import one to fifty complete employee rows.");
  return rows;
}
