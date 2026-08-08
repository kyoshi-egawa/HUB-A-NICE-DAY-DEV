# GAS v11 再デプロイ手順書（patchInsp / caps / 書き込みログ）

対象: Kyoshi（GASプロジェクト「Hub a Nice Day データ」の編集者）
作成: 2026-07-29 / 想定所要: 5分

## これは何か
`GAS_server_v10_snapshots.gs`（このリポジトリの控え）に **v11の追加**を入れた。すべて**追加のみ**で既存経路は一切変えていない。

- `doGet ?action=caps` … 使える機能を返す（フロントが将来オプトインで使う）。
- `doPost action=patchInsp` … insp の**指定した日付キーだけ**をロック内で原子的にマージ（差分書き込み）。`null` の日付は削除。insp全体（約4KB）を送らずに済む。
- 通常書き込みに `write key=… len=…` の実行ログを追加（どのキーが重いか診断用）。

**重要**: これは「準備」。**フロント(v1.69)はまだ patchInsp を使っていない**（従来どおり insp 全文をサーバー最新値ベースで書く）。再デプロイしても挙動は変わらず、後日フロントが caps 検出でオプトインしたときに初めて patchInsp 経路が有効になる。だから**急ぎではない**。メール通知(notifyFail)は現行デプロイ(v15)で既に動くので、この再デプロイは不要。

## やること（挙動は変わらない・安全）
1. GASエディタを開く: script.google.com/home/projects/1pIUVdDZKTmExm8kOtAb5xD3rTxgmh0lFH3oVzuxA633GHbiVOYhwQe7e/edit
2. `GAS_server_v10_snapshots.gs` を**メモ帳で開いて全選択コピー**（チャットから貼ると全角化けの恐れ。必ずファイルから）。
3. GASエディタの「コード.gs」を全選択して貼り替え → 保存（Ctrl+S）。
4. 右上「デプロイ」→「デプロイを管理」→ 鉛筆(編集) → バージョン「**新バージョン**」→「デプロイ」。
   - **デプロイID・URLは変わらない**（`AKfycbxy…B1ST3`）。トリガー再登録は不要。
5. 動作確認（任意）: GASエディタで関数を実行しなくてもOK。ブラウザで
   `<GAS_URL>?action=caps&apiKey=hub2026co-f466kt5vs3vnDQDPuwWeS6XM` を開き、
   `{"patchInsp":true,"notifyFail":true,"snapshots":true,"ver":"v11"}` が返れば成功。
   （現状は未デプロイなので `null` が返る。）

## 確認済み
- patchInsp のマージ処理を単体テスト21件でPASS（scratchpad `patch_insp_test.js`）。
- 既存の全文書き込み・snapshot系・notifyFail は無変更。

## この後（フロント側・別途）
再デプロイ後、フロントに「起動時に caps を1回読み、patchInsp が使えれば差分書き込みに切り替える」オプトインを入れられる。ただし現状の全文書き込み(約4KB)でも十分軽いため、**効果は限定的**（混雑の主因はペイロードではなくGASのロック待ち）。優先度は低め。
