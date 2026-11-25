// The read role (speech, off by default): sends each probed clip to the media service (apps/xvideos/media), which runs speech-to-text and
// takes the frames on the GPU, one clip at a time. When the service is down, loading or busy with that clip, the clip
// waits without using up a try; a timeout or an error counts as a failed try.

import type { Db } from "@socia/db";
import { xvClaimJob, xvDeferJob, xvFailJob, xvFinishJob, xvSaveEvidence, xvSetProgress } from "../db/clips";
import type { XvEvidence } from "../db/schema";
import type { Logger } from "pino";
import type { XvShareReader } from "./share";

/** A 10-minute clip reads in well under a minute; past this the service is stuck on it */
const READ_TIMEOUT_MS = 10 * 60_000;
/** Longer than the timeout, so the lease never runs out while the request is still open */
const LEASE_S = 12 * 60;
/** While the media service is down, a clip is asked again after this many seconds */
const SERVICE_DOWN_RETRY_S = 60;

/** The service is not there or not ready: the clip waits, no try used */
export class XvMediaDown extends Error {
  constructor(reason: string) {
    super(`The X Videos media service is not answering (${reason}).`);
    this.name = "XvMediaDown";
  }
}

/** What POST /read answers (services/xvideos-media/media.py): stills are file names in XVIDEOS_CACHE/frames/<clip id> */
export interface XvReadAnswer {
  mediaVersion: string;
  language: string;
  tookS: number;
  durationS: number;
  hasAudio: boolean;
  transcript: XvEvidence["transcript"];
  cutTimes: number[];
  frames: { at: number; file: string }[];
  contactSheet: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The answer's shape, checked: a bad body is a failed read, never empty evidence */
export function parseReadAnswer(body: unknown): XvReadAnswer {
  const a = body as Partial<XvReadAnswer> | null;
  const ok =
    !!a &&
    typeof a.mediaVersion === "string" &&
    typeof a.language === "string" &&
    isNum(a.tookS) &&
    isNum(a.durationS) &&
    Array.isArray(a.transcript) &&
    a.transcript.every((l) => isNum(l?.at) && isNum(l?.end) && typeof l?.text === "string") &&
    Array.isArray(a.cutTimes) &&
    a.cutTimes.every(isNum) &&
    Array.isArray(a.frames) &&
    a.frames.every((f) => isNum(f?.at) && typeof f?.file === "string" && /^[\w.-]+\.jpg$/.test(f.file)) &&
    (a.contactSheet === null || (typeof a.contactSheet === "string" && /^[\w.-]+\.jpg$/.test(a.contactSheet)));
  if (!ok) throw new Error("the media service sent an answer in the wrong shape");
  return a as XvReadAnswer;
}

/** The service's answer → the evidence kept for the clip, stills as keys under XVIDEOS_CACHE */
export function xvEvidenceOf(clipId: string, a: XvReadAnswer): XvEvidence {
  const key = (file: string) => `frames/${clipId}/${file}`;
  return {
    mediaVersion: a.mediaVersion,
    language: a.language,
    tookS: a.tookS,
    transcript: a.transcript,
    cutTimes: a.cutTimes,
    frames: a.frames.map((f) => ({ at: f.at, key: key(f.file) })),
    contactSheetKey: a.contactSheet ? key(a.contactSheet) : null,
  };
}

export class XvMediaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
  ) {}

  /** `path`: the file on the share. Throws XvMediaDown when the clip should simply wait. */
  async read(clipId: string, path: string): Promise<XvReadAnswer> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/read`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-xvideos-key": this.key },
        body: JSON.stringify({ clipId, path }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") throw new Error(`the media service did not finish in ${READ_TIMEOUT_MS / 60_000} min`);
      throw new XvMediaDown((err as Error).message);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`the media service answered ${res.status} without JSON`);
    }
    const error = (body as { error?: unknown })?.error;
    // 503: model loading; 409: this clip is already being read (an earlier request the worker gave up on)
    if (res.status === 503 || res.status === 409) throw new XvMediaDown(typeof error === "string" ? error : `status ${res.status}`);
    if (!res.ok) throw new Error(typeof error === "string" ? error : `the media service answered ${res.status}`);
    return parseReadAnswer(body);
  }
}

export class XvReadStep {
  private downLogged = false;

  constructor(
    private readonly db: Db,
    private readonly share: XvShareReader,
    private readonly media: XvMediaClient,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<boolean> {
    const job = await xvClaimJob(this.db, "read", LEASE_S);
    if (!job) return false;
    const path = this.share.pathOf(job.clip.folder, job.clip.fileName);
    try {
      await xvSetProgress(this.db, job.clipId, 20);
      const evidence = xvEvidenceOf(job.clipId, await this.media.read(job.clipId, path));
      await xvSaveEvidence(this.db, job.clipId, evidence);
      if (!(await xvFinishJob(this.db, job, null))) {
        this.log.warn({ clip: job.clipId }, "x videos read finished after its lease ran out; left to the newer run");
        return true;
      }
      if (this.downLogged) {
        this.downLogged = false;
        this.log.info("x videos media service is back");
      }
      this.log.info({ clip: job.clipId, file: job.clip.fileName, tookS: evidence.tookS, lines: evidence.transcript.length }, "x videos read");
    } catch (err) {
      if (err instanceof XvMediaDown) {
        await xvDeferJob(this.db, job, SERVICE_DOWN_RETRY_S, err.message);
        if (!this.downLogged) {
          this.downLogged = true;
          this.log.error({ err: err.message }, "x videos media service down or busy; clips wait in reading");
        }
        return false;
      }
      const message = (err as Error).message.split(this.share.root).join("<share>");
      const outcome = await xvFailJob(this.db, job, `read: ${message}`);
      this.log.warn({ clip: job.clipId, file: job.clip.fileName, outcome, err: message }, "x videos read failed");
    }
    return true;
  }
}
