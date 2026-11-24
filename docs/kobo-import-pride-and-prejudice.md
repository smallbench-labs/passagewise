# Kobo import screenshot (synthetic fixture)

`kobo-import-pride-and-prejudice.png` is a rendering of the Markdown Passagewise 0.1.0 actually wrote after running `parseKoboSqlite` and `applyRegion` on `docs/fixtures/kobo-pride-and-prejudice.sqlite`.

The screenshot uses an Obsidian-like Reading view (block IDs hidden). It is not a capture from a physical Kobo device, and it is not a screenshot of the Obsidian app.

## Fixture

The SQLite file was created with Python’s `sqlite3` (standard library), using the same `content` / `Bookmark` schema as `test/fixtures/KoboReader.sqlite`. It is not a copy of a device database.

Highlight text is quoted from Jane Austen, *Pride and Prejudice* (1813), a public-domain novel. The attached annotation on the first highlight (“The famous opening: social pressure, not romance.”) is original demo text, not from the novel. Dates, volume paths, and bookmark IDs are synthetic.

## Markdown the plugin wrote

```
---
title: "Pride and Prejudice"
authors: "Jane Austen"
---

## Highlights

> It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

The famous opening: social pressure, not romance.

Chapter I · 2022-03-08 ^pw-2a9c3ac1b6ed0cf3

> She is tolerable; but not handsome enough to tempt me; and I am in no humour at present to give consequence to young ladies who are slighted by other men.

Chapter III · 2022-03-08 ^pw-3d4fb0021924c6d8

> You must allow me to tell you how ardently I admire and love you.

Chapter XXXIV · 2022-03-10 ^pw-78df9af9dd9966b9
```
