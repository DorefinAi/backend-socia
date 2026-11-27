# Training the X Videos headline model

Teaches Qwen3-14B (the model that writes a headline from a clip's screen text, step 4) to write like the desk, from
videos whose real desk headline we know. Nothing here runs on its own; each step is started by hand, in this order.
Run from `apps/xvideos` in PowerShell (Git Bash cannot see the share), with the media service and Ollama running.

| # | Script | Does | Time |
|---|---|---|---|
| 1 | `capture-pairs.ts` | Reads the screen and the anchor's first 45 s of every share clip whose **file name is the desk's headline** (oldest day first: the share deletes files after ~6 days), and of the X posts in a dataset folder (the test set). Read only on the share and the database; writes `XVIDEOS_CACHE\training\*-reads.jsonl`. Resumable. | ~2 h for ~800 clips |
| 2 | `build-pairs.ts` | Turns the reads into examples exactly as production asks the model (the day's programme filler dropped, the production prompt); the answer is the desk's headline. One example per story; split by day (27 Nov and the X posts are the test set). `--distill` keeps the base model's place and topic tags. | ~20 min with `--distill` |
| 3 | `evaluate.ts` | Baseline: `qwen3:14b`, and `qwen3:14b` with the 8 most similar desk headlines as style examples, on the test set (word match as in the trials). | ~10 min |
| 4 | `train_lora.py` | A LoRA (rank 16) on Qwen3-14B in 4 bit, answers only, 2 epochs; writes the adapter, a GGUF and an Ollama Modelfile. Needs `requirements-train.txt` in `x-requirements\train-env` and ~10 GB download the first time. | ~1-2 h on the RTX 4090 |
| 5 | `evaluate.ts --models qwen3:14b,qwen3-xv` | After `ollama create qwen3-xv -f <run>\gguf\Modelfile`: the trained model against the baseline. Kept only if it wins; then the worker uses it with `XVIDEOS_HEADLINE_MODEL=qwen3-xv`. | ~15 min |

```
node --env-file=.env --import tsx training/capture-pairs.ts --since 2026-11-22
node --env-file=.env --import tsx training/capture-pairs.ts --dataset "C:\Users\Administrator\Desktop\reach checker\firstindia_videos_2026-11-21" --media http://127.0.0.1:8301
node --env-file=.env --import tsx training/build-pairs.ts --distill
node --env-file=.env --import tsx training/evaluate.ts
..\..\..\x-requirements\train-env\Scripts\python.exe -I training\train_lora.py --data C:\vartmaan\data\xvideos-cache\training
ollama create qwen3-xv -f C:\vartmaan\data\xvideos-cache\training\run-<time>\gguf\Modelfile
node --env-file=.env --import tsx training/evaluate.ts --models qwen3:14b,qwen3-xv
```

Material on 28 Nov 2026: 802 distinct file-name headlines on the share (22-27 Nov) for training; the X posts of 21 and
27 Nov with their videos (Desktop\reach checker) for testing. New pairs come from the desk every day.
