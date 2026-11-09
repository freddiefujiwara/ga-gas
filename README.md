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

YouTube・Instagram・Threads・Facebook のフォロワー数を GAS 自身が定期取得し、保存済みスナップショットだけを認証なしで返す。

- 取得：`collectSnsCounts` を時間主導型トリガー（6時間ごと）で実行。トリガーはデプロイでは入らないため、エディタで `setupSnsTriggers` を1回実行して設置する
- 保存先：スクリプトプロパティ `SNS_COUNTS_SNAPSHOT`（各SNSの数値＋取得日時 collected_at）
- 読み取り：`?action=sns_counts`。返すのはスナップショットのみで、トークンや GA4 データは含まない
- YouTube：高度なサービス（YouTube Data API v3）で登録者数を取得。GCP プロジェクト側で YouTube Data API v3 の有効化が必要
- Instagram / Threads：スクリプトプロパティ `META_ACCESS_TOKEN`（Meta の長期ユーザートークン）で Graph API から取得。`META_APP_ID` / `META_APP_SECRET` を設定すると、期限が近づいたトークンを `fb_exchange_token` で自動延長する（有効期限は `META_TOKEN_EXPIRES_AT` に記録）
- Threads 専用トークンを使う場合は `META_THREADS_ACCESS_TOKEN` を設定する（未設定なら `META_ACCESS_TOKEN` で代用）。その有効期限は `META_THREADS_TOKEN_EXPIRES_AT` に記録され、`th_refresh_token` で自動延長される
- Threads 専用アプリ（ユースケース「Access the Threads API」）のトークンは、GAS 内で完結して取得できる。`THREADS_APP_ID`（Threads API の Settings 画面上部の Threads app ID。Meta のアプリIDとは別物）と `THREADS_APP_SECRET` をスクリプトプロパティに設定し、同じ Settings 画面の「Redirect Callback URLs」にこの Web アプリの /exec のURLを登録したうえで、エディタで `threadsAuthorizeUrl` を実行してログのURLから認可すると、コールバックが長期トークンを `META_THREADS_ACCESS_TOKEN` に保存する。認可で求めるスコープは `threads_basic,threads_manage_insights`（フォロワー数はプロフィールではなく `threads_insights` から取るため、インサイト側の権限が要る）。スコープを広げたときは、自動更新では権限が増えないので認可をやり直すこと。取得日時が `THREADS_TOKEN_AT` に記録され、50日以上経つと `refreshThreadsTokenIfNeeded` が取得の前に自動更新する（失敗時はスナップショットの `threads.threads_error` に要約が入る）
- Facebook ページのトークンも、Threads と同じく GAS 内で完結して取得できる。Meta アプリ（Threads 専用アプリとは別）に `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` をスクリプトプロパティに設定し、ログイン設定の「Valid OAuth Redirect URIs」にこの Web アプリの /exec のURL＋`?action=facebook_callback` を登録したうえで、エディタで `facebookAuthorizeUrl` を実行してログのURLから認可すると、コールバック（`action=facebook_callback`）が長期ユーザートークンを `FACEBOOK_USER_ACCESS_TOKEN` に、対象ページのアクセストークンと ID を `FACEBOOK_PAGE_ACCESS_TOKEN` / `FACEBOOK_PAGE_ID` に保存する。対象ページは、事前に `FACEBOOK_PAGE_ID` を設定しておけばそのページ、未設定なら `me/accounts` の先頭のページ。認可で求める権限は `pages_show_list,pages_read_engagement`（ページ自身の投稿とインサイトを読むのに必要な分だけ。訪問者の投稿など他人のコンテンツを読む `pages_read_user_content` は、取得対象でないため求めない）。リダイレクト URI は `FACEBOOK_REDIRECT_URI` で上書きできる。取得日時が `FACEBOOK_TOKEN_AT`、有効期限が `FACEBOOK_TOKEN_EXPIRES_AT` に記録され、期限が近づくと `refreshFacebookTokenIfNeeded` がユーザートークンを再交換し、ページトークンも取り直す（失敗時はスナップショットの `facebook.facebook_error` に要約が入る）
- アプリが **Facebook Login for Business** の場合は `FACEBOOK_CONFIG_ID` が必須。通常の Facebook ログインでは認可URLにスコープを載せるが、ビジネス向けログイン（ユースケース「Manage everything on your Page」等）では、権限と対象ページをまとめた Configuration をアプリ側で作り、認可URLには `config_id` を載せる決まりになっている。`FACEBOOK_CONFIG_ID` に Configuration の ID をスクリプトプロパティに設定すると、`facebookAuthorizeUrl` が config_id 方式のURLを出す（未設定なら従来どおりスコープ方式）。Configuration を経由せずに認可すると、権限自体は granted になっても `me/accounts` が0件を返し、ページトークンを保存できない（コールバックの失敗ページと実行ログに「me/accounts returned 0 Pages …」の要約が出る）。使用中のアプリ `pages-gas` はビジネス向けログインなので、こちらが本番の前提になる
- Facebook のフォロワー数はスナップショットの `facebook.followers` に入り、認証必須の `action=sns_detail` では常に返るが、公開の `action=sns_counts` には**まだ含めていない**（コード内の `SNS_COUNTS_INCLUDE_FACEBOOK = false`）。トップページの「SNS延べフォロワー数」は sns_counts の射影を合算して作るため、含めるかどうかは合計の意味を変える判断として本人が決める。含める場合はこの定数を `true` に変えるだけでよい
- トークン未設定・失効のサービスは null になり、他のサービスの取得は続く
- Instagram の KPI（メインアカウントのみ、スナップショットの `instagram` 内）：`media_count`（投稿数、`instagram_basic` で取得可）、`views_30d`（過去30日の Views 合計）と `non_follower_pct`（そのうちフォロワー以外％、小数1桁）はインサイト由来で、`META_ACCESS_TOKEN` に `instagram_manage_insights` 権限が付くまでは null のまま（付与後は自動で数値が入る）。インサイト取得が失敗した場合は `instagram.insights_error` に API エラーの要約（HTTP ステータスと Graph API の code / subcode / message、秘密値は含まない）が入り、日別合計へのフォールバック時もその旨が記録される（成功時は null）
- なお `action=sns_counts` が返すのは公開用の射影（上記のフォロワー数と KPI のみ）で、次節の詳細データは公開アクションには一切含まれない

