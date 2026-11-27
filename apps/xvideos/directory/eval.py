"""Test the X Videos directory on published #FINVideo posts it was not built from.

Builds the directory from the posts up to --until, then for every later post reads ONLY its title (line 1, what the
share file name or the OCR flow gives the composer) and predicts the hashtags and @handles; the desk's own tags and
handles on X are the answer key. Reporter handles are scored apart: they come from the share file name's token, not from
the title, so a title cannot predict them.

Modes compared on the same posts:
  shared   every handle and keyword tag the breaking desk's directory has (no video layer)
  video    only the tags and handles the desk has used on video posts, with their copied keywords
  video+   video, plus a person / party the breaking directory knows when the title names them, plus proposed keywords

Run: python eval.py [--shared <apps/worker/config>] [--until 2026-11-13]
"""
import argparse, json, re, subprocess, sys, tempfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent
sys.stdout.reconfigure(encoding="utf-8")
import build as B

CRIME = re.compile(r"हत्या|मर्डर|चोरी|लूट|गिरफ्तार|गिरफ्त|हादसा|दुर्घटना|मौत|शव|अपहरण|ठगी|फायरिंग|तस्कर|नशा|डकैती|बदमाश|आरोपी|"
                   r"वारदात|दुष्कर्म|एसीबी|ACB|कार्रवाई|पुलिस|थाना|जब्त|फरार|मारपीट|Accident|Crime|Police", re.I)
DM_WORDS = re.compile(r"कलेक्टर|जिला प्रशासन|प्रधान|जिला प्रमुख|निर्विरोध|मतदान|निर्वाचन|Collector|DM\b", re.I)


def js_pattern(p: str) -> str:
    """campaigns.json holds JavaScript patterns (the composer runs them with the u flag); Python's re has no \\p{...}.
    Only letters, marks and digits are used: map them to classes that cover Latin, Devanagari and digits."""
    return p.replace(r"\p{L}", r"A-Za-zऀ-ॿ").replace(r"\p{M}", r"ऀ-ॿ").replace(r"\p{N}", r"0-9०-९")


def has(term: str, text: str) -> bool:
    term = term.strip().replace("़", "")
    if not term:
        return False
    if re.search(r"[ऀ-ॿ]", term):
        return re.search(rf"(?<![ऀ-ॿ]){re.escape(term)}(?![ऀ-ॿ])", text) is not None
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(term)}(?![A-Za-z0-9])", text, re.I) is not None


def any_has(terms, text):
    return any(has(t, text) for t in terms or [])


def find_place(title, places, other_states):
    """(district tag or None, outside: bool). The suffix after | / । wins over a place in the headline."""
    text = title.replace("़", "")
    parts = re.split(r"\s[|।]\s?", text)
    for chunk in parts[1:] + parts[:1]:
        for d in places:
            if any_has(d.get("hi", []) + [d["tag"]], chunk) or any(has(t.get("hi", ""), chunk) for t in d.get("towns", [])):
                return d["tag"], False
    return None, any_has(other_states, text)


