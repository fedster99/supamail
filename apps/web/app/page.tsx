import StatusTicker from "./components/StatusTicker";

export default function HomePage() {
  return (
    <>
      <div className="topbar">
        <div className="wrap topbar-inner">
          <a className="brand" href="#">
            <div className="brand-mark">~</div>
            <div className="brand-name">supamail</div>
          </a>
          <div className="top-links">
            <a href="#schema">Query it</a>
            <a href="#how">How it works</a>
            <a href="#hosted">Hosted</a>
            <a href="#faq">FAQ</a>
            <a className="top-cta" href="/login">
              <span className="star">★</span>
              <span>Sign in</span>
            </a>
          </div>
        </div>
      </div>

      <header className="hero">
        <div className="wrap">
          <div className="kicker">
            <span className="dot" />
            <span>v0.4.2 · last pushed 3 days ago · MIT</span>
          </div>

          <h1 className="hero-title">
            Email sync, <span className="ital">straight into</span>
            <br />
            your <span className="green">Supabase</span>.
          </h1>

          <p className="hero-sub">
            Point it at any IMAP mailbox. Every message lands in Postgres so you can query email
            like any other table.
          </p>

          <aside className="sticky-note">
            <p className="l1">wanted AI agents</p>
            <p className="l2">in my inbox, but</p>
            <p className="l3">it&apos;s all Gmail/Outlook.</p>
            <p className="l4">we&apos;re not. so I made this.</p>
          </aside>

          <div className="hero-cta-row">
            <a className="btn btn-primary" href="#install">
              <span>Read the README</span>
              <span className="arr">→</span>
            </a>
            <a className="btn btn-ghost" href="#schema">
              <span>See it in SQL</span>
            </a>
          </div>

          <StatusTicker />
        </div>
      </header>

      <section id="why">
        <div className="wrap">
          <p className="sec-tag">// why this exists</p>
          <h2 className="sec-title">
            Every AI email tool integrates with Gmail. Mine was on <em>Rackspace</em>.
          </h2>
          <p className="sec-lede">
            Building IMAP sync from scratch sucks. I know because I tried. UID cursors. UIDVALIDITY
            resets. MIME parsing. Provider quirks. Each one is a small fire.
          </p>
          <p className="sec-lede">
            So SupaMail does it once, properly. You query email like any other table.
          </p>

          <div className="pain-list">
            <div className="pain">
              <h4>UID cursors &amp; UIDVALIDITY</h4>
              <p>
                Folder state, UID cursors, UIDVALIDITY resets. Account-level advisory locks keep
                sync serialized so two workers don&apos;t fight.
              </p>
            </div>
            <div className="pain">
              <h4>Reconciliation, not guessing</h4>
              <p>
                Catches gaps and provider deletes. Missing messages don&apos;t silently become
                permanent.
              </p>
            </div>
            <div className="pain">
              <h4>Full MIME, parsed</h4>
              <p>
                Raw RFC822 plus parsed text, HTML, headers, structure, and parser warnings.
                Attachment metadata too.
                <a className="fn-ref" href="#fn-1">
                  1
                </a>
              </p>
            </div>
            <div className="pain">
              <h4>Sync health is just rows</h4>
              <p>
                Lag, retries, backoff, last error. <code>select</code> from <code>imap_accounts</code>{" "}
                to see what&apos;s broken.
                <a className="fn-ref" href="#fn-2">
                  2
                </a>
              </p>
            </div>
          </div>

          <ol className="fn-list">
            <li>
              <span className="num">1</span>
              <span id="fn-1">
                Rackspace caps IMAP connections at five per IP. Took me a weekend to figure out why
                sync was randomly stalling.
              </span>
            </li>
            <li>
              <span className="num">2</span>
              <span id="fn-2">
                There&apos;s a{" "}
                <code style={{ background: "none", border: "none", padding: 0 }}>sync_runs</code>{" "}
                table too, if you want event-level detail.
              </span>
            </li>
          </ol>
        </div>
      </section>

      <section id="schema">
        <div className="wrap">
          <p className="sec-tag">// query it</p>
          <h2 className="sec-title">
            What it looks like in <em>SQL</em>.
          </h2>
          <p className="sec-lede">
            Once your email is in Postgres, you can do anything with it. Agents, search, dashboards,
            alerts. Here are the queries I actually run.
          </p>

          <div className="codecard">
            <div className="codecard-head">
              <span className="br">~/supamail</span> <span className="pr">(main)</span>{" "}
              <span className="pr">$</span>{" "}
              <span className="cmd">psql $DATABASE_URL -f queries/recent.sql</span>
            </div>
            <pre>
              <span className="com">{`-- recent messages`}</span>
              {"\n"}
              <span className="kw">select</span> m.internal_date, m.from_email, m.subject, m.flags
              {"\n"}
              <span className="kw">from</span> imap_messages m{"\n"}
              <span className="kw">where</span> m.deleted_in_provider ={" "}
              <span className="kw">false</span>
              {"\n"}
              <span className="kw">order by</span> m.internal_date <span className="kw">desc</span>
              {"\n"}
              <span className="kw">limit</span> <span className="num">50</span>;{"\n\n"}
              <span className="com">{`-- full body when you need it`}</span>
              {"\n"}
              <span className="kw">select</span> m.subject, b.body_text, b.body_html, b.raw_bytes
              {"\n"}
              <span className="kw">from</span> imap_messages m{"\n"}
              <span className="kw">join</span> imap_message_bodies b{" "}
              <span className="kw">on</span> b.message_id = m.id{"\n"}
              <span className="kw">where</span> m.id = <span className="str">{"'…'"}</span>;{"\n\n"}
              <span className="com">{`-- sync health`}</span>
              {"\n"}
              <span className="kw">select</span> email_address, sync_state, sync_state_reason,{"\n"}
              {"       "}priority_sync_lag_seconds, overall_sync_lag_seconds{"\n"}
              <span className="kw">from</span> imap_accounts;
            </pre>
          </div>

          <div className="schema-viz" aria-hidden="true">
            <div className="legend">
              <span>
                <b>●</b>pk
              </span>
              <span>
                <b>↗</b>fk
              </span>
            </div>

            <div className="schema-canvas">
              <svg className="schema-lines" viewBox="0 0 760 420" preserveAspectRatio="none">
                <path d="M 380 50 L 380 138" />
                <path d="M 90 138 L 670 138" />
                <path d="M 90 138 L 90 160" />
                <path d="M 380 138 L 380 160" />
                <path d="M 670 138 L 670 160" />
                <path d="M 380 295 L 380 312" />
                <path d="M 263 312 L 497 312" />
                <path d="M 263 312 L 263 324" />
                <path d="M 497 312 L 497 324" />
                <circle className="nub" cx="380" cy="50" r="2.2" />
                <circle className="nub" cx="90" cy="160" r="2.2" />
                <circle className="nub" cx="380" cy="160" r="2.2" />
                <circle className="nub" cx="670" cy="160" r="2.2" />
                <circle className="nub" cx="380" cy="295" r="2.2" />
                <circle className="nub" cx="263" cy="324" r="2.2" />
                <circle className="nub" cx="497" cy="324" r="2.2" />
              </svg>

              <div className="tbl t-accounts">
                <div className="tbl-head">
                  <span>imap_accounts</span>
                  <span className="rows">3 rows</span>
                </div>
                <div className="tbl-cols">
                  <div className="col pk">
                    <span>id</span>
                    <span className="ty">uuid</span>
                  </div>
                  <div className="col">
                    <span>email_address</span>
                    <span className="ty">text</span>
                  </div>
                  <div className="col">
                    <span>sync_state</span>
                    <span className="ty">text</span>
                  </div>
                </div>
              </div>

              <div className="tbl t-folders">
                <div className="tbl-head">
                  <span>imap_folders</span>
                  <span className="rows">17</span>
                </div>
                <div className="tbl-cols">
                  <div className="col pk">
                    <span>id</span>
                  </div>
                  <div className="col fk">
                    <span>account_id</span>
                  </div>
                  <div className="col">
                    <span>path</span>
                  </div>
                </div>
              </div>

              <div className="tbl t-messages">
                <div className="tbl-head">
                  <span>imap_messages</span>
                  <span className="rows">184k</span>
                </div>
                <div className="tbl-cols">
                  <div className="col pk">
                    <span>id</span>
                  </div>
                  <div className="col fk">
                    <span>folder_id</span>
                  </div>
                  <div className="col">
                    <span>subject</span>
                    <span className="ty">text</span>
                  </div>
                  <div className="col">
                    <span>internal_date</span>
                    <span className="ty">timestamptz</span>
                  </div>
                </div>
              </div>

              <div className="tbl t-runs">
                <div className="tbl-head">
                  <span>imap_sync_runs</span>
                  <span className="rows">412</span>
                </div>
                <div className="tbl-cols">
                  <div className="col pk">
                    <span>id</span>
                  </div>
                  <div className="col fk">
                    <span>account_id</span>
                  </div>
                  <div className="col">
                    <span>events</span>
                    <span className="ty">jsonb</span>
                  </div>
                </div>
              </div>

              <div className="tbl t-bodies">
                <div className="tbl-head">
                  <span>imap_message_bodies</span>
                  <span className="rows">184k</span>
                </div>
                <div className="tbl-cols">
                  <div className="col fk">
                    <span>message_id</span>
                  </div>
                  <div className="col">
                    <span>body_text</span>
                    <span className="ty">text</span>
                  </div>
                  <div className="col">
                    <span>body_html</span>
                    <span className="ty">text</span>
                  </div>
                </div>
              </div>

              <div className="tbl t-attach">
                <div className="tbl-head">
                  <span>imap_attachments</span>
                  <span className="rows">3.2k</span>
                </div>
                <div className="tbl-cols">
                  <div className="col fk">
                    <span>message_id</span>
                  </div>
                  <div className="col">
                    <span>filename</span>
                    <span className="ty">text</span>
                  </div>
                  <div className="col">
                    <span>size_bytes</span>
                    <span className="ty">bigint</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how">
        <div className="wrap">
          <p className="sec-tag">// how it works</p>
          <h2 className="sec-title">Setting it up.</h2>
          <p className="sec-lede">
            Supabase hosts the database. Fly runs the worker. Your app reads from its own tables.
          </p>

          <div className="steps">
            <div className="step">
              <div className="step-num">
                <b>01</b>
              </div>
              <div className="step-body">
                <h3 className="step-title">Apply the schema</h3>
                <p>
                  One migration file. Use the direct or session-pooled Postgres URL. The transaction
                  pooler won&apos;t work because SupaMail uses advisory locks.
                </p>
              </div>
              <div className="term">
                <span className="pr">$</span> psql <span className="dim">&quot;$DATABASE_URL&quot;</span>{" "}
                -f \<br />
                <span className="dim">
                  {"    "}supabase/migrations/0001_imap_mirror.sql
                </span>
                <br />
                <span className="ok">✓</span> schema applied
              </div>
            </div>

            <div className="step">
              <div className="step-num">
                <b>02</b>
              </div>
              <div className="step-body">
                <h3 className="step-title">Deploy the worker</h3>
                <p>
                  One <code>fly.worker.toml</code>. Or run it on Render, Coolify, Docker Compose, or
                  your own box. Examples in the repo.
                </p>
              </div>
              <div className="term">
                <span className="dim">DATABASE_URL=postgresql://…</span>
                <br />
                <span className="dim">IMAP_ENCRYPTION_KEY=…</span>
                <br />
                <span className="dim">API_TOKEN=…</span>
                <br />
                <span className="dim">BODY_FETCH_POLICY=priority_then_backfill</span>
                <br />
                <span className="ok">✓</span> worker online
              </div>
            </div>

            <div className="step">
              <div className="step-num">
                <b>03</b>
              </div>
              <div className="step-body">
                <h3 className="step-title">Add a mailbox</h3>
                <p>
                  One CLI command. The worker picks it up and starts syncing in a few seconds.
                </p>
              </div>
              <div className="term">
                <span className="pr">$</span> pnpm exec supamail create-account \<br />
                <span className="dim">{"    "}--email alice@example.com \</span>
                <br />
                <span className="dim">{"    "}--host imap.example.com \</span>
                <br />
                <span className="dim">{"    "}--profile generic-imap</span>
                <br />
                <span className="ok">✓</span> syncing
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="faq">
        <div className="wrap">
          <p className="sec-tag">// faq</p>
          <h2 className="sec-title">Stuff people ask.</h2>

          <div className="faq">
            <details open>
              <summary>
                Why not just use the Gmail API? <span className="plus">+</span>
              </summary>
              <div className="ans">
                Because plenty of inboxes aren&apos;t on Gmail. Mine was on Rackspace. Yours might
                be on Fastmail, Zoho, iCloud, or whatever your enterprise customer is stuck with.
                SupaMail talks plain IMAP, so it works with all of them.
              </div>
            </details>
            <details>
              <summary>
                Why advisory locks? Why not the transaction pooler? <span className="plus">+</span>
              </summary>
              <div className="ans">
                Account-level advisory locks keep sync operations serialized so two workers
                can&apos;t fight over the same mailbox. They need session affinity, which the
                transaction pooler doesn&apos;t give you. Use the direct Supabase Postgres URL or
                session pooling.
              </div>
            </details>
            <details>
              <summary>
                Does it download attachments? <span className="plus">+</span>
              </summary>
              <div className="ans">
                No. Metadata only by default: filename, MIME type, size, part numbers, content IDs,
                and an optional storage key for when you want to wire up your own bucket.
              </div>
            </details>
            <details>
              <summary>
                <span>
                  What&apos;s <code>BODY_FETCH_POLICY</code>?
                </span>{" "}
                <span className="plus">+</span>
              </summary>
              <div className="ans">
                <code>immediate</code> fetches every body during sync. <code>lazy</code> fetches
                only on demand. <code>priority_then_backfill</code> (the default) fetches INBOX and
                Sent during normal sync, then backfills the rest later. Use this one unless you
                have a reason not to.
              </div>
            </details>
            <details>
              <summary>
                Does it send mail too? <span className="plus">+</span>
              </summary>
              <div className="ans">
                No. SupaMail syncs incoming email. Sending is SMTP, which is a different problem
                with its own demons. Maybe later.
              </div>
            </details>
            <details>
              <summary>
                Is it production-ready? <span className="plus">+</span>
              </summary>
              <div className="ans">
                I run it for my own product. It handles a few hundred thousand messages without
                complaining. That said, it&apos;s v0.4.2 and there are sharp edges (see below).
                File issues, I read them.
              </div>
            </details>
          </div>
        </div>
      </section>

      <section id="rough">
        <div className="wrap">
          <p className="sec-tag">// rough edges</p>
          <h2 className="sec-title">What&apos;s flaky right now.</h2>
          <p className="sec-lede">Being honest, since you&apos;re going to find these anyway:</p>

          <ul className="rough-list">
            <li>
              <span className="label">exchange-imap</span>
              <span className="desc">
                Works on the two Exchange mailboxes I tested. I don&apos;t have a real corporate
                one to bash against. PRs welcome.
              </span>
            </li>
            <li>
              <span className="label">gmail [all-mail]</span>
              <span className="desc">
                Gmail&apos;s <code>[Gmail]/All Mail</code> can surface duplicates if you also sync
                labeled folders. The default profile skips it. There&apos;s a flag if you want
                both.
              </span>
            </li>
            <li>
              <span className="label">initial-sync</span>
              <span className="desc">
                Mailboxes north of 500k messages take hours on first sync. It resumes after
                restarts, but it isn&apos;t fast. Working on it.
              </span>
            </li>
            <li>
              <span className="label">no-web-ui</span>
              <span className="desc">
                There isn&apos;t one. You add accounts via the CLI or by inserting rows. A small
                admin UI is on the list but very low priority.
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section id="install">
        <div className="wrap">
          <p className="sec-tag">// install</p>
          <h2 className="sec-title">Run it locally.</h2>
          <p className="sec-lede">
            Clone, install, point at a local Postgres. The full deploy story is in the README.
          </p>

          <div className="codecard">
            <div className="codecard-head">
              <span className="br">~/code</span> <span className="pr">$</span>{" "}
              <span className="cmd">git clone github.com/fedster99/supamail &amp;&amp; cd supamail</span>
            </div>
            <pre>
              <span className="com">{`# clone, install, migrate`}</span>
              {"\n"}
              <span style={{ color: "var(--accent)" }}>$</span> pnpm install &amp;&amp; pnpm migrate
              {"\n\n"}
              <span className="com">{`# add an account`}</span>
              {"\n"}
              <span style={{ color: "var(--accent)" }}>$</span> pnpm exec supamail create-account \
              {"\n"}
              {"    "}--email alice@example.com \{"\n"}
              {"    "}--host imap.example.com --port 993 \{"\n"}
              {"    "}--username alice@example.com \{"\n"}
              {"    "}--password <span className="str">&quot;$IMAP_PASSWORD&quot;</span> \{"\n"}
              {"    "}--profile generic-imap{"\n\n"}
              <span className="com">{`# start the worker (or pnpm start:api for the HTTP API)`}</span>
              {"\n"}
              <span style={{ color: "var(--accent)" }}>$</span> pnpm build &amp;&amp; pnpm start:worker
            </pre>
          </div>

          <div className="hero-cta-row install-cta">
            <a className="btn btn-primary" href="https://github.com/fedster99/supamail">
              <span>github.com/fedster99/supamail</span>
              <span className="arr">→</span>
            </a>
          </div>
        </div>
      </section>

      <section id="hosted">
        <div className="wrap">
          <p className="sec-tag">// or don&apos;t</p>
          <h2 className="sec-title">
            Or pay me <em>$5</em> and I&apos;ll do all that for you.
          </h2>
          <p className="sec-lede">
            Same code. Same schema. Data still lands in <em>your</em> Supabase. The only thing
            different is I run the worker.
          </p>

          <div className="hosted-card">
            <div className="hosted-head">
              <div>
                <div className="price">
                  <span className="dollar">$</span>
                  <span className="amt">5</span>
                  <span className="per">/ month</span>
                </div>
                <div className="plan-name">
                  <span className="live" />
                  SUPAMAIL · HOSTED
                </div>
              </div>
              <a className="btn btn-primary" href="/login">
                <span>Start free trial</span>
                <span className="arr">→</span>
              </a>
            </div>

            <ul className="hosted-list">
              <li>
                <span className="check">→</span>
                <span>
                  <b>Connect Supabase in one click.</b> OAuth handshake, schema applied
                  automatically. No psql.
                </span>
              </li>
              <li>
                <span className="check">→</span>
                <span>
                  <b>Add mailboxes from a web form.</b> Paste IMAP credentials, name the account,
                  done.
                </span>
              </li>
              <li>
                <span className="check">→</span>
                <span>
                  <b>I run the worker.</b> Docker, retries, backoff, monitoring. You don&apos;t see
                  any of it.
                </span>
              </li>
              <li>
                <span className="check">→</span>
                <span>
                  <b>Unlimited mailboxes.</b> Until you do something silly, in which case I&apos;ll
                  email you.
                </span>
              </li>
              <li>
                <span className="check">→</span>
                <span>
                  <b>Cancel anytime.</b> Switch to self-host whenever. Your Supabase keeps every
                  row.
                </span>
              </li>
            </ul>

            <div className="hosted-foot">
              <span>7-day trial · no card up front</span>
              <span>60-second setup</span>
            </div>
          </div>

          <p className="hosted-note">
            Honest: I&apos;m one person. The hosted version is a small Fly worker per customer. If
            five hundred of you sign up tomorrow I&apos;m going to have a rough Tuesday. I would
            love that problem.
          </p>
        </div>
      </section>

      <section>
        <div className="wrap">
          <p className="sec-tag">// who</p>
          <div className="builtby">
            <div className="avatar">JM</div>
            <div>
              <p>
                I built this because every AI email tool I wanted to use integrates with Gmail.
                Some with Outlook. None with Rackspace, which is what our company is on.
              </p>
              <p style={{ marginTop: 10 }}>
                So I wrote the sync myself. Then I pulled it out of our app, stripped the
                proprietary bits, and put it on GitHub. If it saves you a few weekends, cool.
              </p>
              <span className="sig">Jordan</span>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap row">
          <div>
            supamail · v0.4.2 · MIT · built in coffee shops in lisbon, melbourne, and that one in
            copenhagen with the bad wifi
          </div>
          <div className="foot-links">
            <a href="https://github.com/fedster99/supamail">github</a>
            <a href="#">docs</a>
            <a href="#">changelog</a>
            <a href="mailto:hi@supamail.dev">hi@supamail.dev</a>
          </div>
        </div>
      </footer>
    </>
  );
}
