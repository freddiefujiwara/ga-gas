# ga4-gas

GA4 Data API ブリッジ。Google Apps Script の Web アプリが、所有者の Google アカウント権限で GA4 Data API（runReport）を叩き、結果を JSON で返す。

Muse の API 接続の仕組みは OAuth の入口が単一ドメインのサービス専用で、ドメインが分かれる Google には使えないため、この GAS 経由の形にしている。

## エンドポイント

本番: https://script.google.com/macros/s/AKfycbypis7IqAtM2u0_h7ysiZ5UgztUEwNYJ1zPMnr8IbTBXiyfiapfRMtD_9CxVpc5G8YVzQ/exec

※ ANYONE_ANONYMOUS のため、URLを知っている人は誰でも集計を読める。公開物（ブログ・SNS・他のリポジトリ）に載せないこと。

## パラメータ

- `start`（既定 28daysAgo）/ `end`（既定 today）：GA4 の日付表現（YYYY-MM-DD も可）
- `metrics`（既定 screenPageViews,activeUsers,sessions）：カンマ区切り
- `dimensions`（既定 pagePath）：カンマ区切り。空にすると合計のみ
- `limit`（既定 25）
- `offset`（既定 0）：limit と組み合わせてページングする
- `filter`：ディメンションの絞り込み。書式は `<ディメンション>:<マッチ種別>:<値>`、マッチ種別は exact / contains / beginsWith / endsWith / regexp。複数条件は `;` 区切りで AND 結合。例：`filter=pagePath:contains:/blog/`

## Setup

- GCP プロジェクト：ga4-gas-513811（番号 151603615892）。Google Analytics Data API 有効化済み。OAuth 同意画面は External / テストモード（テストユーザー zegenvs@gmail.com）。Apps Script プロジェクト（本番・ステージングとも）にリンクする。
- スクリプトプロパティ：`GA4_PROPERTY_ID` = 561730442（freddiefujiwara.com の GA4 プロパティ）。本番・ステージングの両プロジェクトに設定する。
- スコープ：analytics.readonly + script.external_request（appsscript.json で指定）。

## 開発とデプロイ

他の -gas リポジトリと同じ運用。

- `npm test`：vitest（カバレッジ付き）
- `npm run build`：src/Code.js と appsscript.json を dist/ へ
- CI（.github/workflows/node.yaml）：
  - 全ブランチでテスト
  - main 以外への push → ステージング用プロジェクトへデプロイ（Secrets: STAGING_SCRIPT_ID / STAGING_DEPLOYMENT_ID）
  - main への push（PR マージ）→ 本番プロジェクトへデプロイ（Secrets: DEPLOYMENT_ID、.clasp.json の scriptId が本番）
  - clasp の認証情報は Secret `CLASPRC_JSON`

## 注意

- GAS の認可は黙って失効することがある。/exec がエラーやサインイン画面を返したら、エディタで doGet を実行して同意をやり直す。
- Drive 上の置き場所：本番プロジェクトは API フォルダ内（2026-11-06 にマイドライブ直下から移動）。ステージング用プロジェクト ga4-gas-staging も同日作成（Script ID: 1fHczPxzhetaG4QC2whqGfUGwMuOXWY9o3p-1dquqIcKuv7IatyGp7xiU）。GitHub リポジトリ freddiefujiwara/ga4-gas で管理し、PR（ブランチ push）→ ステージング、main マージ → 本番に CI デプロイされる。
