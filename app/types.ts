import type { User } from "./shell";
export type Named = {
  id: string;
  name: string;
  kind?: string;
  phase?: string;
  type_id?: string;
  required?: boolean;
};
export type RequestRow = {
  id: string;
  title: string;
  type_id: string;
  type_name: string;
  submitter_id: string;
  submitter_email: string;
  status_name: string;
  phase: string;
  kind: string;
  total: string;
  round: number;
  leave_year: number | null;
  leave_days: number | null;
};
export type Snapshot = {
  user: User;
  requests: RequestRow[];
  types: Named[];
  fields: Named[];
  categories: Named[];
  statuses: Named[];
  users: User[];
  rules: { type_id: string; threshold: string; first_id: string; second_id: string | null }[];
  balances: { user_id: string; email: string; year: number; days: number }[];
};
export type Detail = {
  user: User;
  request: RequestRow;
  lines: { id: string; amount: number; spent_on: string; category_id: string }[];
  values: { field_id: string; value: string }[];
  receipts: { id: string; name: string }[];
  steps: {
    id: string;
    round: number;
    position: number;
    approver_id: string;
    email: string;
    decision: string | null;
    reason: string | null;
  }[];
  comments: { id: string; body: string }[];
  audit: { id: string; event: string; actor: string; created_at: string }[];
};
export const amount = (cents: string | number) => (Number(cents) / 100).toFixed(2);
