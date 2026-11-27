"""Build the X Videos directory (format.json, tags.json, handles.json) from the desk's published #FINVideo posts and the
breaking desk's directory files (apps/worker/config), which hold the keywords.

#FINVideo is the identifier: a post is a video post exactly when it carries it. Every tag and handle the desk used on a
video post gets an entry with how often and how recently it was used. Its keywords are copied from the breaking desk's
directory when that directory knows it (so the two desks match the same words); otherwise the entry is marked
`needs_keywords` with example titles for the desk to fill in. Nothing is guessed.

Run (read-only on every input; writes only next to this file):
  python build.py [--shared <apps/worker/config>] [--until YYYY-MM-DD]
--until builds from posts up to that day only (eval.py uses this to test on later days).
"""
import argparse, json, re, sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
sys.stdout.reconfigure(encoding="utf-8")

IDENTIFIER = "FINVideo"
BRANDS = {"RajasthanWithFirstIndia": "rajasthan", "FirstIndiaNews": "outside"}
STATE_TAG = "RajasthanNews"
MIN_USES = 2   # a tag or handle used once is a one-off, not directory material (it stays in the counts file)


# ---------- posts ----------
def load_posts(path: Path, until: str | None, normalise: dict):
    posts = []
    for line in path.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        if until and r["posted_ist"][:10] > until:
            continue
        text = re.sub(r"https://t\.co/\S+", "", r["text"]).strip()
        tags = [normalise.get(t, t) for t in re.findall(r"#(\w+)", text)]
        if IDENTIFIER not in tags:
            continue
        posts.append({"day": r["posted_ist"][:10], "title": text.split("\n")[0].strip(), "tags": tags,
                      "handles": re.findall(r"@\w+", text)})
    return posts


def title_head(title: str) -> str:
    return re.split(r"\s[|।]\s?", title)[0].strip()


# ---------- the breaking desk's directory ----------
def load_shared(cfg: Path):
    j = lambda f: json.loads((cfg / f).read_text(encoding="utf-8"))
    handles = {}

    def put(e, source, **extra):
        h = e["handle"]
        handles.setdefault(h.lower(), {
            "handle": h, "handle_type": e.get("handle_type"), "source": source,
            "names_hi": e.get("names_hi", []), "names_en": e.get("names_en", []),
            "keywords_hi": e.get("keywords_hi", []), "keywords_en": e.get("keywords_en", []), **extra})

    for e in j("subject-handles.json")["entries"]:
        put(e, "subject-handles.json", kind=e.get("kind"), suggest_only=bool(e.get("suggest_only")))
    for e in j("party-handles.json")["entries"]:
        put(e, "party-handles.json", kind="party", party=e.get("party"), scope=e.get("scope"), hashtag=e.get("hashtag"))
    dh = j("district-handles.json")
    for e in dh["state"]:
        put(e, "district-handles.json#state", kind=e.get("role"))
    for district, es in dh["districts"].items():
        for e in es:
            put(e, "district-handles.json", kind=e.get("role"), district=district,
                towns=e.get("towns", []), words=e.get("words", []))
    for e in j("reporter-handles.json")["entries"]:
        put(e, "reporter-handles.json", kind="reporter", districts=e.get("districts", []),
            match_on="share file name token (names_en), never the title")
    places = j("rajasthan-places.json")["districts"]
    campaigns = j("campaigns.json")["entries"]
    normalise = j("hashtag-normalise.json").get("variants", {})
    return handles, places, campaigns, normalise


STOP = set("""के का की को में पर से ने है हैं और व तक भी इस यह एक किया हुआ हुई गया गई लिए साथ आज बाद दौरान लेकर बड़ा बड़ी
कर रहे रही रहा होगा होगी हुए करने वाले वालों News Rajasthan""".split())


def title_words(title: str) -> set:
    return {w for w in re.findall(r"[ऀ-ॿ]+|[A-Za-z][A-Za-z0-9-]+", title_head(title).replace("़", ""))
            if len(w) > 2 and w not in STOP}


def propose(tag: str, posts) -> list:
    """Words that point at this tag in the desk's own titles: in at least 2 of its posts, and at least half of all titles
    with the word carry the tag. Offered to the desk to confirm; never used to emit."""
    with_tag = [title_words(p["title"]) for p in posts if tag in p["tags"]]
    if len(with_tag) < 3:
        return []
    every = Counter(w for p in posts for w in title_words(p["title"]))
    mine = Counter(w for ws in with_tag for w in ws)
    good = [(c / every[w], c, w) for w, c in mine.items() if c >= 2 and c / every[w] >= 0.5]
    return [w for _, _, w in sorted(good, reverse=True)[:6]]


def squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shared", type=Path, default=HERE.parent.parent / "worker" / "config")
    ap.add_argument("--posts", type=Path, default=HERE / "data" / "finvideo-posts.jsonl")
    ap.add_argument("--until", help="build from posts up to this IST day only")
    ap.add_argument("--out", type=Path, default=HERE)
    args = ap.parse_args()

    shared, places, campaigns, normalise = load_shared(args.shared)
    posts = load_posts(args.posts, args.until, normalise)
    n = len(posts)
    days = sorted({p["day"] for p in posts})
    recent_from = days[-3] if len(days) >= 3 else days[0]           # the last 3 posting days = "how the desk does it now"
    recent = [p for p in posts if p["day"] >= recent_from]

    # ---------- format.json ----------
    pos = Counter(p["tags"].index(IDENTIFIER) + 1 for p in recent)
    first = Counter(p["tags"][0] for p in recent)
    def suffix_form(title):
        parts = [x.strip() for x in re.split(r"\s([|।])\s?", title)]
        if len(parts) == 1:
            return "none"
        seps, tails = parts[1::2], parts[2::2]
        shape = []
        for s, t in zip(seps, tails):
            shape.append(f"{s} " + ("<Place> News" if re.search(r"News$", t, re.I) else "<Topic or place>"))
        return " ".join(shape)
    forms = Counter(suffix_form(p["title"]) for p in posts)
    forms_recent = Counter(suffix_form(p["title"]) for p in recent)
    place_tags = {d["tag"].lower() for d in places}
    city_form = Counter()
    for p in recent:
        for t in p["tags"]:
            tl = t.lower()
            if tl in place_tags:
                city_form["#<City>"] += 1
            elif tl.endswith("news") and tl[:-4] in place_tags:
                city_form["#<City>News"] += 1
    fmt = {
        "version": 1,
        "_note": "How a published X video post is laid out, measured on the desk's own #FINVideo posts. Built by build.py; do not edit by hand.",
        "identifier": {"tag": IDENTIFIER, "rule": "A post is an X video post exactly when it carries #FINVideo. Every other count in this directory is over such posts only."},
        "measured_on": {"posts": n, "days": days, "recent_days_from": recent_from, "recent_posts": len(recent)},
        "layout": {
            "line_1": "the title (headline, then an optional suffix)",
            "last_line": "all hashtags, then all @handles, space separated",
            "posts_matching": sum(1 for p in posts if p["title"] and "#" not in p["title"]),
        },
        "tag_order_now": {
            "first_tag": first.most_common(3),
            "FINVideo_position": sorted(pos.items()),
            "rule": "brand tag first, #FINVideo second (since 21 Nov 2026; before that #FINVideo came first)",
        },
        "brand": {"#RajasthanWithFirstIndia": "the story is in Rajasthan", "#FirstIndiaNews": "outside Rajasthan",
                  "uses": {b: sum(b in p["tags"] for p in posts) for b in BRANDS}},
        "state_tag": {"tag": STATE_TAG, "share_all": round(sum(STATE_TAG in p["tags"] for p in posts) / n, 2),
                      "share_recent": round(sum(STATE_TAG in p["tags"] for p in recent) / max(len(recent), 1), 2)},
        "place_tag_form_recent": dict(city_form),
        "title_suffix_forms": {"all": forms.most_common(), "recent": forms_recent.most_common()},
        "file_name_title": {
            "rule": "The share file's name, without the x / done marks and the extension, is often the posted title. "
                    "Windows does not allow '|' in a name, so the desk types two or more spaces where the title has ' | '.",
            "measured": "27 Nov 2026: the heading of all 29 posted videos is a file name on the share (26 within 0.75 letter "
                        "similarity, 3 the same heading with a longer suffix); 22 of those 29 files carried no x mark. "
                        "X-marked files 22-27 Nov: 130 of 230 names hold a full heading, the rest a word ('KOTAA', 'JDR Hadsa').",
        },
    }

    # ---------- counts ----------
    tag_uses, tag_last, tag_titles = Counter(), {}, defaultdict(list)
    h_uses, h_last, h_titles, h_cotags = Counter(), {}, defaultdict(list), defaultdict(Counter)
    for p in posts:
        for t in dict.fromkeys(p["tags"]):
            tag_uses[t] += 1; tag_last[t] = max(tag_last.get(t, ""), p["day"])
            if len(tag_titles[t]) < 3: tag_titles[t].append(title_head(p["title"])[:90])
        for h in dict.fromkeys(p["handles"]):
            h_uses[h] += 1; h_last[h] = max(h_last.get(h, ""), p["day"])
            if len(h_titles[h]) < 3: h_titles[h].append(title_head(p["title"])[:90])

    # ---------- tags.json ----------
    place_by_tag = {d["tag"].lower(): d for d in places}
    camp_by_tag = {c["tag"].lower(): c for c in campaigns}
    person_by_tag = {}
    for e in shared.values():
        for nm in e["names_en"]:
            person_by_tag.setdefault(squash(nm), e)
    party_by_tag = {squash(e["hashtag"]): e for e in shared.values() if e.get("hashtag")}

    tags = []
    for t, u in tag_uses.most_common():
        tl = t.lower()
        base = {"tag": "#" + t, "uses": u, "share": round(u / n, 3), "last_seen": tag_last[t]}
        if t == IDENTIFIER:
            tags.append({**base, "kind": "identifier", "rule": "emit", "position": 2}); continue
        if t in BRANDS:
            tags.append({**base, "kind": "brand", "rule": "emit", "position": 1, "when": BRANDS[t]}); continue
        if t == STATE_TAG:
            tags.append({**base, "kind": "state", "rule": "suggest", "when": "rajasthan story"}); continue
        place = place_by_tag.get(tl) or (place_by_tag.get(tl[:-4]) if tl.endswith("news") else None)
        if place:
            tags.append({**base, "kind": "place", "rule": "emit", "district": place["tag"],
                         "form": "<City>News" if tl.endswith("news") and tl not in place_by_tag else "<City>",
                         "keywords_hi": place.get("hi", []), "keywords_en": [place["tag"]],
                         "keyword_source": "rajasthan-places.json"}); continue
        if u < MIN_USES and tl not in camp_by_tag:
            continue
        camp = camp_by_tag.get(tl)
        if camp:
            tags.append({**base, "kind": camp.get("kind", "keyword"), "rule": "suggest", "pattern": camp.get("pattern"),
                         "start": camp.get("start"), "end": camp.get("end"), "keyword_source": "campaigns.json"}); continue
        person = person_by_tag.get(squash(t)) or person_by_tag.get(squash(re.sub(r"^(CM|PM)", "", t)))
        if person:
            tags.append({**base, "kind": "person", "rule": "suggest", "linked_handle": person["handle"],
                         "keywords_hi": person["names_hi"], "keywords_en": person["names_en"],
                         "keyword_source": person["source"]}); continue
        party = party_by_tag.get(squash(t))
        if party:
            tags.append({**base, "kind": "party", "rule": "suggest", "linked_handle": party["handle"],
                         "keywords_hi": party["keywords_hi"], "keywords_en": party["keywords_en"],
                         "keyword_source": party["source"]}); continue
        tags.append({**base, "kind": "topic", "rule": "suggest", "status": "needs_keywords", "keywords_hi": [], "keywords_en": [],
                     "keywords_proposed": propose(t, posts), "examples": tag_titles[t]})

    # ---------- handles.json ----------
    handles = []
    for h, u in h_uses.most_common():
        e = shared.get(h.lower())
        base = {"handle": h, "uses": u, "share": round(u / n, 3), "last_seen": h_last[h]}
        if not e:
            if u < MIN_USES:
                continue
            handles.append({**base, "kind": "unknown", "rule": "suggest", "status": "needs_keywords",
                            "in_shared_directory": False, "keywords_hi": [], "keywords_en": [], "examples": h_titles[h]})
            continue
        entry = {**base, "kind": e.get("kind"), "handle_type": e.get("handle_type"), "in_shared_directory": True,
                 "keyword_source": e["source"], "names_hi": e["names_hi"], "names_en": e["names_en"],
                 "keywords_hi": e["keywords_hi"], "keywords_en": e["keywords_en"]}
        for k in ("district", "towns", "words", "party", "scope", "districts", "match_on", "suggest_only"):
            if e.get(k):
                entry[k] = e[k]
        entry["rule"] = ("emit" if e.get("kind") == "police" else
                         "by_file_name" if e.get("kind") == "reporter" else "suggest")
        handles.append(entry)

    meta = {"version": 1, "built_from": {"posts": n, "days": days, "until": args.until, "shared_directory": str(args.shared)},
            "min_uses": MIN_USES}
    (args.out / "format.json").write_text(json.dumps(fmt, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "tags.json").write_text(json.dumps({**meta, "_note": "Hashtags the desk used on #FINVideo posts. rule emit = put in the draft; suggest = one click. Keywords come from the breaking desk's directory (keyword_source) or are empty with status needs_keywords.", "entries": tags}, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "handles.json").write_text(json.dumps({**meta, "_note": "@handles the desk used on #FINVideo posts, with the breaking desk's names and keywords for each. Handles not in that directory are listed with status needs_keywords and are never added on their own.", "entries": handles}, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.out / "counts.json").write_text(json.dumps({**meta, "tags": tag_uses.most_common(), "handles": h_uses.most_common()}, ensure_ascii=False), encoding="utf-8")
    kinds = lambda xs: dict(Counter(x["kind"] for x in xs))
    print(f"posts {n}, days {days[0]}..{days[-1]}; tags {len(tags)} {kinds(tags)}; handles {len(handles)} {kinds(handles)}; "
          f"needs keywords: tags {sum(x.get('status') == 'needs_keywords' for x in tags)}, handles {sum(x.get('status') == 'needs_keywords' for x in handles)}")


if __name__ == "__main__":
    main()
