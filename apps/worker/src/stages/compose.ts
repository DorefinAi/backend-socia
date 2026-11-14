// Compose: pure rules turn a story into an X draft. The dictionaries are loaded into memory and
// reloaded when an editor changes them; compose_version records which tables produced a draft.
// Breaking files (phase 1) use their own layout, the district- and subject-handles files, the org's topic
// hashtag rules for their category tags, and the handle directory's verified handles with keywords: the ones the desk
// added (source "desk", keywords stored) and the ones added in Settings or promoted from staging (their names and the
// keywords inside the handle, desk-handles.ts directoryHandleRules), which are suggested after the files' picks.

import { createHash } from "node:crypto";
import {
  LEADER_POST, asFileTags, assemblePostText, composeBreaking, recoverDistrictFrom, directoryHandleRules, districtKeywordCandidates, handleProposal, handleReason, handleSource, hashtagGazetteer,
  mergeReporterTokens, resolveReporterStatus, slotFromTags,
  type BreakingDraft, type Composer, type DeskHandleRow, type DeskHandleRules, type DirectoryHandleRow, type HandlePick, type HandleRules, type SubjectRules, type HashtagGazetteer, type LearnedReporterToken, type Proposal, type ReporterRules,
  type TagSuggestion,
} from "@socia/core";
import {
  EXPLORE_RATE, REPORTER_SOURCE, activeHashtagRules, dictionaryFingerprint, handleDirectory, ingestedFiles, loadRuleComposer, notify, postDrafts, recordProposal,
  stories, type Db, type LoggedProposal, type Tx,
} from "@socia/db";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { nextStoryIsolated } from "./isolate";
import type { PhaseOneData } from "../data-files";
import type { Logger } from "pino";

const RELOAD_MS = 60_000;
const DISTRICT_CANDIDATES = districtKeywordCandidates();

/** The data files a Settings handle's keywords are checked against, and their versions as one string */
export interface DeskRuleFiles {
  rules: HandleRules;
  subjects: SubjectRules;
  version: string;
}

export class Dictionaries {
  private cached: {
    composer: Composer; topics: HashtagGazetteer; deskRows: DeskHandleRow[]; settingsRows: DirectoryHandleRow[]; learnedReporters: LearnedReporterToken[]; version: string; at: number;
  } | null = null;
  /** The handle rules built from the rows above and the data files they were checked against */
  private deskRules: { key: string; value: DeskHandleRules } | null = null;

  constructor(private readonly db: Db, private readonly orgId: string) {}

