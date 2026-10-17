// The slug is the join key between a story's .txt and its media (spec §6.1.1):
// JPR_Metro-Phase2.txt, jpr_metro_phase2_01.jpg and "JPR METRO PHASE2_2.mp4" all belong together.

export type FileKind = "text" | "image" | "video" | "other";

export interface SlugParts {
  /** Normalised base name, without the sequence number */
  slug: string;
  /** Trailing _1 / _01 / _002, when there is one */
  seq: number | null;
  ext: string;
  kind: FileKind;
}

const KINDS: Record<string, FileKind> = {
  txt: "text",
  jpg: "image", jpeg: "image", png: "image", webp: "image",
  mp4: "video", mov: "video", mxf: "video", mkv: "video", m4v: "video",
};

export function slugParts(fileName: string): SlugParts {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const stem = dot > 0 ? base.slice(0, dot) : base;

  const normalised = stem
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  // Only a separated 1–3 digit tail is a sequence number, so "phase2" and "171026_x" stay whole
  const seqMatch = /^(.+?)_(\d{1,3})$/.exec(normalised);
  return {
    slug: seqMatch ? seqMatch[1]! : normalised,
    seq: seqMatch ? Number(seqMatch[2]) : null,
    ext,
    kind: KINDS[ext] ?? "other",
  };
}