## SNS詳細（action=sns_detail、認証必須）

/ga 管理画面用に、`collectSnsCounts` が同じスナップショットへ詳細データも保存する。読み取りは `?action=sns_detail` で、GA4 レポートと同じ認証ゲート（ID トークンまたは一時アクセスリンク）を通る。取得は項目ごとに独立して失敗し、取れない項目は null、失敗の要約はセクションごとのエラーキー（秘密値は含まない）に入る。

- Instagram アカウント全体（過去30日、メインアカウント）：`reach_30d`、`accounts_engaged_30d`、`interactions_30d`（total / likes / comments / shares / saves）、`profile_links_taps_30d`、`follows_30d` / `unfollows_30d`（`follows_and_unfollows` の follow_type 内訳）、`daily_follows`（日次フォロー／フォロー解除系列）。失敗時は `instagram.detail_error`（ただし `daily_follows` の失敗だけは `instagram.daily_follows_error` に分けて記録する）
  - `daily_follows` は `{date, follows, unfollows}`（date は Asia/Tokyo の暦日 \"YYYY-MM-DD\"、日付昇順）の配列で、/ga の Instagram タブで日ごとのフォロー・フォロー解除グラフに投稿日を重ねるための系列。投稿ごとのフォロー帰属は Meta のデータに存在しないため、日次系列と投稿日の重ね合わせで代替する。取得方式は2026-11-09 の本番デバッグで確定した：`follows_and_unfollows` は period=day の素の形が HTTP 400 で拒否され、`metric_type=total_value` 形は指定期間全体の合算（follow_type 内訳）しか返さないため、1回のリクエストでは日次系列は作れない。そこで過去30日の各日について、その日の JST ウィンドウ（00:00:00〜23:59:59 を Unix 秒に変換）で total_value＋breakdown=follow_type を取得し、1日ずつ組み立てる。当日分は途中経過の値で、次の収集で更新される。1日の取得が失敗したらその日は両側 null のまま残し、欠けた日数は `daily_follows_missing_days` に記録する（部分的失敗はエラーにしない）。全日失敗のときだけ系列を null にし、`daily_follows_error` に要約を入れる。ラベルが欠けた側は null（未報告）で、0 にはしない。実応答の形はエディタから `debugInstagramDailyFollows()` を手動実行して確認する
  - `profile_links_taps_30d` は2段構え：まず total_value を取り、null または 0 のときは日別 values の30日合計で補完する。採用した形は `profile_links_taps_source`（`"total_value"` / `"daily_sum"`）に記録する（2026-11-09 の本番初回実行で total_value が実態と食い違う 0 を返したための対策）
  - follows 内訳は、2026-11-09 の本番診断で確定した形で読む：`follows_and_unfollows` は `metric_type=total_value`＋`breakdown=follow_type` のときにだけ内訳が返り、ラベルは結果の状態を表す（`FOLLOWER`＝フォローした数 → `follows_30d`、`NON_FOLLOWER`＝フォローを外した数 → `unfollows_30d`）。照合はこの2ラベルの完全一致（大文字小文字は無視）を最優先とし、どちらにも一致しなかった場合は観測したラベル一覧が `instagram.detail_error` に `follows_and_unfollows labels: [...]` として記録される
