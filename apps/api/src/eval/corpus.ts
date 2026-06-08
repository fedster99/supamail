/**
 * A deterministic, judged email corpus for evaluating search quality. Each
 * message has a stable synthetic id; each query carries the set of message ids
 * that SHOULD be retrieved (ground truth). Operator queries derive their ground
 * truth programmatically from the corpus so they stay correct as the corpus
 * grows. Categories let the scorecard break quality down by query type — most
 * importantly isolating where the current keyword search is weak (typo and
 * semantic), which is the evidence for the improvement goal.
 */

export interface EvalAttachment {
  filename: string;
  mimeType: string;
}

export interface EvalMessage {
  id: string;
  folder: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  /** Omit "\\Seen" to mark the message unread. */
  flags: string[];
  ageDays: number;
  body: string;
  attachments: EvalAttachment[];
  /** Explicit size; defaults to the body length when omitted. */
  sizeBytes?: number;
  /** Conversation id shared by every message in a thread (null = standalone). */
  providerThreadId: string | null;
  /** Parsed headers; list-id / list-unsubscribe here mark a message as bulk. */
  headersJson: Record<string, unknown>;
}

export type QueryCategory =
  | "lexical"
  | "ranking"
  | "operator"
  | "phrase"
  | "typo"
  | "semantic"
  | "email-intent";

export interface EvalQuery {
  id: string;
  category: QueryCategory;
  q: string;
  /** Ground-truth relevant message ids (binary relevance). */
  relevant: string[];
  /** Optional: the id that should rank first (recency / weight checks). */
  topFirst?: string;
  note?: string;
}

const SEEN = ["\\Seen"];
const UNREAD: string[] = [];

function m(message: Partial<EvalMessage> & Pick<EvalMessage, "id" | "subject" | "fromEmail" | "ageDays" | "body">): EvalMessage {
  return {
    folder: "INBOX",
    fromName: message.fromEmail.split("@")[0],
    toEmails: ["me@example.test"],
    flags: SEEN,
    attachments: [],
    providerThreadId: null,
    headersJson: {},
    ...message
  };
}

/** Headers that mark a message as a bulk mailing-list send (RFC 2369/2919). */
const LIST_HEADERS = { "list-id": "bulk", "list-unsubscribe": "<mailto:unsub@example.test>" };

