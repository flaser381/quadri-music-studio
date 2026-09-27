"""YuE2 worker for quadri music studio: one process, one song at a time, spawned by backend/src/worker.ts.

stdin, one JSON object per line:
  {"cmd": "generate", "style", "lyrics", "cot", "seed", "cfg_scale", "abc", "out"}
  {"cmd": "cancel"}   aborts the running song (between tokens / ODE steps)
  {"cmd": "quit"}     unload and exit (also on stdin EOF, i.e. when the studio dies)
stdout, protocol only (JSON lines): ready · stage · progress · stage_end · score · done · error
stderr: everything else (YuE2 progress, torch warnings), shown as the studio's "Worker log".

Environment: YUE2_MODEL, YUE2_VAE (local dirs), YUE2_BACKEND (torch | torch-eager),
YUE2_ATTENTION (auto | sdpa | fast: attention inside the decode graphs, see patch_attention), YUE2_HASH_CACHE (json file).
"""
from __future__ import annotations

import gc
import json
import os
import queue
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from pathlib import Path

# Protocol goes to a private copy of stdout; anything libraries print (also from C) lands on stderr.
_proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
_send_lock = threading.Lock()


def send(ev, **data):
    with _send_lock:
        _proto.write(json.dumps({"ev": ev, **data}, ensure_ascii=False) + "\n")
        _proto.flush()


MODEL = os.environ.get("YUE2_MODEL", "m-a-p/YuE2-3B")
VAE = os.environ.get("YUE2_VAE", "m-a-p/YuE2-Vae")
BACKEND = os.environ.get("YUE2_BACKEND", "torch")
ATTENTION = os.environ.get("YUE2_ATTENTION", "fast")
HASH_CACHE = os.environ.get("YUE2_HASH_CACHE")

cancel = threading.Event()
commands: queue.Queue = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("cmd") == "cancel":
            cancel.set()
        else:
            commands.put(msg)
    commands.put({"cmd": "quit"})


# ---------- patches (no changes to the installed package) ----------

def patch_hash_cache():
    """model_identity() sha256s all 7.8 GB on every start; cache verified digests by size + mtime."""
    if not HASH_CACHE:
        return
    import yue2.pipeline as pipeline_mod
    original = pipeline_mod.model_identity

    def cached(path, verify=True):
        path = Path(path)
        key = {f.name: [f.stat().st_size, f.stat().st_mtime_ns] for f in sorted(path.glob("*.safetensors"))}
        try:
            cache = json.loads(Path(HASH_CACHE).read_text())
        except (OSError, ValueError):
            cache = {}
        hit = cache.get(str(path))
        if hit and hit.get("key") == key and (hit.get("verified") or not verify):
            return hit["identity"]
        print(f"[worker] hashing {path.name} (first start or files changed)", file=sys.stderr, flush=True)
        identity = original(path, verify)
        cache[str(path)] = {"key": key, "verified": verify, "identity": identity}
        tmp = Path(HASH_CACHE + ".tmp")
        tmp.write_text(json.dumps(cache, indent=1))
        tmp.replace(HASH_CACHE)
        return identity

    pipeline_mod.model_identity = cached


