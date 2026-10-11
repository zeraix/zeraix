/**
 * Local model catalog (main process, pure data + lookups, no side effects): the quantisation table, the curated MODELS list,
 * the seed / MoE-pool allowlists and their platform gates, and the descriptor built for a non-catalog Hub repo.
 *
 * Part of localModels.mjs, which re-exports everything here — import from that entry, not from this file. The sizing
 * conventions these numbers follow (nominal vs calibrated bpw, measured kvElems) are described in the localModels.mjs header.
 */

// Quantization tiers: higher quality → larger size. bpw = effective bits per weight.
export const QUANTS = [
  { id: "Q8_0", bpw: 8.5, quality: 99, label: "Q8_0 · near-lossless" },
  { id: "Q6_K", bpw: 6.56, quality: 97, label: "Q6_K · very high" },
  { id: "Q5_K_M", bpw: 5.67, quality: 95, label: "Q5_K_M · high" },
  { id: "Q4_K_M", bpw: 4.85, quality: 90, label: "Q4_K_M · balanced (default)" },
  { id: "IQ4_XS", bpw: 4.25, quality: 87, label: "IQ4_XS · compact 4-bit" },
  { id: "Q3_K_M", bpw: 3.91, quality: 80, label: "Q3_K_M · small" },
  { id: "IQ3_M", bpw: 3.5, quality: 74, label: "IQ3_M · very small" },
  { id: "IQ2_M", bpw: 2.7, quality: 58, label: "IQ2_M · tiny (noticeable quality loss)" },
];

// Capability high → small. active = activated parameters (MoE); arch is only used to estimate KV.
/**
 * Models a resident seed is PUBLISHED for.
 *
 * A seed is a build artifact, not a capability: `scripts/gen-seed.mjs` runs each of these models against each mode and uploads the
 * result. A model is on this list only once its seed has been generated and pushed. Nothing else is gated on it — see
 * kvTierEnabled for the disk tier itself, which every model on mac gets.
 *
 * Every entry also needs a pinned `revision` below, because the seed is only valid for the exact GGUF it was built against (the
 * chat template ships inside the file and model_key does not cover it). seedAvailable enforces that.
 */
export const SEED_MODELS = new Set(["qwen3.6-35b-a3b", "gemma4-26b-a4b", "gemma4-e4b", "gemma4-12b", "ternary-bonsai-27b", "lfm2.5-2.6b"]);

/**
 * Models the MoE expert pool is enabled for.
 *
 * An allowlist because the pool needs a per-model ROUTING PROFILE (which experts to keep resident), so it applies only to
 * mixture-of-experts models, and only where a profile has been generated and shipped. E4B and 12B are dense (`moe: false`) —
 * there is nothing for a pool to do.
 *
 * Without a profile the fork's pool stays inert by design rather than pinning blind index-order experts, so a missing file
 * degrades to stock behaviour instead of degrading quality.
 */
export const MOE_POOL_MODELS = new Set(["gemma4-26b-a4b", "qwen3.6-35b-a3b"]);

/** macOS only, same reason as the KV tier: the pool exists only in the fork's build, and only its mac build is published. */
export function moePoolEnabled(modelId) {
  if (process.platform !== "darwin") return false;
  return !!modelId && MOE_POOL_MODELS.has(String(modelId));
}

/**
 * Whether the KV disk tier runs. macOS only, and no model gate.
 *
 * The tier lives in the fork's llama-server, and only the mac build of that is published — Windows installs the pinned upstream
 * binary from the CDN, which has none of these flags. Keeping the platform check here (rather than only relying on the binary
 * probe) means Windows never even creates a disk directory.
 *
 * It takes no model id because nothing about it is model-specific. The server content-addresses the KV layout itself into a
 * `model_key` (model geometry + KV quant + SWA + rotation flag), files units under `<dir>/<model_key>/`, and a mismatched layout
 * simply never matches — so an unknown GGUF gets prefix reuse across restarts with no way to collide with another model's units.
 * Seeds are a separate, optional accelerator on top: see seedAvailable.
 */
export function kvTierEnabled() {
  return process.platform === "darwin";
}

/**
 * Whether a published seed exists to download for this model.
 *
 * Strictly narrower than kvTierEnabled: the tier works with no seed at all — it just starts cold and warms up as the user talks.
 * A seed only removes the first prefill. So this gates the DOWNLOAD, never the tier.
 *
 * Requires the pinned revision as well as list membership: the seed key embeds `r<revision8>` (see seeds.seedKey), so a model with no
 * pin would request a URL that can never exist and 404 on every launch.
 */
