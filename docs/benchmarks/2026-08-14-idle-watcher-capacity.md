# IMAP IDLE Watcher Capacity

Date: 2026-08-14 PDT

## Question

Can one small Fly Machine hold 1,000 quiet TLS IMAP IDLE sessions and recover them after a simultaneous disconnect without material CPU pressure or lost wake signals?

## Method

The test used two disposable `shared-cpu-1x`, 1 GB Fly Machines in `sjc`:

- a synthetic TLS IMAP server with IDLE support
- a Node 24 watcher process using the repository's pinned ImapFlow version

The watcher opened 1,000 authenticated Inbox sessions. The server emitted `EXISTS`, `EXPUNGE`, and flag updates, then dropped every session. Each successful reconnect recorded a catch-up wake. A second run shortened IDLE renewal from 25 minutes to 30 seconds and held all sessions through several renewal cycles.

The app had no public service, volume, production dependency, provider credential, or mailbox data. It was deleted after the tests.

## Results

| Measurement | 10-minute run | Accelerated-renewal run |
| --- | ---: | ---: |
| Watchers | 1,000 | 1,000 |
| Startup | 1.328 s | 1.324 s |
| Event delivery | 100% | 100% |
| `EXISTS` p95 | 64 ms | 69 ms |
| `EXPUNGE` p95 | 103 ms | 102 ms |
| Flags p95 | 161 ms | 173 ms |
| Reconnect p95 | 6.496 s | 6.412 s |
| Full reconnect | 6.522 s | 6.412 s |
| Failed connections | 0 | 0 |
| Catch-up wakes | 1,000 | 1,000 |
| Peak watcher RSS | 246.1 MB | 251.4 MB |
| Open watcher file descriptors | 1,023 | 1,023 |
| Quiet CPU, one-core basis | 0.40% | 1.86% |
| Event-loop delay p95 | 20 ms | 20 ms |
| Result | Pass | Pass |

The synthetic server peaked at about 160-163 MB RSS while it held 1,000 TLS peers. The accelerated run renewed IDLE every 30 seconds for two minutes; all 1,000 sessions finished in IDLE.

Estimated started-Machine compute was under $0.01 at the published per-second rate. No volume remained after cleanup.

## Decision

The socket architecture is viable at 1,000 active Mailbox Accounts. Quiet IDLE sessions use little CPU. Memory and file descriptors, not CPU, set the first watcher-per-Machine limit.

This result does not validate any provider. Rackspace and other providers still need small real-mailbox canaries for IDLE duration, renewal, `EXPUNGE`, throttling, and reconnect behavior. It also does not test the Cloud ownership lease, durable queue, database write, body storage, search indexing, or periodic reconciliation. Those remain required before production enablement.
