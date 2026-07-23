# Contributing

Thanks for helping improve SupaMail.

Before opening a pull request:

1. Open or reference an issue for behavior changes.
2. Keep the change focused on the open-source IMAP mirror. Hosted billing,
   tenant orchestration, and remote MCP authentication belong in SupaMail
   Cloud.
3. Use Node 24 and pnpm 10.
4. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm test
   pnpm build
   ```

For sync, migration, schema, lock, reconcile, or health changes, also run
`pnpm test:db:live`. Protocol changes should run the relevant GreenMail or
Dovecot smoke test described in `docs/agent/verification.md`.

Never put mailbox credentials, API tokens, private messages, or customer data
in issues, fixtures, logs, commits, or pull requests.