def predict(title, day, D, mode, places, other_states, shared):
    text = title.replace("़", "")
    district, outside = find_place(title, places, other_states)
    raj = not outside
    tags, handles = {"#FINVideo", "#RajasthanWithFirstIndia" if raj else "#FirstIndiaNews"}, set()
    form = Counter(D["format"]["place_tag_form_recent"]).most_common(1)
    if district:
        tags.add(f"#{district}News" if form and form[0][0] == "#<City>News" else f"#{district}")
    if raj and D["format"]["state_tag"]["share_recent"] >= 0.5:
        tags.add("#RajasthanNews")
    entries = D["tags"] if mode != "shared" else D["shared_tags"]
    for e in entries:
        if e["kind"] in ("identifier", "brand", "state", "place"):
            continue
        if e.get("start") and not (e["start"] <= day <= (e.get("end") or "9999")):
            continue
        words = (e.get("keywords_hi") or []) + (e.get("keywords_en") or [])
        if mode == "video+":
            words += e.get("keywords_proposed") or []
        if (e.get("pattern") and re.search(js_pattern(e["pattern"]), text, re.I)) or any_has(words, text):
            tags.add(e["tag"])
    pool = D["handles"] if mode != "shared" else list(shared.values())
    if mode == "video+":
        known = {e["handle"].lower() for e in pool}
        pool = pool + [e for e in shared.values() if e["handle"].lower() not in known and e.get("kind") in ("person", "party")]
    for e in pool:
        kind = e.get("kind")
        if kind == "reporter":
            continue
        if kind in ("police", "collector"):
            if e.get("district") and e["district"] == district:
                if kind == "police" and CRIME.search(text):
                    handles.add(e["handle"])
                if kind == "collector" and DM_WORDS.search(text):
                    handles.add(e["handle"])
            elif not e.get("district") and any_has((e.get("names_hi") or []) + (e.get("names_en") or []) + (e.get("keywords_hi") or []) + (e.get("keywords_en") or []), text):
                handles.add(e["handle"])
            continue
        if any_has((e.get("names_hi") or []) + (e.get("names_en") or []) + (e.get("keywords_hi") or []) + (e.get("keywords_en") or []), text):
            handles.add(e["handle"])
    return tags, handles, district


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shared", type=Path, default=HERE.parent.parent / "worker" / "config")
    ap.add_argument("--until", default="2026-11-13")
    ap.add_argument("--test-until", default="9999-12-31", help="last day tested (to tune on a validation window)")
    ap.add_argument("--detail", action="store_true", help="print each post's misses for the last mode")
    ap.add_argument("--modes", default="shared,video,video+")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, str(HERE / "build.py"), "--shared", str(args.shared), "--until", args.until, "--out", tmp], check=True)
        D = {k: json.loads((Path(tmp) / f"{k}.json").read_text(encoding="utf-8")) for k in ("format", "tags", "handles")}
    D["tags"], D["handles"] = D["tags"]["entries"], D["handles"]["entries"]
    shared, places, campaigns, normalise = B.load_shared(args.shared)
    subj = json.loads((args.shared / "subject-handles.json").read_text(encoding="utf-8"))
    other_states = subj["office_exclusion_lists"]["other_states"]
    other_states = [w for v in (other_states.values() if isinstance(other_states, dict) else [other_states]) for w in (v if isinstance(v, list) else [])] \
        if not isinstance(other_states, list) else other_states
    # shared-only tag list: campaign / keyword patterns, person tags by name, party tags
    D["shared_tags"] = [{"tag": "#" + c["tag"], "kind": c.get("kind"), "pattern": c.get("pattern"), "start": c.get("start"), "end": c.get("end")} for c in campaigns] + \
        [{"tag": "#" + e["hashtag"], "kind": "party", "keywords_hi": e["keywords_hi"], "keywords_en": e["keywords_en"]} for e in shared.values() if e.get("hashtag")]

    test = [p for p in B.load_posts(HERE / "data" / "finvideo-posts.jsonl", None, normalise) if args.until < p["day"] <= args.test_until]
    reporters = {e["handle"].lower() for e in shared.values() if e.get("kind") == "reporter"}
    print(f"\nbuilt on posts up to {args.until}; testing on {len(test)} posts ({', '.join(sorted({p['day'] for p in test}))})\n")

    def cls_tag(t):
        tl = t.lower()[1:]
        if tl == "finvideo": return "identifier"
        if tl in ("rajasthanwithfirstindia", "firstindianews"): return "brand"
        if tl == "rajasthannews": return "state"
        if tl in {d["tag"].lower() for d in places} or (tl.endswith("news") and tl[:-4] in {d["tag"].lower() for d in places}): return "place"
        return "topic"

    def cls_handle(h):
        if h.lower() in reporters: return "reporter (from file name)"
        e = shared.get(h.lower())
        k = (e or {}).get("kind")
        return {"police": "police", "collector": "collector"}.get(k, "person/party/institution" if e else "not in any directory")

    modes = args.modes.split(",")
    for mode in modes:
        stat = defaultdict(lambda: [0, 0, 0])   # desk, predicted, hit
        misses, wrong = Counter(), Counter()
        for p in test:
            pt, ph, dist = predict(p["title"], p["day"], D, mode, places, other_states, shared)
            desk_t = {"#" + t for t in p["tags"]}
            desk_h = set(p["handles"])
            if args.detail and mode == modes[-1]:
                print(f"{p['day']} [{dist}] {p['title'][:90]}\n   desk-only {sorted((desk_t - pt) | (desk_h - ph))}\n   ours-only {sorted((pt - desk_t) | (ph - desk_h))}")
            for t in desk_t | pt:
                c = cls_tag(t); s = stat["# " + c]
                s[0] += t in desk_t; s[1] += t in pt; s[2] += t in desk_t and t in pt
                if t in desk_t and t not in pt and c == "topic": misses[t] += 1
                if t in pt and t not in desk_t: wrong[t] += 1
            for h in desk_h | ph:
                c = cls_handle(h); s = stat["@ " + c]
                s[0] += h in desk_h; s[1] += h in ph; s[2] += h in desk_h and h in ph
                if h in ph and h not in desk_h: wrong[h] += 1
        print(f"=== mode {mode}")
        print(f"{'part':34} {'desk':>5} {'pred':>5} {'hit':>5} {'found':>7} {'right':>7}")
        for k in sorted(stat):
            d, pr, h = stat[k]
            print(f"{k:34} {d:5} {pr:5} {h:5} {h / d if d else 0:7.0%} {h / pr if pr else 0:7.0%}")
        print("  most added wrongly:", wrong.most_common(8))
        print("  topic tags missed most:", misses.most_common(8), "\n")


if __name__ == "__main__":
    main()
