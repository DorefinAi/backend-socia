// Dictionary matching for city hashtags and @mentions. Aho-Corasick over every alias, one pass over
// the text, whole words only. Matching is on folded text (see fold.ts).

import { fold } from "./fold";

export interface GazetteerEntry<T> {
  id: string;
  /** The canonical name; a match on it ranks above a match on an alias */
  name: string;
  aliases: string[];
  priority: number;
  data: T;
}

export interface GazetteerMatch<T> {
  entry: GazetteerEntry<T>;
  /** The folded alias that matched */
  matched: string;
  exact: boolean;
  start: number;
  end: number;
}

interface Pattern {
  entry: number;
  text: string;
  exact: boolean;
}

interface Node {
  next: Map<string, number>;
  fail: number;
  out: number[];
}

export class Gazetteer<T> {
  private readonly nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  private readonly patterns: Pattern[] = [];

  constructor(private readonly entries: GazetteerEntry<T>[]) {
    entries.forEach((entry, index) => {
      const name = fold(entry.name);
      const seen = new Set<string>();
      for (const raw of [entry.name, ...entry.aliases]) {
        const text = fold(raw);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        this.add({ entry: index, text, exact: text === name });
      }
    });
    this.link();
  }

  get size(): number {
    return this.entries.length;
  }

  private add(pattern: Pattern): void {
    let node = 0;
    for (const ch of pattern.text) {
      let child = this.nodes[node]!.next.get(ch);
      if (child === undefined) {
        child = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, out: [] });
        this.nodes[node]!.next.set(ch, child);
      }
      node = child;
    }
    this.nodes[node]!.out.push(this.patterns.length);
    this.patterns.push(pattern);
  }

  private link(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) queue.push(child);
    while (queue.length) {
      const current = queue.shift()!;
      for (const [ch, child] of this.nodes[current]!.next) {
        let fail = this.nodes[current]!.fail;
        while (fail !== 0 && !this.nodes[fail]!.next.has(ch)) fail = this.nodes[fail]!.fail;
        const target = this.nodes[fail]!.next.get(ch);
        this.nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
        this.nodes[child]!.out.push(...this.nodes[this.nodes[child]!.fail]!.out);
        queue.push(child);
      }
    }
  }

  /**
   * Every whole-word match, overlaps resolved: exact name beats alias, longer beats shorter,
   * higher priority breaks ties. One result per entry, in ranked order.
   */
  find(text: string): GazetteerMatch<T>[] {
    const folded = fold(text);
    const chars = [...folded];
    const raw: GazetteerMatch<T>[] = [];
    let node = 0;

    chars.forEach((ch, i) => {
      while (node !== 0 && !this.nodes[node]!.next.has(ch)) node = this.nodes[node]!.fail;
      node = this.nodes[node]!.next.get(ch) ?? 0;
      for (const p of this.nodes[node]!.out) {
        const pattern = this.patterns[p]!;
        const length = [...pattern.text].length;
        const start = i - length + 1;
        const end = i + 1;
        const wholeWord = (start === 0 || chars[start - 1] === " ") && (end === chars.length || chars[end] === " ");
        if (wholeWord) {
          raw.push({ entry: this.entries[pattern.entry]!, matched: pattern.text, exact: pattern.exact, start, end });
        }
      }
    });

    const ranked = raw.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.end - b.start - (a.end - a.start) ||
        b.entry.priority - a.entry.priority ||
        a.start - b.start,
    );

    const taken: GazetteerMatch<T>[] = [];
    const seen = new Set<string>();
    for (const match of ranked) {
      if (seen.has(match.entry.id)) continue;
      if (taken.some((t) => match.start < t.end && t.start < match.end)) continue;
      taken.push(match);
      seen.add(match.entry.id);
    }
    return taken;
  }
}
