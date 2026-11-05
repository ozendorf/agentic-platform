import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic Platform",
  description: "Build and run durable agentic workflows (local)",
};

const TEMPORAL_UI = process.env.TEMPORAL_UI_URL ?? "http://localhost:8080";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
            <Link href="/workflows" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-accent-fg text-sm">A</span>
              Agentic Platform
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">local</span>
            </Link>
            <nav className="flex gap-4 text-sm text-muted">
              <Link href="/workflows" className="hover:text-text">Workflows</Link>
              <Link href="/catalog" className="hover:text-text">Catalog</Link>
              <Link href="/runs" className="hover:text-text">Runs</Link>
            </nav>
            <a href={TEMPORAL_UI} target="_blank" rel="noreferrer" className="ml-auto text-sm text-muted hover:text-text">
              Temporal UI ↗
            </a>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
