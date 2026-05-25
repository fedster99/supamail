import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SupaMail OSS | IMAP mirror for Supabase",
  description:
    "Open-source IMAP sync that mirrors folders, messages, flags, MIME bodies, and sync health into Supabase/Postgres."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Instrument+Serif&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
