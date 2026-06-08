import type { EvalMessage, SearchEngine, SearchHit, SearchRequest, SearchResponse } from "./types.js";

/**
 * In-process reference email-search engine used to drive the eval loop.
 *
 * It is intentionally a LEXICAL engine (no real embeddings) so the whole eval suite
 * runs anywhere with zero infrastructure. Every quality behavior is feature-flagged so
 * the baseline → improved delta is explicit and reproducible. A production
 * Postgres/pgvector engine would implement the same {@link SearchEngine} interface and
 * be scored by the identical evals — the semantic synonym map here is a deliberate
 * stand-in for the Tier-2 vector arm, present only to prove the harness rewards
 * semantic recall.
 */
export interface ReferenceEngineOptions {
  /** Index only the personal body (`body_clean`), excluding quoted reply history. */
  stripQuoted: boolean;
  /** Diacritic-insensitive matching (josé ≈ jose). */
  unaccent: boolean;
  /** Per-field relevance weights (A/B/D-style). */
  fieldWeights: { subject: number; participants: number; body: number };
  /** Recency prior: multiply score by a clamped half-life decay. */
  recency: { enabled: boolean; halfLifeDays: number; floor: number };
  /** Typo tolerance: map an unknown query term to the nearest vocab token. */
  fuzzy: { enabled: boolean; maxEditDistance: number; penalty: number };
  /** Down-weight bulk/newsletter mail for ambiguous queries. */
  newsletterDownweight: { enabled: boolean; factor: number };
  /** Expand query terms via a small synonym map (lexical stand-in for vector recall). */
  semanticSynonyms: boolean;
}

export const BASELINE_OPTIONS: ReferenceEngineOptions = {
  stripQuoted: false,
  unaccent: false,
  fieldWeights: { subject: 1, participants: 1, body: 1 },
  recency: { enabled: false, halfLifeDays: 30, floor: 0.4 },
  fuzzy: { enabled: false, maxEditDistance: 2, penalty: 0.6 },
  newsletterDownweight: { enabled: false, factor: 0.5 },
  semanticSynonyms: false
};

export const IMPROVED_OPTIONS: ReferenceEngineOptions = {
  stripQuoted: true,
  unaccent: true,
  fieldWeights: { subject: 3, participants: 2, body: 1 },
  recency: { enabled: true, halfLifeDays: 30, floor: 0.4 },
  fuzzy: { enabled: true, maxEditDistance: 2, penalty: 0.6 },
  newsletterDownweight: { enabled: true, factor: 0.45 },
  semanticSynonyms: true
};

/** Small, hand-curated synonym map: stand-in for the production vector/semantic arm. */
const SYNONYMS: Record<string, string[]> = {
  invoice: ["bill", "receipt", "payment", "statement"],
  bill: ["invoice", "receipt", "payment"],
  receipt: ["invoice", "bill", "payment"],
  meeting: ["call", "sync", "standup", "catchup"],
  call: ["meeting", "sync"],
  flight: ["airfare", "ticket", "itinerary", "booking"],
  hotel: ["reservation", "booking", "accommodation"],
  refund: ["reimbursement", "chargeback", "credit"],
  contract: ["agreement", "msa", "sow"],
  resume: ["cv", "curriculum"],
  password: ["credentials", "login", "passcode"]
};

