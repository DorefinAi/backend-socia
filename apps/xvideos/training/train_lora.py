"""Training step 4: a LoRA on Qwen3-14B that writes the desk's headline from the screen text, for Ollama.

What it trains: only a small adapter (LoRA, rank 16) on top of Qwen3-14B loaded in 4 bit, on the examples of
build-pairs.ts (the production prompt -> the desk's headline as the JSON production parses). Thinking stays off, as in
production (think: false). Only the answer is trained on, never the prompt.

What it writes (all under <out>, nothing else is touched):
  adapter/          the LoRA itself (small, ~100 MB)
  gguf/             the merged model as GGUF q4_k_m, and a Modelfile for Ollama
  train-report.json the settings, the losses, the time

Then, by hand after looking at the scores:  ollama create qwen3-xv -f <out>/gguf/Modelfile
The worker keeps using qwen3:14b until XVIDEOS_HEADLINE_MODEL=qwen3-xv is set.

    x-requirements\\train-env\\Scripts\\python.exe -I train_lora.py --data <XVIDEOS_CACHE>\\training [--out ...] [--epochs 2]

Needs: an NVIDIA GPU with 24 GB (RTX 4090), the packages in requirements-train.txt, and the first time ~10 GB of
download (unsloth/Qwen3-14B-unsloth-bnb-4bit from Hugging Face).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

BASE = "unsloth/Qwen3-14B-unsloth-bnb-4bit"
MAX_LEN = 4096          # the prompt is ~2,500 tokens with a long screen read; the answer under 200


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="folder with train.jsonl and test.jsonl (build-pairs.ts)")
    ap.add_argument("--out", type=Path, default=None, help="default: <data>/run-<time>")
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--no-gguf", action="store_true", help="train only, no GGUF export")
    args = ap.parse_args()
    out = args.out or args.data / f"run-{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)

    # unsloth first: it patches transformers and trl when imported
    from unsloth import FastLanguageModel
    from unsloth.chat_templates import train_on_responses_only
    from datasets import Dataset
    from trl import SFTConfig, SFTTrainer

    model, tokenizer = FastLanguageModel.from_pretrained(model_name=BASE, max_seq_length=MAX_LEN, load_in_4bit=True)
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.rank,
        lora_alpha=args.rank,
        lora_dropout=0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        use_gradient_checkpointing="unsloth",
        random_state=7,
    )

    def as_text(rows: list[dict]) -> Dataset:
        # Qwen3's own chat template, thinking off, as Ollama runs it in production
        texts = [tokenizer.apply_chat_template(r["messages"], tokenize=False, enable_thinking=False) for r in rows]
        return Dataset.from_dict({"text": texts})

    train_rows, test_rows = load(args.data / "train.jsonl"), load(args.data / "test.jsonl")
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=as_text(train_rows),
        eval_dataset=as_text(test_rows),
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=MAX_LEN,
            per_device_train_batch_size=1,
            gradient_accumulation_steps=8,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.05,
            weight_decay=0.01,
            optim="adamw_8bit",
            logging_steps=5,
            eval_strategy="epoch",
            save_strategy="no",
            bf16=True,
            seed=7,
            output_dir=str(out / "trainer"),
            report_to="none",
        ),
    )
    # Learn the answer only, not the long prompt
    trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")

    started = time.time()
    stats = trainer.train()
    evals = trainer.evaluate()
    model.save_pretrained(str(out / "adapter"))
    tokenizer.save_pretrained(str(out / "adapter"))

    if not args.no_gguf:
        # Merged with the base and written as GGUF for Ollama (llama.cpp's converter, run by unsloth)
        model.save_pretrained_gguf(str(out / "gguf"), tokenizer, quantization_method="q4_k_m")
        gguf = next((out / "gguf").glob("*.gguf"))
        # The same chat template and stops as qwen3:14b in Ollama; temperature as production sends it
        (out / "gguf" / "Modelfile").write_text(
            f"FROM ./{gguf.name}\n"
            'TEMPLATE """{{- range .Messages }}<|im_start|>{{ .Role }}\n{{ .Content }}<|im_end|>\n{{ end }}<|im_start|>assistant\n"""\n'
            'PARAMETER stop "<|im_end|>"\nPARAMETER stop "<|im_start|>"\nPARAMETER temperature 0.2\nPARAMETER num_ctx 8192\n',
            encoding="utf-8",
        )

    (out / "train-report.json").write_text(
        json.dumps(
            {
                "base": BASE,
                "train_examples": len(train_rows),
                "test_examples": len(test_rows),
                "epochs": args.epochs,
                "lr": args.lr,
                "rank": args.rank,
                "train_loss": stats.training_loss,
                "eval": evals,
                "minutes": round((time.time() - started) / 60, 1),
            },
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"done: {out}")


if __name__ == "__main__":
    main()
