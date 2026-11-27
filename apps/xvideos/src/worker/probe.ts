// The probe role: length, shape and codec with ffprobe, and a poster still with ffmpeg, for every clip. Then the
// clip goes on (steps.ts): to the headline's screen read when its name holds no heading, else it is ready on the desk.
// The video is only read from the share; the poster goes to the local cache (XVIDEOS_CACHE/posters/<clip id>.jpg).

import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@socia/db";
import { xvClaimJob, xvDeferJob, xvFailJob, xvFinishJob, xvSaveProbe, type XvProbe } from "../db/clips";
import type { Logger } from "pino";
import { XV_SHARE_TIMEOUT_MS, type XvShareReader } from "./share";
import type { XvNextStep } from "./steps";

const run = promisify(execFile);
/** A probe over the share takes a second or two; this long means the share or the file is stuck */
const PROBE_TIMEOUT_MS = 60_000;
/** Longer than the share check and both tool runs together, so the lease never runs out mid-step */
const LEASE_S = 240;
/** A file missing from the share is looked for again this often, at most this many times, then the step fails */
const MISSING_RETRY_S = 60;

interface FfprobeOut {
  format?: { duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}

/** ffprobe's JSON → the fields the clip keeps */
export function parseProbe(json: string): Omit<XvProbe, "posterKey"> {
  const out = JSON.parse(json) as FfprobeOut;
  const video = out.streams?.find((s) => s.codec_type === "video");
  const durationS = Number(out.format?.duration);
  if (!video || !Number.isFinite(durationS) || durationS <= 0) throw new Error("no video stream or no length in the file");
  return {
    durationS: Math.round(durationS * 100) / 100,
    width: video.width ?? null,
    height: video.height ?? null,
    videoCodec: video.codec_name ?? null,
    hasAudio: out.streams?.some((s) => s.codec_type === "audio") ?? false,
  };
}

/** Where the poster still is taken: past the studio opening, inside the clip */
export const posterAt = (durationS: number) => Math.min(Math.max(durationS * 0.1, 0), Math.max(durationS - 0.5, 0), 8);

/** A tool's failure in a few words, with the share's address left out (the desk sees this) */
export function toolError(err: unknown, tool: string, shareRoot: string): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  if (e.code === "ENOENT" && e.syscall?.startsWith("spawn")) return `${tool} is not installed or not on PATH`;
  if (e.killed) return `${tool} took longer than ${PROBE_TIMEOUT_MS / 1000} s`;
  const text = (e.stderr?.trim() || e.message || String(err)).slice(-300);
  return text.split(shareRoot).join("<share>");
}

export class XvProbeStep {
  constructor(
    private readonly db: Db,
    private readonly share: XvShareReader,
    private readonly cacheDir: string,
    private readonly tools: { ffprobe: string; ffmpeg: string },
    private readonly log: Logger,
    /** "read" with speech on, "headline" when the file's name holds none, null: the clip is ready once probed */
    private readonly next: XvNextStep = () => null,
  ) {}

  async tick(): Promise<boolean> {
    const job = await xvClaimJob(this.db, "probe", LEASE_S);
    if (!job) return false;
    const path = this.share.pathOf(job.clip.folder, job.clip.fileName);

    // Is the file still where the last scan saw it? A renamed or moved one is found again by the next scan.
    try {
      await Promise.race([stat(path), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), XV_SHARE_TIMEOUT_MS))]);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // After the third miss in a row the clip fails instead of waiting forever
        if (job.attempts >= 3) await xvFailJob(this.db, { ...job, attempts: 99 }, "probe: the file is not on the share any more");
        // Counted as a try: a wait that gave the try back would never reach the third
        else await xvDeferJob(this.db, job, MISSING_RETRY_S, "file not found on the share; waiting for the next scan", { countTry: true });
      } else {
        await xvDeferJob(this.db, job, MISSING_RETRY_S, `the share cannot be read (${code ?? "error"})`);
      }
      return true;
    }

    const posterKey = `posters/${job.clipId}.jpg`;
    const tmp = join(this.cacheDir, "posters", `${job.clipId}.${process.pid}.tmp.jpg`);
    try {
      const { stdout } = await run(this.tools.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }).catch((err) => {
        throw new Error(toolError(err, "ffprobe", this.share.root));
      });
      const probe = parseProbe(stdout);
      await mkdir(join(this.cacheDir, "posters"), { recursive: true });
      await run(this.tools.ffmpeg, ["-nostdin", "-v", "error", "-y", "-ss", posterAt(probe.durationS).toFixed(2), "-i", path, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", tmp], { timeout: PROBE_TIMEOUT_MS }).catch((err) => {
        throw new Error(toolError(err, "ffmpeg", this.share.root));
      });
      // Written to a temp name and moved into place, so a killed run never leaves half a poster
      await rename(tmp, join(this.cacheDir, posterKey));
      await xvSaveProbe(this.db, job.clipId, { ...probe, posterKey });
      if (!(await xvFinishJob(this.db, job, this.next(job.clip)))) this.log.warn({ clip: job.clipId }, "x videos probe finished after its lease ran out; left to the newer run");
      else this.log.info({ clip: job.clipId, file: job.clip.fileName, durationS: probe.durationS }, "x videos probed");
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      const message = (err as Error).message;
      const outcome = await xvFailJob(this.db, job, `probe: ${message}`);
      this.log.warn({ clip: job.clipId, file: job.clip.fileName, outcome, err: message }, "x videos probe failed");
    }
    return true;
  }
}
