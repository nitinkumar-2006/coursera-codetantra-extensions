# Chrome Extensions Collection

This repository contains two Manifest V3 Chrome extensions by Nitin Kumar:

1. **Coursera Helper** — Root folder (`manifest.json`, `background.js`, `content.js`)
2. **CodeTantra Helper** — `codetantra-agent/` folder (`manifest.json`, `content.js`, `editor_bridge.js`)

Each user enters their own Google Gemini API key inside the extension settings panel (get a key from [Google AI Studio](https://aistudio.google.com/apikey)).

## Installation (Chrome)

1. Click **`<> Code`** above and choose **Download ZIP** (or clone this repo with `git clone`).
2. Unzip the folder to a permanent location on your computer.
3. Open `chrome://extensions/` in Google Chrome and enable **Developer mode** (top-right).
4. Click **Load unpacked**:
   - Select the main unzipped folder to load the first extension.
   - Click **Load unpacked** again and select the `codetantra-agent` subfolder to load the second extension.
5. Open the extension panel and enter your own Gemini API key.

## Updating

- **ZIP users:** Download the latest ZIP, replace the files in your existing folder (keep the extension installed so your saved API key stays intact), and click **Reload** on `chrome://extensions/`.
- **Git users:** Run `git pull` inside the folder, then click **Reload** on `chrome://extensions/`.
