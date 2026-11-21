# 匯入格式說明（原型，2026-11-19）

解析器只讀使用者放到 vault 裡的匯出檔，不登入、不抓網頁。測試檔來源見 `test/fixtures/SOURCES.md`。

## 1. Kindle My Clippings.txt（免費）

實體 Kindle 的 `Documents/My Clippings.txt`。各則以單獨一行的 `==========` 分隔。常見四段：

1. 書名，通常是 `書名 (作者)`，以最後一組括號當作者。
2. 以 `-` 開頭的中繼資料：類型、頁碼、位置、加入日期。這一行會隨裝置語言改變。
3. 空行。
4. 劃線或筆記正文。書籤通常沒有正文。

已用測試檔覆蓋的寫法：

| 語言 | 類型／位置／日期的典型寫法 | 測試檔 |
|---|---|---|
| 英語 | `Your Highlight on page 3 \| location 42-44 \| Added on Saturday, 26 March 2016 14:59:39` | `clippings-en.txt` |
| 德語 | `Ihre Markierung bei Position 22-23 \| Hinzugefügt am Donnerstag, 14. Juni 2018 23:06:53` | `clippings-de.txt` |
| 法語 | `Votre surlignement … \| emplacement 42-44 \| Ajouté le samedi 26 mars 2016 14:59:39` | `clippings-fr.txt` |
| 西班牙語 | `Tu subrayado … \| posición 42-44 \| Añadido el sábado 26 marzo 2016 14:59:39` | `clippings-es.txt` |
| 簡體中文 | `您在第 1 页（位置 #12-14）的标注 \| 添加于 2023年5月19日星期五 下午1:11:48`；書籤 `您在第 4 页的书签` | `clippings-zh-cn.txt` |
| 繁體中文 | `您在第 1 頁（位置 #12-14）的標註 \| 新增於 …`（**從簡體格式推導，不是真機檔**） | `clippings-zh-tw.txt` |
| 日語 | `12ページのハイライト \| 位置No. 348-349 \| 作成日: 2021年1月9日土曜日 13:36:03`，以及夾雜英文的 `Your Highlight on ページ 13` | `clippings-ja.txt` |

另有義語、葡語的關鍵字支援（`evidenziazione` / `posizione` / `Aggiunto il`，`destaque` / `posição` / `Adicionado em`），沒有獨立的真機測試檔。俄、波、捷克等語言只有部分關鍵字，未經驗證。

解析後，同一本書、同一位置的「筆記」會附到前一則劃線上。去重時，完全相同的劃線、以及「調整範圍」造成的包含關係，會留下較長的那一則，並把短的 ID 記成別名。

## 2. Kindle App 匯出的筆記本 HTML（免費）

手機或電腦版 App 可匯出單本書的筆記本 HTML。結構是平坦的區塊，不是巢狀 DOM：

- `bookTitle`、`authors`、`sectionHeading`
- `noteHeading`（例如 `Highlight (yellow) - Chapter I > Location 42`）
- `noteText`
- 緊接在劃線後面、同一位置的 `Note` 視為該則劃線的筆記

macOS 匯出有時會用錯標籤（`h3.noteHeading` 卻用 `</div>` 關閉）。解析前會先把 `h1`–`h6` 當成 `div`。測試檔：`notebook.html`、`notebook-macos-broken.html`。

日文或中文 App 匯出的 heading 文案尚未用真檔驗證。HTML 匯出通常沒有「加入時間」。

## 3. KOReader（Pro，這次已做）

不複製 KOReader 原始碼（專案是 AGPL）。只依公開欄位名稱讀資料。

### 3.1 `metadata.*.lua` 側邊檔

現在的格式是 `return { doc_props = { title, authors }, annotations = { [1] = { text, note, chapter, datetime, pageno, pos0, pos1, color, drawer } } }`。較舊的檔會用依頁碼分組的 `highlight`，以及 `bookmarks`（`highlighted = true` 時，`notes` 是劃線文字）。Lua 讀取器只接受表格實字，不執行函式。

### 3.2 JSON 匯出

官方 exporter（`plugins/exporter.koplugin/target/json.lua`）的形狀：

- 單本：`{ title, author, entries, exported, file, number_of_pages, created_on, version }`
- 多本：`{ created_on, version, documents: [ … ] }`
- 每則 `entries[]` 常見欄位：`text`、`note`、`page` / `pageno`、`chapter`、`time`、`sort`、`drawer`、`color`

## 4. Kobo `KoboReader.sqlite`（Pro，已做）

裝置上路徑通常是 `.kobo/KoboReader.sqlite`。公開的 `Bookmark` 表重點欄位：`BookmarkID`、`VolumeID`、`ContentID`、`Text`（劃線）、`Annotation`（筆記）、`DateCreated`、`ChapterProgress`、`Type`（`highlight` / `note` / `dogear`）、`Hidden`、`StartContainerPath` / `EndContainerPath`。書名與章名需 join `content`（`BookTitle`、`Title`、`Attribution`）。沒有對到 `content` 時，會從 sideload 的 `VolumeID` 路徑取出檔名當書名。會略過 `Hidden` 與 `dogear`。來源：[boehs.org/node/kobo-sqlite](https://boehs.org/node/kobo-sqlite)、[valeriangalliat/kobo-highlights-to-calibre](https://github.com/valeriangalliat/kobo-highlights-to-calibre)。

實作是本機的唯讀 SQLite 掃描（`src/core/sqlite.ts`），只讀 UTF-8 的資料表，不執行 SQL、不用 Node、也不用 WASM。評估過 sql.js 1.16.0：`sql-wasm.wasm` 約 672 KB、`sql-wasm.js` 約 47 KB，會讓外掛明顯變大，還要在手機上編譯 WASM，所以沒採用。支援 overflow page（長劃線）與 1024／4096 頁大小，已用合成檔驗證。若檔案大於 20 MB，外掛會提示在手機上可能較慢。若資料庫處於 WAL 模式，會提醒使用者一併拷貝 `.sqlite-wal`，或先把裝置安全退出。尚未用真機資料庫或在真的手機上測效能。

## 5. 同步時怎麼避免覆蓋

每一則劃線有穩定 ID（書名＋正文的指紋），寫在該則最後一行的 Obsidian block ID（`^pw-…`）。舊版原型用的 `<!-- passagewise:managed:… -->`／`<!-- passagewise:item:… -->` 標記仍會被辨認，避免重複匯入。再次匯入時：

- 已有的 ID、別名，或筆記裡已經出現相同（或足以辨認的）劃線正文：略過，不改現有文字，即使使用者改過引文或中間加了自己的話
- 新的劃線：加在「最後一則已匯入劃線所在小節」的末尾，所以使用者寫在後面的標題（例如 `## My summary`）會留在新劃線下面
- 使用者加的 frontmatter、標題以外的正文全部不動
- 若這則筆記沒有新劃線，檔案不會被改寫

早期說明裡的「管理區塊」標記只適用於 2026-11-19 的原型筆記；現在的新筆記不再寫入這些 HTML 註解。

## 6. 刪掉的劃線，下次匯入會再加回來（既定行為）

2026-11-21 已確認：使用者在筆記裡刪掉的劃線，如果匯出檔裡還在，下次匯入會再加回來。外掛不會記住刪過的劃線，也不會把刪除當成永久略過。這是既定行為，不是尚未決定的選項。
