# Changes #2 (P3–P7, R1–R9, D1, D2, S1–S7): notes from the final review, 15 Nov 2026

The final combined review found no code defect that changes what gets posted. The items below did not block the commit, per the owner's stop rule. They are recorded here; none is fixed.

## Deployment (read before the next restart)

1. **Restart onto this commit before the new directory JSON goes live.** `apps/worker/config/district-handles.json` and `subject-handles.json` are re-read while the worker runs. The new `"police"` type is unknown to the old code, which rejects those entries. The live worker (started 14 Nov 23:49, old code) did exactly that from 15 Nov 00:38 IST: @PoliceRajasthan, @RajPoliceHelp, @AcbRajasthan, @DelhiPolice, @crpfindia and @BSF_India were dropped from tagging until the files were put back. The working copy of those two files was set back to the previous commit's content so the running worker stays correct. **After the restart onto this commit:** `git checkout -- apps/worker/config/district-handles.json apps/worker/config/subject-handles.json`. Rule from now on: put new code live first, then edit the JSON that depends on it.
2. Drafts composed between 00:38 IST and the files being restored may be missing those police and force handles. Not checked against the database.

## Low

3. **"Back on" can take about 120 s, not 60 s** (`apps/worker/src/data-files.ts` ~154, `index.ts` ~488). Each compose resets the shared 60 s wait, and a reload tick that lands under 60 s after it is skipped. Node timers can also fire about 1 ms early. Fix: let the reload tick skip the wait for a broken file.
4. **A missing reporters or beats file bypasses the 60 s wait on every story** (`data-files.ts` ~153-162). The dependency stamp is saved only after `stat` succeeds. Logs stay deduplicated. Fix: save the stamp before the `try`.
5. **`refresh()` can share a cached read that never checked the disk** (`data-files.ts` ~89-94). The nightly's R3 re-check can then use a copy up to 60 s old. Fix: pass a `force` flag into `read()`.

## Nits and info

6. `handles.ts` ~57: `DistrictHandleEntry.handle_type` is still typed `HandleType`. The local `const t: unknown` widening works, but the interface should say `unknown` like the other three (R6).
7. `packages/db/src/schema.ts` ~1171: the `sources` type in `StoredReporterFeatureSet` is written out by hand and can drift from `ReporterFeatureSet`. Derive it with `Omit`/`Partial`.
8. `crons.ts` ~133: the IST date change clears the wait but not the failure counter, so the first failure of a new day can log at error level.
9. Version labels are now `<mtime>.<n>`, so `composeVersion` strings change shape. Anything that splits a stored `composeVersion` on "." would misread it.
10. `nightlyInstitutions` also refreshes the beats file, which it never uses.
11. Tests: `apps/worker/test/breaking.test.ts` ~413 and other worker tests set the private `checkedAt` directly. They were left as they are, by the owner's decision.
12. The S1 bound is read as one error line per broken file. A beats file refused because a handle is only in the broken file logs its own single line.
13. D1 scope: a beat handle that is in no directory file, or is a CM or state-government handle, still rejects the whole beats file. Those are not type problems: a handle is never invented.
14. The reporters file is also re-parsed when a directory file changes, so its prior is re-checked against the new types.
15. `NightlyFeatures` with no candidate function still writes a snapshot with no candidates. Only tests do this; the worker always passes `nightlyInstitutions`.
16. `testing\sbs\README.md` still points at the deleted `C:\vartmaan\code\.wt` paths. Run it with `--data C:\vartmaan\code\testing\replay-data` and `--db C:\vartmaan\code\testing\sbs\db-snapshot.json`, from a checkout with dependencies installed.
