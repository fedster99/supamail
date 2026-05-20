import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SupaMail · IMAP sync for Supabase",
  description:
    "Point it at any IMAP mailbox. Every message lands in Postgres so you can query email like any other table."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Sans:wght@400;500;600;700&family=Caveat:wght@400;500;600;700&family=Newsreader:ital,wght@0,400;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