interface IndexedDoc {
  msg: EvalMessage;
  fields: { subject: string[]; participants: string[]; body: string[] };
  tokenSet: Set<string>;
  indexedText: string; // normalized concatenation for phrase matching
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export class ReferenceEngine implements SearchEngine {
  readonly name: string;
  private readonly opts: ReferenceEngineOptions;
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>(); // document frequency per token
  private vocab: string[] = [];
  private docCount = 0;

  constructor(opts: ReferenceEngineOptions, name = "reference") {
    this.opts = opts;
    this.name = name;
  }

  private norm(s: string): string {
    const lower = s.toLowerCase();
    return this.opts.unaccent ? stripDiacritics(lower) : lower;
  }

  private tokenize(s: string | null | undefined): string[] {
    if (!s) return [];
    return this.norm(s)
      .split(/[^a-z0-9]+/i)
      .filter(Boolean);
  }

  index(messages: EvalMessage[]): void {
    this.docs = [];
    this.df = new Map();
    this.docCount = 0;

    for (const msg of messages) {
      if (msg.deleted_in_provider) continue; // soft-deleted mail is excluded by default

      const subject = this.tokenize(msg.subject);
      const participants = [
        ...this.tokenize(msg.from_email),
        ...this.tokenize(msg.from_name),
        ...msg.to_emails.flatMap((e) => this.tokenize(e)),
        ...(msg.to_names ?? []).flatMap((n) => this.tokenize(n)),
        ...(msg.cc_emails ?? []).flatMap((e) => this.tokenize(e))
      ];
      const bodyParts = [msg.body_clean ?? ""];
      if (!this.opts.stripQuoted && msg.body_quoted) bodyParts.push(msg.body_quoted);
      const body = bodyParts.flatMap((p) => this.tokenize(p));

      const tokenSet = new Set<string>([...subject, ...participants, ...body]);
      const indexedText = [...subject, ...participants, ...body].join(" ");
      this.docs.push({ msg, fields: { subject, participants, body }, tokenSet, indexedText });
      this.docCount += 1;
      for (const tok of tokenSet) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
    }
    this.vocab = [...this.df.keys()];
  }

  private idf(token: string): number {
    const df = this.df.get(token) ?? 0;
    return Math.log(1 + this.docCount / (1 + df));
  }

  /** Resolve a query token to a corpus token, applying fuzzy/synonym expansion. */
  private resolveTerms(token: string): Array<{ token: string; weight: number }> {
    const out: Array<{ token: string; weight: number }> = [];
    if (this.df.has(token)) {
      out.push({ token, weight: 1 });
    } else if (this.opts.fuzzy.enabled && token.length >= 4) {
      const near = this.nearestVocab(token);
      if (near) out.push({ token: near, weight: this.opts.fuzzy.penalty });
    }
    if (this.opts.semanticSynonyms && SYNONYMS[token]) {
      for (const syn of SYNONYMS[token]) {
        if (this.df.has(syn)) out.push({ token: syn, weight: 0.7 });
      }
    }
    return out;
  }

  private nearestVocab(token: string): string | undefined {
    let best: string | undefined;
    let bestDist = this.opts.fuzzy.maxEditDistance + 1;
    for (const cand of this.vocab) {
      if (Math.abs(cand.length - token.length) > this.opts.fuzzy.maxEditDistance) continue;
      const d = levenshtein(token, cand, bestDist);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
        if (d === 0) break;
      }
    }
    return best;
  }

  private recencyMultiplier(isoDate: string, now: number): number {
    if (!this.opts.recency.enabled) return 1;
    const ageMs = now - Date.parse(isoDate);
    const ageDays = Math.max(0, ageMs / 86_400_000);
    const decay = Math.pow(0.5, ageDays / this.opts.recency.halfLifeDays);
    return this.opts.recency.floor + (1 - this.opts.recency.floor) * decay;
  }

