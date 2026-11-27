// The media service's client (apps/xvideos/media: /read, /screen, /speech) and the read role.
// The read role (speech, off by default): sends each probed clip to the media service, which runs speech-to-text and
// takes the frames on the GPU, one clip at a time. When the service is down, loading or busy with that clip, the clip
// waits without using up a try; a timeout or an error counts as a failed try.

import { request } from "node:http";
import type { Db } from "@socia/db";
import { xvClaimJob, xvDeferJob, xvFailJob, xvFinishJob, xvSaveEvidence, xvSetProgress } from "../db/clips";
import type { XvEvidence } from "../db/schema";
import type { Logger } from "pino";
import type { XvShareReader } from "./share";
import type { XvNextStep } from "./steps";

/** A 10-minute clip reads in well under a minute; past this the service is stuck on it */
const READ_TIMEOUT_MS = 10 * 60_000;
/** A screen read takes 2-4 s and 45 s of speech under 20 s, but either can wait for the GPU behind a whole-clip read */
const SCREEN_TIMEOUT_MS = 12 * 60_000;
/** Longer than the timeout, so the lease never runs out while the request is still open */
const LEASE_S = 12 * 60;
/** While the media service is down, a clip is asked again after this many seconds */
const SERVICE_DOWN_RETRY_S = 60;

/** Connection errors that mean the service is not running (or restarting): the clip waits */
const DOWN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

/** The service is not there or not ready: the clip waits, no try used */
export class XvMediaDown extends Error {
  constructor(reason: string) {
    super(`The X Videos media service is not answering (${reason}).`);
    this.name = "XvMediaDown";
  }
}

/** What POST /read answers (media/media.py): stills are file names in XVIDEOS_CACHE/frames/<clip id> */
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

/** What POST /screen answers (media/media.py, step 4): the bar lines and other screen text, as read */
export interface XvScreenAnswer {
  screenVersion: string;
  tookS: number;
  durationS: number;
  barLines: { text: string; secs: number; firstS: number }[];
  otherText: string[];
  timings: { framesS: number; ocrS: number };
}

export function parseScreenAnswer(body: unknown): XvScreenAnswer {
  const a = body as Partial<XvScreenAnswer> | null;
  const ok =
    !!a &&
    typeof a.screenVersion === "string" &&
    isNum(a.tookS) &&
    isNum(a.durationS) &&
    Array.isArray(a.barLines) &&
    a.barLines.every((l) => typeof l?.text === "string" && isNum(l?.secs) && isNum(l?.firstS)) &&
    Array.isArray(a.otherText) &&
    a.otherText.every((t) => typeof t === "string") &&
    isNum(a.timings?.framesS) &&
    isNum(a.timings?.ocrS);
  if (!ok) throw new Error("the media service sent a screen read in the wrong shape");
  return a as XvScreenAnswer;
}

/** What POST /speech answers: the anchor's opening words */
export interface XvSpeechAnswer {
  tookS: number;
  seconds: number;
  hasAudio: boolean;
  text: string;
}

export function parseSpeechAnswer(body: unknown): XvSpeechAnswer {
  const a = body as Partial<XvSpeechAnswer> | null;
  if (!a || !isNum(a.tookS) || !isNum(a.seconds) || typeof a.hasAudio !== "boolean" || typeof a.text !== "string") {
    throw new Error("the media service sent speech in the wrong shape");
  }
  return a as XvSpeechAnswer;
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
    private readonly timeouts: { readMs: number; screenMs: number } = { readMs: READ_TIMEOUT_MS, screenMs: SCREEN_TIMEOUT_MS },
  ) {}

  /** Speech, cuts and stills of the whole clip. `path`: the file on the share. Throws XvMediaDown when the clip should simply wait. */
  async read(clipId: string, path: string): Promise<XvReadAnswer> {
    return parseReadAnswer(await this.post("/read", { clipId, path }, this.timeouts.readMs));
  }

  /** Step 4: the bar lines and other screen text (a few seconds; the GPU is shared, so it may queue behind a read) */
  async screen(clipId: string, path: string): Promise<XvScreenAnswer> {
    return parseScreenAnswer(await this.post("/screen", { clipId, path }, this.timeouts.screenMs));
  }

  /** Step 4's fallback: the anchor's words over the clip's first `seconds` */
  async speech(clipId: string, path: string, seconds: number): Promise<XvSpeechAnswer> {
    return parseSpeechAnswer(await this.post("/speech", { clipId, path, seconds }, this.timeouts.screenMs));
  }

  /**
   * One request to the service. node:http, not fetch: fetch gives up waiting for an answer after 5 min on its own, and a
   * screen read may queue that long behind a whole-clip read on the GPU. Throws XvMediaDown when the clip should simply
   * wait (no service, model loading, the clip already in work), an Error otherwise.
   */
  private post(route: string, payload: object, timeoutMs: number): Promise<unknown> {
    const url = new URL(route, `${this.baseUrl}/`);
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": body.length, "x-xvideos-key": this.key } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (err) => done(() => reject(err)));
        res.on("end", () =>
          done(() => {
            const status = res.statusCode ?? 0;
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reject(new Error(`the media service answered ${status} without JSON`));
            }
            const error = (parsed as { error?: unknown } | null)?.error;
            const reason = typeof error === "string" ? error : `the media service answered ${status}`;
            // 503: a model loading; 409: this clip is already in work (an earlier request the worker gave up on)
            if (status === 503 || status === 409) return reject(new XvMediaDown(reason));
            if (status < 200 || status >= 300) return reject(new Error(reason));
            resolve(parsed);
          }),
        );
      });
      const timer = setTimeout(() => {
        done(() => reject(new Error(`the media service did not finish ${route} in ${timeoutMs / 60_000} min`)));
        req.destroy();
      }, timeoutMs);
      req.on("error", (err: NodeJS.ErrnoException) => done(() => reject(DOWN_CODES.has(err.code ?? "") ? new XvMediaDown(err.message) : err)));
      req.end(body);
    });
  }
}

export class XvReadStep {
  private downLogged = false;

  constructor(
    private readonly db: Db,
    private readonly share: XvShareReader,
    private readonly media: XvMediaClient,
    private readonly log: Logger,
    /** The headline when the file's name holds none, else null: the clip is ready */
    private readonly next: XvNextStep = () => null,
  ) {}

  async tick(): Promise<boolean> {
    const job = await xvClaimJob(this.db, "read", LEASE_S);
    if (!job) return false;
    const path = this.share.pathOf(job.clip.folder, job.clip.fileName);
    try {
      await xvSetProgress(this.db, job.clipId, 20);
      const evidence = xvEvidenceOf(job.clipId, await this.media.read(job.clipId, path));
      await xvSaveEvidence(this.db, job.clipId, evidence);
      if (!(await xvFinishJob(this.db, job, this.next(job.clip)))) {
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
