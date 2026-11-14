// Live presence and watch mode: who has which story open, and the holder's live text for those watching.
// Transport-free: routes/live.ts carries it (SSE server → browser, REST POSTs browser → server). A "client" is
// one open stream (one browser tab); it has a server-made clientId that its POSTs quote.
//
// Everything here lives in this process's memory; nothing is written to the database. Socia runs one API
// instance. Several instances would need shared state (clients, presence, last edit state, take-over requests and
// cooldowns, rate-limit windows, the holder cache, e.g. in Redis), since a stream on one instance would not see the
// people on another.
//
// The lock itself stays where it is (post_drafts.claimed_by / claim_expires_at, through the REST API). It is one
// record for both kinds of hold: a claim (status claimed) and a correction hold on a posted story (status published),
// so a story has at most one holder. This module only reads it, to decide who may stream edit.state, and never moves
// it: a take-over is the holder's browser releasing and the requester's browser claiming, both over REST. A story
// under correction cannot be taken over (the correction rules decide who may fix a post, not a request).
// Whichever way a hold ends (release, Done, expiry, midnight IST), the next read of the record finds no holder and
// the story's clients get edit.ended.
//
// Actions (from POST /live/*), each answering { ok, error?, mode? }. Rate limits are per person (summed over all
// of that user's streams), in a sliding one-second window:
//   join             { draftId, mode: "edit" | "watch" }          → { ok, mode }        10/s
//   leave            { draftId }                                                       10/s
//   state            { draftId, text, selStart, selEnd, version }  holder only           6/s
//                    text ≤ 2000 chars, no control characters but \n and \t, ≤ MAX_STATE_BYTES as JSON
//   takeover.request { draftId }   only someone who could take the story; once per 10 s per story   3/s
//                    never on a posted story under a correction hold: { ok: false, error: "correcting" } (409)
//   takeover.answer  { draftId, requesterId, accept }               holder only           5/s
// Events (to clients):
//   presence.list       { stories: Record<draftId, { userId, name, initials, color, mode, correcting }[]> }
//                       correcting: this person holds the story and it is a posted story under a correction hold
//   edit.state          { draftId, text, selStart, selEnd, version, userId, name, color, at, correcting }
//                       (story's clients but the sender); correcting: the text is a correction of a posted story
//   edit.snapshot       same shape, to a watcher that joins
//   edit.ended          { draftId, userId }
//   takeover.requested  { draftId, from: { userId, name, color } }
//   takeover.answered   { draftId, accept, by: { userId, name } }

import { postDrafts, type Db } from "@socia/db";
import { and, eq } from "drizzle-orm";
import type { SessionUser } from "./auth";

/**
 * The presence palette; every colour is readable with white text. The frontend can use the same list and hash:
 *   ["#E8590C","#7048E8","#0C8599","#2B8A3E","#C2255C","#1971C2","#E67700","#5F3DC4"]
 * Hash: 32-bit FNV-1a over the userId's UTF-16 code units (h = 0x811c9dc5; for each unit: h ^= unit;
 * h = Math.imul(h, 0x01000193) >>> 0), then PRESENCE_COLORS[h % 8].
 */
export const PRESENCE_COLORS = ["#E8590C", "#7048E8", "#0C8599", "#2B8A3E", "#C2255C", "#1971C2", "#E67700", "#5F3DC4"] as const;

export function presenceColor(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

/** The first letters of the first two words, uppercased: "Asha Rani Verma" → "AR" */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? "")
    .join("")
    .toUpperCase();
}

export const MAX_EDIT_TEXT = 2000;
/**
 * The edit.state broadcast as JSON, in UTF-8 bytes. 2000 characters of Devanagari are about 6 KB, so a valid state
 * never reaches it; it bounds what every watcher is sent whatever the text is.
 */
