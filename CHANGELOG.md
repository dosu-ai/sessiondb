# [0.6.0](https://github.com/dosu-ai/sessiondb/compare/v0.5.0...v0.6.0) (2026-11-12)


### Features

* **sdk:** detect a transcript's source; pass trajectory records through ([aa32eef](https://github.com/dosu-ai/sessiondb/commit/aa32eefee91cb929bfd56ceb8196e4a744c242ab))

# [0.5.0](https://github.com/dosu-ai/sessiondb/compare/v0.4.1...v0.5.0) (2026-11-10)


### Bug Fixes

* **sdk:** put ATIF tool errors on the records the adapter links ([628cf5f](https://github.com/dosu-ai/sessiondb/commit/628cf5ffcc30c21769be9a701f4fa85b584901c7))


### Features

* **sdk:** accept ATIF documents and keep the harness name ([77462ae](https://github.com/dosu-ai/sessiondb/commit/77462ae1d88e79cd454d2ab296d383185bb6401e))

## [0.4.1](https://github.com/dosu-ai/sessiondb/compare/v0.4.0...v0.4.1) (2026-11-09)


### Bug Fixes

* **server:** apply Debian security updates in the image ([87f1a04](https://github.com/dosu-ai/sessiondb/commit/87f1a046a26625315f401fc3189229496b2cd59d))

# [0.4.0](https://github.com/dosu-ai/sessiondb/compare/v0.3.0...v0.4.0) (2026-11-06)


### Features

* **store:** S3 and R2 under Node, over fetch with SigV4 signing ([4b363d5](https://github.com/dosu-ai/sessiondb/commit/4b363d519af174ffe8890743ba5e875148a7a8f5))

# [0.3.0](https://github.com/dosu-ai/sessiondb/compare/v0.2.1...v0.3.0) (2026-11-03)


### Features

* **server:** accept tokens signed with SESSIONDB_TOKEN_SECRET ([345ba95](https://github.com/dosu-ai/sessiondb/commit/345ba95bc2675544474936ab24773ed72dfd84c2))

## [0.2.1](https://github.com/dosu-ai/sessiondb/compare/v0.2.0...v0.2.1) (2026-11-02)


### Bug Fixes

* **redact:** catch bare Pulumi and Supabase access tokens ([290e992](https://github.com/dosu-ai/sessiondb/commit/290e99234135f9ed93b482afb82090c221b97533))

# [0.2.0](https://github.com/dosu-ai/sessiondb/compare/v0.1.0...v0.2.0) (2026-10-30)


### Bug Fixes

* **release:** publish with npm publish --workspaces=false instead of the npm plugin ([bbed95c](https://github.com/dosu-ai/sessiondb/commit/bbed95c34737778e8414192832167629f55854e8))
* **release:** push the release commit as the abbs-bot app, main's one bypass actor ([84df3b3](https://github.com/dosu-ai/sessiondb/commit/84df3b34d11c0b6ff05ccc08954179a2ba51314d))
* **release:** sync the workspace versions in bun.lock, which bun install leaves alone ([31c3a89](https://github.com/dosu-ai/sessiondb/commit/31c3a8968c6c9ee3523974fc0d51ab912fc39d06))
* **spec:** document the 415 for a Content-Encoding other than gzip, and exercise it ([5689bb7](https://github.com/dosu-ai/sessiondb/commit/5689bb75ba2b61b976175e402d07384f19174b07))
* **test:** resolve @dosu/sessiondb to its source under Vitest, which lacks the bun condition ([1f00781](https://github.com/dosu-ai/sessiondb/commit/1f00781e01b07d46088fb198116342ecfad66336))


### Features

* **release:** @dosu/sessiondb, released from main by semantic-release ([7aa0fb1](https://github.com/dosu-ai/sessiondb/commit/7aa0fb139a752064ef99be34b9db831d3dbaf327))
* **sdk:** publishable @dosu-ai/sessiondb: dist build, Node loading, timeoutMs and userAgent ([01b2ab3](https://github.com/dosu-ai/sessiondb/commit/01b2ab3e7e1ee663f8408828b8e4733cd266beea))
