# Passagewise

An Obsidian plugin that imports ebook highlights into one note per book. Re-importing adds only new highlights and never rewrites text that is already in the note, including anything you wrote yourself.

Compatible with Kindle, Kobo, and KOReader export files. Passagewise is not created or endorsed by Amazon, Rakuten Kobo, or the KOReader project.

Public repository: [smallbench-labs/passagewise](https://github.com/smallbench-labs/passagewise). Pro checkout is not open (`CHECKOUT_READY = false`) and will stay closed until submission day: the settings tab does not call `/api/region` and does not show Buy Pro. The Polar product and license-key benefit IDs are in this build, so **Activate** (and a later check if a key is already saved) will contact Polar.

## Formats

- Free: Kindle `My Clippings.txt` (English, German, French, Spanish, Simplified and Traditional Chinese, Japanese, plus keyword support for Italian and Portuguese) and Kindle notebook HTML.
- Pro: KOReader `metadata.*.lua` sidecars and KOReader JSON exports, and a Kobo `KoboReader.sqlite` database.

## How to use

1. Click the highlighter icon in the ribbon, or run **Import highlights** from the command palette.
2. Pick **Choose a file on this device…** (for example `My Clippings.txt` on a connected Kindle, or a file from the Files app on a phone), or pick an export file that is already in your vault.
3. Passagewise creates one note per book in the `Highlights` folder and opens the first note it changed. If that note already existed, it opens at the first new highlight.

Files already in the vault also have **Import highlights** in their right-click menu. Note that Obsidian's file list hides `.txt`, `.html`, `.json`, `.lua` and `.sqlite` files unless "Detect all file extensions" is on; the import picker always lists them.

## What a book note looks like

```
---
title: "Pride and Prejudice"
authors: "Jane Austen"
---

## Highlights

> It is a truth universally acknowledged, …

The famous opening: social pressure, not romance.

p. 3 · loc. 41–45 · 2016-03-26 ^pw-b402e2a9d5e45050
```

Each highlight ends with an Obsidian block ID (`^pw-…`). It is hidden in Reading view, and you can link to a single highlight with `[[Pride and Prejudice#^pw-b402e2a9d5e45050]]`. Passagewise uses these IDs to recognise highlights it has already imported.

Re-import rules:

- New highlights are added at the end of the section that holds the last imported highlight, so a later heading of your own (for example `## My summary`) stays below them.
- Existing text is never rewritten. You can edit quotes, add comments between highlights, add properties, or write above the Highlights heading.
- A highlight is skipped if its ID is already in the note, or if its text already appears in the note (for example the same quote from the Kindle HTML export after importing My Clippings).
- If you delete a highlight from the note and it is still in the export file, the next import adds it again. This is established behaviour (2026-11-21): the plugin does not remember deletions.
- If a note has no new highlights, it is not written at all.
- Exact repeats and "adjusted the highlight range" entries in one export are merged, keeping the longer text and any attached note.

## Network use

- Importing never uses the network. Passagewise does not talk to Amazon, Kobo, any cloud service, or USB devices; it only reads the file you choose. A file picked with **Choose a file on this device…** is read once in memory and is not copied into the vault.
- Pro license (only after you enter a key and press **Activate**): the key, the FormChime Polar organization ID, an activation ID and a device label such as `Obsidian – macOS – a1b2` are sent to Polar (`api.polar.sh`) to activate and validate the key, then at most once a day. **Remove** sends the key and activation ID to Polar to free the device slot. A key is accepted only if Polar reports the Passagewise Pro license benefit (`benefit_id` check), so keys for other FormChime products do not unlock Pro.
- Once Pro is on sale, opening the settings tab without an active key calls `https://formchime.com/api/region` to decide whether to show Buy Pro (it is not sold in Japan). In this prototype (`CHECKOUT_READY = false`) that request is never made.
- No telemetry, analytics or ads. Highlights, book titles, note contents, file names and vault names are never sent anywhere.
- The license key is kept in Obsidian Keychain (Obsidian 1.11.4+), otherwise in this plugin's `data.json`.

## Known limits

- No test against a physical Kindle, Kobo, or KOReader device; fixtures are synthetic (see `test/fixtures/SOURCES.md`).
- A copied Kobo database that still has unsynced changes only in a `.sqlite-wal` file may be incomplete until the device is ejected cleanly.
- Mobile was checked only with Obsidian's desktop mobile emulation, not on a real phone.

## Develop

```
npm install
npm test
npm run lint
npm run build
```

`isDesktopOnly` is `false`. Source under `src/` does not use Node or Electron APIs. Kobo import reads SQLite directly in JavaScript (no WASM).
