// The headline role (step 4, README §4.2): for a clip whose file name holds no heading, the media service reads the
// screen (bar lines, place tag, right panel), the day's programme filler is dropped (src/headline/lines.ts, fixes A and
// C), the anchor's opening words are read when fewer than 2 bar lines are left, and qwen3:14b writes the headline the
// desk sees as its suggestion.
//
// The screen read is kept (xvideos.clip_screen), so a later run only asks the model again. That happens when a newer
// clip of the same day shows that some bar lines are a programme's filler: the day's clips whose lines change are
// written again.
//
// A clip whose name gets a heading before its turn is skipped. When the media service or Ollama is down the clip waits
// without using a try; after XV_MAX_ATTEMPTS failed tries the clip is still ready on the desk, without a suggestion.

import type { Db } from "@socia/db";
import type { Logger } from "pino";
import {
  xvClaimJob,
  xvDayScreens,
  xvDeferJob,
  xvFailJob,
  xvFinishJob,
  xvGetScreen,
  xvQueueMissingHeadlines,
  xvRedoStep,
  xvSaveHeadline,
  xvSaveScreenRead,
  xvSetProgress,
} from "../db/clips";
import type { XvScreenRead } from "../db/schema";
import { XV_MIN_BAR_LINES, xvCleanLines, xvDayProgramme, xvSameLines } from "../headline/lines";
import { XvModelDown, xvHeadlinePrompt, xvHeadlineProblem, xvParseModelAnswer, type XvModelClient } from "../headline/model";
import { XV_KEEP_DAYS, xvToday } from "../share/rules";
import { XvMediaDown, type XvMediaClient } from "./read";
import type { XvShareReader } from "./share";

/**
 * Longer than the screen read, the speech and the model's timeouts together (12 + 12 + 5 min) with room for the
 * database and ffmpeg around them, so the lease never runs out mid-step
 */
const LEASE_S = 40 * 60;
/** While the media service or the model is down, a clip is asked again after this many seconds */
const SERVICE_DOWN_RETRY_S = 60;
/** Clips read before (or renamed so their heading went) are looked for this often */
const CATCH_UP_MS = 10 * 60_000;
/** The speech fallback reads the anchor's opening (trial 4: the lead is read in the first 45 s) */
const SPEECH_S = 45;

const texts = (read: XvScreenRead) => read.barLines.map((l) => l.text);

export class XvHeadlineStep {
  private downLogged = false;
  private nextCatchUp = 0;

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly share: XvShareReader,
    private readonly media: Pick<XvMediaClient, "screen" | "speech">,
    private readonly model: Pick<XvModelClient, "ask" | "model">,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Queues the headline for ready clips of the days still on the share that never had one */
  private async catchUp(): Promise<void> {
    const at = this.now();
    if (at.getTime() < this.nextCatchUp) return;
    this.nextCatchUp = at.getTime() + CATCH_UP_MS;
    const since = xvToday(new Date(at.getTime() - (XV_KEEP_DAYS + 1) * 24 * 3600_000));
    const queued = await xvQueueMissingHeadlines(this.db, this.orgId, since);
    if (queued) this.log.info({ clips: queued, since }, "x videos headlines queued for clips without one");
  }

