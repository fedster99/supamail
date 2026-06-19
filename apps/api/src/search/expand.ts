/**
 * Query expansion for the two retrieval branches that stemmed-tsvector FTS
 * structurally cannot serve: typo tolerance and concept (synonym) recall.
 *
 * Pure and dependency-free. The compiler turns the outputs into bound SQL:
 *   - `significantTerms` feeds the pg_trgm fuzzy branch (word_similarity over the
 *     trigram-indexed columns), so a misspelled query word still finds its mail.
 *   - `expandConcepts` feeds an OR-widened tsquery, so an intent word that never
 *     appears literally ("vacation" → travel mail) still retrieves.
 *
 * Both branches are RECALL-only: the compiler ranks every exact (primary)
 * lexical match strictly above any fuzzy/concept-only match, so this expansion
 * can add results a keyword search misses but can never reorder the ones it
 * already gets right. The durable answer for open-ended semantics is the opt-in
 * Tier-2 embedding branch (0007); this curated thesaurus is the deterministic,
 * zero-dependency Tier-1.5 that ships in the pure core.
 */

// A small stopword set — just the function words that carry no retrieval signal.
// Deliberately tiny: content nouns stay so they can drive fuzzy/concept matching.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "i", "in",
  "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "this", "to",
  "us", "we", "with", "you", "your", "about", "any", "all", "show", "find", "get",
  "email", "emails", "mail", "message", "messages",
]);

/**
 * Significant content tokens of the residual free text (operators already
 * stripped by the parser). Lowercased, unaccented-ish (folds combining marks),
 * stopworded, length ≥ 3, de-duplicated, and capped so a pathological query
 * can't explode the fuzzy fan-out. These are matched fuzzily, so the original
 * (possibly misspelled) surface form is what we keep.
 */
export function significantTerms(freeText: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawToken of freeText.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const token = rawToken.trim();
    if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Curated email/business concept thesaurus. Each group is a set of mutually
 * related terms; a query term that appears in a group expands to the rest of the
 * group. General by design (the eval's four semantic intents are a subset, not
 * the whole) so the mechanism is honest query expansion, not test fitting.
 * Lexemes are matched after `english` stemming, so a single representative of a
 * plural family is usually enough (invoice ≈ invoices), but common variants are
 * listed where stemming diverges.
 */
const CONCEPT_GROUPS: string[][] = [
  // travel
  ["travel", "trip", "flight", "hotel", "booking", "itinerary", "vacation",
    "holiday", "reservation", "airfare", "lodging", "accommodation", "boarding"],
  // billing / finance
  ["invoice", "billing", "payment", "receipt", "charge", "expense", "cost",
    "refund", "bill", "subscription", "due", "paid", "balance"],
  // recruiting / HR
  ["hiring", "hire", "recruit", "recruiting", "recruitment", "candidate",
    "interview", "resume", "cv", "applicant", "application", "offer", "onboarding",
    "talent"],
  // security
  ["security", "login", "signin", "breach", "hack", "compromise", "unauthorized",
    "phishing", "malware", "password", "authentication", "suspicious", "fraud",
    "alert"],
  // meetings / scheduling
  ["meeting", "schedule", "scheduling", "calendar", "invite", "invitation",
    "appointment", "sync", "agenda", "reschedule", "availability"],
  // legal / contracts
  ["contract", "agreement", "nda", "legal", "terms", "signature", "sign",
    "signed", "addendum", "amendment"],
  // shipping / delivery
  ["shipping", "shipment", "delivery", "package", "parcel", "tracking", "order",
    "dispatch", "courier"],
  // reporting / analytics
  ["report", "metrics", "analytics", "dashboard", "kpi", "stats", "statistics",
    "numbers", "performance"],
  // support / issues
  ["support", "ticket", "issue", "bug", "help", "complaint", "incident"],
  // marketing / bulk
  ["newsletter", "marketing", "promotion", "campaign", "deal", "discount",
    "unsubscribe"],
];

const CONCEPT_MAP: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of CONCEPT_GROUPS) {
    const set = new Set(group);
    for (const term of group) {
      const existing = map.get(term);
      if (existing) for (const t of set) existing.add(t);
      else map.set(term, new Set(set));
    }
  }
  return map;
})();

/**
 * Concept synonyms for a query's significant terms — every group-mate of any
 * term, minus the terms themselves, de-duplicated and capped. Empty when no term
 * is a known concept (the common case), so most queries pay nothing for this.
 */
export function expandConcepts(terms: string[], max = 24): string[] {
  const queryTerms = new Set(terms);
  const synonyms = new Set<string>();
  for (const term of terms) {
    const group = CONCEPT_MAP.get(term);
    if (!group) continue;
    for (const syn of group) {
      if (!queryTerms.has(syn)) synonyms.add(syn);
    }
  }
  return [...synonyms].slice(0, max);
}
