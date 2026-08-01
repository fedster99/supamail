export const MCP_INSTRUCTIONS = `SupaMail lets you search and read a synced copy of the user's email, and draft replies. It cannot send or change mail.

Use the fewest calls that preserve accuracy.

Start with search_email for a lookup or investigation. Results are grouped by conversation by default. Use read_message for one email and read_thread for its conversation. For a broader investigation, inspect the search snippets, refine the query when useful, then pass up to 10 selected result IDs to read_thread as message_ids. Do not read every result unless the task requires exhaustive coverage.

Use list_folders when folder names or counts help. draft_reply prepares reply content but does not save or send it.

A search result's identity.id is its message_id. Use it exactly as returned. When a result includes sync_trust, treat it as part of the answer: if it says the mirror may be incomplete, say so. In a batch, each thread can succeed or fail independently. Follow returned error hints, and do not treat an empty result as an error.`;