  private async load() {
    if (this.cached && Date.now() - this.cached.at < RELOAD_MS) return this.cached;
    const version = await dictionaryFingerprint(this.db, this.orgId);
    if (this.cached?.version === version) {
      this.cached.at = Date.now();
      return this.cached;
    }
    const { composer } = await loadRuleComposer(this.db, this.orgId, version);
    // Breaking posts take only the topic rules (category tags); their places come from the places file
    const topics = hashtagGazetteer((await activeHashtagRules(this.db, this.orgId)).filter((r) => r.matchType === "entity"));
    // The fingerprint counts verified handles and their latest verification, so an add, edit or delete reloads these
    const deskRows = await this.db
      .select({ handle: handleDirectory.handle, entityName: handleDirectory.entityName, aliases: handleDirectory.aliases })
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, this.orgId), eq(handleDirectory.platform, "x"), eq(handleDirectory.source, "desk"), isNotNull(handleDirectory.verifiedAt)));
    // Handles added in Settings ("manual") or promoted from staging ("wikidata:Q…"): every verified row that is not
    // a desk add or a learned reporter. Their keywords depend on the data files, so they are worked out in desk().
    const settingsRows = await this.db
      .select({ handle: handleDirectory.handle, entityName: handleDirectory.entityName, entityNameHi: handleDirectory.entityNameHi, aliases: handleDirectory.aliases })
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, this.orgId), eq(handleDirectory.platform, "x"), notInArray(handleDirectory.source, ["desk", REPORTER_SOURCE]), isNotNull(handleDirectory.verifiedAt)));
    // File-name tokens editors taught us by adding a reporter's handle to a draft by hand (desk.ts). The
    // fingerprint above counts every verified directory row, so a newly learned token reloads these too.
    const reporterRows = await this.db
      .select({ handle: handleDirectory.handle, entityName: handleDirectory.entityName, aliases: handleDirectory.aliases })
      .from(handleDirectory)
      .where(and(eq(handleDirectory.orgId, this.orgId), eq(handleDirectory.platform, "x"), eq(handleDirectory.source, REPORTER_SOURCE), isNotNull(handleDirectory.verifiedAt)));
    const learnedReporters = reporterRows.flatMap((r) => r.aliases.map((token) => ({ handle: r.handle, token, name: r.entityName })));
    this.cached = { composer, topics, deskRows, settingsRows, learnedReporters, version, at: Date.now() };
    return this.cached;
  }

  async composer(): Promise<{ composer: Composer; version: string }> {
    const { composer, version } = await this.load();
    return { composer, version };
  }

  /** The org's active topic hashtag rules, for the breaking posts' category tags; the directory's keyword handles */
  async topics(files?: DeskRuleFiles): Promise<{ topics: HashtagGazetteer; desk: DeskHandleRules; learnedReporters: LearnedReporterToken[]; version: string }> {
    const { topics, deskRows, settingsRows, learnedReporters, version } = await this.load();
    return { topics, desk: this.desk(deskRows, settingsRows, version, files), learnedReporters, version };
  }

  /**
   * The desk-added and Settings handles as one rule set, rebuilt only when the directory or a data file changes.
   * Without the data files (no breaking data loaded) a Settings row cannot be checked, so none is used (fail safe).
   */
  private desk(deskRows: DeskHandleRow[], settingsRows: DirectoryHandleRow[], version: string, files?: DeskRuleFiles): DeskHandleRules {
    const key = `${version}|${files?.version ?? "-"}`;
    if (this.deskRules?.key === key) return this.deskRules.value;
    const value = directoryHandleRules(deskRows, files ? settingsRows : [], {
      candidates: [...DISTRICT_CANDIDATES, ...(files?.subjects.keywordCandidates ?? [])],
      fileHandles: files ? [...(files.rules.all ?? []), ...(files.subjects.handles ?? [])] : [],
    });
    this.deskRules = { key, value };
    return value;
  }
}

/** A short, stable tag for a dictionary fingerprint, for the composeVersion */
const shortVersion = (v: string) => createHash("sha1").update(v).digest("hex").slice(0, 8);

/**
 * The reporter list plus the names editors taught us, merged once per version rather than once per
 * story. Both inputs are already cached for a minute each, so this only rebuilds when one really
 * changes — which also means a contested name is reported once per change instead of once per post.
 */
let mergedRoster: { key: string; value: ReporterRules } | null = null;
function mergedReporters(roster: ReporterRules, rosterVersion: string, learned: LearnedReporterToken[], dictVersion: string, log: Logger): ReporterRules {
  const key = `${rosterVersion}|${dictVersion}|${learned.length}`;
  if (mergedRoster?.key === key) return mergedRoster.value;
  const value = mergeReporterTokens(roster, learned, (m) => log.warn({ problem: m }, "learned reporter name skipped"));
  mergedRoster = { key, value };
  return value;
}

/** A handle as the desk's suggestion list carries it: the rule id, its reason line, and the prior's score and n */
function mentionSuggestion(h: HandlePick, prefix: "rule" | "suggest", exact: boolean) {
  return {
    handleId: `${prefix}:${h.reason}:${h.handle}`, entity: h.title ?? h.reason, handle: `@${h.handle}`, exact,
    source: handleSource(h), reason: handleReason(h), ...(h.detail && { detail: h.detail }),
    ...(h.score !== undefined && { score: h.score }), ...(h.n !== undefined && { n: h.n }),
  };
}

/**
 * The decision log's proposals (reporter-prior brief §2.3) from the composed draft: core's own list when it gives
 * one; otherwise built from the fields, each item's source falling back to the reason code it always had.
 */
export function draftProposals(
  out: Pick<BreakingDraft, "hashtags" | "handles" | "handleSuggestions" | "hashtagSuggestions"> & { proposals?: Proposal[]; hashtagSuggestionItems?: TagSuggestion[] },
  onFallback?: () => void,
): LoggedProposal[] {
  if (Array.isArray(out.proposals)) return out.proposals.map((p) => ({ ...p }));
  onFallback?.();
  const items = out.hashtagSuggestionItems ?? out.hashtagSuggestions.map((tag) => ({ tag, source: "suggestion", reason: "suggestion" }));
  return [
    ...out.hashtags.map((t): LoggedProposal => ({ item: t, kind: "hashtag", layer: "emit", source: "footer", reason: "footer" })),
    ...out.handles.map((h) => handleProposal(h, "emit")),
    ...items.map((t): LoggedProposal => ({ item: t.tag, kind: "hashtag", layer: "suggest", source: t.source, reason: t.reason })),
    ...out.handleSuggestions.map((h) => handleProposal(h, "suggest")),
  ];
}