export const messages: EvalMessage[] = [
  // --- Invoices / billing (from billing@acme.com) ---
  m({ id: "inv-1", subject: "Invoice #1042 for March", fromEmail: "billing@acme.com", fromName: "Acme Billing", ageDays: 3,
      body: "Your invoice is attached. Payment of $1,250 is due by March 31. Thank you for your business.",
      attachments: [{ filename: "invoice-1042.pdf", mimeType: "application/pdf" }] }),
  m({ id: "inv-2", subject: "Payment reminder: Invoice #1042 overdue", fromEmail: "billing@acme.com", fromName: "Acme Billing", ageDays: 1, flags: UNREAD,
      body: "This is a reminder that invoice #1042 remains unpaid. Please submit payment promptly." }),
  m({ id: "inv-3", subject: "Receipt for your payment", fromEmail: "billing@acme.com", fromName: "Acme Billing", ageDays: 0,
      body: "We have received your payment of $1,250. A receipt is enclosed for your records." }),
  m({ id: "inv-4", subject: "Quarterly billing summary", fromEmail: "billing@acme.com", fromName: "Acme Billing", ageDays: 40,
      body: "Here is your billing summary for the first quarter, including all charges." }),

  // --- Weekly reports (from data@reportly.io) ---
  m({ id: "rep-1", subject: "Weekly report — week 12", fromEmail: "data@reportly.io", fromName: "Reportly", ageDays: 2,
      body: "Traffic is up 8 percent and signups up 12 percent. Full metrics are below." }),
  m({ id: "rep-2", subject: "Weekly report — week 11", fromEmail: "data@reportly.io", fromName: "Reportly", ageDays: 9,
      body: "Traffic was flat and signups up 3 percent week over week." }),
  m({ id: "rep-3", subject: "Monthly metrics deep dive", fromEmail: "data@reportly.io", fromName: "Reportly", ageDays: 20,
      body: "A deeper look at the monthly numbers and the key performance indicators." }),

  // --- Meetings ---
  m({ id: "meet-1", subject: "Invitation: Design sync on Thursday", fromEmail: "invites@calendarapp.com", fromName: "Calendar", ageDays: 1, flags: UNREAD,
      body: "Please join the Zoom call for the design sync on Thursday at 2pm." }),
  m({ id: "meet-2", subject: "Rescheduled: one-on-one with Sarah", fromEmail: "sarah@contractor.com", fromName: "Sarah", ageDays: 2,
      body: "Our one-on-one is moved to Friday. The calendar invite has been updated." }),
  m({ id: "meet-3", subject: "Notes from the planning meeting", fromEmail: "pm@projecthub.io", fromName: "Project Hub", ageDays: 4,
      body: "Here are the action items from today's planning meeting." }),

  // --- Travel ---
  m({ id: "trav-1", subject: "Your flight to San Francisco is booked", fromEmail: "noreply@travelco.com", fromName: "TravelCo", ageDays: 5,
      body: "Confirmation: flight UA123 departs March 10. Your hotel reservation is included.",
      attachments: [{ filename: "itinerary.pdf", mimeType: "application/pdf" }] }),
  m({ id: "trav-2", subject: "Hotel booking confirmation", fromEmail: "noreply@travelco.com", fromName: "TravelCo", ageDays: 5,
      body: "Your hotel reservation at the Grand Plaza is confirmed for three nights." }),

  // --- Security (from security@acme.com) ---
  m({ id: "sec-1", subject: "Security alert: new login to your account", fromEmail: "security@acme.com", fromName: "Acme Security", ageDays: 1, flags: UNREAD,
      body: "We detected a new login from an unrecognized device. If this was not you, reset your password now." }),
  m({ id: "sec-2", subject: "Verify your email address", fromEmail: "security@acme.com", fromName: "Acme Security", ageDays: 6,
      body: "Please confirm your email address by clicking the verification link." }),

  // --- Project Alpha (from pm@projecthub.io) ---
  m({ id: "alpha-1", subject: "Project Alpha milestone reached", fromEmail: "pm@projecthub.io", fromName: "Project Hub", ageDays: 7,
      body: "We hit the Project Alpha milestone ahead of the deadline. Great work everyone." }),
  m({ id: "alpha-2", subject: "Project Alpha: blockers for next sprint", fromEmail: "pm@projecthub.io", fromName: "Project Hub", ageDays: 3,
      body: "Two blockers remain for Project Alpha before we can launch." }),

  // --- Contracts / attachment-heavy (from legal@partner.com) ---
  m({ id: "con-1", subject: "Signed contract attached", fromEmail: "legal@partner.com", fromName: "Partner Legal", ageDays: 8,
      body: "Please find the signed contract for the partnership enclosed.",
      attachments: [{ filename: "contract-final.pdf", mimeType: "application/pdf" }] }),
  m({ id: "con-2", subject: "Updated NDA", fromEmail: "legal@partner.com", fromName: "Partner Legal", ageDays: 12,
      body: "The revised non-disclosure agreement is attached for your review.",
      attachments: [{ filename: "nda-v2.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }] }),
  m({ id: "con-3", subject: "Logo files for the brand refresh", fromEmail: "legal@partner.com", fromName: "Partner Legal", ageDays: 15,
      body: "Attaching the new logo assets for the brand refresh.",
      attachments: [{ filename: "logo.png", mimeType: "image/png" }, { filename: "logo-dark.png", mimeType: "image/png" }] }),

  // --- Newsletters (bulk; carry list headers so the ranker can demote them) ---
  m({ id: "news-1", subject: "Tech Weekly: 10 tools you need", fromEmail: "newsletter@techweekly.com", fromName: "Tech Weekly", ageDays: 2, headersJson: LIST_HEADERS,
      body: "This week's roundup of developer tools. Unsubscribe at the bottom of this email." }),
  m({ id: "news-2", subject: "Tech Weekly: the AI edition", fromEmail: "newsletter@techweekly.com", fromName: "Tech Weekly", ageDays: 9, headersJson: LIST_HEADERS,
      body: "Everything about artificial intelligence this week. Unsubscribe link below." }),

  // --- Recruiting (from talent@workable.com) ---
  m({ id: "rec-1", subject: "Interview scheduled with candidate Jane", fromEmail: "talent@workable.com", fromName: "Talent", ageDays: 4,
      body: "Jane's interview is set for Tuesday. Her resume is attached for your reference.",
      attachments: [{ filename: "jane-resume.pdf", mimeType: "application/pdf" }] }),
  m({ id: "rec-2", subject: "Candidate feedback needed", fromEmail: "talent@workable.com", fromName: "Talent", ageDays: 6,
      body: "Please submit your feedback for the recent candidates before Friday." }),

  // --- Personal ---
  m({ id: "pers-1", subject: "Dinner this weekend?", fromEmail: "bob@gmail.com", fromName: "Bob", ageDays: 1, flags: UNREAD,
      body: "Hey, want to grab dinner on Saturday? Let me know what works for you." }),

  // --- Large message ---
  m({ id: "big-1", subject: "Huge dataset export", fromEmail: "exports@data.io", fromName: "Data Exports", ageDays: 10,
      body: "Attached is the full dataset export you requested.",
      attachments: [{ filename: "export.csv", mimeType: "text/csv" }], sizeBytes: 6_000_000 }),

  // --- A real conversation: one thread, 4 quoted replies. The phrase "budget
  //     proposal" repeats down the quoted bodies, which inflates keyword matches
  //     and produces near-duplicate hits unless results are grouped by thread. ---
  m({ id: "thr-1", subject: "Q2 budget proposal", fromEmail: "pm@projecthub.io", fromName: "Priya", ageDays: 6, providerThreadId: "thread-budget",
      body: "Here is the Q2 budget proposal for review. Let me know your thoughts." }),
  m({ id: "thr-2", subject: "Re: Q2 budget proposal", fromEmail: "sarah@contractor.com", fromName: "Sarah", ageDays: 5, providerThreadId: "thread-budget",
      body: "Thanks for the Q2 budget proposal. I have a couple of questions.\n> Here is the Q2 budget proposal for review. Let me know your thoughts." }),
  m({ id: "thr-3", subject: "Re: Q2 budget proposal", fromEmail: "pm@projecthub.io", fromName: "Priya", ageDays: 4, providerThreadId: "thread-budget",
      body: "Good questions on the budget proposal. Answers inline.\n> Thanks for the Q2 budget proposal. I have a couple of questions.\n>> Here is the Q2 budget proposal for review." }),
  m({ id: "thr-4", subject: "Re: Q2 budget proposal", fromEmail: "sarah@contractor.com", fromName: "Sarah", ageDays: 3, providerThreadId: "thread-budget",
      body: "The Q2 budget proposal looks good to me now. Approved.\n> Good questions on the budget proposal. Answers inline.\n>> Thanks for the Q2 budget proposal." }),

  // --- Human-vs-bulk: a person's question and a newsletter both about "tools".
  //     The newsletter is keyword-richer and more recent, so it out-ranks the
  //     human mail until the ranker demotes bulk. ---
  m({ id: "hum-tools", subject: "question about our tooling", fromEmail: "dave@projecthub.io", fromName: "Dave", ageDays: 1,
      body: "Quick question — which of our internal tools should I use for the report?" }),
  m({ id: "news-tools", subject: "The 15 best developer tools this week", fromEmail: "newsletter@devtools.io", fromName: "DevTools Digest", ageDays: 0, headersJson: LIST_HEADERS,
      body: "Our roundup of the best developer tools and productivity tools. Unsubscribe anytime." })
];

const byId = new Map(messages.map((msg) => [msg.id, msg]));
function ids(predicate: (msg: EvalMessage) => boolean): string[] {
  return messages.filter(predicate).map((msg) => msg.id);
}
function isUnread(msg: EvalMessage): boolean {
  return !msg.flags.includes("\\Seen");
}

export const queries: EvalQuery[] = [
  // --- Lexical: exact keywords present in the relevant docs ---
  { id: "L1", category: "lexical", q: "invoice", relevant: ["inv-1", "inv-2", "inv-4"] },
  { id: "L2", category: "lexical", q: "payment", relevant: ["inv-1", "inv-2", "inv-3"] },
  { id: "L3", category: "lexical", q: "hotel", relevant: ["trav-1", "trav-2"] },
  { id: "L4", category: "lexical", q: "password", relevant: ["sec-1"] },
  { id: "L5", category: "lexical", q: "flight", relevant: ["trav-1"] },
  { id: "L6", category: "lexical", q: "contract", relevant: ["con-1"] },
  { id: "L7", category: "lexical", q: "candidate interview", relevant: ["rec-1", "rec-2"] },

  // --- Ranking: the most recent / strongest match should lead ---
  { id: "R1", category: "ranking", q: "weekly report", relevant: ["rep-1", "rep-2"], topFirst: "rep-1" },
  { id: "R2", category: "ranking", q: "project alpha", relevant: ["alpha-1", "alpha-2"], topFirst: "alpha-2" },
  { id: "R3", category: "ranking", q: "security login", relevant: ["sec-1"], topFirst: "sec-1" },

  // --- Phrase: exact multiword match ---
  { id: "P1", category: "phrase", q: '"project alpha"', relevant: ["alpha-1", "alpha-2"] },
  { id: "P2", category: "phrase", q: '"new login"', relevant: ["sec-1"] },

  // --- Operator: ground truth derived from the corpus; should be ~perfect ---
  { id: "O1", category: "operator", q: "is:unread", relevant: ids(isUnread) },
  { id: "O2", category: "operator", q: "from:billing@acme.com", relevant: ids((x) => x.fromEmail === "billing@acme.com") },
  { id: "O3", category: "operator", q: "from:@acme.com", relevant: ids((x) => x.fromEmail.endsWith("@acme.com")) },
  { id: "O4", category: "operator", q: "has:attachment", relevant: ids((x) => x.attachments.length > 0) },
  { id: "O5", category: "operator", q: "filename:*.pdf", relevant: ids((x) => x.attachments.some((a) => a.filename.endsWith(".pdf"))) },
  { id: "O6", category: "operator", q: "filetype:image", relevant: ids((x) => x.attachments.some((a) => a.mimeType.startsWith("image/"))) },
  { id: "O7", category: "operator", q: "larger:2mb", relevant: ids((x) => (x.sizeBytes ?? x.body.length) > 2 * 1024 * 1024) },
  { id: "O8", category: "operator", q: "before:14d", relevant: ids((x) => x.ageDays > 14) },

  // --- Typo: misspelled keywords (current keyword search has no fuzzy fallback) ---
  { id: "T1", category: "typo", q: "invioce", relevant: ["inv-1", "inv-2", "inv-4"], note: "invoice misspelled" },
  { id: "T2", category: "typo", q: "secuirty", relevant: ["sec-1"], note: "security misspelled" },
  { id: "T3", category: "typo", q: "candiate", relevant: ["rec-1", "rec-2"], note: "candidate misspelled" },
  { id: "T4", category: "typo", q: "metrcs", relevant: ["rep-1", "rep-3"], note: "metrics misspelled" },

  // --- Semantic: intent words that never appear literally in the relevant docs ---
  { id: "S1", category: "semantic", q: "vacation", relevant: ["trav-1", "trav-2"], note: "no 'vacation' token in travel mail" },
  { id: "S2", category: "semantic", q: "hiring", relevant: ["rec-1", "rec-2"], note: "no 'hiring' token in recruiting mail" },
  { id: "S3", category: "semantic", q: "breach", relevant: ["sec-1"], note: "no 'breach' token in the security alert" },
  { id: "S4", category: "semantic", q: "expense", relevant: ["inv-1", "inv-2", "inv-4"], note: "no 'expense' token in billing mail" },

  // --- Email intent: the things that make email search EMAIL search. Ground
  //     truth is conversation-level (the canonical / latest message of a thread),
  //     so recall stays meaningful under grouping; the duplicate-collapse benefit
  //     shows up in the scorecard's distinct_thread_ratio. ---
  { id: "EI1", category: "email-intent", q: "budget proposal", relevant: ["thr-4"], topFirst: "thr-4",
    note: "one conversation; should return one grouped result, not 4 quoted-reply dupes" },
  { id: "EI2", category: "email-intent", q: "tools", relevant: ["hum-tools"], topFirst: "hum-tools",
    note: "the human question should outrank the keyword-rich, more-recent newsletter" },
  { id: "EI3", category: "email-intent", q: "sarah", relevant: ["meet-2", "thr-4"],
    note: "people-centric: mail from Sarah, conversation-deduplicated" },
  { id: "EI4", category: "email-intent", q: "unsubscribe", relevant: ["news-1", "news-2", "news-tools"],
    note: "reverse-bulk guardrail: demoted newsletters must still be findable when sought" }
];

export function messageById(id: string): EvalMessage | undefined {
  return byId.get(id);
}
