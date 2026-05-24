const quickStart = `git clone https://github.com/fedster99/supamail
cd supamail
cp .env.example .env.local
pnpm install
pnpm migrate
pnpm dev`;

const tables = [
  ["imap_accounts", "mailbox configuration, encrypted IMAP credentials, sync health"],
  ["imap_folders", "folder paths, UIDVALIDITY, cursors, discovery state"],
  ["imap_messages", "folder-scoped message rows, flags, headers, provider state"],
  ["imap_message_bodies", "raw RFC822, parsed text/html, MIME parser output"],
  ["imap_attachments", "attachment metadata from message structure"],
  ["sync_runs", "durable sync attempts, errors, timing, and outcomes"]
];

const guarantees = [
  "Folder-scoped identity: account, folder path, UIDVALIDITY, UID",
  "Session-affine Postgres advisory locks for account work",
  "UIDVALIDITY reset handling and resumable initial sync",
  "Due-based reconcile and flag scans with bounded per-cycle work",
  "Full MIME body fetch behind the same account lock",
  "Sync health stored in Postgres, not hidden in process memory"
];

export default function HomePage() {
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="SupaMail home">
          <span className="brand-mark">~</span>
          <span>SupaMail</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#quickstart">Quickstart</a>
          <a href="#schema">Schema</a>
          <a href="#reliability">Reliability</a>
          <a href="https://github.com/fedster99/supamail">GitHub</a>
        </nav>
      </header>

      <section id="top" className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">open-source IMAP mirror for Postgres</p>
            <h1>Sync mailboxes into your Supabase database.</h1>
            <p className="lede">
              SupaMail is the public core: a Node worker and API that mirrors IMAP folders,
              messages, flags, MIME bodies, attachment metadata, sync runs, and health into
              Postgres tables you own.
            </p>
            <div className="actions">
              <a className="button primary" href="#quickstart">
                Start self-hosting
              </a>
              <a className="button secondary" href="https://supamail-cloud.vercel.app">
                Hosted BYO Supabase
              </a>
            </div>
          </div>

          <div className="terminal" aria-label="SupaMail sync terminal output">
            <div className="terminal-bar">
              <span />
              <span />
              <span />
            </div>
            <pre>{`supamail worker
mode=combined
db=postgres session pooler

sync account: ops@example.com
lock acquired: account 01HY...
folders discovered: inbox, sent, archive
messages mirrored: 184,203
health: healthy`}</pre>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="wrap split">
          <div>
            <p className="eyebrow">what this repo owns</p>
            <h2>Mailbox mirror core. Not the hosted SaaS.</h2>
          </div>
          <p>
            This repository stays focused on sync reliability and self-hosting. Billing, signup,
            dashboards, Supabase OAuth onboarding, and managed cloud operations live outside the
            public core.
          </p>
        </div>
      </section>

      <section id="quickstart" className="wrap section">
        <div className="section-head">
          <p className="eyebrow">quickstart</p>
          <h2>Bring Postgres, Supabase, and IMAP credentials.</h2>
          <p>
            SupaMail runs as a worker, API, or combined process. Point it at a session-affine
            Postgres connection, apply the public migrations, and configure a mailbox.
          </p>
        </div>

        <div className="code-block">
          <pre>{quickStart}</pre>
        </div>
      </section>

      <section id="schema" className="wrap section">
        <div className="section-head">
          <p className="eyebrow">public schema</p>
          <h2>Email becomes queryable rows.</h2>
          <p>
            The public migration installs only mirror tables. Hosted control-plane tables never
            belong in a customer database.
          </p>
        </div>

        <div className="schema-list">
          {tables.map(([name, description]) => (
            <div className="schema-row" key={name}>
              <code>{name}</code>
              <span>{description}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="reliability" className="wrap section">
        <div className="section-head">
          <p className="eyebrow">reliability contract</p>
          <h2>Built around the parts of IMAP that usually break.</h2>
          <p>
            The sync engine treats Postgres as the source of truth for mirrored state and keeps IMAP
            provider work serialized per account.
          </p>
        </div>

        <div className="guarantees">
          {guarantees.map((item) => (
            <div className="guarantee" key={item}>
              <span className="check">+</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="wrap section cta">
        <div>
          <p className="eyebrow">deployment paths</p>
          <h2>Self-host the core, or use the hosted wrapper.</h2>
          <p>
            The same public sync engine powers both. Self-hosters own their infra. Hosted BYO
            Supabase users bring a mirror target and let SupaMail Cloud run sync/API/MCP around it.
          </p>
        </div>
        <div className="cta-actions">
          <a className="button primary" href="https://github.com/fedster99/supamail">
            View GitHub
          </a>
          <a className="button secondary" href="https://supamail-cloud.vercel.app">
            Open hosted site
          </a>
        </div>
      </section>
    </main>
  );
}