  search(req: SearchRequest): SearchResponse {
    const now = corpusNow(this.docs);

    // ---- 1. Hard structured filters ----
    const filtered = this.docs.filter((d) => this.passesFilters(d, req));

    // ---- 2. Relevance terms ----
    const textTerms = this.tokenize(req.text);
    const subjectTerms = this.tokenize(req.subject);
    const bodyTerms = this.tokenize(req.body);
    const orTerms = (req.or ?? []).flatMap((t) => this.tokenize(t));
    const phrase = req.phrase ? this.norm(req.phrase) : undefined;
    const hasRelevance =
      textTerms.length > 0 ||
      subjectTerms.length > 0 ||
      bodyTerms.length > 0 ||
      orTerms.length > 0 ||
      Boolean(phrase);

    const hits: SearchHit[] = [];
    for (const doc of filtered) {
      if (phrase && !doc.indexedText.includes(phrase)) continue;
      if (subjectTerms.length > 0 && !this.fieldHasAll(doc.fields.subject, subjectTerms)) continue;
      if (bodyTerms.length > 0 && !this.fieldHasAll(doc.fields.body, bodyTerms)) continue;
      if (orTerms.length > 0 && !orTerms.some((t) => this.resolveTerms(t).some((r) => doc.tokenSet.has(r.token))))
        continue;

      let score = 0;
      const matchedIn = new Set<string>();
      if (textTerms.length > 0) {
        let matchedAny = false;
        for (const term of textTerms) {
          for (const { token, weight } of this.resolveTerms(term)) {
            const c = this.fieldScore(doc, token, matchedIn);
            if (c > 0) {
              matchedAny = true;
              score += c * weight;
            }
          }
        }
        if (!matchedAny) continue; // free-text query with zero matches ⇒ not a candidate
      }
      for (const term of subjectTerms) score += this.fieldScore(doc, term, matchedIn, "subject");
      for (const term of bodyTerms) score += this.fieldScore(doc, term, matchedIn, "body");
      for (const term of orTerms)
        for (const { token, weight } of this.resolveTerms(term)) score += this.fieldScore(doc, token, matchedIn) * weight;
      if (phrase) {
        score += 5;
        matchedIn.add(doc.fields.subject.join(" ").includes(phrase) ? "subject" : "body");
      }

      if (!hasRelevance) {
        // pure structured query: every filtered doc qualifies, rank by recency
        score = 1;
      }

      score *= this.recencyMultiplier(doc.msg.internal_date, now);
      if (this.opts.newsletterDownweight.enabled && doc.msg.is_listish && this.isAmbiguous(req)) {
        score *= this.opts.newsletterDownweight.factor;
      }

      hits.push({
        id: doc.msg.id,
        score,
        thread_key: doc.msg.thread_key,
        matched_in: [...matchedIn]
      });
    }

    // ---- 3. Sort ----
    const byRecency = (a: SearchHit, b: SearchHit): number =>
      Date.parse(docById(this.docs, b.id).internal_date) - Date.parse(docById(this.docs, a.id).internal_date);
    if (req.sort === "recent") {
      hits.sort(byRecency);
    } else {
      hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : byRecency(a, b)));
    }

    // ---- 4. Thread collapse (contract feature, honored on request) ----
    let ranked = hits;
    if (req.granularity === "thread") {
      const seen = new Set<string>();
      ranked = hits.filter((h) => {
        const key = h.thread_key ?? h.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    return { hits: ranked.slice(0, req.limit ?? 50) };
  }

  private fieldHasAll(fieldTokens: string[], terms: string[]): boolean {
    const set = new Set(fieldTokens);
    return terms.every((t) => this.resolveTerms(t).some((r) => set.has(r.token)));
  }

  private fieldScore(
    doc: IndexedDoc,
    token: string,
    matchedIn: Set<string>,
    only?: "subject" | "body"
  ): number {
    const idf = this.idf(token);
    let score = 0;
    const fields: Array<[keyof IndexedDoc["fields"], number]> = only
      ? [[only, only === "subject" ? this.opts.fieldWeights.subject : this.opts.fieldWeights.body]]
      : [
          ["subject", this.opts.fieldWeights.subject],
          ["participants", this.opts.fieldWeights.participants],
          ["body", this.opts.fieldWeights.body]
        ];
    for (const [field, weight] of fields) {
      const tf = doc.fields[field].filter((t) => t === token).length;
      if (tf > 0) {
        score += weight * (1 + Math.log(tf)) * idf;
        matchedIn.add(field === "participants" ? "from" : field);
      }
    }
    return score;
  }

  private passesFilters(doc: IndexedDoc, req: SearchRequest): boolean {
    const m = doc.msg;
    if (req.accounts && req.accounts.length > 0 && !req.accounts.includes(m.account_id)) return false;
    if (req.in && req.in.length > 0 && !req.in.some((f) => f.toLowerCase() === m.folder_path.toLowerCase()))
      return false;
    if (req.thread && m.thread_key !== req.thread) return false;
    if (req.is) {
      const seen = m.flags.includes("\\Seen");
      for (const state of req.is) {
        if (state === "unread" && seen) return false;
        if (state === "read" && !seen) return false;
        if (state === "flagged" && !m.flags.includes("\\Flagged")) return false;
      }
    }
    if (req.has?.includes("attachment") && !(m.attachments && m.attachments.length > 0)) return false;
    if (req.filename) {
      const pat = this.norm(req.filename);
      const names = (m.attachments ?? []).map((a) => this.norm(a.filename ?? ""));
      const matches = names.some((n) =>
        pat.startsWith("*.") ? n.endsWith(pat.slice(1)) : n.includes(pat)
      );
      if (!matches) return false;
    }
    if (req.from && !this.matchesAddress(m.from_email, m.from_name, req.from)) return false;
    if (req.to) {
      const recipients = [...m.to_emails, ...(m.to_names ?? []), ...(m.cc_emails ?? [])].join(" ");
      if (!this.norm(recipients).includes(this.norm(req.to))) return false;
    }
    if (req.after && Date.parse(m.internal_date) < Date.parse(req.after)) return false;
    if (req.before && Date.parse(m.internal_date) > Date.parse(req.before)) return false;
    if (typeof req.larger === "number" && (m.size_bytes ?? 0) <= req.larger) return false;
    if (typeof req.smaller === "number" && (m.size_bytes ?? Infinity) >= req.smaller) return false;
    if (req.not && req.not.length > 0) {
      for (const term of req.not) {
        if (doc.indexedText.includes(this.norm(term))) return false;
      }
    }
    return true;
  }

  private matchesAddress(email: string, name: string | null | undefined, query: string): boolean {
    const hay = this.norm(`${email} ${name ?? ""}`);
    return hay.includes(this.norm(query));
  }

  private isAmbiguous(req: SearchRequest): boolean {
    // A query is "ambiguous" (eligible for newsletter down-weighting) when it doesn't
    // explicitly target a folder, flag state, or sender.
    return !(req.in && req.in.length) && !(req.is && req.is.length) && !req.from;
  }
}

/** Treat "now" as the newest message in the corpus, so fixtures stay deterministic over time. */
function corpusNow(docs: IndexedDoc[]): number {
  let max = 0;
  for (const d of docs) {
    const t = Date.parse(d.msg.internal_date);
    if (t > max) max = t;
  }
  return max || Date.now();
}

function docById(docs: IndexedDoc[], id: string): EvalMessage {
  const found = docs.find((d) => d.msg.id === id);
  // Hits are only ever produced from indexed docs, so this is always present.
  return found!.msg;
}

/** Levenshtein distance with an early-exit ceiling. */
function levenshtein(a: string, b: string, ceiling: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > ceiling) return ceiling + 1;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > ceiling) return ceiling + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
