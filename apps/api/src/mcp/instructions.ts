export const MCP_INSTRUCTIONS = `SupaMail provides read-only access to synced email and can prepare reply content. It cannot send, save drafts, move, delete, flag, or otherwise change mail.

The available tools are search_email, read_message, read_thread, list_folders, and draft_reply.

search_email returns results grouped by conversation by default, with 25 results by default and at most 100. A result's identity.id is its message_id. read_message accepts one message_id. read_thread accepts one message_id, 1 to 10 message_ids, or an account-scoped conversation_id or provider thread_id. Thread reads return at most 20 messages by default and 100 when requested. Duplicate message_ids are collapsed in first-occurrence order; each distinct ID returns independently.

read_message and read_thread return cleaned bodies limited to 4,096 characters; body_truncated reports whether text was cut. list_folders returns folders containing mirrored messages, their total and unread counts, and account-wide totals. draft_reply returns prepared reply content but does not save or send it. Read results include sync_trust, which describes mirror completeness. Tool errors include a code, message, and hint.`;
