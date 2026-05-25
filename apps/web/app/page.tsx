const quickStart = `git clone https://github.com/fedster99/supamail
cd supamail
cp .env.example .env.local
pnpm install
pnpm migrate
pnpm dev`;

const tables = [
  ["imap_accounts", "credentials, policy, and health"],
  ["imap_folders", "folder state, cursors, and UIDVALIDITY"],
  ["imap_messages", "headers, flags, provider state, and metadata"],
  ["imap_message_bodies", "raw MIME plus parsed text and HTML"],
  ["imap_attachments", "attachment and inline-part metadata"],
  ["imap_sync_runs", "sync attempts, timing, and outcomes"],
  ["imap_sync_events", "folder, message, reconcile, and health events"]
];

const guarantees = [
  "Folder-scoped message identity",
  "Session-affine advisory locks",
  "Resumable initial sync",
  "Budgeted reconcile and flag scans",
  "MIME bodies behind account locks",
  "Durable sync health"
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
              Self-host a Node worker and API that mirrors folders, messages, flags, MIME bodies,
              attachments, sync runs, and health into Postgres.
            </p>
            <div className="actions">
              <a className="button primary" href="#quickstart">
                Start self-hosting
              </a>
              <a className="button secondary" href="https://github.com/fedster99/supamail">
                View GitHub
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
            <p className="eyebrow">where it fits</p>
            <h2>IMAP sync, already handled.</h2>
          </div>
          <p>
            SupaMail handles cursors, UIDVALIDITY resets, provider deletes, MIME parsing, retries,
            and health. Your app reads ordinary tables.
          </p>
        </div>
      </section>

      <section id="quickstart" className="wrap section">
        <div className="section-head">
          <p className="eyebrow">quickstart</p>
          <h2>Bring Postgres and IMAP credentials.</h2>
          <p>
            Use a session-affine Postgres connection, apply the migrations, and add a mailbox.
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
            Migrations create mirror tables for accounts, folders, messages, bodies, attachments,
            runs, events, and progress.
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
            Postgres is the source of truth. IMAP work is serialized per account.
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
          <p className="eyebrow">deployment</p>
          <h2>Deploy with session-affine Postgres.</h2>
          <p>
            Use Supabase and Fly.io, or any Node 24 host with a long-lived worker. Avoid
            transaction poolers; advisory locks need session affinity.
          </p>
        </div>
        <div className="cta-actions">
          <a className="button primary" href="https://github.com/fedster99/supamail">
            View GitHub
          </a>
          <a
            className="button secondary"
            href="https://github.com/fedster99/supamail/blob/main/docs/fly-supabase.md"
          >
            Read deploy docs
          </a>
        </div>
      </section>
    </main>
  );
}