export const MAX_STATE_BYTES = 8 * 1024;
export const TAKEOVER_COOLDOWN_MS = 10_000;
const TAKEOVER_TTL_MS = 60_000;
export const HOLDER_REFRESH_MS = 30_000;
export const LIST_THROTTLE_MS = 250;
/** Per person, per second */
export const RATE_LIMITS = { join: 10, leave: 10, state: 6, request: 3, answer: 5 } as const;
type RateKind = keyof typeof RATE_LIMITS;
/** Stream opens per person per minute (GET /live/stream; the probe does not count) */
export const STREAM_OPENS_PER_MIN = 10;
/** A person's rate windows are kept this long after their last stream closes, so closing and reopening resets nothing */
export const RATE_IDLE_MS = 10 * 60_000;
/** How often windows idle past RATE_IDLE_MS are swept */
export const RATE_SWEEP_MS = 60_000;

interface Rates {
  hits: Record<RateKind | "open", number[]>;
  /** When the person's last stream closed (or the windows were made with none open); null while one is open */
  idleSince: number | null;
}

/** Events from the LISTEN fan-out after which a draft's holder is read again */
const HOLDER_EVENTS = new Set(["draft.claimed", "draft.released", "draft.updated"]);
/** The statuses in which claimed_by is a live hold, as views.ts reads it: a claim, or a correction hold on a posted story */
const HELD_STATUSES = new Set(["claimed", "published"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control characters but \n and \t (C0, DEL, C1): refused in edit text */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

export type Mode = "edit" | "watch";
export interface PresenceResult {
  ok: boolean;
  error?: string;
  mode?: Mode;
}

/** One open stream. `send` must never throw; `close` ends the stream (and the transport then calls disconnect). */
export interface LiveClient {
  id: string;
  user: SessionUser;
  sessionId: string;
  /** The platform the stream was opened for: its presence list, its queue events, and the stories it may join */
  platform: string;
  send(event: string, data: unknown): void;
  /** Too far behind to be sent live text: edit.state skips it (the next state, or a snapshot on re-join, catches up) */
  lagging(): boolean;
  close(): void;
}

interface EditState {
  draftId: string;
  text: string;
  selStart: number;
  selEnd: number;
  version: number;
  userId: string;
  name: string;
  color: string;
  at: string;
  /** A correction of a posted story (the hold is on a published draft) */
  correcting: boolean;
}

interface Holder {
  holderId: string;
  expiresAt: number;
  /** A correction hold on a posted story (status published), not a claim */
  correcting: boolean;
}

interface DraftState {
  orgId: string;
  platform: string;
  holder: Holder | null;
  /** client ids on this story */
  members: Set<string>;
  last: EditState | null;
  /** Senders whose edit.state already caused a DB read since the holder last changed */
  checkedSenders: Set<string>;
  /** requesterId → expiry (ms): a request waiting for the holder's answer */
  takeovers: Map<string, number>;
  refreshing: Promise<void> | null;
  /** A change event arrived while a read was in flight: read again when it finishes */
  dirty: boolean;
}

interface ClientState {
  client: LiveClient;
  draftId: string | null;
  mode: Mode;
}

/** Sliding window (one second unless given): true when another hit is allowed (and records it) */
function allow(hits: number[], limit: number, now: number, windowMs = 1000): boolean {
  while (hits.length && hits[0]! <= now - windowMs) hits.shift();
  if (hits.length >= limit) return false;
  hits.push(now);
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

interface HubLog {
  warn(obj: object, msg: string): void;
}

export interface PresenceOptions {
  db: Db;
  log: HubLog;
  refreshMs?: number;
  throttleMs?: number;
  takeoverCooldownMs?: number;
  maxStateBytes?: number;
  /**
   * Whether this user could take the story if the holder let go (routes/live.ts: claim rights). "correcting": the
   * story is a posted story under a correction hold, which is never taken over. Absent: anyone.
   */
  mayTakeOver?: (user: SessionUser, draftId: string) => Promise<boolean | "correcting">;
  /** Stream opens per person per minute (STREAM_OPENS_PER_MIN) */
  streamOpensPerMin?: number;
  /** How long a person's rate windows outlive their last stream (RATE_IDLE_MS) */
  rateIdleMs?: number;
  /** How often idle rate windows are swept (RATE_SWEEP_MS) */
  rateSweepMs?: number;
}

export class PresenceHub {
  private readonly clients = new Map<string, ClientState>();
  private readonly drafts = new Map<string, DraftState>();
  /** userId → rate windows, shared by all of that user's streams; swept RATE_IDLE_MS after their last stream closes */
  private readonly rates = new Map<string, Rates>();
  /** `${draftId}:${userId}` → when that person may ask for that story again; kept across leave and re-join */
  private readonly cooldowns = new Map<string, number>();
  private readonly listTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastList = new Map<string, number>();
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly throttleMs: number;

  constructor(private readonly opts: PresenceOptions) {
    this.throttleMs = opts.throttleMs ?? LIST_THROTTLE_MS;
    // Leases are extended by heartbeat without an event, and can lapse: re-read the lock where someone edits, or
    // where the cached lease has run out
    this.refreshTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, until] of this.cooldowns) if (until <= now) this.cooldowns.delete(key);
      for (const [draftId, d] of this.drafts) {
        for (const [rid, exp] of d.takeovers) if (exp <= now) d.takeovers.delete(rid);
        const editing = [...d.members].some((cid) => this.clients.get(cid)?.mode === "edit");
        if (editing || (d.holder && d.holder.expiresAt <= now)) void this.refreshHolder(draftId);
      }
    }, opts.refreshMs ?? HOLDER_REFRESH_MS);
    this.refreshTimer.unref();
    this.sweepTimer = setInterval(() => this.sweepRates(), opts.rateSweepMs ?? RATE_SWEEP_MS);
    this.sweepTimer.unref();
  }

  // ─── Clients ───────────────────────────────────────────────────────────────

  get(clientId: string): LiveClient | undefined {
    return this.clients.get(clientId)?.client;
  }

  /** A new stream: registered, then given the current list */
  connect(client: LiveClient): void {
    this.clients.set(client.id, { client, draftId: null, mode: "watch" });
    this.ratesOf(client.user.id).idleSince = null;
    client.send("presence.list", { stories: this.storiesFor(client.user.orgId, client.platform) });
  }

  /** The stream closed: leave everything */
  disconnect(clientId: string): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    this.leaveCurrent(c);
    this.clients.delete(clientId);
    const userId = c.client.user.id;
    // The windows stay (closing and reopening resets nothing); the sweep drops them once idle long enough
    if (!this.hasStream(userId)) this.ratesOf(userId).idleSince = Date.now();
  }

  private hasStream(userId: string): boolean {
    return [...this.clients.values()].some((o) => o.client.user.id === userId);
  }

  private ratesOf(userId: string): Rates {
    let r = this.rates.get(userId);
    if (!r) {
      r = { hits: { join: [], leave: [], state: [], request: [], answer: [], open: [] }, idleSince: this.hasStream(userId) ? null : Date.now() };
      this.rates.set(userId, r);
    }
    return r;
  }

  private allowed(user: SessionUser, kind: RateKind): boolean {
    return allow(this.ratesOf(user.id).hits[kind], RATE_LIMITS[kind], Date.now());
  }

  /** A stream may be opened (and the open is counted): at most streamOpensPerMin per person in a sliding minute */
  allowOpen(user: SessionUser): boolean {
    return allow(this.ratesOf(user.id).hits.open, this.opts.streamOpensPerMin ?? STREAM_OPENS_PER_MIN, Date.now(), 60_000);
  }

  /** Drops the windows of people with no stream whose last one closed at least rateIdleMs ago */
  sweepRates(now = Date.now()): void {
    const idleMs = this.opts.rateIdleMs ?? RATE_IDLE_MS;
    for (const [userId, r] of this.rates) {
      if (r.idleSince !== null && now - r.idleSince >= idleMs && !this.hasStream(userId)) this.rates.delete(userId);
    }
  }

  // ─── presence.list ─────────────────────────────────────────────────────────

  private storiesFor(orgId: string, platform: string) {
    type Entry = { userId: string; name: string; initials: string; color: string; mode: Mode; correcting: boolean };
    const stories: Record<string, Entry[]> = {};
    for (const [draftId, d] of this.drafts) {
      if (d.orgId !== orgId || d.platform !== platform || d.members.size === 0) continue;
      const people = new Map<string, Entry>();
      const fixer = d.holder?.correcting ? d.holder.holderId : null;
      for (const cid of d.members) {
        const c = this.clients.get(cid);
        if (!c) continue;
        const u = c.client.user;
        const seen = people.get(u.id);
        if (seen) {
          if (c.mode === "edit") seen.mode = "edit";
        } else {
          people.set(u.id, { userId: u.id, name: u.name, initials: initials(u.name), color: presenceColor(u.id), mode: c.mode, correcting: u.id === fixer });
        }
      }
      if (people.size) stories[draftId] = [...people.values()];
    }
    return stories;
  }

  private flushList(orgId: string) {
    this.listTimers.delete(orgId);
    this.lastList.set(orgId, Date.now());
    const byPlatform = new Map<string, unknown>();
    for (const { client } of this.clients.values()) {
      if (client.user.orgId !== orgId) continue;
      let data = byPlatform.get(client.platform);
      if (!data) byPlatform.set(client.platform, (data = { stories: this.storiesFor(orgId, client.platform) }));
      client.send("presence.list", data);
    }
  }

  /** At most one broadcast per org per throttleMs; the last change in a burst is always sent */
  private scheduleList(orgId: string) {
    if (this.listTimers.has(orgId)) return;
    const wait = Math.max(0, (this.lastList.get(orgId) ?? 0) + this.throttleMs - Date.now());
    const t = setTimeout(() => this.flushList(orgId), wait);
    t.unref();
    this.listTimers.set(orgId, t);
  }

  // ─── Holder cache ──────────────────────────────────────────────────────────

  private isHolder(d: DraftState, userId: string, now = Date.now()) {
    return !!d.holder && d.holder.holderId === userId && d.holder.expiresAt > now;
  }

  private toStory(d: DraftState, event: string, data: unknown, exceptClientId?: string) {
    for (const cid of d.members) if (cid !== exceptClientId) this.clients.get(cid)?.client.send(event, data);
  }

  private endEdit(draftId: string, d: DraftState, userId: string) {
    d.last = null;
    this.toStory(d, "edit.ended", { draftId, userId });
  }

  /** The holder changed: the old one's clients drop to watch, their live text ends */
  private setHolder(draftId: string, d: DraftState, next: Holder | null) {
    const prev = d.holder;
    d.holder = next;
    if ((prev?.holderId ?? null) === (next?.holderId ?? null)) {
      // The same holder, another kind of hold (a claim that became a correction): the list says which
      if (prev && next && prev.correcting !== next.correcting) this.scheduleList(d.orgId);
      return;
    }
    d.checkedSenders.clear();
    if (!prev) return;
    let changed = false;
    for (const c of this.clientsOf(d, prev.holderId)) {
      if (c.mode === "edit") {
        c.mode = "watch";
        changed = true;
      }
    }
    this.endEdit(draftId, d, prev.holderId);
    d.takeovers.clear();
    if (changed) this.scheduleList(d.orgId);
  }

  private async readDraft(draftId: string, orgId: string) {
    const [row] = await this.opts.db
      .select({ platform: postDrafts.platform, status: postDrafts.status, claimedBy: postDrafts.claimedBy, claimExpiresAt: postDrafts.claimExpiresAt })
      .from(postDrafts)
      .where(and(eq(postDrafts.id, draftId), eq(postDrafts.orgId, orgId)));
    return row ?? null;
  }

  private holderOf(row: { status: string; claimedBy: string | null; claimExpiresAt: Date | null }): Holder | null {
    if (!HELD_STATUSES.has(row.status) || !row.claimedBy || !row.claimExpiresAt || row.claimExpiresAt.getTime() <= Date.now()) return null;
    return { holderId: row.claimedBy, expiresAt: row.claimExpiresAt.getTime(), correcting: row.status === "published" };
  }

  /**
   * Read the lock again. Concurrent callers share one read; a call that arrives while a read is in flight marks the
   * draft dirty, and the read is repeated once it finishes, so a change made after the first read began is never lost.
   */
  private refreshHolder(draftId: string): Promise<void> {
    const d = this.drafts.get(draftId);
    if (!d) return Promise.resolve();
    if (d.refreshing) {
      d.dirty = true;
      return d.refreshing;
    }
    const run = async () => {
      do {
        d.dirty = false;
        try {
          const row = await this.readDraft(draftId, d.orgId);
          if (this.drafts.get(draftId) !== d) return;
          this.setHolder(draftId, d, row ? this.holderOf(row) : null);
        } catch (err) {
          this.opts.log.warn({ err, draftId }, "presence: could not read the draft's holder");
          return;
        }
      } while (d.dirty && this.drafts.get(draftId) === d);
    };
    d.refreshing = run().finally(() => {
      d.refreshing = null;
    });
    return d.refreshing;
  }

  /** From the LISTEN fan-out: a lock may have moved */
  onEvent(orgId: string, event: { type: string; draftId?: unknown }): void {
    if (!HOLDER_EVENTS.has(event.type) || typeof event.draftId !== "string") return;
    const d = this.drafts.get(event.draftId);
    if (d && d.orgId === orgId) void this.refreshHolder(event.draftId);
  }

  /** The event listener reconnected: anything may have moved meanwhile, so every tracked draft reads its lock again */
  refreshAll(): Promise<void> {
    return Promise.all([...this.drafts.keys()].map((id) => this.refreshHolder(id))).then(() => undefined);
  }

  // ─── Membership ────────────────────────────────────────────────────────────

  private clientsOf(d: DraftState, userId: string): ClientState[] {
    return [...d.members].map((cid) => this.clients.get(cid)).filter((c): c is ClientState => !!c && c.client.user.id === userId);
  }

  private leaveCurrent(c: ClientState) {
    const draftId = c.draftId;
    if (!draftId) return;
    c.draftId = null;
    const wasEditing = c.mode === "edit";
    c.mode = "watch";
    const d = this.drafts.get(draftId);
    if (!d) return;
    d.members.delete(c.client.id);
    const userId = c.client.user.id;
    // The holder's last editing tab is gone: watchers stop seeing live text
    const mine = this.clientsOf(d, userId);
    if (wasEditing && !mine.some((o) => o.mode === "edit")) this.endEdit(draftId, d, userId);
    // A requester gone from this story no longer waits for an answer (the cooldown stays)
    if (!mine.length) d.takeovers.delete(userId);
    if (d.members.size === 0) this.drafts.delete(draftId);
    this.scheduleList(d.orgId);
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  async join(clientId: string, p: unknown): Promise<PresenceResult> {
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    const user = c.client.user;
    if (!this.allowed(user, "join")) return { ok: false, error: "rate_limited" };
    if (!isObj(p) || !isId(p.draftId) || (p.mode !== "edit" && p.mode !== "watch")) return { ok: false, error: "bad_request" };
    const { draftId } = p;
    const row = await this.readDraft(draftId, user.orgId);
    if (this.clients.get(clientId) !== c) return { ok: false, error: "unknown_client" };
    // A stream works on its own platform's stories only (its list would never show any other)
    if (!row || row.platform !== c.client.platform || (user.platformScoped && !user.platforms.includes(row.platform))) return { ok: false, error: "not_found" };

    if (c.draftId && c.draftId !== draftId) this.leaveCurrent(c);
    let d = this.drafts.get(draftId);
    if (!d) {
      d = { orgId: user.orgId, platform: row.platform, holder: null, members: new Set(), last: null, checkedSenders: new Set(), takeovers: new Map(), refreshing: null, dirty: false };
      this.drafts.set(draftId, d);
    }
    this.setHolder(draftId, d, this.holderOf(row));
    d.checkedSenders.add(user.id);

    const mode: Mode = p.mode === "edit" && this.isHolder(d, user.id) ? "edit" : "watch";
    const changed = c.draftId !== draftId || c.mode !== mode;
    // Stepping down from edit in this tab (re-join as watch) ends the live text if no other tab edits
    if (c.draftId === draftId && c.mode === "edit" && mode === "watch") {
      c.mode = "watch";
      if (!this.clientsOf(d, user.id).some((o) => o.mode === "edit")) this.endEdit(draftId, d, user.id);
    }
    c.draftId = draftId;
    c.mode = mode;
    d.members.add(clientId);
    if (mode === "watch" && d.last) c.client.send("edit.snapshot", d.last);
    if (changed) this.scheduleList(d.orgId);
    return { ok: true, mode };
  }

  leave(clientId: string, p: unknown): PresenceResult {
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    if (!this.allowed(c.client.user, "leave")) return { ok: false, error: "rate_limited" };
    if (!isObj(p) || !isId(p.draftId)) return { ok: false, error: "bad_request" };
    if (c.draftId === p.draftId) this.leaveCurrent(c);
    return { ok: true };
  }

  async state(clientId: string, p: unknown): Promise<PresenceResult> {
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    const user = c.client.user;
    if (!isObj(p) || !isId(p.draftId) || typeof p.text !== "string" || !isCount(p.selStart) || !isCount(p.selEnd) || !isCount(p.version)) {
      return { ok: false, error: "bad_request" };
    }
    if (CONTROL.test(p.text)) return { ok: false, error: "bad_request" };
    if (!this.allowed(user, "state")) return { ok: false, error: "rate_limited" };
    if (p.text.length > MAX_EDIT_TEXT) return { ok: false, error: "too_long" };
    const { draftId } = p;
    let d = this.drafts.get(draftId);
    if (!d || c.draftId !== draftId) return { ok: false, error: "not_holder" };
    // A new sender, or a holder whose cached lease ran out (heartbeats extend it without an event): read the lock
    if (!d.checkedSenders.has(user.id) || (d.holder?.holderId === user.id && !this.isHolder(d, user.id))) {
      await this.refreshHolder(draftId);
      d.checkedSenders.add(user.id);
    }
    d = this.drafts.get(draftId);
    if (!d || c.draftId !== draftId || !this.isHolder(d, user.id)) return { ok: false, error: "not_holder" };

    const state: EditState = {
      draftId,
      text: p.text,
      selStart: p.selStart,
      selEnd: p.selEnd,
      version: p.version,
      userId: user.id,
      name: user.name,
      color: presenceColor(user.id),
      at: new Date().toISOString(),
      correcting: d.holder!.correcting,
    };
    if (Buffer.byteLength(JSON.stringify(state)) > (this.opts.maxStateBytes ?? MAX_STATE_BYTES)) return { ok: false, error: "too_long" };

    if (c.mode !== "edit") {
      c.mode = "edit";
      this.scheduleList(d.orgId);
    }
    d.last = state;
    // A watcher far behind is skipped rather than buffered towards the stream's close; it catches up on the next state
    for (const cid of d.members) {
      if (cid === clientId) continue;
      const o = this.clients.get(cid)?.client;
      if (o && !o.lagging()) o.send("edit.state", state);
    }
    return { ok: true };
  }

  async takeoverRequest(clientId: string, p: unknown): Promise<PresenceResult> {
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    const user = c.client.user;
    if (!this.allowed(user, "request")) return { ok: false, error: "rate_limited" };
    if (!isObj(p) || !isId(p.draftId)) return { ok: false, error: "bad_request" };
    const { draftId } = p;
    const key = `${draftId}:${user.id}`;
    // Still waiting for an answer: "pending"; asked (and answered, or left) within the cooldown: "cooldown". Both
    // are answered from memory, before any database read, so asking again and again costs no reads
    const waiting = (now: number): PresenceResult | null => {
      const pending = this.drafts.get(draftId)?.takeovers.get(user.id);
      if (pending && pending > now) return { ok: false, error: "pending" };
      if ((this.cooldowns.get(key) ?? 0) > now) return { ok: false, error: "cooldown" };
      return null;
    };
    if (!this.drafts.has(draftId) || c.draftId !== draftId) return { ok: false, error: "not_joined" };
    const early = waiting(Date.now());
    if (early) return early;
    // No holder cached, or its cached lease has run out: read the lock before answering
    const cached = this.drafts.get(draftId)!.holder;
    if (!cached || cached.expiresAt <= Date.now()) await this.refreshHolder(draftId);
    let d = this.drafts.get(draftId);
    if (!d || c.draftId !== draftId) return { ok: false, error: "not_joined" };
    const holder = d.holder && d.holder.expiresAt > Date.now() ? d.holder : null;
    if (!holder) return { ok: false, error: "no_holder" };
    if (holder.holderId === user.id) return { ok: false, error: "already_holder" };
    // A posted story under correction is never taken over: who may fix a post is the correction rules' call
    if (holder.correcting) return { ok: false, error: "correcting" };
    // Only someone who could take the story may ask: else the holder would let go and nobody could take it. This
    // reads the draft again, so a correction hold the cache has not seen yet is refused as well
    if (this.opts.mayTakeOver) {
      const may = await this.opts.mayTakeOver(user, draftId);
      if (may === "correcting") return { ok: false, error: "correcting" };
      if (!may) return { ok: false, error: "forbidden" };
    }
    d = this.drafts.get(draftId);
    if (!d || c.draftId !== draftId) return { ok: false, error: "not_joined" };
    const now = Date.now();
    // Again after the reads: another request let through meanwhile is now the pending one
    const late = waiting(now);
    if (late) return late;
    const targets = this.clientsOf(d, holder.holderId);
    if (!targets.length) return { ok: false, error: "holder_away" };
    d.takeovers.set(user.id, now + TAKEOVER_TTL_MS);
    this.cooldowns.set(key, now + (this.opts.takeoverCooldownMs ?? TAKEOVER_COOLDOWN_MS));
    for (const t of targets) t.client.send("takeover.requested", { draftId, from: { userId: user.id, name: user.name, color: presenceColor(user.id) } });
    return { ok: true };
  }

  async takeoverAnswer(clientId: string, p: unknown): Promise<PresenceResult> {
    const c = this.clients.get(clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    const user = c.client.user;
    if (!this.allowed(user, "answer")) return { ok: false, error: "rate_limited" };
    if (!isObj(p) || !isId(p.draftId) || !isId(p.requesterId) || typeof p.accept !== "boolean") return { ok: false, error: "bad_request" };
    const { draftId, requesterId, accept } = p;
    if (!this.drafts.has(draftId) || c.draftId !== draftId) return { ok: false, error: "not_holder" };
    if (!this.isHolder(this.drafts.get(draftId)!, user.id)) await this.refreshHolder(draftId);
    const d = this.drafts.get(draftId);
    if (!d || c.draftId !== draftId || !this.isHolder(d, user.id)) return { ok: false, error: "not_holder" };
    const pending = d.takeovers.get(requesterId);
    d.takeovers.delete(requesterId);
    if (!pending || pending <= Date.now()) return { ok: false, error: "no_request" };
    for (const t of this.clientsOf(d, requesterId)) t.client.send("takeover.answered", { draftId, accept, by: { userId: user.id, name: user.name } });
    return { ok: true };
  }

  close(): void {
    clearInterval(this.refreshTimer);
    clearInterval(this.sweepTimer);
    for (const t of this.listTimers.values()) clearTimeout(t);
    this.listTimers.clear();
  }
}