- Instagram フォロワー属性（lifetime）：`instagram.demographics` = `age_gender`（`{key, value}` の降順リスト、key は "25-34/F" 形式）、`top_cities` / `top_countries`（各上位10件）。失敗分は `instagram.detail_error` に合算
- Instagram 投稿ごと（新しい順・最大30件）：`instagram.recent_media[]` = `{id, type, posted_at, caption（80字まで）, permalink, views, reach, likes, comments, shares, saves, avg_watch_sec, total_watch_sec}`。リールの視聴時間はミリ秒→秒に変換。メディア種別で使える metric が違うため、失敗時は metric を絞って再試行する。失敗時は `instagram.media_error`
- YouTube：`youtube.total_views`（総再生数）と `youtube.video_count`（動画数）を追加。`youtube.recent_videos[]`（新しい順・最大10件）= `{id, title, published_at, views, likes, comments, url}`。失敗時は `youtube.youtube_error`
- Threads アカウント全体（過去30日）：`threads.views_30d`、`threads.interactions_30d`（total / likes / replies / reposts / quotes）。`threads_insights` から metric ごとに取得し、total_value があればそれを、なければ日別 values の合計を読む（フォロワー数だけは現在値なので従来どおり別扱い）。失敗時は `threads.detail_error`
- Threads 投稿ごと（新しい順・最大30件）：`threads.recent_posts[]` = `{id, type, posted_at, text（全文、上限2000字）, permalink, views, likes, replies, reposts, quotes}`。投稿一覧は本人の `threads` エッジ、数値は各投稿の media insights から。insights が取れない投稿（他人の投稿のリポスト等）は数値 null のまま残り、失敗件数は `threads.posts_error` に要約される
- Facebook アカウント全体（過去28日）：`facebook.views_28d`、`unique_viewers_28d`、`engagement_28d`、`profile_visits_28d`、`new_followers_28d` / `unfollowers_28d`。ページ insights から metric ごとに取得し、total_value があればそれを、なければ日別 values の合計を読む。指標名は現行名（`page_media_view` 系）を先に試し、API が知らない名前なら従来名（`page_impressions` 系）へフォールバックする。失敗時は `facebook.detail_error`
- Facebook 投稿ごと（新しい順・最大30件）：`facebook.recent_posts[]` = `{id, posted_at, message（全文、上限2000字）, permalink, views, unique_viewers, engagements, clicks, link_clicks, saves}`。投稿一覧はページの `published_posts` エッジ、数値は各投稿の post insights から（metric セットを段階的に絞って再試行する）。link_clicks は `post_clicks_by_type` の内訳から「link clicks」だけを取り出す。ページ投稿の insights には保存（saves）の指標が無いため `saves` は常に null。投稿一覧自体が取れない場合は `recent_posts` が null になり、投稿ごとの失敗件数は `facebook.posts_error` に要約される

## SNS履歴（スプレッドシート）

スナップショットは取得のたびに上書きされるため、推移を残す目的で `collectSnsCounts` が Google スプレッドシートにも書き込む。スクリプトプロパティ `SNS_HISTORY_SHEET_ID` にスプレッドシートの ID が設定されているときだけ動作し、未設定なら何もしない（ID はコードに書かない）。

書き方はタブで2種類に分かれる。**投稿系と日次は「1キー1行の上書き（upsert）」で、account のみ時系列の追記**。

