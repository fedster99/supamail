export const MCP_INSTRUCTIONS = `SupaMail agent email — a READ-ONLY window onto your mirrored mailbox in Postgres, plus a reply *drafter*. Five tools, no sending.

The loop: orient → search → read → draft.
1. ORIENT with list_folders to see folders + unread/flagged/total counts for an account.
2. SEARCH with search_email (the canonical ranked search) to find messages. It groups by conversation by default, and each hit carries an identity.id.
3. READ with read_message for one message. Use read_thread {message_id} for one focused conversation. For a broader investigation, choose relevant grouped search results from their snippets, then pass up to 10 of their ids as read_thread {message_ids:[...]} instead of issuing separate read_thread calls.
4. DRAFT with draft_reply to produce a ready-to-send reply. It NEVER sends — you (or your client) send it.

ID model: a search hit's identity.id IS the message_id. Pass it verbatim to read_message {message_id} or read_thread {message_id}. For a batch, pass distinct grouped search hits as read_thread {message_ids:[...]}; each requested thread succeeds or fails independently.

Recipes:
- Latest email from someone: search_email {q:"from:alice@example.com sort:recent", limit:1}.
- Unread today: search_email {q:"is:unread newer_than:1d", sort:"recent"}.
- Triage the inbox: search_email {q:"is:unread", sort:"recent"} — then read_message the ones that matter.
- Investigate a topic: search_email with the broad topic, inspect the grouped snippets, then batch the relevant ids through read_thread.

Non-goals (do not attempt): NO sending or appending mail; NO attachment bytes or content extraction (only attachment metadata is mirrored); NO labels, flags, moves, deletes, or any mutation.

Every read tool attaches a sync_trust block. It reports how complete the mirror is for the searched accounts (initial sync still running, history backfilling, bodies missing, account degraded). If sync_trust says results may be incomplete, say so — do not present a partial mirror as the whole mailbox.

Errors come back as { error: { code, message, hint } }; the hint tells you what to do next. Empty results are NOT errors.`;
