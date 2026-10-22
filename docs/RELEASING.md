# リリース手順

`@kinocode/dsh-model-routes` は GitHub の組織 **kinocode-jp** の `kinocode-jp/dsh-model-routes` から、GitHub Actions
「Publish to npm」（`.github/workflows/publish.yml`）で公開する（npm Trusted Publishing / OIDC）。
個人の npm アカウントから `npm publish` しない。コミット作者は `kinocode <noreply@kinocode.jp>`。

1. `package.json` の `version` を上げ、CHANGELOG を追記してコミット。
2. `npm test` と `npm pack --dry-run` で確認。
3. `git tag v<version> && git push origin v<version>`（タグと version が違えば止まる）。
4. `npm view @kinocode/dsh-model-routes@<version> _npmUser` が GitHub Actions になっていること。

## 最初に一度だけ（組織オーナーがブラウザで）
npmjs.com の `@kinocode/dsh-model-routes` → Settings → Trusted Publisher → GitHub Actions:
Organization `kinocode-jp` / Repository `dsh-model-routes` / Workflow `publish.yml`。
その後 Publishing access で「Require two-factor authentication and disallow tokens」。

## パッケージがまだ npm に無いとき（最初の1回だけ）
Trusted Publisher は、npm にパッケージが既にあるときしか登録できない。dsh-lcu と同じく、組織オーナーが
一度だけ手元から仮の版（例: `0.0.0-stage`）を 2FA 付きで公開してから、上の Trusted Publisher を登録する。
その後は、通常の手順（タグの push）で GitHub Actions が公開する。
