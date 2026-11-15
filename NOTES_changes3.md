# Changes #3 (hashtag and handle logic) plus the Extracted sheet: notes, 15 Nov 2026

The single combined code and TypeScript review found **no HIGH finding**: nothing wrongly changes what gets posted, and nothing loses data. Per the owner's rule, nothing below blocks and none of it is fixed here.

## Deployment (read before the next restart)

1. **Put the code live first, then the JSON** (the rule from Changes #2). The old worker reads the new JSON files without rejecting them, but it ignores three new fields:
   - `"bureau": true` (reporter-handles.json). Old code treats Kasana as a single-district Jaipur reporter, so his JPR-coded files would get `#Jaipur:`. That is the one thing Q2 forbids.
   - `"alternate": true` (district-handles.json). Old code would list `@pratapgarhpol` as a second Pratapgarh force and warn "check the town" on every Pratapgarh incident. `@DcDmBaran` is first in the file, so Baran is right either way.
   - `leaders` (party-handles.json). Old code ignores it, so no INC suggestion is made.
2. `apps/worker/config/pending-handles.json` is loaded by nothing (a test pins this). It is safe at any time.
3. Ladakh is in the code's national places list (`places.ts`), so it goes live with the code.

## Decisions made while building (the owner's doc was silent or the data disagreed)

- **13 handles, not 12; pending has 42, not 43.** The sheet review counted 0 desk uses for `@ArvindKejriwal`. The stricter recount for this change found 2: the posts end "… #ArvindKejriwal @ArvindKejriwal". By Q4's rule (2+ posts go in) and by pending-handles' own promotion rule, he goes in. To undo it, move his entry from subject-handles.json to pending-handles.json.
- **`bureau: true` on Kasana** (a new reporter field). Q2 asks for `districts: ["Jaipur"]` *and* "no `#Jaipur:` is ever added for him". In the existing code, a reporter with exactly one district has his file code trusted as the story's district. That would have put `#Jaipur:` on his 32 JPR-coded files. The flag keeps him a bureau reporter: his file code is never the story's district, Jaipur is never offered from it, and no mismatch is warned.
- **`alternate: true`** (a new district-handles field) holds Q1's "kept, never chosen" and Q4's "recognised, never chosen automatically". Such an entry stays in `all`, `bound` and `types`, and is never in a pick list.
- **`@pratapgarhpol` is very likely Pratapgarh, Uttar Pradesh police.** X handles are case-insensitive, and the file already said "Do NOT use @PratapgarhPol (Pratapgarh, Uttar Pradesh)". It was added as the owner decided, never picked, with a caution in its note. The desk's 5 uses may be slips.
- **`@cpjoshiBJP`: the name is contested.** One of its 2 desk uses (Nathdwara) was on a story about Congress's Dr. C.P. Joshi, the former Speaker. The entry excludes the "डॉ. सी.पी. जोशी" and "विधानसभा अध्यक्ष" spellings.
- **`@swacchhjaipur`** is a different account from the unverified `@Swachh_Jaipur` already in the file, which is left as it was. "नगर निगम जयपुर" was not taken as a keyword: it names the whole corporation.
- **Ladakh added to the national places** (`places.ts`). The oct20 post "#Ladakh: …" by Kamalkant was read as a label run, so the new desk rule put `#Jaipur:` in front of it and kept the Rajasthan footer. It now goes out as the desk posted it: `#Ladakh:` with `#FirstIndiaNews`. Putting Ladakh in districts.json instead was measured and rejected: it lowered oct20's exact count to 247 (floor 248) without fixing the composer.
- **The party_of_leader offer runs before the reporter prior.** With it after, Naresh's prior (INC 65%) made the offer depend on the prior, which broke L7. The prior now sees INC as taken.
- **Hashtag Hindi keywords (Q6):** a run on 2 of the tag's posts let one story's words in (`#SupremeCourt` ← "बिश्नोई", "अल्बानिया"). A run must therefore be on at least half of the tag's posts (minimum 2), and at least half of the posts that contain it must carry the tag. Four words that still passed on 3-post tags were removed by review: "कोरिया दौरा" (#ChiefSecretary), "कंवर" and "सायर" (#DharmendraRathore), "स्वर्ण" (#PremBhandari). Removing a keyword only narrows a rule.
- **All 4 campaign windows have closed** (they end 13–15 Nov, the last use plus 3 days). They will not fire again unless re-dated.
- **Precision for check 4 is in-sample:** the Hindi keywords were chosen from the same 2,704 posts.

## Review findings (not fixed; for the owner's pick)

### Medium
1. **The Kejriwal count** (see above): 13 loaded handles where the final answers say 12.
2. **`@swacchhjaipur` and `@KolkataPolice` will fire rarely or never.** Both kinds (department, police) fire only as acting agents (`ONLY_ACTING`, `handles.ts`). Neither has a firing test. This is a no-post risk, not a wrong post.

### Low
3. **A desk-typed alternate does not stop the preferred pick.** "#Baran: … @DcDmBaran_" posts with both `@DcDmBaran_` and `@DcDmBaran`. The same happens for `@pratapgarhpol` with `@PratapgrhPolice`. It is within the spec's "recognised", but this needs deciding.
4. **Two notes in district-handles.json contradict each other.** The preferred Pratapgarh entry says "Do NOT use @PratapgarhPol", and the alternate is that account.
5. **Kasana's `_todo` in reporter-handles.json is stale.** It still says "Districts left empty on purpose… 'Jaipur' was not applied".
6. **The new policy reporters get `#Jaipur:` / `#Kota:` in front of copy about another place** when only the gazetteer finds it: Yogesh "Mumbai में बारिश…" → "#Jaipur: Mumbai में बारिश…". This is the agreed rituraj rule (A5: only what the desk wrote blocks it). The side-by-side shows it on, for example, "पाली RTO … का निधन" and "दिल्ली के राम लीला मैदान में कांग्रेस की रैली".
7. **Kamalkant now warns "usually files from Jaipur, not Delhi/Jodhpur"** on his #Delhi and #Jodhpur posts. It is a warning only.

### Nits
8. `parties.ts` `parseLeaders`: `return problem(...), null;` is a comma expression. Write it on two lines.
9. `#PMModi` (मोदी) and `#NarendraModi` can both be offered on one story. They are suggest-only.
10. Shubham Jain's `names_hi: ["शुभम जैन"]` goes beyond Q8's two tokens. It is display only (`names_hi` is never matched) and inert while `verified: false`.

## Where the evidence is

All of it is under `C:\vartmaan\code\testing\sbs\c3\`:
- `replay-before.txt`, `replay-after.txt`: the per-day replay.
- `base.json`, `new.json`, `diff.txt`, `diff.json`: the side-by-side against `0bfb956`.
- `sbs-differences.md`: every difference, with its post and step.
- `hashtags.ts`, `hashtags-report.json`, `hashtag-lists.txt`: the step 5 analysis, every dropped tag and the contested words.