  async tick(): Promise<boolean> {
    await this.catchUp();
    const job = await xvClaimJob(this.db, "headline", LEASE_S);
    if (!job) return false;
    const clip = job.clip;
    if (clip.heading) {
      // The desk renamed the file with its heading while it waited
      await xvFinishJob(this.db, job, null);
      this.log.info({ clip: job.clipId, file: clip.fileName }, "x videos headline skipped: the file's name holds one now");
      return true;
    }
    const path = this.share.pathOf(clip.folder, clip.fileName);
    try {
      const stored = await xvGetScreen(this.db, job.clipId);
      let read: XvScreenRead;
      let screenVersion: string;
      if (stored) {
        read = stored.read;
        screenVersion = stored.screenVersion;
      } else {
        await xvSetProgress(this.db, job.clipId, 40);
        const a = await this.media.screen(job.clipId, path);
        read = { tookS: a.tookS, durationS: a.durationS, barLines: a.barLines, otherText: a.otherText, timings: a.timings, speech: null };
        screenVersion = a.screenVersion;
        await xvSaveScreenRead(this.db, job.clipId, screenVersion, read);
      }

      // The day's programme, from every screen read of the day (this clip's included)
      const day = clip.day ? await xvDayScreens(this.db, this.orgId, clip.day) : [];
      const reads = [...day.filter((d) => d.clipId !== job.clipId), { clipId: job.clipId, read, result: null, jobStatus: "running" }];
      const programme = xvDayProgramme(reads.map((r) => ({ clipId: r.clipId, lines: texts(r.read) })));
      const lines = xvCleanLines(texts(read), programme);

      if (lines.kept.length < XV_MIN_BAR_LINES && read.speech === null && clip.hasAudio !== false) {
        await xvSetProgress(this.db, job.clipId, 60);
        const s = await this.media.speech(job.clipId, path, SPEECH_S);
        read = { ...read, speech: { text: s.text, seconds: s.seconds, tookS: s.tookS, hasAudio: s.hasAudio } };
        await xvSaveScreenRead(this.db, job.clipId, screenVersion, read);
      }
      const speech = lines.kept.length < XV_MIN_BAR_LINES ? (read.speech?.text ?? "") : "";

      if (!lines.kept.length && !read.otherText.length && !speech.trim()) {
        // Nothing to write from: no suggestion (an older one, made from lines now known as filler, goes), the editor
        // writes the headline. The empty lines are kept, so the day's later clips do not ask for this one again.
        const empty = { model: this.model.model, tookS: 0, tokensOut: null, placeHindi: "", district: "", state: "", topicHashtags: [], linesUsed: [], dropped: lines.dropped, usedSpeech: false };
        if (await xvFinishJob(this.db, job, null, (tx) => xvSaveHeadline(tx, job.clipId, null, empty))) {
          this.log.info({ clip: job.clipId, file: clip.fileName }, "x videos headline: nothing read on the screen or heard");
        }
        return true;
      }

      await xvSetProgress(this.db, job.clipId, 80);
      const reply = await this.model.ask(xvHeadlinePrompt(lines.kept, read.otherText, speech));
      if (reply.thought) this.log.warn({ clip: job.clipId }, "x videos headline: the model thought although think=false");
      const answer = xvParseModelAnswer(reply.content);
      const problem = xvHeadlineProblem(answer.headline);
      const result = {
        model: this.model.model,
        tookS: reply.tookS,
        tokensOut: reply.tokensOut,
        placeHindi: answer.placeHindi,
        district: answer.district,
        state: answer.state,
        topicHashtags: answer.topicHashtags,
        linesUsed: lines.kept,
        dropped: lines.dropped,
        usedSpeech: !!speech.trim(),
        ...(problem ? { rejected: `${problem}: ${answer.headline.slice(0, 300)}` } : {}),
      };
      // Saved with the finish, only while this run still holds the job
      if (!(await xvFinishJob(this.db, job, null, (tx) => xvSaveHeadline(tx, job.clipId, problem ? null : answer.headline, result)))) {
        this.log.warn({ clip: job.clipId }, "x videos headline finished after its lease ran out; left to the newer run");
        return true;
      }
      if (this.downLogged) {
        this.downLogged = false;
        this.log.info("x videos headline: media service and model answering again");
      }
      this.log.info(
        { clip: job.clipId, file: clip.fileName, lines: lines.kept.length, dropped: lines.dropped.length, speech: !!speech.trim(), modelS: reply.tookS, rejected: problem ?? undefined },
        problem ? "x videos headline not offered: " + problem : "x videos headline written",
      );

      // The day's other clips whose bar lines read differently with this programme are written again
      const stale = reads
        .filter((r) => r.clipId !== job.clipId && r.jobStatus === "done" && r.result && !xvSameLines(xvCleanLines(texts(r.read), programme).kept, r.result.linesUsed))
        .map((r) => r.clipId);
      const redone = await xvRedoStep(this.db, stale, "headline");
      if (redone) this.log.info({ day: clip.day, clips: redone }, "x videos headlines to write again: the day's programme filler changed");
    } catch (err) {
      if (err instanceof XvMediaDown || err instanceof XvModelDown) {
        await xvDeferJob(this.db, job, SERVICE_DOWN_RETRY_S, err.message);
        if (!this.downLogged) {
          this.downLogged = true;
          this.log.error({ err: err.message }, "x videos headline: media service or model down; clips wait");
        }
        return false;
      }
      const message = (err as Error).message.split(this.share.root).join("<share>");
      const outcome = await xvFailJob(this.db, job, `headline: ${message}`);
      this.log.warn({ clip: job.clipId, file: clip.fileName, outcome, err: message }, "x videos headline failed");
    }
    return true;
  }
}
