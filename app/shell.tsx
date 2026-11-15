"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useResource } from "../lib/pramaan/client";
export type User = { id: string; email: string | null; role: string };
export function Shell({ children }: { children: ReactNode }) {
  const { data } = useResource<{ user: User }>("/api/account/session");
  return (
    <>
      <header>
        <nav aria-label="Main">
          <Link href="/">Requests and approvals</Link>
          {data?.user && <Link href="/requests">Requests</Link>}
          {data?.user?.role === "owner" && (
            <>
              <Link href="/settings">Approval settings</Link>
              <Link href="/owner">Owner settings</Link>
            </>
          )}
        </nav>
      </header>
      {children}
    </>
  );
}