- `account` シート（例外的に追記のまま）：取得ごとに1行を追記する。フォロワー推移グラフの元データなので、ここだけは収集の履歴そのものを残す。列は collected_at、ig_followers、ig_anemone_followers、threads_followers、youtube_subscribers、total_followers（Instagram メイン＋Threads＋YouTube、トップページと同じ定義）、media_count、views_30d、non_follower_pct、reach_30d、accounts_engaged_30d、interactions_total / likes / comments / shares / saves、profile_links_taps_30d、profile_links_taps_source、follows_30d、unfollows_30d、yt_total_views、yt_video_count、facebook_followers（末尾に追加した列。total_followers の定義には含めない）。null の項目は空欄
- `media` シート（キー `media_id` で upsert）：`recent_media` の投稿ごとに1行。列は collected_at、media_id、posted_at、type、caption、permalink、views、reach、likes、comments、shares、saves、avg_watch_sec、total_watch_sec
- `daily` シート（キー `date` で upsert）：Instagram の日次フォロー。列は date、follows、unfollows、collected_at。`daily_follows` は収集のたびに過去30日分が再取得されるため、date をキーに上書きし、30日より古い日も残り続ける。両側 null の日は行を作らず、既存行も消さない
- `threads_media` シート（キー `post_id` で upsert）：`threads.recent_posts` の投稿ごとに1行。列は collected_at、post_id、posted_at、type、text、permalink、views、likes、replies、reposts、quotes
- `youtube_media` シート（キー `video_id` で upsert）：`youtube.recent_videos` の動画ごとに1行。列は collected_at、video_id、published_at、title、views、likes、comments。動画ごとの数値はもともと毎回の収集でアップロード一覧から取得していた分（最大10件）で、履歴のために追加の取得はしていない
- `facebook_media` シート（キー `post_id` で upsert）：`facebook.recent_posts` の投稿ごとに1行。列は collected_at、post_id、posted_at、message、permalink、views、unique_viewers、engagements、clicks、link_clicks、saves（ページ投稿の insights に保存の指標が無いため saves は常に空欄）。Facebook が未認可・取得エラーの間は投稿が無いものとして静かにスキップする
- upsert の方式：収集のたびにタブ全体を読み、キーでマージして（新しい取得値が勝つ。ただし新しい値が null の項目は空欄として扱い、既存値を残す＝null で潰さない）、ヘッダー＋1キー1行で書き戻し、余った行は削除する。この方式により、追記方式だった頃に貯まった `media` の重複行（30投稿×収集回数分）も、次回収集で自動的に1投稿1行へ整理される
- どのシートも無ければ自動作成し、1行目が空（シートが空）のときだけヘッダー行を書く。既存のヘッダー行は upsert でも書き換えない
- 書き込みに失敗しても取得自体は成功として扱い、実行ログに `SNS history append failed: <要約>` が1行出る（要約に秘密値・URL は含めない）
- 読み取りは `?action=sns_history`（認証必須、sns_detail と同じゲート）で、/ga の推移グラフ用。`account` シートの行を collected_at 昇順で最大直近400行返し、項目は collected_at、ig_followers、threads_followers、youtube_subscribers、total_followers、media_count、views_30d、non_follower_pct、reach_30d、interactions_total、follows_30d、unfollows_30d、yt_total_views の13項目に絞る（空欄は null）。プロパティ未設定・シートが無い／空の場合はエラーにせず `rows: []` を返す

## 診断関数 `debugSnsInsights`（手動実行専用）

詳細の数値が実態と食い違うときの切り分け用。エディタから手動実行すると、`follows_and_unfollows` と `profile_links_taps` について6つのリクエスト形（A：現行の breakdown=follow_type 形、B：breakdown なし、C：metric_type なし、D：現行の total_value 形、E：metric_type なし＋values の件数・合計、F：period=lifetime）の生応答を実行ログに出す（各応答は先頭3000文字まで、トークンは伏せる）。トリガーや doGet からは呼ばれず、スナップショットにも影響しない。2026-11-09 の本番切り分けで、breakdown=follow_type のラベルは結果の状態（FOLLOWER＝フォローした数、NON_FOLLOWER＝フォローを外した数）を表すことと、profile_links_taps は現行の両形とも 0 だったことが判明済みで、その原因確定のために使う。

## 診断関数 `debugThreadsFollowers` / `debugThreadsPosts`（手動実行専用）

Threads の数値が取れないときの切り分け用。`debugThreadsFollowers` はフォロワー数取得（`threads_insights` の `followers_count`）の生応答を、`debugThreadsPosts` は詳細取得の3リクエスト（アカウント指標の合算リクエスト、投稿一覧 limit 3、先頭投稿の media insights）の生応答と、本番パーサが読み取った値を実行ログに出す（トークンは伏せる）。どちらもトリガーや doGet からは呼ばれず、スナップショットにも影響しない。

## 診断関数 `debugFacebook`（手動実行専用）

Facebook の数値が取れないときの切り分け用。プロパティの設定有無（値そのものは出さない）、ページ情報（`fan_count`）の生応答と読み取り値、本番のアカウント詳細取得が読んだ値、投稿一覧（limit 3）と先頭投稿の post insights の生応答と読み取り値を実行ログに出す（トークンは伏せる）。トリガーや doGet からは呼ばれず、スナップショットにも影響しない。ページ insights の指標名の現行名／従来名のどちらが生きているかは、この生応答で確定させる想定。

## Setup

- GCP プロジェクト：ga-gas-513811（番号 151603615892）。Google Analytics Data API 有効化済み。OAuth 同意画面は External / テストモード（テストユーザー zegenvs@gmail.com）。Apps Script プロジェクト（本番・ステージングとも）にリンクする。
- スクリプトプロパティ：`GA4_PROPERTY_ID` = 561730442（freddiefujiwara.com の GA4 プロパティ）。本番・ステージングの両プロジェクトに設定する。
- スコープ：appsscript.json で指定（analytics.readonly、script.external_request、script.scriptapp、spreadsheets、youtube.readonly）。spreadsheets は SNS 履歴の書き込み用で、追加したプロジェクトでは初回実行時に再認可が要る場合がある。

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