def patch_attention():
    """Attention inside the AR decode graphs (GraphAR).

    auto: YuE2's choice, varlen FlashAttention with seqused_k, which ROCm rejects ("seqused_k must be nullopt").
    sdpa: masked SDPA over the whole preallocated cache. On ROCm ~2.1 ms per layer at 11k slots → ~12 tok/s.
    fast: same masked attention as two matmuls + softmax per CFG branch, ~0.14 ms per layer (≥ 60 tok/s).
    """
    if ATTENTION == "auto":
        return
    import types

    import torch
    import torch.nn.functional as F
    import yue2.cuda_graph as cg

    original = cg.GraphAR.__init__

    def init(self, *args, **kwargs):
        kwargs.setdefault("attention_backend", "sdpa")
        original(self, *args, **kwargs)

    cg.GraphAR.__init__ = init
    if ATTENTION != "fast":
        return
    sdpa = F.scaled_dot_product_attention

    def branch(q, k, v, visible):
        # q [Hq,1,D]; k, v [Hk,cap,D] (strided cache views); visible [cap]; GQA: q head h uses kv head h // g
        heads, dim = q.shape[0], q.shape[-1]
        scores = torch.matmul(q.reshape(k.shape[0], heads // k.shape[0], dim), k.transpose(-1, -2)).float()
        scores = (scores * dim ** -0.5).masked_fill(~visible, float("-inf"))
        return torch.matmul(scores.softmax(-1).to(q.dtype), v).reshape(heads, 1, dim)

    def decode_attention(query, key, value, attn_mask=None, is_causal=False, enable_gqa=False, **kwargs):
        if (query.shape[-2] != 1 or attn_mask is None or attn_mask.dtype != torch.bool or is_causal or kwargs
                or query.shape[1] % key.shape[1]):
            return sdpa(query, key, value, attn_mask=attn_mask, is_causal=is_causal, enable_gqa=enable_gqa, **kwargs)
        # one branch at a time: a batched matmul over [branch, head] strides takes a slow path on ROCm
        return torch.stack([branch(query[b], key[b], value[b], attn_mask[b].reshape(-1)) for b in range(query.shape[0])])

    class FastF(types.ModuleType):
        def __getattr__(self, name):
            return getattr(F, name)

    fast = FastF("yue2_fast_functional")
    fast.scaled_dot_product_attention = decode_attention
    cg.F = fast


# ---------- progress: replaces YuE2Pipeline._status (stderr text) with protocol events ----------

STAGE_OF = {
    "Verifying model files": "load",
    "Loading model": "load",
    "Planning score": "compose",
    "Using provided score": "compose",
    "Generating song": "sing",
    "Synthesizing audio": "render",
    "Loading audio decoder": "decode",
    "Decoding audio": "decode",
}


class Stage:
    def __init__(self, label, total, unit):
        self.key = STAGE_OF.get(label, "load")
        self.label, self.total, self.unit = label, total, unit
        self.completed = 0
        self.started = time.perf_counter()
        self._sent = 0.0

    def _emit(self, force=False):
        now = time.perf_counter()
        if force or now - self._sent >= 0.25:
            self._sent = now
            send("progress", stage=self.key, completed=self.completed, total=self.total,
                 seconds=round(now - self.started, 3))

    def advance(self, count=1):
        self.completed += count
        self._emit()

    def update(self, completed, total=None):
        self.completed = completed
        if total is not None:
            self.total = total
        self._emit(completed == self.total)

    def set_total(self, total):
        self.total = total

    def token(self, phase, token):
        self.advance()

    def finish(self, status="completed"):
        pass


@contextmanager
def status(label, *, total=None, unit=None):
    stage = Stage(label, total, unit)
    send("stage", stage=stage.key, label=label, total=total)
    try:
        yield stage
    finally:
        stage._emit(True)
        send("stage_end", stage=stage.key, label=label, seconds=round(time.perf_counter() - stage.started, 3))


# ---------- song ----------

def peaks(audio, n=240):
    import numpy as np
    mono = np.abs(audio).mean(axis=1) if audio.ndim == 2 else np.abs(audio)
    if len(mono) < n:
        return [0] * n
    buckets = np.array_split(mono, n)
    rms = np.array([float(np.sqrt(np.mean(b * b))) for b in buckets])
    top = rms.max() or 1.0
    return [int(round(100 * v / top)) for v in rms]


def generate(pipe, req):
    from yue2.pipeline import SongResult
    from yue2.protocol import EOD
    from yue2.storage import identity

    cancel.clear()
    kwargs = {"cot": req.get("cot", "full"), "seed": int(req["seed"])}
    if req.get("abc"):
        kwargs["abc"] = req["abc"]
    if req.get("cfg_scale") is not None:
        kwargs["cfg_scale"] = float(req["cfg_scale"])
    request = pipe._request(req["style"], req["lyrics"], **kwargs)
    config = pipe.effective_config(request)
    request_id = identity({"request": request.to_dict(), "config": config, "weights": pipe.weights})
    start = time.perf_counter()

    abc_ids, last = [], [0.0]

    def on_token(phase, token):
        if phase != "abc" or token >= EOD:
            return
        abc_ids.append(token)
        now = time.monotonic()
        if now - last[0] > 0.4:
            last[0] = now
            send("score", text=pipe.tokenizer.decode(abc_ids))

    plan = pipe.plan(request=request, cancelled=cancel.is_set, on_token=on_token)
    if plan.abc is not None:
        send("score", text=plan.abc)
    semantic = pipe.generate_semantic(plan, cancelled=cancel.is_set, on_token=on_token)
    nar_start = time.perf_counter()
    latents = pipe.synthesize(semantic, cancelled=cancel.is_set)
    nar_seconds = time.perf_counter() - nar_start
    if cancel.is_set():
        raise InterruptedError("Cancelled before VAE")
    vae_start = time.perf_counter()
    audio = pipe.decode(latents)
    timing = {"abc": plan.timing, "semantic": semantic.timing, "nar_seconds": nar_seconds,
              "vae_seconds": time.perf_counter() - vae_start, "load": dict(pipe.load_timing),
              "e2e_seconds": time.perf_counter() - start}
    song = SongResult(audio, 48000, semantic, latents, config, pipe.weights, timing, request_id)
    send("stage", stage="save", label="Saving", total=None)
    song.save_artifacts(req["out"])
    send("done", duration=len(audio) / 48000, peaks=peaks(audio), score=plan.abc,
         truncated=song.truncated, timing=timing,
         tokens={"abc": len(plan.abc_ids), "semantic": len(semantic.tokens),
                 "tps": semantic.timing.get("output_tps")})


def main():
    threading.Thread(target=read_stdin, name="stdin", daemon=True).start()
    import torch
    from yue2 import YuE2Pipeline

    patch_hash_cache()
    patch_attention()
    t0 = time.perf_counter()
    with status("Verifying model files"):
        pipe = YuE2Pipeline.from_pretrained(MODEL, vae=VAE, local_files_only=True, device="auto",
                                            backend=BACKEND, progress=True)
    pipe._status = status
    dev = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
    hip = getattr(torch.version, "hip", None)
    send("ready", seconds=round(time.perf_counter() - t0, 2), device=dev, torch=torch.__version__,
         hip=hip, backend=BACKEND, attention=ATTENTION)

    while True:
        msg = commands.get()
        if msg.get("cmd") == "quit":
            break
        if msg.get("cmd") != "generate":
            continue
        try:
            generate(pipe, msg)
        except BaseException as exc:  # noqa: BLE001 — every failure must reach the studio
            cancelled = isinstance(exc, InterruptedError) or cancel.is_set()
            text = f"{type(exc).__name__}: {exc}"
            if not cancelled:
                traceback.print_exc(file=sys.stderr)
            # after a device error the HIP context may be unusable: report and let the studio respawn us
            fatal = not cancelled and any(s in text for s in ("HIP", "CUDA", "hipError", "out of memory"))
            send("error", message=text, cancelled=cancelled, fatal=fatal)
            if fatal or isinstance(exc, (KeyboardInterrupt, SystemExit)):
                break
        finally:
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
    pipe.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        send("error", message=f"{type(exc).__name__}: {exc}", cancelled=False, fatal=True)
        sys.exit(1)
