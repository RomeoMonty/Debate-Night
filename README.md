# Debate Night 2028 (desktop)

A presidential debate game with a built-in AI that runs entirely on the player's computer.
No accounts, no servers, no per-player cost: the AI model downloads once from Hugging Face and then everything works offline.

## How it works

- **Game:** `game/index.html`, the same screens as the browser version.
- **AI engine:** [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, bundled with the app. It runs on a private local port that only the game can use (random port and key each launch). It uses Metal on Macs, Vulkan or CPU on Windows, and CPU on Linux.
- **`ai-service.js`:** downloads models (resumable), picks the fastest settings the computer supports, and falls back automatically when it can't use them.
- **`models.js`:** the three AI choices.

| Choice | Model | Download | Suggested for |
|---|---|---|---|
| Pocket | Qwen 3.5 2B | 1.3 GB | 4–8 GB computers |
| Standard | Qwen 3.5 4B | 3.0 GB | 8 GB Macs and most laptops |
| Max | Qwen 3.5 9B | 6.2 GB | 16 GB+ computers |

The game suggests one based on the computer's memory. Players can switch models any time.

### Speed and memory

- **Small working memory:** Qwen 3.5 keeps most of its memory in a small fixed-size state, so even a long debate stays light. Flash attention is used when the computer supports it.
- **Multi-token prediction:** the engine tries writing several words per step, and falls back if the model file doesn't support it. Whatever settings work are remembered for next time.
- **Shared briefing:** every AI call starts with the same game briefing, so the engine reads it once and reuses it. Each call only processes the new part.
- **Background reactions:** voter reactions are written while you type your next answer, and a plain policy answer skips the cut-in check.
- **Bounded answers:** every structured answer has hard length limits, so it always comes back complete and valid.

## Build the apps for free (GitHub Actions)

1. Create a free GitHub account and a new repository.
2. Upload this whole folder to it, including the hidden `.github` folder.
3. Open the **Actions** tab, choose **Build Debate Night 2028**, then **Run workflow**.
4. When it finishes (about 10 minutes), download these from the run page:
   - **mac**: Apple Silicon and Intel zips
   - **windows**: zip
   - **linux**: AppImage

To make a public release, push a tag such as `v0.3.0`.

### Optional: publish to itch.io automatically

1. Create the game page on itch.io and set it to a downloadable project.
2. In your GitHub repo, open **Settings → Secrets and variables → Actions**, then add:
   - Secret `BUTLER_API_KEY`: from itch.io → Settings → API keys.
   - Variable `ITCH_GAME`: for example `yourname/debate-night-2028`.
3. Each build then uploads the Mac, Windows and Linux versions to itch.io.

## Opening the Mac app the first time

The app isn't signed with a paid Apple Developer ID ($99/year), so macOS asks the first time:

1. Unzip the download and drag **Debate Night 2028** to Applications.
2. Open it. macOS will say it can't verify the app.
3. Go to **System Settings → Privacy & Security** and click **Open Anyway**.

Players who install through the itch.io app usually skip this step.

If macOS still refuses (for example "the AI engine can't be opened"), run this once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Debate Night 2028.app"
```

## Run it yourself while developing

```bash
npm install
npm run fetch-llama -- mac-arm64   # or mac-x64, win-x64, linux-x64 (needs the GitHub CLI)
npm start
```

Models are stored in the app's data folder:

- **Mac:** `~/Library/Application Support/Debate Night 2028/models`
- **Windows:** `%APPDATA%\Debate Night 2028\models`
- **Linux:** `~/.config/Debate Night 2028/models`
