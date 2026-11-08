# ga-gas

GA4 Data API ブリッジ。Google Apps Script の Web アプリが、所有者の Google アカウント権限で GA4 Data API（runReport）を叩き、結果を JSON で返す。

Muse の API 接続の仕組みは OAuth の入口が単一ドメインのサービス専用で、ドメインが分かれる Google には使えないため、この GAS 経由の形にしている。

## エンドポイント

本番: https://script.google.com/macros/s/AKfycbypis7IqAtM2u0_h7ysiZ5UgztUEwNYJ1zPMnr8IbTBXiyfiapfRMtD_9CxVpc5G8YVzQ/exec

※ ANYONE_ANONYMOUS のため、URLを知っている人は誰でも集計を読める。公開物（ブログ・SNS・他のリポジトリ）に載せないこと。

## 認証（Googleログイン＋一時アクセスリンク）

他のアプリ（health・asset・tweet）と同じ方式。

- スクリプトプロパティ：`GOOGLE_OAUTH_CLIENT_ID`（health と同じクライアント）と `AVAILABLE_GMAILS`（許可するメールアドレス、カンマ区切り）。両方が設定されている間だけ認証が有効になる
- データ取得は、検証済み Google ID トークン（`id_token` パラメータまたは Authorization: Bearer）か、一時アクセスリンクの `share_token` パラメータのどちらかで通る
- 一時アクセスリンク：ログイン状態で `action=issue_share`（ID トークン必須）を呼ぶと30日有効なトークンを発行。再発行で旧トークンは無効。`action=revoke_share` で即時無効化。フロントでは URL の `#share=` フラグメントで受け渡す（サーバーやリファラに残らない）
- 保管：スクリプトプロパティに SHA-256 ハッシュ（SHARE_TOKEN_HASH）と有効期限（SHARE_EXPIRES_AT）のみ。生トークンは保存しない
- エディタ用の補助：`issueShareToken` を実行するとログに発行済みURLが出る（初期発行用）

## パラメータ

- `start`（既定 28daysAgo）/ `end`（既定 today）：GA4 の日付表現（YYYY-MM-DD も可）
- `metrics`（既定 screenPageViews,activeUsers,sessions）：カンマ区切り
- `dimensions`（既定 pagePath）：カンマ区切り。空にすると合計のみ
- `limit`（既定 25）
- `offset`（既定 0）：limit と組み合わせてページングする
- `filter`：ディメンションの絞り込み。書式は `<ディメンション>:<マッチ種別>:<値>`、マッチ種別は exact / contains / beginsWith / endsWith / regexp。複数条件は `;` 区切りで AND 結合。例：`filter=pagePath:contains:/blog/`
- `action=music_count`：唯一の公開アクション。サイト共通ヘッダーに出す「川口の歌」の累計再生回数のため、認証なしで呼べる。返すのは music_play イベントの累計 eventCount（2026-11-08以降）と更新日時だけで、他のデータは一切返さない。CacheService で約1時間キャッシュし、GA4 Data API を叩く頻度を抑える

## SNSフォロワー数（action=sns_counts）

YouTube・Instagram・Threads のフォロワー数を GAS 自身が定期取得し、保存済みスナップショットだけを認証なしで返す。

- 取得：`collectSnsCounts` を時間主導型トリガー（6時間ごと）で実行。トリガーはデプロイでは入らないため、エディタで `setupSnsTriggers` を1回実行して設置する
- 保存先：スクリプトプロパティ `SNS_COUNTS_SNAPSHOT`（各SNSの数値＋取得日時 collected_at）
- 読み取り：`?action=sns_counts`。返すのはスナップショットのみで、トークンや GA4 データは含まない
- YouTube：高度なサービス（YouTube Data API v3）で登録者数を取得。GCP プロジェクト側で YouTube Data API v3 の有効化が必要
- Instagram / Threads：スクリプトプロパティ `META_ACCESS_TOKEN`（Meta の長期ユーザートークン）で Graph API から取得。`META_APP_ID` / `META_APP_SECRET` を設定すると、期限が近づいたトークンを `fb_exchange_token` で自動延長する（有効期限は `META_TOKEN_EXPIRES_AT` に記録）
- Threads 専用トークンを使う場合は `META_THREADS_ACCESS_TOKEN` を設定する（未設定なら `META_ACCESS_TOKEN` で代用）。その有効期限は `META_THREADS_TOKEN_EXPIRES_AT` に記録され、`th_refresh_token` で自動延長される
- トークン未設定・失効のサービスは null になり、他のサービスの取得は続く

## Setup

- GCP プロジェクト：ga-gas-513811（番号 151603615892）。Google Analytics Data API 有効化済み。OAuth 同意画面は External / テストモード（テストユーザー zegenvs@gmail.com）。Apps Script プロジェクト（本番・ステージングとも）にリンクする。
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
- Drive 上の置き場所：本番プロジェクトは API フォルダ内（2026-11-06 にマイドライブ直下から移動）。ステージング用プロジェクト ga-gas-staging も同日作成（Script ID: 1fHczPxzhetaG4QC2whqGfUGwMuOXWY9o3p-1dquqIcKuv7IatyGp7xiU）。GitHub リポジトリ freddiefujiwara/ga-gas で管理し、PR（ブランチ push）→ ステージング、main マージ → 本番に CI デプロイされる。
