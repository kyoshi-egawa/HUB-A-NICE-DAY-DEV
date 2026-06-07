# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

「Hub a Nice Day」= 車検予約管理PWA（本店・三田店の2店舗運用）。スケジュール表・カレンダー・顧客リスト・代車/レンタカー管理を、**ビルド工程なしの単一HTMLファイル**で提供する。React 18 UMD + Babel standalone（ブラウザ内トランスパイル）で動き、バックエンドは Google Apps Script (GAS) + スプレッドシート。

## ビルド・テスト・実行

- **ビルド/lint/テストは存在しない。** 静的HTMLをGitHub Pagesが直接配信する。
- 動作確認はブラウザでHTMLを開く（PWA。Service Workerキャッシュがあるので確認時は**強制リロード Ctrl+Shift+R**）。
- デプロイ = `git push`。GitHub Pages反映に1〜3分。
- コード変更後の検証は、ブラウザで開いて操作する以外に手段がない（自動テスト基盤なし）。Babelのin-browser変換のため、構文エラーは実行時まで出ない。

## リポジトリ構成（DEVと本番は別リポジトリ）

| | DEV（このリポジトリ） | 本番 |
|---|---|---|
| パス | `C:\Users\A\HUB-A-NICE-DAY-DEV` | `C:\Users\A\hub-a-nice-day` |
| GitHub | `kyoshi-egawa/HUB-A-NICE-DAY-DEV` | `kyoshi-egawa/hub-a-nice-day-main`（旧 `hub-a-nice-day` からリダイレクト） |
| STORプレフィックス | `hub-v8-dev-` | `hub-v8-` |
| スケジュール本体 | `index_dev.html`（`index.html`がリダイレクト） | `index_main.html`（`index.html`がリダイレクト） |
| 顧客リスト | `customers.html` | `customers.html` |

- **`index.html` は中身がなく `index_dev.html` / `index_main.html` へ `location.replace` するだけ。** 実装は `index_dev.html`（DEV）/ `index_main.html`（本番）にある。
- DEVと本番でファイルが**乖離している**ことがある（片方だけ修正されたまま）。**片方を直したら必ずもう片方も確認すること。** 過去に useShared のマージロジックがDEVだけ新しく、本番で代車が消えるバグが出た。
- `customers_dev.html` / `index_redirect_dev.html` は実験用サブファイル。ユーザーが日常使うのは `customers.html` と `index_dev.html`（本番は `index_main.html`）。
- **GAS_URL と GAS_API_KEY は DEV・本番で同一**。同じGASスクリプト・同じスプレッドシートを共有し、`STOR` プレフィックスだけでデータを分離している（例: `hub-v8-insp` vs `hub-v8-dev-insp`）。localStorageキャッシュキーも必ず `STOR` を前置すること（同一オリジンでDEV/本番が混ざるため）。

## index_*.html 内のBLOCK制約（最重要）

ファイル先頭のコメントに編集可否が宣言されている。逸脱しないこと：

- **BLOCK-A: 設定値・定数** → 変更可能
- **BLOCK-B: データ層・GAS通信**（`STOR` / `GAS_URL` / `GAS_API_KEY` / `sGet` / `sSet` / `acquireLock` / `releaseLock` / `useShared`）→ **変更禁止**（データ消失リスク。必要時はユーザー Kyoshi に確認）
- **BLOCK-C: コアロジック**（`InspRow` / 1日6台・7台目承認ロジック・レギュラー車検3台上限）→ **変更禁止**
- **BLOCK-D: UIコンポーネント・モーダル** → 変更可能
- **BLOCK-E: メインアプリ・画面レイアウト** → 変更可能（要注意）

## データアーキテクチャ

すべての共有状態はGAS経由でスプレッドシート `hubdata`（key/value/updated 列）に保存。フロントは `sGet(key)` / `sSet(key,value)` で読み書きする。

主なキー（`STOR` 前置。store別は `storKey(base, storeId)` = `${STOR}${storeId}-${base}`）:
- `${STOR}insp` — スケジュール（車検枠）。`{ "YYYY-M-D": [行...] }`。**日付キーはゼロ詰めなし**（`2026-3-6`）。
- `${STOR}custbk` — 顧客リスト発の仮予約（スケジュール未登録分）。`{ "氏名::YYYY-M-D": entry }`。
- `${STOR}{store}-lres` — 代車予約。**オブジェクト構造** `{ carId: { key: 予約 } }`（配列ではない）。
- `${STOR}rres` — レンタカー予約。これも**オブジェクト構造** `{ carId: { key: 予約 } }`。
- `${STOR}cf-index` / `${STOR}cf-{name}-chunk-{i}` — 顧客ファイル（Excelインポート結果）をチャンク分割保存。

### loanerRes / rentalRes は配列ではなくオブジェクト
`loanerRes[carId]` / `rentalRes[carId]` は `{ key: 予約 }` のオブジェクト。`.filter`/`.map`/`.find` を直接呼ぶと `TypeError`。必ず `Object.values(loanerRes[carId]||{})` で配列化してから使う。各予約は日付フィールド `fy/fm/fd`（from）・`ty/tm/td`（to）で期間を表す（`fm`/`tm` は0始まりの月）。

### GAS側（スプレッドシート + ドライブ）
GASサーバーコードはリポジトリ内の `GAS_server_v9_drive.gs`（控え。実体はGoogle Apps Script側にデプロイ済み）。重要な制約と設計：
- **1セルの上限は50,000文字。** これを超えると `setValue` が失敗する（no-corsのためフロントは失敗を検知できない）。
- v9以降、**30,000字超の値はGoogleドライブのファイル**（`hubdata_blobs` フォルダ）に保存し、シートにはマーカー `__DRIVEFILE__` だけ置く。`doGet`/`doPost` が透過的に処理するのでフロントは無変更。
- シートに巨大セルがあると、そのシートへの全書き込みが極端に遅くなる（小データでも10秒超）。大きいデータは必ずドライブへ逃がす。
- 書き込みは `LockService`（25秒）で直列化。毎日深夜2時に `backup_YYYYMMDD` シートへ自動バックアップ（90日保持）。
- GASは**1プロジェクトに複数デプロイが存在しうる**。フロントが使う本番デプロイIDは `AKfycbxy...` で始まるもの。コード更新は「デプロイを管理 → 該当デプロイを編集 → 新バージョン」で行う（URLが変わると繋がらなくなる）。DriveApp を使う変更はドライブ権限の再承認＋再デプロイが必要。

### useShared（ポーリング同期）
`useShared(key, def, pollMs)` が各共有状態のフック。マウント時に `sGet`、`pollMs` 間隔でポーリングしてサーバーの最新を反映する。**書き込み中（writeCount>0）はポーリングをスキップし、idベースマージ**でローカルの新しいエントリ（id大）を保持する——これを怠ると、保存中のポーリングが新規予約をサーバーの古い値で上書きして消す。配列値（insp等）はマージせずGAS版を採用。

## コミット規約

- 機能変更は DEV と本番の両リポジトリに反映する（ユーザーが両方を運用しているため）。`git -C <path>` で各リポジトリを操作。
- 日本語コミットメッセージで可。
- GASコードをチャットからコピーさせると全角文字が化けて構文エラーになることがある。控えの `.gs` ファイルをメモ帳で開かせてコピーさせると確実。
