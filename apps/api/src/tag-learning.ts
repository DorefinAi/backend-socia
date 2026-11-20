// What the desk's posts are learned from (core learn.ts, packages/db learn.ts): the worker's places file and its four
// directory files, the same files and the same *_FILE overrides as the worker. Each is read again when it changes
// (WatchedJson: checked at most once a minute, a file that cannot be read keeps its last good copy). Until every file
// has been read once there is no learner (failing safe: the post goes out, the hashtags are staged, nothing is learned),
// because a handle can only be cleared for learning against the full lists of the files' handles.

import {
  PlaceBook, PostedLearner, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, type SubjectRules,
} from "@socia/core";
import type { FastifyBaseLogger } from "fastify";
import { DISTRICT_HANDLES_FILE, REPORTER_HANDLES_FILE, SUBJECT_HANDLES_FILE, WatchedJson } from "./handle-keywords";
import { PARTY_HANDLES_FILE, PLACES_FILE } from "./handle-search";

export class PostedTagLearning {
  private readonly places: WatchedJson<PlaceBook>;
  private readonly subjects: WatchedJson<SubjectRules>;
  private readonly district: WatchedJson<ReadonlySet<string>>;
  private readonly party: WatchedJson<ReadonlySet<string>>;
  private readonly reporter: WatchedJson<ReadonlySet<string>>;
  private built: { parts: unknown[]; value: PostedLearner } | null = null;

  constructor(log: FastifyBaseLogger, env = process.env) {
    this.places = new WatchedJson(env.PLACES_FILE ?? PLACES_FILE, (j) => new PlaceBook(parsePlacesData(j)), log);
    this.subjects = new WatchedJson(env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE, (j) => parseSubjectHandles(j), log);
    this.district = new WatchedJson(env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j).all ?? new Set<string>(), log);
    this.party = new WatchedJson(env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE, (j) => parsePartyHandles(j).handles ?? new Set<string>(), log);
    this.reporter = new WatchedJson(env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE, (j) => parseReporterHandles(j).handles ?? new Set<string>(), log);
  }

  /** The learner for the files as they are now; null until all five have been read */
  async learner(): Promise<PostedLearner | null> {
    const parts = await Promise.all([this.places.get(), this.subjects.get(), this.district.get(), this.party.get(), this.reporter.get()]);
    const [book, subjects, district, party, reporter] = parts;
    if (!book || !subjects || !district || !party || !reporter) return null;
    // Rebuilt only when a file's parsed copy changed
    if (this.built && this.built.parts.every((p, i) => p === parts[i])) return this.built.value;
    const value = new PostedLearner({ book, subjects, fileHandles: [...district, ...subjects.handles ?? [], ...party, ...reporter] });
    this.built = { parts, value };
    return value;
  }
}
