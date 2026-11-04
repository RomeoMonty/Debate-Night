// The AI models players can choose. Downloaded once from Hugging Face, then everything runs offline.
// All three are Qwen 3.5 (March 2026), the strongest small open models the engine supports:
// on Artificial Analysis's intelligence index the 4B scores 27 vs 18 for the older Qwen 3 4B 2507,
// with fewer made-up facts. They are hybrid models, so their working memory stays small even with
// a long debate in view.
// `file` is the expected file name; the app also checks the repo listing for any file ending in
// `-<quant>.gguf`, so a renamed upload still works.
module.exports = [
  {
    id: "pocket",
    name: "Pocket",
    label: "Qwen 3.5 2B",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    quant: "Q4_K_M",
    file: "Qwen3.5-2B-Q4_K_M.gguf",
    sizeGB: 1.3,
    minRamGB: 4,
    ctx: 12288,
    note: "For computers with 4 to 8 GB of memory. Quick, with simpler opponents."
  },
  {
    id: "standard",
    name: "Standard",
    label: "Qwen 3.5 4B",
    repo: "bartowski/Qwen_Qwen3.5-4B-GGUF",
    quant: "Q4_K_M",
    file: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    sizeGB: 3.0,
    minRamGB: 8,
    ctx: 12288,
    note: "The sweet spot for 8 GB Macs and most laptops. Sharp, consistent opponents."
  },
  {
    id: "max",
    name: "Max",
    label: "Qwen 3.5 9B",
    repo: "bartowski/Qwen_Qwen3.5-9B-GGUF",
    quant: "Q4_K_M",
    file: "Qwen_Qwen3.5-9B-Q4_K_M.gguf",
    sizeGB: 6.2,
    minRamGB: 16,
    ctx: 16384,
    note: "For computers with 16 GB of memory or more. The smartest opponents and voters."
  }
];
