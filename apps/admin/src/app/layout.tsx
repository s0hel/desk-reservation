import type { Metadata } from "next";

import { SignOutButton } from "@/components/SignOutButton";
import { getIdentity } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: "Deskflow admin",
  description: "Sites, floors and the floor plan editor",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const identity = await getIdentity();

  return (
    <html lang="en">
      <body>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--panel)",
          }}
        >
          <a href="/" style={{ color: "var(--text)", fontWeight: 700 }}>
            Deskflow
          </a>
          <span className="pill">admin</span>
          <div className="spacer" />
          {identity ? (
            <>
              <span className="muted small">{identity.email}</span>
              <SignOutButton />
            </>
          ) : null}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