export function seedAvailable(modelId) {
  if (!kvTierEnabled() || !modelId || !SEED_MODELS.has(String(modelId))) return false;
  return !!MODELS.find((m) => m.id === modelId)?.revision;
}

export const MODELS = [
  {
    id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B", params: 35, active: 3, moe: true, vision: true, mtp: true, mtpEmbedded: true,
    // Share of the weights held in expert tensors (ffn_*_exps), measured from the UD-Q4_K_XL GGUF: 20.12 of 22.84 GB.
    // Only the pooled fraction of these is resident; see moeResidentGB. Absent => the model is sized as fully resident.
    expertFrac: 0.881,
    // Cap thinking at N tokens (--reasoning-budget). Qwen3.6's template FORCES thinking open - add_generation_prompt
    // emits a bare `<think>\n` - so every turn reasons whether or not it needs to. Measured across a session, 1242
    // of 2526 generated tokens were thinking that the template then discards at the next user turn: 49%, with
    // individual turns at 91-98%. Decode is ~56% of an agentic turn's wall clock and scales with tokens generated,
    // so this is the largest single lever on how the model feels.
    //
    // A sampler, not a prompt hint: it forces the closing tag at the budget, so it holds regardless of the model's
    // inclination. 1000 leaves the ordinary 100-500 token turns untouched and only truncates the runaways.
    // Gemma models are not capped - none of them showed this behaviour.
    reasoningBudget: 1000,
    // Injected immediately before the closing tag when the budget runs out, INSIDE the thinking stream - so it
    // reads as the model's own last thought. Without it the reasoning is severed mid-sentence and whatever comes
    // next starts from a broken train of thought.
    //
    // Deliberately neutral about WHAT happens next. An earlier wording ("let me answer with what I have") biased
    // the turn toward replying, which is wrong whenever the model was mid-plan on a tool call: the budget can run
    // out in a turn whose next act is a tool call, and telling it to answer talks it out of the call it needed to
    // make. "Move on to the next step" fits both.
    reasoningBudgetMessage: "\n\nI have enough to go on. Let me move on to the next step.\n",
    // vision:true = this GGUF repo ships a vision projector (mmproj). At launch, explicitly pass --mmproj to load the same repo's vision projector (vision on, default);
    // if vision is off, pass --no-mmproj to skip it (saves ~1GB of resident memory, see VISION_OVERHEAD_GB). Whether an mmproj actually exists follows the HF repo.
    // mtpEmbedded:true = use unsloth's "-MTP-GGUF" repo: the MTP (multi-token prediction) head is embedded in the weights themselves (self-speculative, no separate drafter file),
    // and it also ships UD quants + mmproj. At launch, --spec-type draft-mtp enables self-speculative decoding (turning off vision/MTP only affects loading/toggles; the weights still come from this repo).
    hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    // Read from the GGUF, not guessed: block_count 41, head_count_kv 2, key/value_length 256, and
    // full_attention_interval 4 - so only 1 layer in 4 holds KV cells at all. The other 3 in 4 are GDN-recurrent,
    // whose state is a fixed [S,S,H] blob per sequence with no per-token cells, hence window 0 rather than a
    // sliding window. The previous { L:48, kvH:4, hd:128 } over-stated KV by 4.4x (6.44 GB vs 1.48 GB at 256K),
    // which is what made the context ladder refuse rungs this machine can hold.
    // UNDER-counts by the recurrent state itself, which is real but not per-token and not modelled here.
    // kvElems = KV elements per cell (K+V, summed over the layers in that group), read from the GGUF.
    // full: 11 attention layers x head_count_kv 2 x (key_length 256 + value_length 256). 11 is not an
    // estimate: full_attention_interval=4 and models/qwen35moe.cpp marks layer i recurrent when
    // (i+1) % 4 != 0 for i < n_layer(), so the 40-layer trunk has 10 full-attention layers and the
    // nextn/MTP layer (index 40) is dense attention too. swa: 0 - the 30 GDN-recurrent layers hold no
    // growing KV; their fixed state is recurrentGB's job.
    arch: { L: 41, kvH: 2, hd: 256, swa: { every: 4, window: 0 }, kvElems: { full: 11264, swa: 0 } }, maxCtx: 262144,
    // The 30 GDN-recurrent layers the window-0 above excludes from KV. Their state is NOT per-token: a
    // fixed blob per layer per SEQUENCE, so it does not grow with ctx.
    //
    // perSeqMiB is MEASURED, from the server's own startup line at --parallel 2:
    //   llama_memory_recurrent: size = 376.88 MiB (2 cells, 40 layers, 2 seqs 2 rs_seq)
    // 376.88 / 2 = 188.44. The GGUF fields (ssm.state_size 128, ssm.inner_size 4096, conv_kernel 4,
    // group_count 16) are kept for reference but are NOT what this is computed from - see recurrentGB
    // for why deriving it produced a 3x error.
    recurrent: { perSeqMiB: 188.44, layers: 30, state: 128, inner: 4096, conv: 4, groups: 16 },
    // Pinned commit. Required for any model on SEED_MODELS: a resident seed is only valid for the exact GGUF it was built
    // against, because the chat template ships inside the file and model_key does not cover it. Leaving this on "main" means a
    // repo re-upload silently changes the rendered prefix and every published seed stops matching, with no error. Bump it and
    // regenerate seeds together. null = track main (fine for models with no seed).
    revision: "5bc3e238d916f48a861bac2f8a1990a0e9b7e98d",
    // unsloth ships only UD dynamic quants; pick a UD tag by device-memory tier (i.e. the :QUANT in -hf). memGB = total Mac unified memory / discrete-GPU VRAM.
    quantTiers: [
      // bpw measured from the shipped GGUF (22.85 GB / 35B params), not the nominal 4.5 of a plain Q4_K: unsloth's UD
      // quants keep selected tensors at higher precision, and at 4.5 the catalog under-estimated this model by 13.9%.
      // UD-Q3_K_XL below is still the nominal figure - that tier is not installed here, so there was nothing to measure.
      // minMemGB is where the quant measurably fits WITH the expert pool, not where the whole GGUF would.
      // At 256K context, q4 KV, vision on, and the native/pooled split moeNativePlan derives for that machine:
      //   UD-Q4_K_XL  fits from 20 GB (16.3 of a 16.3 GB budget on 24 GB, 12 layers native)
      //   UD-Q3_K_XL  fits from 16 GB (10.7 of 10.9)
      // Both figures moved with the budget factor (0.70 -> 0.68) and again when kvGB was corrected against the
      // GGUF geometry; q4's floor is 13.3 GB, so it now needs mem*0.68 >= 13.3, i.e. 20 GB rather than 18.
      // 24 GB gets q4 at the full 256K, 16/18 GB stays on q3. Note the q4 threshold below is now AT its fit
      // point rather than a config above it: an 18 GB Mac is excluded by 1.1 GB, not by a deliberate margin.
      // What margin remains is that moeResidentGB models the dirty allocation only - neither the GDN recurrent
      // state nor the page cache the pooled experts want is charged against this budget.
      // Was 31/23, sized when the model was counted as fully resident (22.84 GB rather than 8.5-13.3).
      { minMemGB: 20, quant: "UD-Q4_K_XL", bpw: 5.22 },
      { minMemGB: 16, quant: "UD-Q3_K_XL", bpw: 3.6 },
      // UD-Q2_K_XL (~14GB weights) leaves too little headroom for KV/context on a 16G machine, commented out for now; enable it if you need to barely run 35B on 16G.
      // { minMemGB: 16, quant: "UD-Q2_K_XL", bpw: 2.6 },
    ],
    notes: "MoE, ~3B active → fast decode, quality close to a large model. Multimodal + agentic coding."
  },
  // —— Gemma 4 QAT (quantization-aware training) series: 4-bit near bf16, unsloth UD GGUF built from the official QAT checkpoints.
  // Use only UD-Q4_K_XL (the QAT repos ship only Q2/Q4; Q2 loses quality noticeably so it is dropped). All three repos include a separate MTP drafter (MTP/mtp-*-Q4_0.gguf, ~hundreds of MB),
  // auto-downloaded alongside the main weights and enabling speculative decoding via -md + --spec-type draft-mtp (on by default, can be turned off in the UI). If the drafter is missing, it degrades to no speculation (does not block startup).
  // vision:true: all three repos bundle an mmproj (mmproj-F16.gguf etc.); at launch, explicitly pass --mmproj to load the vision projector; if you don't need vision, turn it off in the UI (saves ~1GB resident).
  {
    id: "gemma4-26b-a4b", name: "Gemma 4 26B-A4B", params: 26, active: 4, moe: true, vision: true, mtp: true,
    // Measured from the UD-Q4_K_XL GGUF: 12.85 of 14.23 GB in expert tensors. See moeResidentGB.
    expertFrac: 0.903,
    revision: "7b92b5b28818151e8669af2e45e88d6086f490dd", // pinned: see the note on qwen above — required for seeded models
    // GGUF: block_count 30 (5 full-attention + 25 window), head_count_kv 2 on the full layers and 8 on the
    // window ones, key/value_length 512 full and 256 SWA. L stays 48 because it feeds the -ngl split, not KV.
    hf: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 }, kvElems: { full: 10240, swa: 102400 } }, maxCtx: 262144,
    quantTiers: [
      // 16, not 18: with the expert pool the weights are 7.3-8.6 GB resident rather than the whole 14.2 GB file,
      // and the model fits a 16 GB Mac at 64K (10.9 of a 10.9 GB budget, 7 layers native) or the full 256K with
      // vision off (7 native there too; 11 at 64K). 14 GB and below fits at no rung at all, so this is the real
      // floor. Vision on tops out at 192K. The reachable context grew when kvGB was corrected against the GGUF
      // geometry - this model's KV at 256K was over-counted by 2.6 GB, which had capped a 16 GB Mac at 128K.
      // Which CONTEXT is affordable is decided per rung by estimate(), not here - the tier only answers "can this
      // machine run the model at all". Gating the model on the memory a 256K context needs hid it from machines
      // that can run it perfectly well at 64K.
      { minMemGB: 16, quant: "UD-Q4_K_XL", bpw: 4.38 }, // 14.25 GB on disk / 26B params. Was 4.37, which is
      // 14.20 GB - a 47 MB under-count, and under-counting weights is the direction that overruns the budget.
    ],
    notes: "MoE ~4B active → fast decode, high quality. Multimodal (images only, no audio)."
  },
  {
    // The id stays `ternary-bonsai-27b` while the display name does not: the id is what seed archives,
    // locale keys and installed model directories are named after, and the seeds published for this
    // revision are already keyed to it. Renaming the id would orphan all three for a label change.
    id: "ternary-bonsai-27b", name: "Qwen Bonsai 27B", params: 27.3, active: 27.3, moe: false, vision: true,
    // macOS only, and the reason is the weights: the tier below is PQ2_0, a ggml type this project's
    // Metal fork adds (id 142). A Windows/Linux build does not have it and would fail to load the file
    // with a size mismatch, not a clean "unsupported quant". Those platforms keep gemma4-12b instead -
    // see the entry after this one, which carries the complementary platforms list.
    platforms: ["darwin"],
    // mtp:false - this model's drafter is NOT an MTP head, so --spec-type draft-mtp does not apply.
    // It is a DSpark block-diffusion drafter: a separate model that predicts a whole block of
    // block_size positions at once and scores each with a confidence head. It gets its own descriptor
    // below rather than reusing the mtp fields, because the launch flags and the download source both
    // differ.
    mtp: false,
    // The drafter does not live in the model's own repo. prism-ml ships an unconverted one
    // (Ternary-Bonsai-27B-dspark-Q4_1.gguf, 1.95 GB) whose arch is `dspark` and whose token_embd
    // declares ggml type 42 - group-64 here, group-128 there - so mainline cannot load it. Ours is that
    // file converted to the `dflash` arch with the target's tokenizer injected and token_embd/output
    // dropped so it borrows the target's, which is what takes it to 825 MB.
    //
    // Pinned to the upload commit, not `main`: llama-seeds is also where seed payloads land, so its
    // main moves for reasons that have nothing to do with this file.
    //
    // Measured on M3 Pro against Ternary-Bonsai-27B PQ2_0, 24-prompt suite, mean of three prompt
    // orders: 1.262x aggregate, 67% of drafted tokens accepted. n_max 7 rather than the trained
    // block_size of 4 on purpose - the target verifies 1 + n_draft tokens in one batch and that batch
    // costs the same anywhere from 4 to 8 wide, so the surplus is free and gets filled from token
    // history. p_min 0.7 is where the confidence head's truncation was measured best.
    draft: {
      type: "dspark",
      repo: "Zeraix/llama-seeds",
      path: "drafters/Ternary-Bonsai-27B-dspark-dflash-Q4_1.gguf",
      revision: "710ab23950c66513344e51d324fe8bcb18a2d140",
      bytes: 824995296,
      nMax: 7,
      pMin: 0.7,
    },
    // Sampling, because llama-server's defaults send this model into endless loops. The app declares
    // no sampling fields anywhere (openai-adapter builds model/messages/max_tokens and nothing else),
    // so every request ran the server defaults: temp 0.80, top-k 40, top-p 0.95, min-p 0.05, and every
    // repetition control off (repeat-penalty 1.0, presence-penalty 0.0, dry-multiplier 0.0).
    //
    // Not the drafter - measured, not assumed. The same prompt with the drafter off loops the same way
    // (no -md in the args, zero draft-acceptance lines, still going at 1,226 tokens). The target
    // verifies every drafted token, so speculative decoding cannot change the output in the first place.
    //
    // The failure is stochastic, so every row below is repeated runs of one prompt ("write ~300 words
    // about West Lake"), never a single sample. Reading these in order is the whole argument:
    //
    //   defaults                          runaway, killed by hand at 4,670 tokens
    //   DRY 0.8 alone                     ends at 555 tokens, text still degenerate ("荷荷" bursts)
    //   temp 0.6 + top-k 20 + DRY         3/4 clean, 4th ran away
    //   ... with "\n" out of DRY breakers 5/6 normal, 6th restarted the essay at 1,233 chars
    //   temp 0.7 (Bonsai's card) + above  runaway at 2,372 tokens
    //   + presence-penalty 1.5            6/6 clean, 256-379 tokens, zero repeated sentences
    //
    // presence-penalty is what actually fixes it, and it is Qwen's own prescription: their card says to
    // "adjust presence_penalty between 0 and 2 to reduce endless repetitions", and ships 1.5 in the
    // non-thinking profile. The narrowed window and DRY are kept because they were measured better than
    // without, but neither of them closes it - a config was twice declared fixed on runs that looked
    // clean and failed on the next prompt. Judge any change here by repeated runs.
    //
    // Qwen's caveat for presence-penalty is language mixing and slightly reduced quality. Checked, not
    // taken on trust: prose stayed monolingual and the pool-filling word problem still answered 4.8 h
    // with correct working, at 12.5 tok/s.
    //
    // temp 0.6 against the 0.7 on Bonsai's own model card. The card's number is its benchmark setting;
    // 0.7 produced the 2,372-token runaway above and 0.6 did not, so the measurement wins. top-k 20 /
    // top-p 0.95 / min-p 0 are common to both Bonsai's card and Qwen's thinking profile. DRY's penalty
    // window is widened from the 64 default because 64 tokens spans only about seven repeats of a
    // sentence this long.
    sampling: {
      temp: 0.6,
      topK: 20,
      topP: 0.95,
      minP: 0,
      presencePenalty: 1.5,
      dryMultiplier: 0.8,
      dryBase: 1.75,
      dryAllowedLength: 2,
      dryPenaltyLastN: 2048,
      // The default breaker list is ["\n", ":", "\"", "*"], and "\n" is why DRY sat in the sampler
      // chain doing nothing. A breaker RESETS DRY's match, and the loop repeats across paragraph
      // breaks - `西湖的四季，是"水光潁溢"。` then a blank line, then the same sentence again - so DRY
      // only ever saw one short segment at a time and never a repeat. Verified against the server
      // rather than assumed: /props reported dry_multiplier 0.8 and 'dry' in the sampler chain while
      // that generation ran away.
      //
      // "\n" dropped, the other three kept. Clearing the list entirely would also work, but a
      // newline-blind DRY with allowed_length 2 would start penalising legitimate repeated structure -
      // list markers, indentation, boilerplate lines in generated code - which this app asks for often.
      drySequenceBreakers: [":", "\"", "*"],
    },
    // Bonsai is Qwen3.6-derived and inherits its template's forced-open thinking: add_generation_prompt
    // emits a bare `<think>\n`, so every turn reasons whether it needs to. Measured here - three short
    // questions ("17 x 23?", "capital of France", "what is a hash table") each spent their whole budget
    // in reasoning and returned content="". The repo README documents no thinking mode; it is wrong.
    // Same cap and same message as qwen3.6 - see that entry for why the wording is deliberately neutral
    // about what happens next.
    reasoningBudget: 1000,
    reasoningBudgetMessage: "\n\nI have enough to go on. Let me move on to the next step.\n",
    hf: "prism-ml/Ternary-Bonsai-27B-gguf",
    revision: "abbae723028d71be674e71e1a71201a6f43fab22", // pinned: the chat template ships inside the GGUF
    // Two projectors in this repo: mmproj-BF16 (931 MB) and mmproj-Q8_0 (629 MB). The README recommends
    // the Q8_0 (HQQ 4-bit in a Q8_0 container). Named explicitly because the scan would otherwise take
    // whichever readdir listed first - see localModelFiles.
    mmprojFile: "Ternary-Bonsai-27B-mmproj-Q8_0.gguf",
    // Read from the GGUF: block_count 64, full_attention_interval 4, head_count_kv 4, key/value_length 256.
    // Layer i is recurrent when (i+1) % 4 != 0, so 16 of the 64 hold KV and the other 48 are GDN-recurrent
    // (window 0 - a fixed per-sequence state, not growing cells; that is recurrentGB's job).
    //   kvElems.full = 16 layers x 4 kv heads x (256 + 256) = 32768.
    // CONFIRMED against the server, not just derived: it reports
    //   llama_kv_cache: size = 4608.00 MiB (262144 cells, 16 layers), K (q4_0) 2304 + V (q4_0) 2304
    // 2304 MiB / 262144 cells = 9216 B/cell for K, and q4_0 is 18 B per 32 elements, so 16384 elements
    // per cell for K and the same for V.
    arch: { L: 64, kvH: 4, hd: 256, swa: { every: 4, window: 0 }, kvElems: { full: 32768, swa: 0 } }, maxCtx: 262144,
    // MEASURED at --parallel 2, exactly as qwen3.6's was - deriving this from the ssm.* fields is what
    // produced a 3x error there, so it is read off the startup line:
    //   llama_memory_recurrent: size = 299.25 MiB (2 cells, 64 layers, 2 seqs 0 rs_seq)
    // 299.25 / 2 = 149.63. The GGUF fields below are reference only.
    recurrent: { perSeqMiB: 149.63, layers: 48, state: 128, inner: 6144, conv: 4, groups: 16 },
    quantTiers: [
      // PQ2_0: the same ternary codes as Q2_g64 but one fp16 scale per 128 weights instead of 64, so
      // 2.125 bpw against 2.250 - 7.17 GB against 7.59. The repo ships both; the g128 file needs the
      // PQ2_0 type (id 142) that this project's ggml adds, which is why the entry is darwin-only above.
      // Measured on M3 Pro: decode 15.46 -> 16.24 tok/s (+5.0%) and 633 MiB less wired, with output
      // byte-identical to the g64 file. bpw from the shipped file: 7.17 GB x 8 / 27.3B.
      { minMemGB: 16, quant: "PQ2_0", bpw: 2.10 },
    ],
    notes: "Dense 27B at ~2 bits. Hybrid attention (16 of 64 layers full). Multimodal (images)."
  },
  {
    // The Windows/Linux counterpart to ternary-bonsai-27b above: same slot in the catalog, but a model
    // whose weights those builds can actually read. The two platforms lists are complementary on
    // purpose - every platform sees exactly one of these, never both and never neither.
    platforms: ["win32", "linux"],
    // mtp:true: dense 12B decoding is bandwidth-bound (reads ~6.7GB per token); speculative decoding gives ~1.5–2× speedup. The drafter (MTP/…-Q4_0-MTP.gguf,
    // ~254MB) is in the same repo as the main weights and is fetched alongside them during auto-download (hfDownload), then passed to llama-server via -md; not enabled on the -hf fallback path.
    id: "gemma4-12b", name: "Gemma 4 12B", params: 12, active: 12, moe: false, vision: true, mtp: true,
    revision: "980b060c40a8539ac159e0501a3e0f66a6365af3", // pinned: see the note on qwen above — required for seeded models
    // GGUF: block_count 48 (8 full-attention + 40 window), head_count_kv 1 on the full layers and 8 on the
    // window ones - the clearest case that one kvH/hd pair cannot describe both groups.
    hf: "unsloth/gemma-4-12B-it-qat-GGUF", arch: { L: 48, kvH: 8, hd: 256, swa: { every: 6, window: 1024 }, kvElems: { full: 8192, swa: 163840 } }, maxCtx: 262144,
    quantTiers: [
      { minMemGB: 12, quant: "UD-Q4_K_XL", bpw: 4.48 }, // 6.72 GB
    ],
    notes: "Dense 12B, quality close to 26B-A4B. Multimodal (image/audio)."
  },
  {
    id: "gemma4-e4b", name: "Gemma 4 E4B", params: 8, active: 8, moe: false, vision: true, mtp: true,
    revision: "8c5a9e4fd5482e2be20fe0bf013b4c262a8f4265", // pinned: see the note on qwen above — required for seeded models
    // ≈4.5B effective parameters (8B raw, MatFormer + Per-Layer Embeddings); top pick for low-end laptops (4–5GB is enough).
    // Native tool-calling tokens, well suited for agents. Q4_0 loses quality, so use UD-Q4_K_XL.
    // window 512, read from the GGUF (gemma4.attention.sliding_window); 26B and 12B are 1024. It was 1024
    // here, which double-counted every SWA layer — and kvGB now multiplies this by the slot count, so a
    // wrong window is amplified rather than absorbed.
    // GGUF: block_count 42 (7 full-attention + 35 window), head_count_kv 2 throughout, key/value_length
    // 512 full and 256 SWA. L stays 34 because it feeds the -ngl split, not KV.
    hf: "unsloth/gemma-4-E4B-it-qat-GGUF", arch: { L: 34, kvH: 4, hd: 256, swa: { every: 6, window: 512 }, kvElems: { full: 14336, swa: 35840 } }, maxCtx: 131072,
    quantTiers: [
      { minMemGB: 8, quant: "UD-Q4_K_XL", bpw: 4.22 }, // 4.22 GB
    ],
    notes: "≈4.5B effective parameters. Native tool calling, QAT 4-bit near bf16. Multimodal (image/audio)."
  },
  {
    id: "lfm2.5-2.6b", name: "LFM2.5 2.6B", params: 2.7, active: 2.7, moe: false, vision: false, mtp: false,
    hf: "LiquidAI/LFM2.5-2.6B-GGUF",
    revision: "b421ad1d549afeda6a0fb2ad3a697cb5a7879adc", // pinned: the chat template ships inside the GGUF
    // Hybrid, and the KV shape is the reason it belongs on a small machine: of 30 layers only 8 are full
    // attention; the other 22 are double-gated short convolutions whose state is fixed per sequence rather
    // than growing per token. Read from the GGUF, where head_count_kv is a PER-LAYER ARRAY, not a scalar:
    //
    //   lfm2.attention.head_count_kv = [0, 0, 8, 0, 0, 8, 0, 0, 0, 8, ...]   attention at 2,5,9,13,17,21,24,27
    //   n_embd_k_gqa = n_embd_v_gqa  = 512 on those layers (8 kv heads x 64)
    //   kvElems.full = 8 x (512 + 512) = 8192
    //
    // Verified against the server, not only derived - at ctx 32768 with q4_0 it reports
    //   llama_kv_cache: size = 144.00 MiB (32768 cells, 8 layers)
    // and 8192 x 32768 x 4.5/8 is 144.0 MiB exactly.
    //
    // No `swa` field: those 8 layers are FULL attention, so there is no window cache to size, and the
    // pattern is irregular (ccAccAcccAcccAcccAcccAccAccAcc) which `swa.every` could not describe anyway.
    // kvGB only reads swa.window when kvElems is present, and absent behaves as window 0.
    arch: { L: 30, kvH: 8, hd: 64, kvElems: { full: 8192, swa: 0 } }, maxCtx: 128000,
    // One rung, the native window. The shared ladder trades context for memory, and here there is nothing
    // to trade: 8 of 30 layers hold KV, so the WHOLE cache at 128000 is 0.6 GB and the rungs below it save
    // 0.3 GB at most while giving up 30-60K of context. Measured on the 8 GB machine this entry targets -
    // 65536 -> 3.8 GB, 98304 -> 3.9, 128000 -> 4.1, against a 5.00 GB budget: every rung fits, so offering
    // the smaller ones only invites a worse choice.
    ctxRungs: [128000],
    // MEASURED from the startup line, exactly as bonsai's was, because deriving it is wrong here too:
    // shortconv.l_cache (3) x conv_dim (2048) x 22 layers x f32 predicts 0.516 MiB and the server says
    //   llama_memory_recurrent: size = 0.69 MiB (2 cells, 30 layers, 2 seqs 0 rs_seq)
    // 0.69 / 2 = 0.345 per seq. Negligible beside KV at this size - it is carried for the same reason the
    // GDN models carry it, so the field means one thing everywhere.
    recurrent: { perSeqMiB: 0.345, layers: 22, conv: 3, inner: 2048 },
    // LiquidAI's own card, unchanged. The low temperature is theirs, not a guess. Nothing is stacked on
    // top: this model has not been seen looping the way bonsai did at 2.125 bpw, so it gets no DRY and no
    // presence penalty. Add them only against repeated runs, never one clean sample.
    sampling: { temp: 0.1, topK: 50, repeatPenalty: 1.1 },
    // No reasoningBudget, deliberately. The card calls it "a pure reasoning model that always thinks", and
    // its template does open <think> every turn - but unlike qwen3.6 and bonsai it comes back on its own:
    // "What is the capital of France?" spent 582 characters reasoning and then answered, 142 completion
    // tokens, finish_reason "stop". A budget is a cap for models that spend the whole allowance and return
    // content="", which is what those two measurably did. This one does not, so capping it would only cut
    // answers short.
    quantTiers: [
      { minMemGB: 8, quant: "Q8_0", bpw: 8.50 }, // print_info: file size = 2.67 GiB (8.50 BPW), 2.70 B params
    ],
    // English fallback only — the shown copy is local.note.lfm2.5-2.6b in src/locales (see modelNote()).
    // It sells the machine it fits on, not the architecture: the reason this entry exists is that it is
    // the one capable model an 8 GB Mac can run with room left over.
    notes: "The smallest and fastest option — runs comfortably on an 8 GB machine. 128K context, native tool calling. Text only.",
  },
  // { id: "qwen3.6-27b", name: "Qwen3.6-27B", params: 27, active: 27, moe: false, vision: true, mtp: false,
  //   hf: "unsloth/Qwen3.6-27B-GGUF", arch: { L: 64, kvH: 8, hd: 128 },
  //   notes: "Dense 27B, highest quality but heavier compute (all params active → slower decode than A3B). Multimodal." },
  // { id: "qwen3-coder-30b-a3b", name: "Qwen3-Coder-30B-A3B", params: 30, active: 3, moe: true, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", arch: { L: 48, kvH: 4, hd: 128 },
  //   notes: "Text-only coding specialist, MoE ~3B active. Good for coding agents; lighter than 3.6, no vision overhead." },
  // { id: "qwen3-14b", name: "Qwen3-14B", params: 14, active: 14, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-14B-GGUF", arch: { L: 40, kvH: 8, hd: 128 }, notes: "Dense 14B, a solid choice for 16GB-class machines." },
  // { id: "qwen3-8b", name: "Qwen3-8B", params: 8, active: 8, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-8B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "Dense 8B, a good default for 12GB machines / 8GB GPUs." },
  // { id: "qwen3-4b", name: "Qwen3-4B", params: 4, active: 4, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-4B-GGUF", arch: { L: 36, kvH: 8, hd: 128 }, notes: "Dense 4B, runs on 8GB machines / older GPUs." },
  // { id: "qwen3-1.7b", name: "Qwen3-1.7B", params: 1.7, active: 1.7, moe: false, vision: false, mtp: false,
  //   hf: "unsloth/Qwen3-1.7B-GGUF", arch: { L: 28, kvH: 8, hd: 128 }, notes: "Runs on low memory / pure CPU. Fast but limited reasoning." },
];