export interface ComposeOptions {
  /** Share of posts whose proposals carry explore: true (brief §7.2.3); default EXPLORE_RATE. Tests pin it. */
  exploreRate?: number;
  /** The explore roll's source of randomness; Math.random by default */
  random?: () => number;
  /** Phase 1: a draft goes straight to the queue with no card; "Add card" asks for one */
  cardOnDemand?: boolean;
  /** The places and district-handles files, for breaking stories (required when any arrive) */
  data?: PhaseOneData;
}

/** Draft states that already went (or are going) out: a re-saved file never rewrites them */
const SENT = ["published", "recalled", "queued", "publishing"];

/** A pre-0023 row's district provenance, recovered by parsing its stored file again; null when that is not possible */
async function legacyDistrictFrom(tx: Tx, story: typeof stories.$inferSelect, book: Parameters<typeof recoverDistrictFrom>[3]) {
  if (!story.fileId || !story.sourceText || !story.district) return null;
  const [file] = await tx.select({ fileName: ingestedFiles.fileName }).from(ingestedFiles).where(eq(ingestedFiles.id, story.fileId));
  return recoverDistrictFrom(story.sourceText, file?.fileName, story.district, book);
}

async function composeBreakingStory(tx: Tx, story: typeof stories.$inferSelect, dictionaries: Dictionaries, log: Logger, opts: ComposeOptions) {
  if (!opts.data) throw new Error("Breaking stories need the places and handles files (compose started without them)");
  const { value: book, version: placesVersion } = await opts.data.places.get();
  const { value: rules, version: handlesVersion } = await opts.data.handles.get();
  const [
    { value: subjects, version: subjectsVersion }, { value: roster, version: reportersVersion }, { value: parties, version: partiesVersion },
    { value: normaliser, version: normaliseVersion }, { value: suggestRules, version: campaignsVersion }, { value: beats, version: beatsVersion }, dict,
  ] = await Promise.all([
    opts.data.subjects.get(),
    opts.data.reporters.get(),
    opts.data.parties.get(),
    opts.data.normalise.get(),
    opts.data.campaigns.get(),
    opts.data.beats.get(),
    // Settings handles are checked against the district- and subject-handles files (read just above and in this call)
    opts.data.subjects.get().then(({ value, version }) => dictionaries.topics({ rules, subjects: value, version: `h${handlesVersion}.s${version}` })),
  ]);
  const { topics, desk, learnedReporters, version: topicsVersion } = dict;
  const tags = asFileTags(story.fileTags);
  const place = book.district(story.district);
  const headline = story.headline ?? "";
  // The reporter and the district the file name states. The copy's district still decides (it sets the
  // hashtag); the file name fills a gap, cross-checks, and is the only source of the byline.
  const slot = slotFromTags(tags);
  const reporters = mergedReporters(roster, reportersVersion, learnedReporters, topicsVersion, log);
  const out = composeBreaking(
    {
      headline,
      points: (story.body ?? "").split("\n").filter(Boolean),
      district: story.district,
      // Only a stated district goes in line 1 or picks a handle (core storyDistrict). A row from before 0023 has
      // none: its stored file is parsed again for it; failing that storyDistrict's legacy rule applies
      districtFrom: story.districtFrom ?? (await legacyDistrictFrom(tx, story, book)),
      town: story.town,
      // No place: Rajasthan, unless the file came from the national desk
      rajasthan: place ? place.rajasthan : !tags?.other.includes("NWS"),
      leaderPost: LEADER_POST.test(headline),
      reporterToken: slot.reporterToken,
      fileDistrict: slot.district,
      unknownBureauCode: slot.unknownCode,
    },
    rules,
    book,
    {
      version: `p${placesVersion}.h${handlesVersion}.s${subjectsVersion}.r${reportersVersion}.y${partiesVersion}.n${normaliseVersion}.c${campaignsVersion}.b${beatsVersion}.t${shortVersion(topicsVersion)}`,
      topics, subjects, desk, reporters, parties, normaliser, suggestRules, beats,
      // The story's own arrival, so a re-saved or replayed file keeps the campaign window it came in
      at: story.createdAt,
    },
  );
  const needsCheck = out.headlineCut && !story.needsCheck.includes("headline_cut") ? [...story.needsCheck, "headline_cut"] : story.needsCheck;
  const content = {
    bodyText: out.bodyText,
    // Line 2 as composed ("" when there is none): Fit to 280 rebuilds line 2 only while the draft still carries it
    composerLine2: out.bodyText.split("\n\n")[1] ?? "",
    cardHeadline: headline,
    hashtags: out.hashtags,
    // Offered to the desk, never applied on their own
    hashtagSuggestions: out.hashtagSuggestions,
    mentions: out.mentions,
    // The rule-picked handles are in the post already; as suggestions too, they stay valid when the post is edited
    // Each with its rule id and reason line (source, reason) and, for the reporter prior, score and n
    mentionSuggestions: [
      ...out.handles.map((h) => mentionSuggestion(h, "rule", true)),
      // Offered and NOT in the post: police beside a party at a police venue, an institution named in passing,
      // the reporter's likely handles (prior, beat)
      ...out.handleSuggestions.map((h) => mentionSuggestion(h, "suggest", false)),
    ],
    composeMethod: "rules",
    composeVersion: out.composeVersion,
    // Why these handles: the class every rule hung off, and what the desk should look at but that never
    // blocked a tag (an unknown reporter token, an unknown district code)
    handlePick: {
      cls: out.cls,
      why: out.why,
      // The desk sees the missing byline as a line it can act on; the log keeps it out of `warnings`
      // because it is routine and would drown the rest
      warnings: [
        ...out.warnings,
        ...(out.unmatchedReporter ? [`the file names ${out.unmatchedReporter}, who is not in the reporter list, so no byline was added`] : []),
      ],
      handles: out.handles.map((h) => ({ handle: `@${h.handle}`, reason: h.reason, ...(h.title && { title: h.title }) })),
      suggested: out.handleSuggestions.map((h) => ({ handle: `@${h.handle}`, reason: h.reason, ...(h.title && { title: h.title }) })),
      reporterToken: slot.reporterToken,
      // hashtagSuggestions with the rule and reason behind each, for the desk (the column holds the strings)
      ...(out.hashtagSuggestionItems && { tagSuggestions: out.hashtagSuggestionItems }),
    },
  };

  // The decision log's proposal half (brief §2): what the file name said about the reporter, and every item with
  // its rule. Written in a savepoint that never fails or holds up the draft.
  const logProposal = async (draftId: string) => {
    // Everything, the file-name lookup included, runs inside the log's savepoint (recordProposal): the log is a
    // record, and if keeping it fails for any reason the draft still goes through
    try {
      // A failure is logged at error by the log itself, and a decided row marked stale at info: nothing to add here
      await recordProposal(tx, { orgId: story.orgId, draftId }, async (sp) => {
        const [file] = story.fileId ? await sp.select({ fileName: ingestedFiles.fileName }).from(ingestedFiles).where(eq(ingestedFiles.id, story.fileId)) : [];
        const who = resolveReporterStatus(file?.fileName ?? null, tags, reporters);
        const rate = opts.exploreRate ?? EXPLORE_RATE;
        const proposals = draftProposals(out, () => log.warn({ storyId: story.id, draftId }, "decision log: core gave no proposals; built them from the draft's fields"));
        return {
          orgId: story.orgId, draftId, storyId: story.id,
          filenameRaw: file?.fileName ?? null, slotRaw: who.slotRaw, reporterToken: who.reporterToken, bureauCode: who.bureauCode,
          bureauDistrict: who.bureauDistrict, reporterHandle: who.reporterHandle, reporterStatus: who.status,
          storyClass: out.cls, district: story.district, districtFrom: story.districtFrom ?? null, composeVersion: out.composeVersion,
          draftText: assemblePostText(out.bodyText, out.hashtags, out.mentions), proposals,
          explore: (opts.random ?? Math.random)() < rate,
        };
      });
    } catch (err) {
      // recordProposal never throws; this is the belt to its braces
      log.error({ err, storyId: story.id, draftId }, "decision log: proposal not written; the draft went through");
    }
  };

  // A re-saved file (the ingest stage sent its story back here): rewrite the unposted draft in place
  const [existing] = await tx.select().from(postDrafts).where(and(eq(postDrafts.storyId, story.id), eq(postDrafts.platform, "x"))).for("update");
  if (existing) {
    if (SENT.includes(existing.status)) {
      // Posted between the re-save and now: the post stays as it went out; the story keeps the new text
      log.warn({ storyId: story.id, draftId: existing.id, status: existing.status }, "re-saved file's draft already went out; draft left as it is");
    } else {
      const [row] = await tx
        .update(postDrafts)
        .set({
          ...content,
          // A card already asked for is drawn again with the new headline; none asked for stays none
          ...(existing.cardRev > 0 && existing.cardHeadline !== headline && { cardRev: sql`${postDrafts.cardRev} + 1` }),
          version: sql`${postDrafts.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(postDrafts.id, existing.id))
        .returning({ status: postDrafts.status, version: postDrafts.version });
      await notify(tx, story.orgId, { type: "draft.updated", draftId: existing.id, status: row!.status, version: row!.version });
      await logProposal(existing.id);
      log.info({ storyId: story.id, draftId: existing.id }, "re-saved file: draft rewritten in place");
    }
    await tx.update(stories).set({ status: "composed", needsCheck, updatedAt: sql`now()` }).where(eq(stories.id, story.id));
    return;
  }

  const ready = !!opts.cardOnDemand;
  const [draft] = await tx
    .insert(postDrafts)
    .values({ orgId: story.orgId, storyId: story.id, platform: "x", status: ready ? "ready" : "rendering", ...(ready && { cardRev: 0 }), ...content })
    .onConflictDoNothing()
    .returning({ id: postDrafts.id });
  await tx.update(stories).set({ status: "composed", needsCheck, updatedAt: sql`now()` }).where(eq(stories.id, story.id));
  if (draft) await logProposal(draft.id);
  // With no card to wait for the draft is in the queue now; otherwise the render worker announces it
  if (draft && ready) await notify(tx, story.orgId, { type: "story.arrived", storyId: story.id, draftIds: [draft.id] });
  // A reporter the list does not carry yet is routine — it is true of about 45% of files today and the
  // name is on the draft for the desk to see — so it goes in at info and does not fill the ops log with
  // warnings. Anything else (an unknown district code, a reporter filing from another district) is rarer
  // and worth a warning.
  if (out.warnings.length) log.warn({ storyId: story.id, draftId: draft?.id, cls: out.cls, warnings: out.warnings }, "breaking handles: something to look at");
  if (out.unmatchedReporter) {
    log.info({ storyId: story.id, draftId: draft?.id, reporterToken: out.unmatchedReporter }, "breaking handles: no byline, this reporter is not in the list");
  }
  log.info({ storyId: story.id, draftId: draft?.id, district: story.district, districtFrom: story.districtFrom, cls: out.cls, hashtags: out.hashtags, handles: out.mentions }, "breaking draft composed");
}

export async function composeNext(db: Db, dictionaries: Dictionaries, log: Logger, opts: ComposeOptions = {}): Promise<boolean> {
  return nextStoryIsolated(db, "converted", log, "compose", async (tx, story) => {
    if (story.layout === "breaking") return composeBreakingStory(tx, story, dictionaries, log, opts);

    const { composer } = await dictionaries.composer();
    const content = await composer.compose({ headline: story.headline ?? "", body: story.body ?? "", place: story.district }, "x");

    const [draft] = await tx
      .insert(postDrafts)
      .values({
        orgId: story.orgId,
        storyId: story.id,
        platform: "x",
        status: opts.cardOnDemand ? "ready" : "rendering",
        ...(opts.cardOnDemand && { cardRev: 0 }),
        bodyText: content.bodyText,
        cardHeadline: story.headline ?? "",
        hashtags: content.hashtags,
        mentionSuggestions: content.mentionSuggestions,
        composeMethod: content.composeMethod,
        composeVersion: content.composeVersion,
      })
      .onConflictDoNothing()
      .returning({ id: postDrafts.id });
    await tx.update(stories).set({ status: "composed", updatedAt: sql`now()` }).where(eq(stories.id, story.id));
    if (draft && opts.cardOnDemand) await notify(tx, story.orgId, { type: "story.arrived", storyId: story.id, draftIds: [draft.id] });
    log.info({ storyId: story.id, draftId: draft?.id, hashtags: content.hashtags, suggestions: content.mentionSuggestions.length }, "draft composed");
  });
}
