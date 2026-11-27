"""All published #FINVideo posts we hold, one JSON line each: posted_ist (YYYY-MM-DD HH:MM), text, source file.
Sources: testing\replay-data X captures (9 Sep - 13 Nov), the 21 Nov video set, today's 150-post timeline. Dedupe on the text."""
import glob, json, re, sys
from datetime import datetime, timedelta, timezone
sys.stdout.reconfigure(encoding="utf-8")
IST = timezone(timedelta(hours=5, minutes=30))
rows = {}

def add(text, when, src):
    if not text or "#FINVideo" not in text and "#FINVido" not in text:
        return
    key = re.sub(r"https://t\.co/\S+", "", text).strip()
    rows.setdefault(key, {"posted_ist": when, "text": text, "source": src})

def ist(t):
    for f in ("%a %b %d %H:%M:%S %z %Y", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            d = datetime.strptime(t, f)
            return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(IST).strftime("%Y-%m-%d %H:%M")
        except (ValueError, TypeError):
            pass
    return None

for f in sorted(glob.glob(r"C:/vartmaan/code/testing/replay-data/*.json")):
    d = json.load(open(f, encoding="utf-8"))
    items = d if isinstance(d, list) else d.get("items") or d.get("tweets") or d.get("data") or []
    for t in items:
        text = t.get("text") or t.get("body") or ""
        when = ist(t.get("timestamp_utc") or t.get("time_utc") or "") or (t.get("timestamp_ist") or t.get("time_ist") or "")[:16].replace("T", " ")
        add(text, when, f.rsplit("\\", 1)[-1].rsplit("/", 1)[-1])
for l in open(r"C:/Users/Administrator/Desktop/reach checker/firstindia_videos_2026-11-21/dataset.jsonl", encoding="utf-8"):
    r = json.loads(l); add(r["caption"], r["posted_ist"], "videos_2026-11-21")
for i in json.load(open(r"C:/Users/Administrator/Desktop/reach checker/firstindia_videos_2026-11-27/tweets_raw.json", encoding="utf-8"))["items"]:
    t = i["raw"]
    if not t.get("is_retweet"):
        add(t["text"], ist(t["created_at"]), "timeline_2026-11-27")
out = sorted(rows.values(), key=lambda r: r["posted_ist"])
with open("finvideo_corpus.jsonl", "w", encoding="utf-8") as fh:
    for r in out:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
from collections import Counter
print(len(out), sorted(Counter(r["posted_ist"][:10] for r in out).items()))