/**
 * Build a MODELS-entry-shaped descriptor for a non-catalog repo from HF's parsed GGUF header (hfDownload.repoDetail().gguf),
 * so the whole existing sizing/launch pipeline (computeFit / pickCtxKv / gpuLayers / isModelInstalled) runs unchanged on any Hub model.
 * HF's gguf field reliably carries { architecture, context_length, total = parameter count }; layer/KV-head dims are usually absent,
 * so those fall back to size-class heuristics — KV estimates are approximate by design (see the localModels.mjs header), this stays within that contract.
 * extras: { vision, mtp } from the repo's file listing (mmproj / drafter presence).
 */
export function descriptorFromGguf(repo, gguf = null, extras = {}) {
  const name = repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo;
  // Parameter count: HF gguf.total; fallback: the "NNB" size class in the repo name (e.g. Qwen3-8B-GGUF); last resort 7B.
  const nameB = name.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  const params = gguf && gguf.total > 0 ? gguf.total / 1e9 : nameB ? Number(nameB[1]) : 7;
  // MoE: "A3B"-style active-params tag in the name (30B-A3B), else assume dense (HF metadata has no expert count).
  const activeM = name.match(/[-_]a(\d+(?:\.\d+)?)b/i);
  // Layer count: gguf.block_count when present, else a dense-transformer size-class heuristic (only feeds the KV/offload estimate).
  const L = (gguf && gguf.block_count) || (params <= 2 ? 24 : params <= 4 ? 32 : params <= 9 ? 36 : params <= 16 ? 40 : params <= 40 ? 48 : params <= 80 ? 64 : 80);
  return {
    id: repo,
    name,
    hf: repo,
    params: Math.round(params * 10) / 10,
    active: activeM ? Number(activeM[1]) : Math.round(params * 10) / 10,
    moe: !!activeM,
    vision: !!extras.vision,
    mtp: !!extras.mtp,
    arch: { L, kvH: (gguf && gguf.head_count_kv) || 8, hd: (gguf && gguf.head_dim) || 128 },
    maxCtx: (gguf && gguf.context_length) || 32768,
    notes: "",
  };
}
