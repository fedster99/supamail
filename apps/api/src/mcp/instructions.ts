export const MCP_INSTRUCTIONS = `SupaMail provides read-only access to synced email and can prepare reply content. It cannot send, save drafts, move, delete, flag, or otherwise change mail.

The available tools are search_email, read_message, read_thread, list_folders, and draft_reply.

search_email returns results grouped by conversation by default. A result's identity.id is its message_id. read_message accepts one message_id. read_thread accepts one message_id or up to 10 message_ids; batch items return independently.

list_folders returns folder names and message counts. draft_reply returns prepared reply content but does not save or send it. Read results can include sync_trust, which describes mirror completeness. Tool errors include a code, message, and hint.`;
