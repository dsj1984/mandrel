# Changelog

All notable changes to this project will be documented in this file.

## [1.52.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.51.0...mandrel-v1.52.0) (2026-06-06)


### Added

* **baselines:** add code-duplication (DRY) quality gate (refs [#3664](https://github.com/dsj1984/mandrel/issues/3664)) ([#3670](https://github.com/dsj1984/mandrel/issues/3670)) ([5057a32](https://github.com/dsj1984/mandrel/commit/5057a327d92eefb8b03e0f64e7710d7a00b64977))
* Epic [#3597](https://github.com/dsj1984/mandrel/issues/3597) — generalize dynamic-workflow audit orchestration to 4 lenses + retire pilot ([#3680](https://github.com/dsj1984/mandrel/issues/3680)) ([970ddbb](https://github.com/dsj1984/mandrel/commit/970ddbb735b36a27d14b0375b84ca3899c136f82))
* **finalize:** embed a run-trace digest in the epic-handoff comment (refs [#3669](https://github.com/dsj1984/mandrel/issues/3669)) ([#3676](https://github.com/dsj1984/mandrel/issues/3676)) ([1170cf3](https://github.com/dsj1984/mandrel/commit/1170cf35a32f1e45f7c57c0be1922c91a7cd7c78))
* **tech-debt:** Epic [#3599](https://github.com/dsj1984/mandrel/issues/3599) — Clean-Code & Performance Audit Remediation ([#3673](https://github.com/dsj1984/mandrel/issues/3673)) ([ec013c9](https://github.com/dsj1984/mandrel/commit/ec013c904e4206cbf919b6c6669210492a9f3838))
* **workflows:** add role re-anchoring and minimal-handoff discipline to delivery sub-agents (refs [#3667](https://github.com/dsj1984/mandrel/issues/3667)) ([#3674](https://github.com/dsj1984/mandrel/issues/3674)) ([1acc68d](https://github.com/dsj1984/mandrel/commit/1acc68dbc9b191bd1b88c0b777e17d65e3472eff))


### Fixed

* **git-cleanup:** decouple ref reap from worktree removal so a Windows-locked merged worktree no longer strands its ref (refs [#3598](https://github.com/dsj1984/mandrel/issues/3598)) ([#3617](https://github.com/dsj1984/mandrel/issues/3617)) ([819ebbc](https://github.com/dsj1984/mandrel/commit/819ebbcf73d7bffcf44e0fe81329de405c0e6ea5))
* **scripts:** add ESM boundary package.json to silence MODULE_TYPELESS_PACKAGE_JSON in consumers (refs [#3589](https://github.com/dsj1984/mandrel/issues/3589)) ([#3677](https://github.com/dsj1984/mandrel/issues/3677)) ([4364c51](https://github.com/dsj1984/mandrel/commit/4364c515c6b1f936b4f9537c9ba274954763160a))
* **story-close:** canonicalize both paths in cd-out guard so symlinked prefixes (macOS /tmp) no longer false-negative (refs [#3672](https://github.com/dsj1984/mandrel/issues/3672)) ([#3678](https://github.com/dsj1984/mandrel/issues/3678)) ([e37b27a](https://github.com/dsj1984/mandrel/commit/e37b27a0e3b255963337a8b77553588b93d8a9da))


### Changed

* **dynamic-workflow:** share report contract assertion core (refs [#3681](https://github.com/dsj1984/mandrel/issues/3681)) ([#3683](https://github.com/dsj1984/mandrel/issues/3683)) ([75851fe](https://github.com/dsj1984/mandrel/commit/75851fe8ac4213507bcdc05e95728a8aab563b7a))

## [1.51.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.50.0...mandrel-v1.51.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* **commands:** Mandrel slash commands revert from `/mandrel:<command>` back to `/<command>`. Consumers no longer need the mandrel plugin enabled; the next `mandrel sync` reaps the plugin tree and writes flat `.claude/commands/`.

### Added

* **commands:** revert the [#3576](https://github.com/dsj1984/mandrel/issues/3576) plugin cutover — flat /&lt;name&gt; commands ([#3594](https://github.com/dsj1984/mandrel/issues/3594)) ([a8afee6](https://github.com/dsj1984/mandrel/commit/a8afee613c700e19c9fa3015570a981560a51035))


### Fixed

* **quality:** preview gate honors the configured maintainability tolerance ([#3593](https://github.com/dsj1984/mandrel/issues/3593)) ([3c770dc](https://github.com/dsj1984/mandrel/commit/3c770dcaf895aafdbc2051022f16ba91319a4bc5))
* **worktree:** copy operator local-override files into isolated worktrees ([#3591](https://github.com/dsj1984/mandrel/issues/3591)) ([784df1a](https://github.com/dsj1984/mandrel/commit/784df1a74edde57f52928f80273179aa29c7dad3))

## [1.50.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.49.0...mandrel-v1.50.0) (2026-06-04)


### Fixed

* **postinstall:** materialize .agents/ into INIT_CWD, not the npm-lifecycle cwd (refs [#3584](https://github.com/dsj1984/mandrel/issues/3584)) ([#3585](https://github.com/dsj1984/mandrel/issues/3585)) ([0844b45](https://github.com/dsj1984/mandrel/commit/0844b45351b47fddf01e5e90b4bd68764d578f50))

## [1.49.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.48.0...mandrel-v1.49.0) (2026-06-04)


### Fixed

* **postinstall:** source-checkout guard misfires on every consumer install, skipping `.agents/` sync ([#3580](https://github.com/dsj1984/mandrel/issues/3580)) ([#3582](https://github.com/dsj1984/mandrel/issues/3582)) ([97b896f](https://github.com/dsj1984/mandrel/commit/97b896f1cb974ef86726353532087de1e9828c0e))
* **update:** auto-detect package manager in mandrel update (refs [#3575](https://github.com/dsj1984/mandrel/issues/3575)) ([#3577](https://github.com/dsj1984/mandrel/issues/3577)) ([f766f7c](https://github.com/dsj1984/mandrel/commit/f766f7ce649c5d56741318339173a69755f8a0ae))

## [1.48.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.47.0...mandrel-v1.48.0) (2026-06-04)


### Added

* **skills:** add operator comprehension capability (refs [#3571](https://github.com/dsj1984/mandrel/issues/3571)) ([#3572](https://github.com/dsj1984/mandrel/issues/3572)) ([12f0810](https://github.com/dsj1984/mandrel/commit/12f0810ac184a4d54808f7f977fee93310b2fb0c))


### Fixed

* **bootstrap:** honest applied-group + prepare-removal reporting and non-TTY help ([#3545](https://github.com/dsj1984/mandrel/issues/3545)) ([#3569](https://github.com/dsj1984/mandrel/issues/3569)) ([d5691f9](https://github.com/dsj1984/mandrel/commit/d5691f976796819a4a2f39c66161fa03d27abff7))

## [1.47.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.46.0...mandrel-v1.47.0) (2026-06-04)


### Fixed

* **update:** resolve Windows spawn ENOENT and add --install-cmd (refs [#3565](https://github.com/dsj1984/mandrel/issues/3565)) ([#3567](https://github.com/dsj1984/mandrel/issues/3567)) ([48b8d64](https://github.com/dsj1984/mandrel/commit/48b8d64b22f9dd52ef8f5dfb055ace8418503770))

## [1.46.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.45.0...mandrel-v1.46.0) (2026-06-03)


### ⚠ BREAKING CHANGES

* **orchestration:** `.agentrc.json` documents with a `github` block must now include `github.operatorHandle`. The shipped templates already carry the `@[USERNAME]` placeholder, so consumers upgrading via `mandrel sync` get it automatically; a hand-written config without it will fail schema validation until the key is added.

### Added

* **orchestration:** require per-contributor operatorHandle and fail closed in lease guards ([#3563](https://github.com/dsj1984/mandrel/issues/3563)) ([50e0b3e](https://github.com/dsj1984/mandrel/commit/50e0b3ea8f2a67679114620cd9ed292e5473686d))


### Fixed

* **column-sync:** use projectOwner instead of viewer in #loadMeta query ([#3560](https://github.com/dsj1984/mandrel/issues/3560)) ([#3561](https://github.com/dsj1984/mandrel/issues/3561)) ([f4a1de8](https://github.com/dsj1984/mandrel/commit/f4a1de806b9ba3aac9d12bad868da88b0de08a98))
* **uninstall:** add revertAgentrc handler to fix reversibility mismatch (refs [#3543](https://github.com/dsj1984/mandrel/issues/3543)) ([#3557](https://github.com/dsj1984/mandrel/issues/3557)) ([70f1d88](https://github.com/dsj1984/mandrel/commit/70f1d88036dbab79090cc02ced98afc05bb7852a))
* **uninstall:** guard per-target reversal loop against JSON.parse failures (refs [#3544](https://github.com/dsj1984/mandrel/issues/3544)) ([#3562](https://github.com/dsj1984/mandrel/issues/3562)) ([d974e0d](https://github.com/dsj1984/mandrel/commit/d974e0df2736200624aca56d37feebac7b952b77))

## [1.45.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.44.0...mandrel-v1.45.0) (2026-06-03)


### Fixed

* **uninstall:** keep the .mcp.json gitignore entry when a real .mcp.json exists ([#3542](https://github.com/dsj1984/mandrel/issues/3542)) ([#3555](https://github.com/dsj1984/mandrel/issues/3555)) ([0ff599c](https://github.com/dsj1984/mandrel/commit/0ff599c51872f595298b0a1aeddd4dbf0de74793))
* **uninstall:** replace hash-prefix heuristic with byte-equality check ([#3551](https://github.com/dsj1984/mandrel/issues/3551)) ([1b11d68](https://github.com/dsj1984/mandrel/commit/1b11d68bbe37a172e83dacef9aad7b514629e4cc))

## [1.44.0](https://github.com/dsj1984/mandrel/compare/mandrel-v1.43.0...mandrel-v1.44.0) (2026-06-03)


### ⚠ BREAKING CHANGES

* Mandrel v6.0.0 — ticket hierarchy is now Epic -> Feature -> Story (with inline acceptance/verify on the Story body). The planning.hierarchy config flag, type::task label, Task-tier scripts, and Task-aware lifecycle hooks have been deleted. Consumers re-pinning .agents/ to v6.0.0 MUST migrate any local Task-tier artifacts per docs/upgrade-guide-3-tier.md.
* **board:** collapse Status field to Todo/In Progress/Done ([#2868](https://github.com/dsj1984/mandrel/issues/2868))
* **release:** footers or !-marked commits never auto-propose a major version. Major bumps now require explicit operator intervention via a Release-As: X.0.0 trailer or a manual edit on the release PR branch.
* **release:** 5.36.4 — remove sprintClose.runRetro back-compat shim

### Epic

* 3078 ([#3164](https://github.com/dsj1984/mandrel/issues/3164)) ([206da29](https://github.com/dsj1984/mandrel/commit/206da297bdf60fdee976dbaae0858816c308c56a))


### Added

* add cutover smoke tests for friction-comment + flat-temp absence (resolves [#1049](https://github.com/dsj1984/mandrel/issues/1049)) ([d3e825d](https://github.com/dsj1984/mandrel/commit/d3e825d5020747f1cb9a6f958cf43e6fd5e85f68))
* add lifecycle defaults + strip redundant config from .agentrc.json ([#2846](https://github.com/dsj1984/mandrel/issues/2846)) ([#2848](https://github.com/dsj1984/mandrel/issues/2848)) ([89a8b30](https://github.com/dsj1984/mandrel/commit/89a8b3063c5fd38583db31c1d08538fe7f0e79d4))
* add PreToolUse / PostToolUse trace hook + env propagation (resolves [#1043](https://github.com/dsj1984/mandrel/issues/1043)) ([8b50fbe](https://github.com/dsj1984/mandrel/commit/8b50fbee2f602d08f7a913f028999dbc70becca1))
* **agents:** define wave-runner sub-agent type and probe nested agent dispatch (resolves [#1133](https://github.com/dsj1984/mandrel/issues/1133)) ([03227f9](https://github.com/dsj1984/mandrel/commit/03227f9ad3c21ef1a2fe559fe2b28287612c32f8))
* **analyze-execution:** implement analyze-execution.js with --story and --epic modes (resolves [#1135](https://github.com/dsj1984/mandrel/issues/1135)) ([73b5ee2](https://github.com/dsj1984/mandrel/commit/73b5ee23549b64b4ea02653ce50216efff8992d4))
* **architecture:** cleanup shims, adapters, and enums (closes [#2646](https://github.com/dsj1984/mandrel/issues/2646)) ([#2712](https://github.com/dsj1984/mandrel/issues/2712)) ([8993bad](https://github.com/dsj1984/mandrel/commit/8993bad5085c02e39fce0fbd0dd6c440eba2e7c5))
* atomic writes in `render-manifest.js` (resolves [#1090](https://github.com/dsj1984/mandrel/issues/1090)) ([dff4cbb](https://github.com/dsj1984/mandrel/commit/dff4cbb063392162d01fa207bab9f012bdf0d13b))
* **audit-architecture:** add Automated Architecture Guardrails dimension ([#2734](https://github.com/dsj1984/mandrel/issues/2734)) ([184574d](https://github.com/dsj1984/mandrel/commit/184574d65bdaba1ebed54a68cda5d0cdee50d823)), closes [#2713](https://github.com/dsj1984/mandrel/issues/2713)
* **audit:** pilot dynamic-workflow orchestration for audit-clean-code with graceful degradation (refs [#3278](https://github.com/dsj1984/mandrel/issues/3278)) ([#3282](https://github.com/dsj1984/mandrel/issues/3282)) ([414ecd4](https://github.com/dsj1984/mandrel/commit/414ecd4dcdc13b8c46b535634d28cb1df35a87e4))
* **board:** collapse Status field to Todo/In Progress/Done ([#2868](https://github.com/dsj1984/mandrel/issues/2868)) ([60e99a2](https://github.com/dsj1984/mandrel/commit/60e99a2b019698034e146e0e73c92ee3c68a08bf)), closes [#2867](https://github.com/dsj1984/mandrel/issues/2867)
* **bootstrap:** auto-accept inferred git defaults instead of prompting ([#2122](https://github.com/dsj1984/mandrel/issues/2122)) ([09b1413](https://github.com/dsj1984/mandrel/commit/09b1413d203a4c0f886da7a76bf0322895b598dc)), closes [#2121](https://github.com/dsj1984/mandrel/issues/2121)
* **bootstrap:** unified consumer setup script + README cleanup (hard cutover) ([#2075](https://github.com/dsj1984/mandrel/issues/2075)) ([8543677](https://github.com/dsj1984/mandrel/commit/854367748c68c5191fef99d849664f49329db63f)), closes [#2074](https://github.com/dsj1984/mandrel/issues/2074)
* bound `cascadeCompletion` in `lib/orchestration/ticketing.js` (resolves [#1088](https://github.com/dsj1984/mandrel/issues/1088)) ([bfd6101](https://github.com/dsj1984/mandrel/commit/bfd6101905104e89ea36b6bffd5b224b898b1da8))
* bound fs fanout in `detect-merges.js` (resolves [#1086](https://github.com/dsj1984/mandrel/issues/1086)) ([505a257](https://github.com/dsj1984/mandrel/commit/505a257bfd1462b8d9ba5db0e93e59059b1bac77))
* bound GitHub mutations in force-close / cleanup paths (resolves [#1087](https://github.com/dsj1984/mandrel/issues/1087)) ([d2321c6](https://github.com/dsj1984/mandrel/commit/d2321c698ec6a9a9c80f9a356d02be5352853df4))
* bounded parallelism for serial API loops (resolves [#1089](https://github.com/dsj1984/mandrel/issues/1089)) ([60272b9](https://github.com/dsj1984/mandrel/commit/60272b919869082ab05e9b077d020eb9a493d050))
* centralized temp-paths helper + JSON schemas (resolves [#1039](https://github.com/dsj1984/mandrel/issues/1039)) ([c7cf980](https://github.com/dsj1984/mandrel/commit/c7cf9800a26af71ea058d8ef86fb5b57710bfb5e))
* **close-validation:** create lib/baseline-loader.js with readbaselineatref helper (resolves [#1127](https://github.com/dsj1984/mandrel/issues/1127)) ([1d4480b](https://github.com/dsj1984/mandrel/commit/1d4480b228ded41b023701b43bc0bcd94dfac2b9))
* **close-validation:** run every close-validation gate with cwd=.worktrees/story-&lt;id&gt;/ (resolves [#1128](https://github.com/dsj1984/mandrel/issues/1128)) ([ad0e7b5](https://github.com/dsj1984/mandrel/commit/ad0e7b5854d87f4333f82527e22bc5177ab7612e))
* **close-validation:** wire baseline-loader into the maintainability and crap gates (resolves [#1130](https://github.com/dsj1984/mandrel/issues/1130)) ([b187cf8](https://github.com/dsj1984/mandrel/commit/b187cf808cea990eac1d7b0bbed5b028f8a8328a))
* **close:** sync story/epic branch from base before PR open ([#2581](https://github.com/dsj1984/mandrel/issues/2581)) ([1026c86](https://github.com/dsj1984/mandrel/commit/1026c86759de7f1319c2d173773cb35fedbe4da6)), closes [#2580](https://github.com/dsj1984/mandrel/issues/2580)
* **code-review:** add security-review and ultrareview providers via chain ([#2872](https://github.com/dsj1984/mandrel/issues/2872)) ([832b189](https://github.com/dsj1984/mandrel/commit/832b1892d735c1574dea77e3f536dd99475862c2)), closes [#2871](https://github.com/dsj1984/mandrel/issues/2871)
* **column-sync:** wire Projects v2 Status sync into transitionTicketState (resolves [#2548](https://github.com/dsj1984/mandrel/issues/2548)) ([#2575](https://github.com/dsj1984/mandrel/issues/2575)) ([5457ca7](https://github.com/dsj1984/mandrel/commit/5457ca7c39a31d8c6d9a80091597364c893785cb))
* **config:** add agentsettings.limits.signals defaults + signals_defaults export (resolves [#1070](https://github.com/dsj1984/mandrel/issues/1070)) ([b50c264](https://github.com/dsj1984/mandrel/commit/b50c264a1fe521766f14a584d858d0b4bdd98e97))
* **config:** add lib/config/temp-paths.js helper for per-epic artifact paths (resolves [#1051](https://github.com/dsj1984/mandrel/issues/1051)) ([5d9a138](https://github.com/dsj1984/mandrel/commit/5d9a13842bf4746d68ba7487d48892b87600d76c))
* **config:** implement .agentrc.local.json override layer (refs [#3388](https://github.com/dsj1984/mandrel/issues/3388)) ([#3405](https://github.com/dsj1984/mandrel/issues/3405)) ([f42e898](https://github.com/dsj1984/mandrel/commit/f42e898212b3c62bdd9de0e19ce7a876ff435839))
* decomposer fails when a Task AC references a missing file in the Epic base branch (resolves [#1125](https://github.com/dsj1984/mandrel/issues/1125)) ([748a7fe](https://github.com/dsj1984/mandrel/commit/748a7fea7727d74d7fa85800d0f17b0a07101e68))
* **decomposer:** add validateacfreshness gate to ticket-validator + wire into decompose phase (resolves [#1138](https://github.com/dsj1984/mandrel/issues/1138)) ([2c5dea9](https://github.com/dsj1984/mandrel/commit/2c5dea960bdfc6d7b4950e676e0cf6ede1641860))
* Epic [#3304](https://github.com/dsj1984/mandrel/issues/3304) ([#3379](https://github.com/dsj1984/mandrel/issues/3379)) ([850355e](https://github.com/dsj1984/mandrel/commit/850355e34392211d8dff2da3ad95f2c96ffbabbf))
* Epic [#3316](https://github.com/dsj1984/mandrel/issues/3316) ([#3359](https://github.com/dsj1984/mandrel/issues/3359)) ([2ee5462](https://github.com/dsj1984/mandrel/commit/2ee546258dbb46483fbd201caaf5f1d91cd569df))
* Epic [#3418](https://github.com/dsj1984/mandrel/issues/3418) ([#3434](https://github.com/dsj1984/mandrel/issues/3434)) ([c926255](https://github.com/dsj1984/mandrel/commit/c926255d04f7d769b2a2d5ac9fcbdb67b48ec6a1))
* Epic [#3435](https://github.com/dsj1984/mandrel/issues/3435) ([#3453](https://github.com/dsj1984/mandrel/issues/3453)) ([6dc9381](https://github.com/dsj1984/mandrel/commit/6dc93816d61add8829179b5cfe1915d6dd6b43af))
* Epic [#3436](https://github.com/dsj1984/mandrel/issues/3436) ([#3485](https://github.com/dsj1984/mandrel/issues/3485)) ([7136f4e](https://github.com/dsj1984/mandrel/commit/7136f4e1326be1e4a81c0034d526fda0cf0f52d5))
* Epic [#3437](https://github.com/dsj1984/mandrel/issues/3437) ([#3534](https://github.com/dsj1984/mandrel/issues/3534)) ([e7f6373](https://github.com/dsj1984/mandrel/commit/e7f63734e35eaf7ae3fda66c51f437d29726bd49))
* Epic [#3438](https://github.com/dsj1984/mandrel/issues/3438) ([#3539](https://github.com/dsj1984/mandrel/issues/3539)) ([e13ed25](https://github.com/dsj1984/mandrel/commit/e13ed25b2cb4eee02a36ca3309e09d14946e24f8))
* Epic [#3457](https://github.com/dsj1984/mandrel/issues/3457) ([#3528](https://github.com/dsj1984/mandrel/issues/3528)) ([18318bc](https://github.com/dsj1984/mandrel/commit/18318bc6f654ba2b5758be52dc543f34f013f597))
* **epic-close:** add phase 6 step that posts epic-perf-report before retro renders (resolves [#1066](https://github.com/dsj1984/mandrel/issues/1066)) ([f0ea300](https://github.com/dsj1984/mandrel/commit/f0ea300825c7f806757856b9a2c1413b0d6d6926))
* **epic-close:** wire analyze-execution into post-merge-pipeline and epic-close phase 6.0 (resolves [#1140](https://github.com/dsj1984/mandrel/issues/1140)) ([cfc37fa](https://github.com/dsj1984/mandrel/commit/cfc37facb0623ba487439d381f01131553af6a66))
* **epic-deliver:** conditional auto-merge gate + post-merge cleanup ([#1275](https://github.com/dsj1984/mandrel/issues/1275)) ([b949275](https://github.com/dsj1984/mandrel/commit/b949275e9687823fed802fd74c933e6da9af1882))
* **epic-deliver:** enforce code-review halted flag before retro phase (resolves [#2167](https://github.com/dsj1984/mandrel/issues/2167)) ([#2168](https://github.com/dsj1984/mandrel/issues/2168)) ([d41634c](https://github.com/dsj1984/mandrel/commit/d41634c606c540abfc0a06d49b8a3120c69c3197))
* **epic-deliver:** surface cross-Story conflict findings in manifest and prepare-gate (resolves [#2297](https://github.com/dsj1984/mandrel/issues/2297)) ([#2305](https://github.com/dsj1984/mandrel/issues/2305)) ([e2a3288](https://github.com/dsj1984/mandrel/commit/e2a3288ef4a6d671d91a0a58627d29205fc92f18))
* **epic-execute:** rolling concurrency contract + richer manifest progress symbols ([841162d](https://github.com/dsj1984/mandrel/commit/841162d8ac47d9757d77c94daddfb638dac68f3e))
* **epic-plan:** add cross-Story path-conflict & implicit-dependency graph (resolves [#2296](https://github.com/dsj1984/mandrel/issues/2296)) ([#2302](https://github.com/dsj1984/mandrel/issues/2302)) ([20fe62c](https://github.com/dsj1984/mandrel/commit/20fe62c81f319f40ac17069e6cf5fd44df72ac04))
* **epic-plan:** add Epic Clarity Gate (new Phase 6) and renumber phases to linear 1..11 ([#2128](https://github.com/dsj1984/mandrel/issues/2128)) ([#2163](https://github.com/dsj1984/mandrel/issues/2163)) ([f65a14f](https://github.com/dsj1984/mandrel/commit/f65a14f4fa954242011ccd7bbebd5ade2c981d12))
* **epic-plan:** cross-reference ACs against existing BDD scenarios ([#2642](https://github.com/dsj1984/mandrel/issues/2642)) ([de68d65](https://github.com/dsj1984/mandrel/commit/de68d65e7c392f07fb5eeb9b207b061c5bea8f6d)), closes [#2637](https://github.com/dsj1984/mandrel/issues/2637)
* **epic-plan:** cross-validate Tech Spec against codebase in Phase 7 ([#2638](https://github.com/dsj1984/mandrel/issues/2638)) ([aec99d1](https://github.com/dsj1984/mandrel/commit/aec99d1ccb216104a216bf6386c39a2eb64ba3bd)), closes [#2635](https://github.com/dsj1984/mandrel/issues/2635)
* **epic-plan:** decomposer prompt heuristic for shared config-file edits across Stories ([#2300](https://github.com/dsj1984/mandrel/issues/2300)) ([30dadc0](https://github.com/dsj1984/mandrel/commit/30dadc070124e45e5b56cf4295763fee1c28ed65)), closes [#2298](https://github.com/dsj1984/mandrel/issues/2298)
* **epic-plan:** require explicit filesAssumption on Task paths ([#2639](https://github.com/dsj1984/mandrel/issues/2639)) ([fda76f2](https://github.com/dsj1984/mandrel/commit/fda76f2166f7096f31f92d3c45de2751b2fb92ec)), closes [#2636](https://github.com/dsj1984/mandrel/issues/2636)
* extract canonical branch-name safety guard (resolves [#1081](https://github.com/dsj1984/mandrel/issues/1081)) ([43f44a7](https://github.com/dsj1984/mandrel/commit/43f44a7ad65f88e62b341b7bc753c03462791f90))
* **gh-exec:** default-timeout knob + transient classification for GhExecTimeoutError ([#2877](https://github.com/dsj1984/mandrel/issues/2877)) ([dad2b16](https://github.com/dsj1984/mandrel/commit/dad2b163695486bd5aa800ee40fb7d7112531ae5)), closes [#2860](https://github.com/dsj1984/mandrel/issues/2860)
* **git-cleanup-branches:** prune stale tracking refs after remote delete ([#1714](https://github.com/dsj1984/mandrel/issues/1714)) ([ccf9490](https://github.com/dsj1984/mandrel/commit/ccf94901e671a04c3ad381ac4466781ed9a808e7))
* **hooks:** rebalance pre-push to diff-scoped gates ([#2745](https://github.com/dsj1984/mandrel/issues/2745)) ([#2754](https://github.com/dsj1984/mandrel/issues/2754)) ([5f93eb0](https://github.com/dsj1984/mandrel/commit/5f93eb05bcf443bb5b8ce9d3fb5158cd379d6d25))
* **idea-refinement:** fold grill-me interrogation pattern into Phase 2 (resolves [#1926](https://github.com/dsj1984/mandrel/issues/1926)) ([#1932](https://github.com/dsj1984/mandrel/issues/1932)) ([987eb93](https://github.com/dsj1984/mandrel/commit/987eb93c78bb8a6529228932bcaca21af654ead2))
* implement analyze-execution.js CLI core (resolves [#1045](https://github.com/dsj1984/mandrel/issues/1045)) ([99c42ac](https://github.com/dsj1984/mandrel/commit/99c42ac7c2fef18e2fcd104f988b7aa572a8ea5e))
* implement signals-writer module + unit tests (resolves [#1041](https://github.com/dsj1984/mandrel/issues/1041)) ([b92d5e4](https://github.com/dsj1984/mandrel/commit/b92d5e45eaadd5ff8edc1face804e286232b79a9))
* invert dependency direction in `lib/orchestration/index.js` (resolves [#1083](https://github.com/dsj1984/mandrel/issues/1083)) ([1425183](https://github.com/dsj1984/mandrel/commit/14251831eddf365f0408f95021a80d4864d7cb32))
* **manifest-persistence:** sweep legacy dispatch-manifest-&lt;id&gt;.{md,json} orphans on render (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([7c7daef](https://github.com/dsj1984/mandrel/commit/7c7daef19dc4469d6518036e10ecd8fe8bb61c4b))
* **manifest:** move Agent Operating Procedures & symbol reference to the top ([#1765](https://github.com/dsj1984/mandrel/issues/1765)) ([4754261](https://github.com/dsj1984/mandrel/commit/475426166e2cbf3eda4733010b120f096d94f859))
* **manifest:** trim dispatch manifest markdown for clean top-to-bottom flow ([#1344](https://github.com/dsj1984/mandrel/issues/1344)) ([1b5e051](https://github.com/dsj1984/mandrel/commit/1b5e0512fa5aab5c13c623af455231f2d20c1022))
* migrate all temp-path writers, readers, and workflow docs to per-Epic tree (resolves [#1040](https://github.com/dsj1984/mandrel/issues/1040)) ([10be30d](https://github.com/dsj1984/mandrel/commit/10be30ded8e4187080973caeb5081b9fe26e3b1a))
* migrate diagnose-friction to writer; delete friction-emitter cooldown (resolves [#1042](https://github.com/dsj1984/mandrel/issues/1042)) ([9c7a64d](https://github.com/dsj1984/mandrel/commit/9c7a64d342d6099c0f64744c03ee5aa4b323c35e))
* move HTTP client under `providers/github/` (resolves [#1084](https://github.com/dsj1984/mandrel/issues/1084)) ([4b6861f](https://github.com/dsj1984/mandrel/commit/4b6861f9d9d2975e8031ac1ba239ebba07a6f5eb))
* **notify:** curate webhook channel to epic-* event allowlist ([#1264](https://github.com/dsj1984/mandrel/issues/1264)) ([90bffe5](https://github.com/dsj1984/mandrel/commit/90bffe5ac518a632254d27593ccf25dbd3ae53ee))
* **observability:** add lib/observability/signals-writer.js with append/foreachline api (resolves [#1056](https://github.com/dsj1984/mandrel/issues/1056)) ([5c9016f](https://github.com/dsj1984/mandrel/commit/5c9016f96fee1cf185ed015fd56eab211cd00ae6))
* **observability:** add lib/observability/tool-trace-hook.js with pre/post entry points (resolves [#1058](https://github.com/dsj1984/mandrel/issues/1058)) ([233f8dc](https://github.com/dsj1984/mandrel/commit/233f8dcf1d4f07300252630c4dffa7fea4994e48))
* **observability:** measure & de-duplicate /epic-deliver (Epic [#3019](https://github.com/dsj1984/mandrel/issues/3019)) ([#3084](https://github.com/dsj1984/mandrel/issues/3084)) ([fe95b9f](https://github.com/dsj1984/mandrel/commit/fe95b9f462fe0a695d1651dbd38ec76bdc362ec6))
* **observability:** wire trace hook into .claude/settings.json + propagate env vars from story-init (resolves [#1061](https://github.com/dsj1984/mandrel/issues/1061)) ([91d7b57](https://github.com/dsj1984/mandrel/commit/91d7b579fc1ad9883e6dc3c526324eb0c9e60a7c))
* **orchestration:** add BranchCleaner lifecycle listener for end-of-Epic branch reap ([#2402](https://github.com/dsj1984/mandrel/issues/2402)) ([b912e54](https://github.com/dsj1984/mandrel/commit/b912e54f5da1c2c8305af4ef0e6eead8f6050d7f)), closes [#2398](https://github.com/dsj1984/mandrel/issues/2398)
* **orchestration:** close Tasks at commit-time; defer epic-complete to PR-ready ([f0b3d7a](https://github.com/dsj1984/mandrel/commit/f0b3d7a48c45e2dbc5e554b947750bdbb4dee26a))
* **orchestration:** propagate ticket state upward on every transition ([#2677](https://github.com/dsj1984/mandrel/issues/2677)) ([29a036d](https://github.com/dsj1984/mandrel/commit/29a036deea739a0ec7abd39ba8e76dc2ebeb8d5b)), closes [#2676](https://github.com/dsj1984/mandrel/issues/2676)
* **orchestration:** record model attribution as structured comments on tasks + rollup ([#2814](https://github.com/dsj1984/mandrel/issues/2814)) ([3bbea99](https://github.com/dsj1984/mandrel/commit/3bbea99cf09260dd8d227d41b370db72226aa24a)), closes [#2813](https://github.com/dsj1984/mandrel/issues/2813)
* **perf:** parallelise calculateAll and scanAndScore via worker pool ([036a5c4](https://github.com/dsj1984/mandrel/commit/036a5c4c06cae31e3a089529c03cd125c14a2a2f))
* **planning:** decomposer cross-cutting rule covers registries + symbol fan-out ([#2974](https://github.com/dsj1984/mandrel/issues/2974)) ([5b3cb85](https://github.com/dsj1984/mandrel/commit/5b3cb852276653c82d1d84c084121f637d234842)), closes [#2962](https://github.com/dsj1984/mandrel/issues/2962)
* **post-merge:** replace phase-timings comment phase with analyzer perf-summary invocation (resolves [#1064](https://github.com/dsj1984/mandrel/issues/1064)) ([71c291b](https://github.com/dsj1984/mandrel/commit/71c291babb78ab8a24d6563729e9181d7a611460))
* **pr-watch:** auto-recover from BEHIND mergeStateStatus during PR watch loops ([#2009](https://github.com/dsj1984/mandrel/issues/2009)) ([fc013e8](https://github.com/dsj1984/mandrel/commit/fc013e81a1318fc9b0564b6bf0f3e4bc97ba4e4b))
* **pre-push:** add STORY_CLOSE_RECOVERY scoped coverage-gate bypass (refs [#3162](https://github.com/dsj1984/mandrel/issues/3162)) ([#3171](https://github.com/dsj1984/mandrel/issues/3171)) ([62bbd2f](https://github.com/dsj1984/mandrel/commit/62bbd2f08954abe67af4a5912e97c30744f3cf41))
* probe + commit a custom wave-runner sub-agent type (resolves [#1122](https://github.com/dsj1984/mandrel/issues/1122)) ([5c49c6c](https://github.com/dsj1984/mandrel/commit/5c49c6c73744182b2223f93c3d50902569d7afaa))
* **providers:** retry transient gh-api reads + cap paginateRest pages ([#2857](https://github.com/dsj1984/mandrel/issues/2857)) ([b8a60e6](https://github.com/dsj1984/mandrel/commit/b8a60e6ba7db6e2129b28a7aa38ace3391fccafc)), closes [#2852](https://github.com/dsj1984/mandrel/issues/2852)
* **qa-harness:** accept name-only personas for url-template seams (refs [#3306](https://github.com/dsj1984/mandrel/issues/3306)) ([#3309](https://github.com/dsj1984/mandrel/issues/3309)) ([6a96c07](https://github.com/dsj1984/mandrel/commit/6a96c07bc8a1789c2dcde54b9341b13ff3164d1d))
* **release:** 5.36.4 — remove sprintClose.runRetro back-compat shim ([8b5c0ab](https://github.com/dsj1984/mandrel/commit/8b5c0ab7c7d8b4ce4a161484251179765d89a29b))
* replace WorktreeManager.isSafeToRemove heuristic with git merge-base --is-ancestor (resolves [#1121](https://github.com/dsj1984/mandrel/issues/1121)) ([6acf52f](https://github.com/dsj1984/mandrel/commit/6acf52f286b55c3716d261522faccb4048d4cf89))
* retire prose-legacy hydration output mode ([#2864](https://github.com/dsj1984/mandrel/issues/2864)) ([#2865](https://github.com/dsj1984/mandrel/issues/2865)) ([5d514c9](https://github.com/dsj1984/mandrel/commit/5d514c9d9d1e148a9eab9d693988548f732434f2))
* **retro:** read story-perf-summary + epic-perf-report comments + mirror retro to temp/ (resolves [#1067](https://github.com/dsj1984/mandrel/issues/1067)) ([ee16c81](https://github.com/dsj1984/mandrel/commit/ee16c81cd0409b7e56e454ac72e4485533cadad3))
* run close-validation gates inside the worktree, read baselines from epic ref (resolves [#1120](https://github.com/dsj1984/mandrel/issues/1120)) ([fdc838b](https://github.com/dsj1984/mandrel/commit/fdc838b2f72cd6665c06a60513861d4071725d67))
* **schemas:** publish signal-event, story-perf-summary, epic-perf-report schemas + agentrc signals block (resolves [#1050](https://github.com/dsj1984/mandrel/issues/1050)) ([14ddd9e](https://github.com/dsj1984/mandrel/commit/14ddd9e1041e4d9dccae74018b0a8ac39da53aff))
* **scripts:** create lib/branch-name-guard.js with the union of both existing guards (resolves [#1099](https://github.com/dsj1984/mandrel/issues/1099)) ([5f6c9d3](https://github.com/dsj1984/mandrel/commit/5f6c9d35c0ca228546a9251e5d9ce90c90114694))
* SDLC state-machine consolidation (Epic [#2880](https://github.com/dsj1984/mandrel/issues/2880)) ([#2958](https://github.com/dsj1984/mandrel/issues/2958)) ([ac84841](https://github.com/dsj1984/mandrel/commit/ac84841aaa77c940efbc5efba520d0a295b5c994))
* ship analyze-execution.js with --story and --epic modes (resolves [#1123](https://github.com/dsj1984/mandrel/issues/1123)) ([e86b711](https://github.com/dsj1984/mandrel/commit/e86b7110fb2fc60c523be7cada7d25e232c0b7e0))
* **single-story-close:** add wrong-tree edit guard (refs [#3364](https://github.com/dsj1984/mandrel/issues/3364)) ([#3366](https://github.com/dsj1984/mandrel/issues/3366)) ([db07f38](https://github.com/dsj1984/mandrel/commit/db07f382863b7a80d19012dadb291b9f8666e22b))
* **single-story-execute:** standalone Story workflow (no parent Epic) ([#1475](https://github.com/dsj1984/mandrel/issues/1475)) ([4f56c49](https://github.com/dsj1984/mandrel/commit/4f56c495d1ec0f86a7807d31a73f09b8d564ae85))
* **single-story:** enable auto-merge by default; expose prNumber ([be81e11](https://github.com/dsj1984/mandrel/commit/be81e11ac974b2e8b055755fa6cce31024fc728e))
* skill library index + policy capsules (Epic [#2647](https://github.com/dsj1984/mandrel/issues/2647)) ([#2755](https://github.com/dsj1984/mandrel/issues/2755)) ([2e7f2b8](https://github.com/dsj1984/mandrel/commit/2e7f2b8d48ee147e2f4ad1f783eb29d8806088eb))
* story-close attributes baseline refreshes to the Story whose diff caused them (resolves [#1124](https://github.com/dsj1984/mandrel/issues/1124)) ([1390ffa](https://github.com/dsj1984/mandrel/commit/1390ffa3217cc4506f4d89efa521a171de68312e))
* **story-close:** bounded timeout for biome-format + baseline-refresh spawns ([#2165](https://github.com/dsj1984/mandrel/issues/2165)) ([#2180](https://github.com/dsj1984/mandrel/issues/2180)) ([01a61b3](https://github.com/dsj1984/mandrel/commit/01a61b32488ea6dc9031a5427a2029f56b67a043))
* **story-close:** classify baseline regressions as attributable vs non-attributable per story diff (resolves [#1132](https://github.com/dsj1984/mandrel/issues/1132)) ([627459a](https://github.com/dsj1984/mandrel/commit/627459ac2181c81a1e035462325f8ccc6cbda2af))
* **story-close:** wire attribution classifier and friction posting into story-close (resolves [#1134](https://github.com/dsj1984/mandrel/issues/1134)) ([88115d1](https://github.com/dsj1984/mandrel/commit/88115d19c54bb5a5139a38751f0e7dbe23cf7d33))
* **story-deliver:** add stories-wave-tick.js DAG/wave engine with unit tests (refs [#3233](https://github.com/dsj1984/mandrel/issues/3233)) ([#3243](https://github.com/dsj1984/mandrel/issues/3243)) ([72fba7e](https://github.com/dsj1984/mandrel/commit/72fba7e4c3ef89e6e97f410a0c922a8cd04565c5))
* sweep dispatch-manifest-&lt;id&gt;.{md,json} orphans on each manifest render (resolves [#1126](https://github.com/dsj1984/mandrel/issues/1126)) ([1dbe62e](https://github.com/dsj1984/mandrel/commit/1dbe62ef4774b5091f6c9aa3864e8d7164d8a933))
* **sweep:** protect active worktrees + add cross-session lock (resolves [#2011](https://github.com/dsj1984/mandrel/issues/2011)) ([#2013](https://github.com/dsj1984/mandrel/issues/2013)) ([67e6bd9](https://github.com/dsj1984/mandrel/commit/67e6bd9c84507368eb4d5c6659cdb9d9d2859f40))
* **tests:** add test-isolate diagnostic for pollution cascades ([#2976](https://github.com/dsj1984/mandrel/issues/2976)) ([420d4f5](https://github.com/dsj1984/mandrel/commit/420d4f54487bd452766abe2c3dc7273f872338bc)), closes [#2963](https://github.com/dsj1984/mandrel/issues/2963)
* **wave-execute:** route wave/epic dispatch through subagent_type: wave-runner (resolves [#1137](https://github.com/dsj1984/mandrel/issues/1137)) ([f34b0de](https://github.com/dsj1984/mandrel/commit/f34b0deda490757b07323909d9b33582af0e5112))
* **wave-runner:** extract wave loop into lib/wave-runner/tick.js + thin CLI ([#1477](https://github.com/dsj1984/mandrel/issues/1477)) ([a236fd2](https://github.com/dsj1984/mandrel/commit/a236fd2a421147ccad0f594255ccf2daf512d3eb))
* wire story-perf-summary into post-merge pipeline; epic-perf-report into Epic close + retro (resolves [#1046](https://github.com/dsj1984/mandrel/issues/1046)) ([70626b7](https://github.com/dsj1984/mandrel/commit/70626b7046a83fc3ddd5ce28b3c979183edf976d))
* **workflows:** add /audit-to-stories — convert audit MD findings into actionable GitHub Stories ([#2583](https://github.com/dsj1984/mandrel/issues/2583)) ([#2585](https://github.com/dsj1984/mandrel/issues/2585)) ([e4ab422](https://github.com/dsj1984/mandrel/commit/e4ab4227c84b825f259b8682c95a285baafe08b3))
* **workflows:** add /single-story-plan for standalone Story drafting (resolves [#2293](https://github.com/dsj1984/mandrel/issues/2293)) ([#2295](https://github.com/dsj1984/mandrel/issues/2295)) ([7b9b3b7](https://github.com/dsj1984/mandrel/commit/7b9b3b7cd76d9d92dff9aa451c05fbc6b039199e))
* **workflows:** create helpers/epic-deliver-story.md and repoint epic-deliver fan-out (refs [#3229](https://github.com/dsj1984/mandrel/issues/3229)) ([#3239](https://github.com/dsj1984/mandrel/issues/3239)) ([6173324](https://github.com/dsj1984/mandrel/commit/6173324d502126dbacff665ffa8479beeac94bba))


### Fixed

* **analyze-execution:** use runascli wrapper to satisfy cli-wrapper enforcement (resolves [#1135](https://github.com/dsj1984/mandrel/issues/1135)) ([5229fee](https://github.com/dsj1984/mandrel/commit/5229fee1f10c84e855a4bf6fe78a564ce8b67498))
* **audit:** isolate audit selector and acceptance reconciler per-epic (refs [#3362](https://github.com/dsj1984/mandrel/issues/3362)) ([#3365](https://github.com/dsj1984/mandrel/issues/3365)) ([8cd28e5](https://github.com/dsj1984/mandrel/commit/8cd28e5483078d289db59c2673ecddbddbb724bb))
* baseline-refresh epic-merge-lock.js (Node 22 instrumentation) ([#1233](https://github.com/dsj1984/mandrel/issues/1233)) ([7daf164](https://github.com/dsj1984/mandrel/commit/7daf164a5fbe7f550d5683f895311ec08e3bc1ec))
* **baselines/writer:** project legacy prior rows through projectRow at writer entry ([#2578](https://github.com/dsj1984/mandrel/issues/2578)) ([a106457](https://github.com/dsj1984/mandrel/commit/a1064577334a0cc4a901500f7888dd18b9fb6e29)), closes [#2574](https://github.com/dsj1984/mandrel/issues/2574)
* **baselines:** classify new files as additions, not regressions (resolves [#2012](https://github.com/dsj1984/mandrel/issues/2012)) ([#2058](https://github.com/dsj1984/mandrel/issues/2058)) ([3bcb15a](https://github.com/dsj1984/mandrel/commit/3bcb15a8ff8fc36176b168330a173536b983eb06))
* **baselines:** harden MI scorer against escomplex parse-fail phantoms ([#2998](https://github.com/dsj1984/mandrel/issues/2998)) ([8023458](https://github.com/dsj1984/mandrel/commit/8023458c597689020ba04e0b1c802fe3170407c3)), closes [#2996](https://github.com/dsj1984/mandrel/issues/2996)
* **baselines:** maintainability/crap update writes worktree-relative paths instead of repo-relative ([#2079](https://github.com/dsj1984/mandrel/issues/2079)) ([#2080](https://github.com/dsj1984/mandrel/issues/2080)) ([b5f0f24](https://github.com/dsj1984/mandrel/commit/b5f0f245b0b306e984c617efa74b57eceaf2a817))
* **baselines:** ship refresh-service.js inside .agents/ bundle ([#2579](https://github.com/dsj1984/mandrel/issues/2579)) ([e27c109](https://github.com/dsj1984/mandrel/commit/e27c109597485301f9f7d6597c8e5e81b725c8a2)), closes [#2572](https://github.com/dsj1984/mandrel/issues/2572)
* **bdd-detect:** scan workspace package.json files in monorepos ([#2957](https://github.com/dsj1984/mandrel/issues/2957)) ([456326e](https://github.com/dsj1984/mandrel/commit/456326ee41da1a8443125665cf28592215877e67))
* **bootstrap:** close consumer-side runtime-deps install gap ([#2057](https://github.com/dsj1984/mandrel/issues/2057)) ([#2061](https://github.com/dsj1984/mandrel/issues/2061)) ([4cfc564](https://github.com/dsj1984/mandrel/commit/4cfc564619626ca80e988a20440ea9ba2bdfa2b7))
* **bootstrap:** handle fresh-empty-repo bootstrap failure modes ([#2022](https://github.com/dsj1984/mandrel/issues/2022)) ([28ae5d4](https://github.com/dsj1984/mandrel/commit/28ae5d481ca9fb256e6b22bc9e515b2dcc74f5e5)), closes [#2018](https://github.com/dsj1984/mandrel/issues/2018)
* **bootstrap:** sync-agentrc and quality-bootstrap contradict each other on default-key writes ([#2281](https://github.com/dsj1984/mandrel/issues/2281)) ([#2285](https://github.com/dsj1984/mandrel/issues/2285)) ([c6626f3](https://github.com/dsj1984/mandrel/commit/c6626f3723f1a772e90f3eb030402d0a4af6388f))
* **cascade:** enable parent-Feature cascade from single-story close path ([#3242](https://github.com/dsj1984/mandrel/issues/3242)) ([368bc1d](https://github.com/dsj1984/mandrel/commit/368bc1d9a8e5c8133be3c16c2ab385896971f3af))
* **cascade:** preserve orchestrator footer and walk native Sub-Issues parent (resolves [#2982](https://github.com/dsj1984/mandrel/issues/2982)) ([#2983](https://github.com/dsj1984/mandrel/issues/2983)) ([5b2b51d](https://github.com/dsj1984/mandrel/commit/5b2b51defb065e6066b46be43316e0a2dbd8cbf8))
* **checkpointer:** refresh totalWaves on re-prepare delta ([#1821](https://github.com/dsj1984/mandrel/issues/1821)) ([a148964](https://github.com/dsj1984/mandrel/commit/a148964fcd661b0f492bab6e3623a1d15265abba)), closes [#1816](https://github.com/dsj1984/mandrel/issues/1816)
* **ci:** denominator-aware coverage tolerance + c=1 CRAP exemption ([#1234](https://github.com/dsj1984/mandrel/issues/1234)) ([3a95bdc](https://github.com/dsj1984/mandrel/commit/3a95bdcb46ea7d45d0499e0a9a921f12333beef3))
* **ci:** revert local-only coverage ratchets for three flapping files ([#1265](https://github.com/dsj1984/mandrel/issues/1265)) ([731d0d0](https://github.com/dsj1984/mandrel/commit/731d0d0baea79a41ab13c1f77fef47889ea531c2))
* **ci:** SHA-pin third-party GitHub Actions (refs [#3399](https://github.com/dsj1984/mandrel/issues/3399)) ([#3403](https://github.com/dsj1984/mandrel/issues/3403)) ([32a3744](https://github.com/dsj1984/mandrel/commit/32a374436718e97f91da274930d25120b81b0388))
* **cli:** add defineFlags export and finish parseCliArgs migration ([cf8cb6f](https://github.com/dsj1984/mandrel/commit/cf8cb6f19c59a80809b68fd5a0672f037d3902f2))
* **close:** defer agent::done + issue-close to PR-merge in standalone story-close (refs [#3385](https://github.com/dsj1984/mandrel/issues/3385)) ([#3395](https://github.com/dsj1984/mandrel/issues/3395)) ([43dd1f4](https://github.com/dsj1984/mandrel/commit/43dd1f45c734b97c2c3cc647d55ab3e8c0e5d221))
* **column-sync:** look up project item by issue, not by paginated board scan ([#2633](https://github.com/dsj1984/mandrel/issues/2633)) ([bc6b6e4](https://github.com/dsj1984/mandrel/commit/bc6b6e4b2e1cf736cc65b6c67b022a3fa04146fa)), closes [#2632](https://github.com/dsj1984/mandrel/issues/2632)
* **config:** getQuality reads wrong shape — operator coverage timeout never honored ([#2959](https://github.com/dsj1984/mandrel/issues/2959)) ([#2969](https://github.com/dsj1984/mandrel/issues/2969)) ([09409e6](https://github.com/dsj1984/mandrel/commit/09409e6e07646fdb6b98d79b0836e95a9427a584))
* **coverage:** wire .c8rc.cjs scope through `c8 report` + `check-coverage` ([ca7745c](https://github.com/dsj1984/mandrel/commit/ca7745cf936c43608cc912d876fe96255db276bc))
* **emit-context:** route Logger output to stderr to keep stdout pure JSON ([#2287](https://github.com/dsj1984/mandrel/issues/2287)) ([5622bd6](https://github.com/dsj1984/mandrel/commit/5622bd6cf63645778a8e108626e5176883ba6b44)), closes [#2278](https://github.com/dsj1984/mandrel/issues/2278)
* **epic-deliver-cleanup:** reap local-side leftovers after merge ([#1348](https://github.com/dsj1984/mandrel/issues/1348)) ([aea6f6c](https://github.com/dsj1984/mandrel/commit/aea6f6c6360dc943430ea38be23604a7d3870d48))
* **epic-plan-decompose:** preserve acceptance::* and planning::* on Epic through reconciler ([#3052](https://github.com/dsj1984/mandrel/issues/3052)) ([0e96fac](https://github.com/dsj1984/mandrel/commit/0e96fac373b5414917485da1165be435f0c52197)), closes [#3050](https://github.com/dsj1984/mandrel/issues/3050)
* **epic-plan-decompose:** preserve Epic body through reconciler persist ([#2286](https://github.com/dsj1984/mandrel/issues/2286)) ([07e50e5](https://github.com/dsj1984/mandrel/commit/07e50e59e355040115c38586fdf5fdfba8e541c6)), closes [#2283](https://github.com/dsj1984/mandrel/issues/2283)
* **epic-plan-decompose:** restore sub-issue link safety net + branch cleanup ([#2067](https://github.com/dsj1984/mandrel/issues/2067)) ([450b159](https://github.com/dsj1984/mandrel/commit/450b159b414cb87603668f3cac1747f6a460c1a7)), closes [#2063](https://github.com/dsj1984/mandrel/issues/2063)
* **epic-plan:** overwrite context tickets in place on --force re-plan (refs [#3310](https://github.com/dsj1984/mandrel/issues/3310)) ([#3314](https://github.com/dsj1984/mandrel/issues/3314)) ([3c4c5b5](https://github.com/dsj1984/mandrel/commit/3c4c5b52641dd54de7cf571c33872d073bdf098c))
* **epic-plan:** route --emit-context drain logs to stderr ([#2055](https://github.com/dsj1984/mandrel/issues/2055)) ([#2066](https://github.com/dsj1984/mandrel/issues/2066)) ([295bd4b](https://github.com/dsj1984/mandrel/commit/295bd4b0fceb9e9b34c63c8678f7bc15ca02d8e2))
* **epic-runner:** emit epic-blocked before epic-progress on wave halt ([d7daa35](https://github.com/dsj1984/mandrel/commit/d7daa35a9423517f4beada68a02e872806be1a5d))
* **epic-spec-reconciler:** preserve type::* and risk::* labels on Epic persist ([#2064](https://github.com/dsj1984/mandrel/issues/2064)) ([c6aa08f](https://github.com/dsj1984/mandrel/commit/c6aa08f5824b749122317e237a59ebf164d9a01a)), closes [#2056](https://github.com/dsj1984/mandrel/issues/2056)
* **finalize:** strip [skip ci] markers from openOrLocatePr body (refs [#3165](https://github.com/dsj1984/mandrel/issues/3165)) ([#3176](https://github.com/dsj1984/mandrel/issues/3176)) ([0374a1d](https://github.com/dsj1984/mandrel/commit/0374a1dffa96dfacc1ef116d854009edc82d9710))
* **full-agentrc:** correct floor axis keys to match v2 envelopes ([#2577](https://github.com/dsj1984/mandrel/issues/2577)) ([bdb90d7](https://github.com/dsj1984/mandrel/commit/bdb90d781c3d4658fe6f720a208db328b5aa5a17)), closes [#2573](https://github.com/dsj1984/mandrel/issues/2573)
* **git-cleanup-branches:** prune via `git fetch --prune` to defeat GitHub replication lag ([#1716](https://github.com/dsj1984/mandrel/issues/1716)) ([260d5a5](https://github.com/dsj1984/mandrel/commit/260d5a513079f737990cf2633dd95177942e5532))
* **git-cleanup:** correct merged-PR signal and guard DEP0190 stderr ([#2498](https://github.com/dsj1984/mandrel/issues/2498)) ([8fe3ea0](https://github.com/dsj1984/mandrel/commit/8fe3ea063ea2aa1c495731e1d3dabe94e5c51363))
* **git-cleanup:** split current-HEAD skip + add remote-only sweep ([#2446](https://github.com/dsj1984/mandrel/issues/2446)) ([8b63fee](https://github.com/dsj1984/mandrel/commit/8b63feed54b738e97492c00ae284b0db3148f9d1)), closes [#2445](https://github.com/dsj1984/mandrel/issues/2445)
* guard postinstall + unignore framework .agents/ source (refs [#3489](https://github.com/dsj1984/mandrel/issues/3489)) ([#3531](https://github.com/dsj1984/mandrel/issues/3531)) ([4c68d6b](https://github.com/dsj1984/mandrel/commit/4c68d6bfc94e39682a7090d2b36bcde5605ae76a))
* **lifecycle:** allow epicId on epic.automerge.start payload ([#2856](https://github.com/dsj1984/mandrel/issues/2856)) ([c76b7ae](https://github.com/dsj1984/mandrel/commit/c76b7aec424ef5d6dddb9043ec2421b643dc24d5)), closes [#2855](https://github.com/dsj1984/mandrel/issues/2855)
* **lifecycle:** close-tail completeness — audit-results marker, epic.merge.* schemas, Phase 7 doc-truth ([#2710](https://github.com/dsj1984/mandrel/issues/2710)) ([41c4c84](https://github.com/dsj1984/mandrel/commit/41c4c84ec272f501f3d6e30df6ecb71a0d8357e1)), closes [#2681](https://github.com/dsj1984/mandrel/issues/2681)
* **lifecycle:** stop epic.close.end cascading into branch reap (refs [#3367](https://github.com/dsj1984/mandrel/issues/3367)) ([#3381](https://github.com/dsj1984/mandrel/issues/3381)) ([9d21318](https://github.com/dsj1984/mandrel/commit/9d213186c6511a1a2128f472512f24271e05af46))
* **lint-baseline:** honor agentrc override and run shim launchers via shell ([#2752](https://github.com/dsj1984/mandrel/issues/2752)) ([6c39c29](https://github.com/dsj1984/mandrel/commit/6c39c292433a67067f2cb5dee713658306f4cfcb)), closes [#2750](https://github.com/dsj1984/mandrel/issues/2750)
* **maintainability:** raise tolerance 0.001 → 0.5, plumb config (kills baseline-refresh-guardrail flap) ([#1269](https://github.com/dsj1984/mandrel/issues/1269)) ([f1877c6](https://github.com/dsj1984/mandrel/commit/f1877c642c1c5af732721b4e98a880c570652c0d))
* **observability:** support standalone stories with null epicId ([#2875](https://github.com/dsj1984/mandrel/issues/2875)) ([d20c51e](https://github.com/dsj1984/mandrel/commit/d20c51e49cc24914f21bffab6828025344f94aef)), closes [#2874](https://github.com/dsj1984/mandrel/issues/2874)
* **orchestration:** cap Auto-resolved-file trailer at 100 chars (refs [#3160](https://github.com/dsj1984/mandrel/issues/3160)) ([#3170](https://github.com/dsj1984/mandrel/issues/3170)) ([fbdf13d](https://github.com/dsj1984/mandrel/commit/fbdf13d8306ed3fbabac2afa0f6a0a8fc35ec51b))
* **orchestration:** flip task labels at per-task start, not story-init ([#2779](https://github.com/dsj1984/mandrel/issues/2779)) ([a155549](https://github.com/dsj1984/mandrel/commit/a155549ccaff45134e5c3306c059f836af23fe9a))
* **orchestration:** harden reassertStatusColumn with poll-and-retry ([#2878](https://github.com/dsj1984/mandrel/issues/2878)) ([8efcc28](https://github.com/dsj1984/mandrel/commit/8efcc28e1f4513cbf1dd008a91457f5d438955b1)), closes [#2876](https://github.com/dsj1984/mandrel/issues/2876)
* **orchestration:** own Projects v2 Status column — audit + post-merge re-sync ([#2847](https://github.com/dsj1984/mandrel/issues/2847)) ([acc277d](https://github.com/dsj1984/mandrel/commit/acc277da06d6c5971dd7295bf9808c0ad4be7247)), closes [#2845](https://github.com/dsj1984/mandrel/issues/2845)
* **orchestration:** refuse PR creation against main when Story has Epic parent ([#2967](https://github.com/dsj1984/mandrel/issues/2967)) ([a5dcb0d](https://github.com/dsj1984/mandrel/commit/a5dcb0d155137caa995aedba53eff2882be541ae)), closes [#2960](https://github.com/dsj1984/mandrel/issues/2960)
* **quality:** inject framework-default floors in resolver; delete dead per-row machinery ([#2125](https://github.com/dsj1984/mandrel/issues/2125)) ([#2126](https://github.com/dsj1984/mandrel/issues/2126)) ([4c3d687](https://github.com/dsj1984/mandrel/commit/4c3d6875a7dd61eeb49888330f9711d29a91d1ea))
* **reconciler:** order dependsOn ahead of dependents in topo-sort ([#1787](https://github.com/dsj1984/mandrel/issues/1787)) ([87b0a5f](https://github.com/dsj1984/mandrel/commit/87b0a5fbbf5efa9445164a4ec70c371b0789579b))
* **reconciler:** seed epic slug in state before diff to stop duplicate Epic issues ([#1823](https://github.com/dsj1984/mandrel/issues/1823)) ([a4523ce](https://github.com/dsj1984/mandrel/commit/a4523ceafbbabffe2118d3ff3fe8c52c2e62b5f4)), closes [#1820](https://github.com/dsj1984/mandrel/issues/1820)
* **release:** use PAT so release-please PRs trigger CI ([#1933](https://github.com/dsj1984/mandrel/issues/1933)) ([4ee603f](https://github.com/dsj1984/mandrel/commit/4ee603f4317e92f3c75397bae28a3e8a3adb75c2))
* **release:** version Epic merges and fix agents-update changelog source ([#3307](https://github.com/dsj1984/mandrel/issues/3307)) ([44ea136](https://github.com/dsj1984/mandrel/commit/44ea136aef07154f414150f2ee89c4d6f264382d))
* **retro:** align retro-runner with ITicketingProvider; add no-op guard; count manual interventions ([#2290](https://github.com/dsj1984/mandrel/issues/2290)) ([3815739](https://github.com/dsj1984/mandrel/commit/3815739f0cc707c8ea24606198edf55936de9357)), closes [#2289](https://github.com/dsj1984/mandrel/issues/2289)
* **review:** close correctness/doc gaps from medium-low review pass ([7d6b61a](https://github.com/dsj1984/mandrel/commit/7d6b61ac7d86ae9793ef8ad44f70c904d693e3ac))
* **review:** handle PathEntry objects in analyseChanges, suppress MI noise, fix lint errors ([#3248](https://github.com/dsj1984/mandrel/issues/3248)) ([972fe78](https://github.com/dsj1984/mandrel/commit/972fe783fac74b7040c992c68bec4695738c6086))
* scope epic child-ticket fetch through getSubTickets in reconciliation (refs [#3455](https://github.com/dsj1984/mandrel/issues/3455)) ([#3456](https://github.com/dsj1984/mandrel/issues/3456)) ([c447940](https://github.com/dsj1984/mandrel/commit/c4479405c3012d19619120e92cb9126a5a8d6c8a))
* **single-story-close:** pass epicId: null for standalone Stories ([#1478](https://github.com/dsj1984/mandrel/issues/1478)) ([c288bd3](https://github.com/dsj1984/mandrel/commit/c288bd3c231c8a345a72814807329a88341e295f))
* **single-story-deliver:** route label flips through transitionTicketState so Projects v2 Status syncs ([#2739](https://github.com/dsj1984/mandrel/issues/2739)) ([5f4e6e2](https://github.com/dsj1984/mandrel/commit/5f4e6e291f89f7f4353b6a72d57f173982b25c75)), closes [#2717](https://github.com/dsj1984/mandrel/issues/2717)
* **single-story:** fast-forward local main after deliver and at init ([#2753](https://github.com/dsj1984/mandrel/issues/2753)) ([80a5cea](https://github.com/dsj1984/mandrel/commit/80a5cea77dcc43968fc5e0a9be0e420ba5cc871f))
* **single-story:** gate confirm-merge noop on agent::done label not closed issue (refs [#3415](https://github.com/dsj1984/mandrel/issues/3415)) ([#3416](https://github.com/dsj1984/mandrel/issues/3416)) ([6ac471e](https://github.com/dsj1984/mandrel/commit/6ac471edd3da4869d3632a0f85e7edc199840835))
* **skill:** align decompose-author SKILL Story-body shape with validator + provider contract (refs [#3263](https://github.com/dsj1984/mandrel/issues/3263)) ([#3267](https://github.com/dsj1984/mandrel/issues/3267)) ([5b6a439](https://github.com/dsj1984/mandrel/commit/5b6a4390bec18621ad8a0e5e279f513d2b4dc070))
* **skills:** enforce manifest schema and dedupe SKILL walkers ([#2757](https://github.com/dsj1984/mandrel/issues/2757)) ([88b0098](https://github.com/dsj1984/mandrel/commit/88b0098aad447fc04739c5fe34fb1cf57bec1e89))
* **spec-renderer:** omit tasks: [] for 3-tier Stories (refs [#3163](https://github.com/dsj1984/mandrel/issues/3163)) ([#3177](https://github.com/dsj1984/mandrel/issues/3177)) ([859fe4b](https://github.com/dsj1984/mandrel/commit/859fe4ba47050e2be98ee36e1c642dcaee0e4f87))
* **spec:** write epic spec + state under temp/epic-&lt;id&gt;/, untrack leaked temp/ files ([#1715](https://github.com/dsj1984/mandrel/issues/1715)) ([0965e85](https://github.com/dsj1984/mandrel/commit/0965e85535dfde1f26ca988156a4edc53e521891))
* **story-body:** serialize object bodies in createOp; parse string bodies in freshness + assumption gates (refs [#3302](https://github.com/dsj1984/mandrel/issues/3302)) ([#3303](https://github.com/dsj1984/mandrel/issues/3303)) ([69322ac](https://github.com/dsj1984/mandrel/commit/69322ac2ed772b7fb6281c0aa49c0087a6834fbb))
* **story-close:** assert final label is agent::done before returning success ([#2961](https://github.com/dsj1984/mandrel/issues/2961)) ([#2968](https://github.com/dsj1984/mandrel/issues/2968)) ([e112131](https://github.com/dsj1984/mandrel/commit/e112131c774ea34334be5a7ec4f9618a20a29cad))
* **story-close:** drop retired structured:friction marker text from doc strings ([d751ae6](https://github.com/dsj1984/mandrel/commit/d751ae64bfac937ee173752c1ac0c71ed350886d))
* **story-close:** enforce single baseline-refresh commit per close cycle (resolves [#2176](https://github.com/dsj1984/mandrel/issues/2176)) ([#2177](https://github.com/dsj1984/mandrel/issues/2177)) ([a900e4f](https://github.com/dsj1984/mandrel/commit/a900e4f0c8c5c598dbd831feca218636cecb49d5))
* **story-close:** filter format gate scope to formatter-eligible files (refs [#3410](https://github.com/dsj1984/mandrel/issues/3410)) ([#3411](https://github.com/dsj1984/mandrel/issues/3411)) ([f38f32c](https://github.com/dsj1984/mandrel/commit/f38f32cfc3da400b13648fd32ac5e7bc8fa271bf))
* **story-close:** hold epic-merge lock across entire close flow ([5ad47ea](https://github.com/dsj1984/mandrel/commit/5ad47eaff31713413e972482feb1a6ba651e2930))
* **story-close:** scope format gate to story diff (refs [#3407](https://github.com/dsj1984/mandrel/issues/3407)) ([#3408](https://github.com/dsj1984/mandrel/issues/3408)) ([25e671e](https://github.com/dsj1984/mandrel/commit/25e671eee24686bcf04d979afc780f647143711c))
* switch the push-to-main path to set BASELINE_SCOPE=full instead. ([9b8b1a2](https://github.com/dsj1984/mandrel/commit/9b8b1a26e7465920bfd49c469f427b421ccea2e2))
* **temp-paths:** honor configured tempRoot in story-close pipeline ([#1345](https://github.com/dsj1984/mandrel/issues/1345)) ([868ffef](https://github.com/dsj1984/mandrel/commit/868ffefade602650b619a541b59c77c09a8000b1))
* **test-runner:** chunk node --test spawns to avoid Windows ENAMETOOLONG ([#3540](https://github.com/dsj1984/mandrel/issues/3540)) ([6b00be5](https://github.com/dsj1984/mandrel/commit/6b00be5ad64ce5ecc1f06a444b1ea767ee0b52e0))
* **tests:** canonicalize Windows tmp paths via realpathSync.native ([3c8ce93](https://github.com/dsj1984/mandrel/commit/3c8ce939f25f626671017002d76f3d9b70d7019c))
* **tests:** inject noop notify in epic-execute-record-wave defaults ([#3007](https://github.com/dsj1984/mandrel/issues/3007)) ([8575489](https://github.com/dsj1984/mandrel/commit/85754894b9fbba5c64ad6860c2dea3d8df05e440)), closes [#3006](https://github.com/dsj1984/mandrel/issues/3006)
* **tests:** retry rmSync on Windows EBUSY in cd-out-guard cleanup ([bdaee94](https://github.com/dsj1984/mandrel/commit/bdaee94980fee5d97550785c403f22c5c3892eae))
* **tests:** scrub NOTIFICATION_WEBHOOK_URL from test child env (resolves [#2975](https://github.com/dsj1984/mandrel/issues/2975)) ([#2977](https://github.com/dsj1984/mandrel/issues/2977)) ([da0ae04](https://github.com/dsj1984/mandrel/commit/da0ae044cff06885a0007343a912e1523bfb5d67))
* **tests:** stabilize shipped-baselines-idempotency round-trip ([#2017](https://github.com/dsj1984/mandrel/issues/2017)) ([#2026](https://github.com/dsj1984/mandrel/issues/2026)) ([4cc4075](https://github.com/dsj1984/mandrel/commit/4cc4075a906bbca4a1f866334372585586297df5))
* **tests:** swallow EBUSY/EPERM in cd-out-guard tmp cleanup ([c23e91d](https://github.com/dsj1984/mandrel/commit/c23e91d981ca3d70c33e8668578c6d607d42167e))
* **tests:** unblock CI on cpu-pool exit race + Windows path mismatches ([fe09b4e](https://github.com/dsj1984/mandrel/commit/fe09b4e7478939ff6d926ef5c3bb6c5470c27f4d))
* **workspace:** include .mcp.json in default bootstrap file set ([#2978](https://github.com/dsj1984/mandrel/issues/2978)) ([0cdd9bd](https://github.com/dsj1984/mandrel/commit/0cdd9bdfaace8954a377c3e371929ed9d7c512a2))


### Performance

* **retro:** parallelize Story comment fetches + level-order BFS ([#2859](https://github.com/dsj1984/mandrel/issues/2859)) ([66e45bc](https://github.com/dsj1984/mandrel/commit/66e45bcfd5f45cec2a8e7780ec006e580affa196)), closes [#2853](https://github.com/dsj1984/mandrel/issues/2853)
* **test:** trim slow integration-style suite setup ([#2744](https://github.com/dsj1984/mandrel/issues/2744)) ([#2751](https://github.com/dsj1984/mandrel/issues/2751)) ([3cfc316](https://github.com/dsj1984/mandrel/commit/3cfc316cd4b861570ed76bc67d8a76f5c1119555))


### Changed

* **audit-suite:** centralize audit artifacts under {tempRoot}/audits ([#2452](https://github.com/dsj1984/mandrel/issues/2452)) ([1eff6c4](https://github.com/dsj1984/mandrel/commit/1eff6c48e1da0f8828016d30db8c4e8aaa3663cd)), closes [#2451](https://github.com/dsj1984/mandrel/issues/2451)
* **audit-suite:** create lib/audit-suite/ sdk with runauditsuite and selectaudits (resolves [#1098](https://github.com/dsj1984/mandrel/issues/1098)) ([c9798be](https://github.com/dsj1984/mandrel/commit/c9798be404f0d2bee56a72e927c6ef7330cb5a69))
* **branch-cleanup:** migrate delete-epic-branches.js to lib helpers; add deleteBranchesBatched ([ffad94c](https://github.com/dsj1984/mandrel/commit/ffad94cf53302c86cc96bebf910c4c058b3f75d7))
* break down CRAP hotspots to ratchet crap floor below 340 ([#2850](https://github.com/dsj1984/mandrel/issues/2850)) ([#2858](https://github.com/dsj1984/mandrel/issues/2858)) ([d3e68c2](https://github.com/dsj1984/mandrel/commit/d3e68c22494a9cc4a4ef89c3ce9caeeea310fb59))
* **cli:** extract runX from main in 4 top-CRAP CLI shells ([38a6592](https://github.com/dsj1984/mandrel/commit/38a65924a0f6732dc68b3aa473b930c1128a4413))
* consolidate branch-seed classifier and add lease boundary tests (refs [#3513](https://github.com/dsj1984/mandrel/issues/3513)) ([#3532](https://github.com/dsj1984/mandrel/issues/3532)) ([50ec417](https://github.com/dsj1984/mandrel/commit/50ec417b0c93eeda90376edf4a7146ce147d1a6d))
* **detect-merges:** replace promise.all with concurrentmap (cap=64) in detect-merges.js (resolves [#1104](https://github.com/dsj1984/mandrel/issues/1104)) ([f7512ea](https://github.com/dsj1984/mandrel/commit/f7512eafe3ac8f1dd1a86b80731fe9c22e1cf334))
* **diagnose-friction:** refactor diagnose-friction.js to detector-only (calls signals-writer, posts no comment) (resolves [#1057](https://github.com/dsj1984/mandrel/issues/1057)) ([184e49e](https://github.com/dsj1984/mandrel/commit/184e49e9c638a91e49f78281f304ef3f41aac18d))
* **epic-close:** bound auxiliary-ticket close (cap=3) (resolves [#1107](https://github.com/dsj1984/mandrel/issues/1107)) ([fdc6903](https://github.com/dsj1984/mandrel/commit/fdc6903224b0c97d67d71aa404561646f4724e86))
* **epic-close:** split phaseFinalizeBranchCleanup into named sub-phases ([590b641](https://github.com/dsj1984/mandrel/commit/590b641b87804e6c31856d0d02418f681857a262))
* **epic-deliver:** drop close-as-approval gate for context::acceptance-spec ([#2280](https://github.com/dsj1984/mandrel/issues/2280)) ([328f4a5](https://github.com/dsj1984/mandrel/commit/328f4a539a4748a7b2b3aeb914899320d1ebb452))
* **epic-plan:** unify Epic canonical headings (Context/Goal/Non-Goals/Scope/AC) ([#2183](https://github.com/dsj1984/mandrel/issues/2183)) ([2abc8f3](https://github.com/dsj1984/mandrel/commit/2abc8f3ea5f245c2370595955b89b71946b00e2e))
* **friction:** delete friction-emitter cooldown module + remaining importers (resolves [#1059](https://github.com/dsj1984/mandrel/issues/1059)) ([c58a45d](https://github.com/dsj1984/mandrel/commit/c58a45d0934d31690757cf4f1b5e8af2bd7ab763))
* **manifest-persistence:** extract sweep helpers to satisfy mi baseline (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([20e627f](https://github.com/dsj1984/mandrel/commit/20e627fa7f85056ec9115c4911a7552d22fb8a38))
* **manifest:** migrate dispatcher + story-init manifest writers to per-epic tree (resolves [#1053](https://github.com/dsj1984/mandrel/issues/1053)) ([fc49ce9](https://github.com/dsj1984/mandrel/commit/fc49ce9d2f2ecceb623988435e5ab9c8bf416e5d))
* **manifest:** migrate helpers to canonical config pointers ([#2955](https://github.com/dsj1984/mandrel/issues/2955)) ([f9b3dac](https://github.com/dsj1984/mandrel/commit/f9b3dac0deea6c2c63cdc4bd4d7b3e0122210e7c)), closes [#2945](https://github.com/dsj1984/mandrel/issues/2945) [#2950](https://github.com/dsj1984/mandrel/issues/2950)
* **model-selection:** resolve daylight between schema, code, and docs ([#2630](https://github.com/dsj1984/mandrel/issues/2630)) ([d1f1eaf](https://github.com/dsj1984/mandrel/commit/d1f1eaff693528d1f8223f5ff555ea18c6494615)), closes [#2590](https://github.com/dsj1984/mandrel/issues/2590)
* **orchestration:** bound cascadecompletion sibling reads + sequential parents (resolves [#1108](https://github.com/dsj1984/mandrel/issues/1108)) ([4a8c713](https://github.com/dsj1984/mandrel/commit/4a8c71393edf3b4a0786296c7bf8280c51e07d1a))
* **orchestration:** bounded parallelism in reconciler, sub-issue links, delete-epic (resolves [#1110](https://github.com/dsj1984/mandrel/issues/1110)) ([d0defa8](https://github.com/dsj1984/mandrel/commit/d0defa85956628c9e10705ec4c92bb93178c2283))
* **orchestration:** delete aggregate-phase-timings and telemetry helpers (resolves [#1068](https://github.com/dsj1984/mandrel/issues/1068)) ([e386a46](https://github.com/dsj1984/mandrel/commit/e386a4608ea0b640d057a01a46096c2206a0642a))
* **orchestration:** delete health-monitor and post-merge health-monitor phase (resolves [#1065](https://github.com/dsj1984/mandrel/issues/1065)) ([da87499](https://github.com/dsj1984/mandrel/commit/da87499d02c2997b537f036e7dec39662676381c))
* **orchestration:** delete unused lib/orchestration/index.js barrel ([5d8a4c8](https://github.com/dsj1984/mandrel/commit/5d8a4c8528183d4ead0d0a16172d7c46a1385bfc))
* **orchestration:** migrate health-monitor + render-manifest + dependency-guard to per-epic tree (resolves [#1054](https://github.com/dsj1984/mandrel/issues/1054)) ([9d99184](https://github.com/dsj1984/mandrel/commit/9d991846304c527bd7b04b3f0237652188858bf6))
* **orchestration:** remove upward re-exports from lib/orchestration/index.js (resolves [#1100](https://github.com/dsj1984/mandrel/issues/1100)) ([d8cf3c3](https://github.com/dsj1984/mandrel/commit/d8cf3c39bd8a020df863f08bdac6d9c16d33ed61))
* **plan-phase-cleanup:** migrate plan-phase-cleanup to per-epic paths (resolves [#1052](https://github.com/dsj1984/mandrel/issues/1052)) ([ac33f34](https://github.com/dsj1984/mandrel/commit/ac33f342f8cd0450a1f5fd230bce92d488f83bda))
* **planning-state-manager:** bound close/detach mutations (cap=3) (resolves [#1106](https://github.com/dsj1984/mandrel/issues/1106)) ([a03b335](https://github.com/dsj1984/mandrel/commit/a03b335cdac68352af0e9dbad45295ce9696ef2c))
* **providers:** move `providers/github-http-client.js` to `providers/github/http-client.js` (resolves [#1101](https://github.com/dsj1984/mandrel/issues/1101)) ([65e0ada](https://github.com/dsj1984/mandrel/commit/65e0ada5a4cd8cb728fb3c03e6c7ad1bf9968930))
* remove Sprint Health residue (creator + close-side + dead config) ([023faa0](https://github.com/dsj1984/mandrel/commit/023faa0d2ff16f953ffaadb82354e087031e56be))
* rename /story-execute to /story-deliver (hard cutover) ([#2174](https://github.com/dsj1984/mandrel/issues/2174)) ([a40e385](https://github.com/dsj1984/mandrel/commit/a40e3854ee6bb3e3bf15f096a4186bd0df6c6822)), closes [#2171](https://github.com/dsj1984/mandrel/issues/2171)
* **render-manifest:** atomic writes for manifest .md/.json (resolves [#1111](https://github.com/dsj1984/mandrel/issues/1111)) ([669db24](https://github.com/dsj1984/mandrel/commit/669db24dc2493feef877a80e9ebd390f4069ea78))
* retire /wave-execute; /epic-execute owns the wave loop directly ([9036a6a](https://github.com/dsj1984/mandrel/commit/9036a6a7be76b3caef954a59171691fbb8c357e1))
* **scripts:** address Epic [#3316](https://github.com/dsj1984/mandrel/issues/3316) audit follow-ups ([#3361](https://github.com/dsj1984/mandrel/issues/3361)) ([7728a60](https://github.com/dsj1984/mandrel/commit/7728a6049d9739ea48881bba108adee056e13f41))
* **scripts:** complete parseStandardCliArgs rollout + centralize parseRequired{Positive,NonNegative}Int ([#3012](https://github.com/dsj1984/mandrel/issues/3012)) ([b767d1a](https://github.com/dsj1984/mandrel/commit/b767d1a480dbc5d7202ff541abba4f5aec51780b)), closes [#2989](https://github.com/dsj1984/mandrel/issues/2989) [#2993](https://github.com/dsj1984/mandrel/issues/2993)
* **scripts:** decompose baseline-attribution into phases/ ([#3009](https://github.com/dsj1984/mandrel/issues/3009)) ([32695ff](https://github.com/dsj1984/mandrel/commit/32695ff9b33614bb191f19ac33c1bf9b8f97adef))
* **scripts:** decompose epic-plan-spec into phases/ ([#3011](https://github.com/dsj1984/mandrel/issues/3011)) ([1a00215](https://github.com/dsj1984/mandrel/commit/1a0021597343283cbb34adf26462fe9a8229b54a))
* **scripts:** decompose post-merge-pipeline into phases/ ([#3005](https://github.com/dsj1984/mandrel/issues/3005)) ([52f1f78](https://github.com/dsj1984/mandrel/commit/52f1f78104e206722ef8dfda3240338bb503a775))
* **scripts:** decompose retro-runner into phases/ ([#3008](https://github.com/dsj1984/mandrel/issues/3008)) ([0316a4d](https://github.com/dsj1984/mandrel/commit/0316a4dfcbc30f8300290962cf55cf301544654d))
* **scripts:** decompose single-story-close.js into phases/ (4/5) ([#3003](https://github.com/dsj1984/mandrel/issues/3003)) ([#3010](https://github.com/dsj1984/mandrel/issues/3010)) ([b93a95f](https://github.com/dsj1984/mandrel/commit/b93a95f062d4df4f3288c9398d19635ec1245ba9))
* **scripts:** migrate git-branch-lifecycle.js and git-branch-cleanup.js to the shared guard (resolves [#1102](https://github.com/dsj1984/mandrel/issues/1102)) ([d85a937](https://github.com/dsj1984/mandrel/commit/d85a93708b0cc35602823daa033a4b370b4f325f))
* **scripts:** route post-auth gh spawns through lib/gh-exec.js ([#3014](https://github.com/dsj1984/mandrel/issues/3014)) ([f511810](https://github.com/dsj1984/mandrel/commit/f511810abfc82cb5b8a2e791d21990d59e446417)), closes [#2990](https://github.com/dsj1984/mandrel/issues/2990)
* **scripts:** split config-gates-schema.js per-gate ([#3017](https://github.com/dsj1984/mandrel/issues/3017)) ([26dc20c](https://github.com/dsj1984/mandrel/commit/26dc20c5e97924b4cc946117d5ee9fa13fb9d699)), closes [#2987](https://github.com/dsj1984/mandrel/issues/2987)
* **scripts:** split git-cleanup phase-drivers into decide/execute pairs ([#3015](https://github.com/dsj1984/mandrel/issues/3015)) ([db24b7c](https://github.com/dsj1984/mandrel/commit/db24b7c20bf152b983d018d9ed704c3e6f61563a)), closes [#2994](https://github.com/dsj1984/mandrel/issues/2994)
* **scripts:** split runPreMergeValidation into summarizer + emitter ([#3013](https://github.com/dsj1984/mandrel/issues/3013)) ([5b8ce9a](https://github.com/dsj1984/mandrel/commit/5b8ce9a583fad184e9124820a9e245bf55415275)), closes [#2995](https://github.com/dsj1984/mandrel/issues/2995)
* **scripts:** table-drive renderNotable to drop CRAP 52.5 → &lt; 20 ([#3016](https://github.com/dsj1984/mandrel/issues/3016)) ([1c85190](https://github.com/dsj1984/mandrel/commit/1c85190319a0e90cdd08ba3ef1cd0c5d8961d66f)), closes [#2991](https://github.com/dsj1984/mandrel/issues/2991)
* **story-close:** move attribution wrapper into baseline-attribution-wiring module ([b626af4](https://github.com/dsj1984/mandrel/commit/b626af4532bf95eaeef8c2e8f73fbe5f22e413ff))
* **temp-paths:** nest per-story dirs under stories/ and fix divergent dispatch-state path ([#2941](https://github.com/dsj1984/mandrel/issues/2941)) ([2cb4043](https://github.com/dsj1984/mandrel/commit/2cb40431c5ed21aae86fb11196c0db43c99bf54f)), closes [#2940](https://github.com/dsj1984/mandrel/issues/2940)
* **tests:** extract seedorphans helper to satisfy test mi baseline (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([308a322](https://github.com/dsj1984/mandrel/commit/308a32236c514171282ab0432db462c16ddbfc1f))
* **ticket-decomposer:** bound force-close closepromises (cap=3) (resolves [#1105](https://github.com/dsj1984/mandrel/issues/1105)) ([4d623cc](https://github.com/dsj1984/mandrel/commit/4d623cc3e33ff71b54838eafad4ee231d5201ab5))
* **validation-evidence:** migrate to per-Epic temp tree ([1957d88](https://github.com/dsj1984/mandrel/commit/1957d889570dd97d528653614bf29d2e8e380113))
* **worktree:** replace issafetoremove heuristic with merge-base + merge-commit fallback (resolves [#1129](https://github.com/dsj1984/mandrel/issues/1129)) ([a633f6c](https://github.com/dsj1984/mandrel/commit/a633f6cd80d775d2b316deec434b75a2a497b2ec))


### Chores

* **release:** cap release-please at minor bumps ([#1929](https://github.com/dsj1984/mandrel/issues/1929)) ([d4ea2c8](https://github.com/dsj1984/mandrel/commit/d4ea2c8955a94958e0c96005183ab1252f5a8c09))

## [1.43.0](https://github.com/dsj1984/mandrel/compare/v1.42.0...v1.43.0) (2026-06-02)


### Added

* Epic [#3418](https://github.com/dsj1984/mandrel/issues/3418) ([#3434](https://github.com/dsj1984/mandrel/issues/3434)) ([c926255](https://github.com/dsj1984/mandrel/commit/c926255d04f7d769b2a2d5ac9fcbdb67b48ec6a1))


### Fixed

* **single-story:** gate confirm-merge noop on agent::done label not closed issue (refs [#3415](https://github.com/dsj1984/mandrel/issues/3415)) ([#3416](https://github.com/dsj1984/mandrel/issues/3416)) ([6ac471e](https://github.com/dsj1984/mandrel/commit/6ac471edd3da4869d3632a0f85e7edc199840835))
* **story-close:** filter format gate scope to formatter-eligible files (refs [#3410](https://github.com/dsj1984/mandrel/issues/3410)) ([#3411](https://github.com/dsj1984/mandrel/issues/3411)) ([f38f32c](https://github.com/dsj1984/mandrel/commit/f38f32cfc3da400b13648fd32ac5e7bc8fa271bf))

## [1.42.0](https://github.com/dsj1984/mandrel/compare/v1.41.0...v1.42.0) (2026-06-01)


### Fixed

* **story-close:** scope format gate to story diff (refs [#3407](https://github.com/dsj1984/mandrel/issues/3407)) ([#3408](https://github.com/dsj1984/mandrel/issues/3408)) ([25e671e](https://github.com/dsj1984/mandrel/commit/25e671eee24686bcf04d979afc780f647143711c))

## [1.41.0](https://github.com/dsj1984/mandrel/compare/v1.40.0...v1.41.0) (2026-05-31)


### Added

* **config:** implement .agentrc.local.json override layer (refs [#3388](https://github.com/dsj1984/mandrel/issues/3388)) ([#3405](https://github.com/dsj1984/mandrel/issues/3405)) ([f42e898](https://github.com/dsj1984/mandrel/commit/f42e898212b3c62bdd9de0e19ce7a876ff435839))


### Fixed

* **ci:** SHA-pin third-party GitHub Actions (refs [#3399](https://github.com/dsj1984/mandrel/issues/3399)) ([#3403](https://github.com/dsj1984/mandrel/issues/3403)) ([32a3744](https://github.com/dsj1984/mandrel/commit/32a374436718e97f91da274930d25120b81b0388))
* **close:** defer agent::done + issue-close to PR-merge in standalone story-close (refs [#3385](https://github.com/dsj1984/mandrel/issues/3385)) ([#3395](https://github.com/dsj1984/mandrel/issues/3395)) ([43dd1f4](https://github.com/dsj1984/mandrel/commit/43dd1f45c734b97c2c3cc647d55ab3e8c0e5d221))

## [1.40.0](https://github.com/dsj1984/mandrel/compare/v1.39.0...v1.40.0) (2026-05-30)


### Fixed

* **lifecycle:** stop epic.close.end cascading into branch reap (refs [#3367](https://github.com/dsj1984/mandrel/issues/3367)) ([#3381](https://github.com/dsj1984/mandrel/issues/3381)) ([9d21318](https://github.com/dsj1984/mandrel/commit/9d213186c6511a1a2128f472512f24271e05af46))

## [1.39.0](https://github.com/dsj1984/mandrel/compare/v1.38.0...v1.39.0) (2026-05-30)


### Added

* Epic [#3304](https://github.com/dsj1984/mandrel/issues/3304) ([#3379](https://github.com/dsj1984/mandrel/issues/3379)) ([850355e](https://github.com/dsj1984/mandrel/commit/850355e34392211d8dff2da3ad95f2c96ffbabbf))

## [1.38.0](https://github.com/dsj1984/mandrel/compare/v1.37.0...v1.38.0) (2026-05-29)


### Added

* Epic [#3316](https://github.com/dsj1984/mandrel/issues/3316) ([#3359](https://github.com/dsj1984/mandrel/issues/3359)) ([2ee5462](https://github.com/dsj1984/mandrel/commit/2ee546258dbb46483fbd201caaf5f1d91cd569df))
* **single-story-close:** add wrong-tree edit guard (refs [#3364](https://github.com/dsj1984/mandrel/issues/3364)) ([#3366](https://github.com/dsj1984/mandrel/issues/3366)) ([db07f38](https://github.com/dsj1984/mandrel/commit/db07f382863b7a80d19012dadb291b9f8666e22b))


### Fixed

* **audit:** isolate audit selector and acceptance reconciler per-epic (refs [#3362](https://github.com/dsj1984/mandrel/issues/3362)) ([#3365](https://github.com/dsj1984/mandrel/issues/3365)) ([8cd28e5](https://github.com/dsj1984/mandrel/commit/8cd28e5483078d289db59c2673ecddbddbb724bb))


### Changed

* **scripts:** address Epic [#3316](https://github.com/dsj1984/mandrel/issues/3316) audit follow-ups ([#3361](https://github.com/dsj1984/mandrel/issues/3361)) ([7728a60](https://github.com/dsj1984/mandrel/commit/7728a6049d9739ea48881bba108adee056e13f41))

## [1.37.0](https://github.com/dsj1984/mandrel/compare/v1.36.0...v1.37.0) (2026-05-29)


### Fixed

* **epic-plan:** overwrite context tickets in place on --force re-plan (refs [#3310](https://github.com/dsj1984/mandrel/issues/3310)) ([#3314](https://github.com/dsj1984/mandrel/issues/3314)) ([3c4c5b5](https://github.com/dsj1984/mandrel/commit/3c4c5b52641dd54de7cf571c33872d073bdf098c))

## [1.36.0](https://github.com/dsj1984/mandrel/compare/v1.35.0...v1.36.0) (2026-05-29)


### Added

* **qa-harness:** accept name-only personas for url-template seams (refs [#3306](https://github.com/dsj1984/mandrel/issues/3306)) ([#3309](https://github.com/dsj1984/mandrel/issues/3309)) ([6a96c07](https://github.com/dsj1984/mandrel/commit/6a96c07bc8a1789c2dcde54b9341b13ff3164d1d))


### Fixed

* **release:** version Epic merges and fix agents-update changelog source ([#3307](https://github.com/dsj1984/mandrel/issues/3307)) ([44ea136](https://github.com/dsj1984/mandrel/commit/44ea136aef07154f414150f2ee89c4d6f264382d))

## [1.35.0](https://github.com/dsj1984/mandrel/compare/v1.34.0...v1.35.0) (2026-05-29)


### Added

* **audit:** pilot dynamic-workflow orchestration for audit-clean-code with graceful degradation (refs [#3278](https://github.com/dsj1984/mandrel/issues/3278)) ([#3282](https://github.com/dsj1984/mandrel/issues/3282)) ([414ecd4](https://github.com/dsj1984/mandrel/commit/414ecd4dcdc13b8c46b535634d28cb1df35a87e4))
* **story-deliver:** add stories-wave-tick.js DAG/wave engine with unit tests (refs [#3233](https://github.com/dsj1984/mandrel/issues/3233)) ([#3243](https://github.com/dsj1984/mandrel/issues/3243)) ([72fba7e](https://github.com/dsj1984/mandrel/commit/72fba7e4c3ef89e6e97f410a0c922a8cd04565c5))
* **workflows:** create helpers/epic-deliver-story.md and repoint epic-deliver fan-out (refs [#3229](https://github.com/dsj1984/mandrel/issues/3229)) ([#3239](https://github.com/dsj1984/mandrel/issues/3239)) ([6173324](https://github.com/dsj1984/mandrel/commit/6173324d502126dbacff665ffa8479beeac94bba))


### Fixed

* **cascade:** enable parent-Feature cascade from single-story close path ([#3242](https://github.com/dsj1984/mandrel/issues/3242)) ([368bc1d](https://github.com/dsj1984/mandrel/commit/368bc1d9a8e5c8133be3c16c2ab385896971f3af))
* **review:** handle PathEntry objects in analyseChanges, suppress MI noise, fix lint errors ([#3248](https://github.com/dsj1984/mandrel/issues/3248)) ([972fe78](https://github.com/dsj1984/mandrel/commit/972fe783fac74b7040c992c68bec4695738c6086))
* **skill:** align decompose-author SKILL Story-body shape with validator + provider contract (refs [#3263](https://github.com/dsj1984/mandrel/issues/3263)) ([#3267](https://github.com/dsj1984/mandrel/issues/3267)) ([5b6a439](https://github.com/dsj1984/mandrel/commit/5b6a4390bec18621ad8a0e5e279f513d2b4dc070))
* **story-body:** serialize object bodies in createOp; parse string bodies in freshness + assumption gates (refs [#3302](https://github.com/dsj1984/mandrel/issues/3302)) ([#3303](https://github.com/dsj1984/mandrel/issues/3303)) ([69322ac](https://github.com/dsj1984/mandrel/commit/69322ac2ed772b7fb6281c0aa49c0087a6834fbb))

## [1.34.0](https://github.com/dsj1984/mandrel/compare/v1.33.0...v1.34.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* Mandrel v6.0.0 — ticket hierarchy is now Epic -> Feature -> Story (with inline acceptance/verify on the Story body). The planning.hierarchy config flag, type::task label, Task-tier scripts, and Task-aware lifecycle hooks have been deleted. Consumers re-pinning .agents/ to v6.0.0 MUST remove any local Task-tier artifacts as part of the upgrade.

### Epic

* 3078 ([#3164](https://github.com/dsj1984/mandrel/issues/3164)) ([206da29](https://github.com/dsj1984/mandrel/commit/206da297bdf60fdee976dbaae0858816c308c56a))


### Added

* **pre-push:** add STORY_CLOSE_RECOVERY scoped coverage-gate bypass (refs [#3162](https://github.com/dsj1984/mandrel/issues/3162)) ([#3171](https://github.com/dsj1984/mandrel/issues/3171)) ([62bbd2f](https://github.com/dsj1984/mandrel/commit/62bbd2f08954abe67af4a5912e97c30744f3cf41))


### Fixed

* **finalize:** strip [skip ci] markers from openOrLocatePr body (refs [#3165](https://github.com/dsj1984/mandrel/issues/3165)) ([#3176](https://github.com/dsj1984/mandrel/issues/3176)) ([0374a1d](https://github.com/dsj1984/mandrel/commit/0374a1dffa96dfacc1ef116d854009edc82d9710))
* **orchestration:** cap Auto-resolved-file trailer at 100 chars (refs [#3160](https://github.com/dsj1984/mandrel/issues/3160)) ([#3170](https://github.com/dsj1984/mandrel/issues/3170)) ([fbdf13d](https://github.com/dsj1984/mandrel/commit/fbdf13d8306ed3fbabac2afa0f6a0a8fc35ec51b))
* **spec-renderer:** omit tasks: [] for 3-tier Stories (refs [#3163](https://github.com/dsj1984/mandrel/issues/3163)) ([#3177](https://github.com/dsj1984/mandrel/issues/3177)) ([859fe4b](https://github.com/dsj1984/mandrel/commit/859fe4ba47050e2be98ee36e1c642dcaee0e4f87))

## [1.33.0](https://github.com/dsj1984/mandrel/compare/v1.32.0...v1.33.0) (2026-05-26)


### Fixed

* **baselines:** harden MI scorer against escomplex parse-fail phantoms ([#2998](https://github.com/dsj1984/mandrel/issues/2998)) ([8023458](https://github.com/dsj1984/mandrel/commit/8023458c597689020ba04e0b1c802fe3170407c3)), closes [#2996](https://github.com/dsj1984/mandrel/issues/2996)
* **cascade:** preserve orchestrator footer and walk native Sub-Issues parent (resolves [#2982](https://github.com/dsj1984/mandrel/issues/2982)) ([#2983](https://github.com/dsj1984/mandrel/issues/2983)) ([5b2b51d](https://github.com/dsj1984/mandrel/commit/5b2b51defb065e6066b46be43316e0a2dbd8cbf8))
* **epic-plan-decompose:** preserve acceptance::* and planning::* on Epic through reconciler ([#3052](https://github.com/dsj1984/mandrel/issues/3052)) ([0e96fac](https://github.com/dsj1984/mandrel/commit/0e96fac373b5414917485da1165be435f0c52197)), closes [#3050](https://github.com/dsj1984/mandrel/issues/3050)
* **tests:** inject noop notify in epic-execute-record-wave defaults ([#3007](https://github.com/dsj1984/mandrel/issues/3007)) ([8575489](https://github.com/dsj1984/mandrel/commit/85754894b9fbba5c64ad6860c2dea3d8df05e440)), closes [#3006](https://github.com/dsj1984/mandrel/issues/3006)


### Changed

* **scripts:** complete parseStandardCliArgs rollout + centralize parseRequired{Positive,NonNegative}Int ([#3012](https://github.com/dsj1984/mandrel/issues/3012)) ([b767d1a](https://github.com/dsj1984/mandrel/commit/b767d1a480dbc5d7202ff541abba4f5aec51780b)), closes [#2989](https://github.com/dsj1984/mandrel/issues/2989) [#2993](https://github.com/dsj1984/mandrel/issues/2993)
* **scripts:** decompose baseline-attribution into phases/ ([#3009](https://github.com/dsj1984/mandrel/issues/3009)) ([32695ff](https://github.com/dsj1984/mandrel/commit/32695ff9b33614bb191f19ac33c1bf9b8f97adef))
* **scripts:** decompose epic-plan-spec into phases/ ([#3011](https://github.com/dsj1984/mandrel/issues/3011)) ([1a00215](https://github.com/dsj1984/mandrel/commit/1a0021597343283cbb34adf26462fe9a8229b54a))
* **scripts:** decompose post-merge-pipeline into phases/ ([#3005](https://github.com/dsj1984/mandrel/issues/3005)) ([52f1f78](https://github.com/dsj1984/mandrel/commit/52f1f78104e206722ef8dfda3240338bb503a775))
* **scripts:** decompose retro-runner into phases/ ([#3008](https://github.com/dsj1984/mandrel/issues/3008)) ([0316a4d](https://github.com/dsj1984/mandrel/commit/0316a4dfcbc30f8300290962cf55cf301544654d))
* **scripts:** decompose single-story-close.js into phases/ (4/5) ([#3003](https://github.com/dsj1984/mandrel/issues/3003)) ([#3010](https://github.com/dsj1984/mandrel/issues/3010)) ([b93a95f](https://github.com/dsj1984/mandrel/commit/b93a95f062d4df4f3288c9398d19635ec1245ba9))
* **scripts:** route post-auth gh spawns through lib/gh-exec.js ([#3014](https://github.com/dsj1984/mandrel/issues/3014)) ([f511810](https://github.com/dsj1984/mandrel/commit/f511810abfc82cb5b8a2e791d21990d59e446417)), closes [#2990](https://github.com/dsj1984/mandrel/issues/2990)
* **scripts:** split config-gates-schema.js per-gate ([#3017](https://github.com/dsj1984/mandrel/issues/3017)) ([26dc20c](https://github.com/dsj1984/mandrel/commit/26dc20c5e97924b4cc946117d5ee9fa13fb9d699)), closes [#2987](https://github.com/dsj1984/mandrel/issues/2987)
* **scripts:** split git-cleanup phase-drivers into decide/execute pairs ([#3015](https://github.com/dsj1984/mandrel/issues/3015)) ([db24b7c](https://github.com/dsj1984/mandrel/commit/db24b7c20bf152b983d018d9ed704c3e6f61563a)), closes [#2994](https://github.com/dsj1984/mandrel/issues/2994)
* **scripts:** split runPreMergeValidation into summarizer + emitter ([#3013](https://github.com/dsj1984/mandrel/issues/3013)) ([5b8ce9a](https://github.com/dsj1984/mandrel/commit/5b8ce9a583fad184e9124820a9e245bf55415275)), closes [#2995](https://github.com/dsj1984/mandrel/issues/2995)
* **scripts:** table-drive renderNotable to drop CRAP 52.5 → &lt; 20 ([#3016](https://github.com/dsj1984/mandrel/issues/3016)) ([1c85190](https://github.com/dsj1984/mandrel/commit/1c85190319a0e90cdd08ba3ef1cd0c5d8961d66f)), closes [#2991](https://github.com/dsj1984/mandrel/issues/2991)

## [1.32.0](https://github.com/dsj1984/mandrel/compare/v1.31.0...v1.32.0) (2026-05-25)


### Fixed

* **workspace:** include .mcp.json in default bootstrap file set ([#2978](https://github.com/dsj1984/mandrel/issues/2978)) ([0cdd9bd](https://github.com/dsj1984/mandrel/commit/0cdd9bdfaace8954a377c3e371929ed9d7c512a2))

## [1.31.0](https://github.com/dsj1984/mandrel/compare/v1.30.0...v1.31.0) (2026-05-25)


### Added

* **planning:** decomposer cross-cutting rule covers registries + symbol fan-out ([#2974](https://github.com/dsj1984/mandrel/issues/2974)) ([5b3cb85](https://github.com/dsj1984/mandrel/commit/5b3cb852276653c82d1d84c084121f637d234842)), closes [#2962](https://github.com/dsj1984/mandrel/issues/2962)
* **tests:** add test-isolate diagnostic for pollution cascades ([#2976](https://github.com/dsj1984/mandrel/issues/2976)) ([420d4f5](https://github.com/dsj1984/mandrel/commit/420d4f54487bd452766abe2c3dc7273f872338bc)), closes [#2963](https://github.com/dsj1984/mandrel/issues/2963)


### Fixed

* **config:** getQuality reads wrong shape — operator coverage timeout never honored ([#2959](https://github.com/dsj1984/mandrel/issues/2959)) ([#2969](https://github.com/dsj1984/mandrel/issues/2969)) ([09409e6](https://github.com/dsj1984/mandrel/commit/09409e6e07646fdb6b98d79b0836e95a9427a584))
* **orchestration:** refuse PR creation against main when Story has Epic parent ([#2967](https://github.com/dsj1984/mandrel/issues/2967)) ([a5dcb0d](https://github.com/dsj1984/mandrel/commit/a5dcb0d155137caa995aedba53eff2882be541ae)), closes [#2960](https://github.com/dsj1984/mandrel/issues/2960)
* **story-close:** assert final label is agent::done before returning success ([#2961](https://github.com/dsj1984/mandrel/issues/2961)) ([#2968](https://github.com/dsj1984/mandrel/issues/2968)) ([e112131](https://github.com/dsj1984/mandrel/commit/e112131c774ea34334be5a7ec4f9618a20a29cad))
* **tests:** scrub NOTIFICATION_WEBHOOK_URL from test child env (resolves [#2975](https://github.com/dsj1984/mandrel/issues/2975)) ([#2977](https://github.com/dsj1984/mandrel/issues/2977)) ([da0ae04](https://github.com/dsj1984/mandrel/commit/da0ae044cff06885a0007343a912e1523bfb5d67))

## [1.30.0](https://github.com/dsj1984/mandrel/compare/v1.29.0...v1.30.0) (2026-05-23)


### Fixed

* **bdd-detect:** scan workspace package.json files in monorepos ([#2957](https://github.com/dsj1984/mandrel/issues/2957)) ([456326e](https://github.com/dsj1984/mandrel/commit/456326ee41da1a8443125665cf28592215877e67))


### Changed

* **manifest:** migrate helpers to canonical config pointers ([#2955](https://github.com/dsj1984/mandrel/issues/2955)) ([f9b3dac](https://github.com/dsj1984/mandrel/commit/f9b3dac0deea6c2c63cdc4bd4d7b3e0122210e7c)), closes [#2945](https://github.com/dsj1984/mandrel/issues/2945) [#2950](https://github.com/dsj1984/mandrel/issues/2950)
* **temp-paths:** nest per-story dirs under stories/ and fix divergent dispatch-state path ([#2941](https://github.com/dsj1984/mandrel/issues/2941)) ([2cb4043](https://github.com/dsj1984/mandrel/commit/2cb40431c5ed21aae86fb11196c0db43c99bf54f)), closes [#2940](https://github.com/dsj1984/mandrel/issues/2940)

## [1.29.0](https://github.com/dsj1984/mandrel/compare/v1.28.0...v1.29.0) (2026-05-22)


### Added

* **code-review:** add security-review and ultrareview providers via chain ([#2872](https://github.com/dsj1984/mandrel/issues/2872)) ([832b189](https://github.com/dsj1984/mandrel/commit/832b1892d735c1574dea77e3f536dd99475862c2)), closes [#2871](https://github.com/dsj1984/mandrel/issues/2871)
* **gh-exec:** default-timeout knob + transient classification for GhExecTimeoutError ([#2877](https://github.com/dsj1984/mandrel/issues/2877)) ([dad2b16](https://github.com/dsj1984/mandrel/commit/dad2b163695486bd5aa800ee40fb7d7112531ae5)), closes [#2860](https://github.com/dsj1984/mandrel/issues/2860)


### Fixed

* **observability:** support standalone stories with null epicId ([#2875](https://github.com/dsj1984/mandrel/issues/2875)) ([d20c51e](https://github.com/dsj1984/mandrel/commit/d20c51e49cc24914f21bffab6828025344f94aef)), closes [#2874](https://github.com/dsj1984/mandrel/issues/2874)
* **orchestration:** harden reassertStatusColumn with poll-and-retry ([#2878](https://github.com/dsj1984/mandrel/issues/2878)) ([8efcc28](https://github.com/dsj1984/mandrel/commit/8efcc28e1f4513cbf1dd008a91457f5d438955b1)), closes [#2876](https://github.com/dsj1984/mandrel/issues/2876)

## [1.28.0](https://github.com/dsj1984/mandrel/compare/v1.27.0...v1.28.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* **board:** collapse Status field to Todo/In Progress/Done ([#2868](https://github.com/dsj1984/mandrel/issues/2868))

### Added

* **board:** collapse Status field to Todo/In Progress/Done ([#2868](https://github.com/dsj1984/mandrel/issues/2868)) ([60e99a2](https://github.com/dsj1984/mandrel/commit/60e99a2b019698034e146e0e73c92ee3c68a08bf)), closes [#2867](https://github.com/dsj1984/mandrel/issues/2867)

## [1.27.0](https://github.com/dsj1984/mandrel/compare/v1.26.0...v1.27.0) (2026-05-21)


### Added

* retire prose-legacy hydration output mode ([#2864](https://github.com/dsj1984/mandrel/issues/2864)) ([#2865](https://github.com/dsj1984/mandrel/issues/2865)) ([5d514c9](https://github.com/dsj1984/mandrel/commit/5d514c9d9d1e148a9eab9d693988548f732434f2))

## [1.26.0](https://github.com/dsj1984/mandrel/compare/v1.25.0...v1.26.0) (2026-05-21)


### Added

* add lifecycle defaults + strip redundant config from .agentrc.json ([#2846](https://github.com/dsj1984/mandrel/issues/2846)) ([#2848](https://github.com/dsj1984/mandrel/issues/2848)) ([89a8b30](https://github.com/dsj1984/mandrel/commit/89a8b3063c5fd38583db31c1d08538fe7f0e79d4))
* **architecture:** cleanup shims, adapters, and enums (closes [#2646](https://github.com/dsj1984/mandrel/issues/2646)) ([#2712](https://github.com/dsj1984/mandrel/issues/2712)) ([8993bad](https://github.com/dsj1984/mandrel/commit/8993bad5085c02e39fce0fbd0dd6c440eba2e7c5))
* **audit-architecture:** add Automated Architecture Guardrails dimension ([#2734](https://github.com/dsj1984/mandrel/issues/2734)) ([184574d](https://github.com/dsj1984/mandrel/commit/184574d65bdaba1ebed54a68cda5d0cdee50d823)), closes [#2713](https://github.com/dsj1984/mandrel/issues/2713)
* **hooks:** rebalance pre-push to diff-scoped gates ([#2745](https://github.com/dsj1984/mandrel/issues/2745)) ([#2754](https://github.com/dsj1984/mandrel/issues/2754)) ([5f93eb0](https://github.com/dsj1984/mandrel/commit/5f93eb05bcf443bb5b8ce9d3fb5158cd379d6d25))
* **orchestration:** propagate ticket state upward on every transition ([#2677](https://github.com/dsj1984/mandrel/issues/2677)) ([29a036d](https://github.com/dsj1984/mandrel/commit/29a036deea739a0ec7abd39ba8e76dc2ebeb8d5b)), closes [#2676](https://github.com/dsj1984/mandrel/issues/2676)
* **orchestration:** record model attribution as structured comments on tasks + rollup ([#2814](https://github.com/dsj1984/mandrel/issues/2814)) ([3bbea99](https://github.com/dsj1984/mandrel/commit/3bbea99cf09260dd8d227d41b370db72226aa24a)), closes [#2813](https://github.com/dsj1984/mandrel/issues/2813)
* **providers:** retry transient gh-api reads + cap paginateRest pages ([#2857](https://github.com/dsj1984/mandrel/issues/2857)) ([b8a60e6](https://github.com/dsj1984/mandrel/commit/b8a60e6ba7db6e2129b28a7aa38ace3391fccafc)), closes [#2852](https://github.com/dsj1984/mandrel/issues/2852)
* skill library index + policy capsules (Epic [#2647](https://github.com/dsj1984/mandrel/issues/2647)) ([#2755](https://github.com/dsj1984/mandrel/issues/2755)) ([2e7f2b8](https://github.com/dsj1984/mandrel/commit/2e7f2b8d48ee147e2f4ad1f783eb29d8806088eb))


### Fixed

* **lifecycle:** allow epicId on epic.automerge.start payload ([#2856](https://github.com/dsj1984/mandrel/issues/2856)) ([c76b7ae](https://github.com/dsj1984/mandrel/commit/c76b7aec424ef5d6dddb9043ec2421b643dc24d5)), closes [#2855](https://github.com/dsj1984/mandrel/issues/2855)
* **lifecycle:** close-tail completeness — audit-results marker, epic.merge.* schemas, Phase 7 doc-truth ([#2710](https://github.com/dsj1984/mandrel/issues/2710)) ([41c4c84](https://github.com/dsj1984/mandrel/commit/41c4c84ec272f501f3d6e30df6ecb71a0d8357e1)), closes [#2681](https://github.com/dsj1984/mandrel/issues/2681)
* **lint-baseline:** honor agentrc override and run shim launchers via shell ([#2752](https://github.com/dsj1984/mandrel/issues/2752)) ([6c39c29](https://github.com/dsj1984/mandrel/commit/6c39c292433a67067f2cb5dee713658306f4cfcb)), closes [#2750](https://github.com/dsj1984/mandrel/issues/2750)
* **orchestration:** flip task labels at per-task start, not story-init ([#2779](https://github.com/dsj1984/mandrel/issues/2779)) ([a155549](https://github.com/dsj1984/mandrel/commit/a155549ccaff45134e5c3306c059f836af23fe9a))
* **orchestration:** own Projects v2 Status column — audit + post-merge re-sync ([#2847](https://github.com/dsj1984/mandrel/issues/2847)) ([acc277d](https://github.com/dsj1984/mandrel/commit/acc277da06d6c5971dd7295bf9808c0ad4be7247)), closes [#2845](https://github.com/dsj1984/mandrel/issues/2845)
* **single-story-deliver:** route label flips through transitionTicketState so Projects v2 Status syncs ([#2739](https://github.com/dsj1984/mandrel/issues/2739)) ([5f4e6e2](https://github.com/dsj1984/mandrel/commit/5f4e6e291f89f7f4353b6a72d57f173982b25c75)), closes [#2717](https://github.com/dsj1984/mandrel/issues/2717)
* **single-story:** fast-forward local main after deliver and at init ([#2753](https://github.com/dsj1984/mandrel/issues/2753)) ([80a5cea](https://github.com/dsj1984/mandrel/commit/80a5cea77dcc43968fc5e0a9be0e420ba5cc871f))
* **skills:** enforce manifest schema and dedupe SKILL walkers ([#2757](https://github.com/dsj1984/mandrel/issues/2757)) ([88b0098](https://github.com/dsj1984/mandrel/commit/88b0098aad447fc04739c5fe34fb1cf57bec1e89))


### Performance

* **retro:** parallelize Story comment fetches + level-order BFS ([#2859](https://github.com/dsj1984/mandrel/issues/2859)) ([66e45bc](https://github.com/dsj1984/mandrel/commit/66e45bcfd5f45cec2a8e7780ec006e580affa196)), closes [#2853](https://github.com/dsj1984/mandrel/issues/2853)
* **test:** trim slow integration-style suite setup ([#2744](https://github.com/dsj1984/mandrel/issues/2744)) ([#2751](https://github.com/dsj1984/mandrel/issues/2751)) ([3cfc316](https://github.com/dsj1984/mandrel/commit/3cfc316cd4b861570ed76bc67d8a76f5c1119555))


### Changed

* break down CRAP hotspots to ratchet crap floor below 340 ([#2850](https://github.com/dsj1984/mandrel/issues/2850)) ([#2858](https://github.com/dsj1984/mandrel/issues/2858)) ([d3e68c2](https://github.com/dsj1984/mandrel/commit/d3e68c22494a9cc4a4ef89c3ce9caeeea310fb59))

## [1.25.0](https://github.com/dsj1984/mandrel/compare/v1.24.0...v1.25.0) (2026-05-19)


### Added

* **epic-plan:** cross-reference ACs against existing BDD scenarios ([#2642](https://github.com/dsj1984/mandrel/issues/2642)) ([de68d65](https://github.com/dsj1984/mandrel/commit/de68d65e7c392f07fb5eeb9b207b061c5bea8f6d)), closes [#2637](https://github.com/dsj1984/mandrel/issues/2637)
* **epic-plan:** cross-validate Tech Spec against codebase in Phase 7 ([#2638](https://github.com/dsj1984/mandrel/issues/2638)) ([aec99d1](https://github.com/dsj1984/mandrel/commit/aec99d1ccb216104a216bf6386c39a2eb64ba3bd)), closes [#2635](https://github.com/dsj1984/mandrel/issues/2635)
* **epic-plan:** require explicit filesAssumption on Task paths ([#2639](https://github.com/dsj1984/mandrel/issues/2639)) ([fda76f2](https://github.com/dsj1984/mandrel/commit/fda76f2166f7096f31f92d3c45de2751b2fb92ec)), closes [#2636](https://github.com/dsj1984/mandrel/issues/2636)


### Fixed

* **column-sync:** look up project item by issue, not by paginated board scan ([#2633](https://github.com/dsj1984/mandrel/issues/2633)) ([bc6b6e4](https://github.com/dsj1984/mandrel/commit/bc6b6e4b2e1cf736cc65b6c67b022a3fa04146fa)), closes [#2632](https://github.com/dsj1984/mandrel/issues/2632)


### Changed

* **model-selection:** resolve daylight between schema, code, and docs ([#2630](https://github.com/dsj1984/mandrel/issues/2630)) ([d1f1eaf](https://github.com/dsj1984/mandrel/commit/d1f1eaff693528d1f8223f5ff555ea18c6494615)), closes [#2590](https://github.com/dsj1984/mandrel/issues/2590)

## [1.24.0](https://github.com/dsj1984/mandrel/compare/v1.23.0...v1.24.0) (2026-05-19)


### Added

* **close:** sync story/epic branch from base before PR open ([#2581](https://github.com/dsj1984/mandrel/issues/2581)) ([1026c86](https://github.com/dsj1984/mandrel/commit/1026c86759de7f1319c2d173773cb35fedbe4da6)), closes [#2580](https://github.com/dsj1984/mandrel/issues/2580)
* **workflows:** add /audit-to-stories — convert audit MD findings into actionable GitHub Stories ([#2583](https://github.com/dsj1984/mandrel/issues/2583)) ([#2585](https://github.com/dsj1984/mandrel/issues/2585)) ([e4ab422](https://github.com/dsj1984/mandrel/commit/e4ab4227c84b825f259b8682c95a285baafe08b3))

## [1.23.0](https://github.com/dsj1984/mandrel/compare/v1.22.0...v1.23.0) (2026-05-19)


### Added

* **column-sync:** wire Projects v2 Status sync into transitionTicketState (resolves [#2548](https://github.com/dsj1984/mandrel/issues/2548)) ([#2575](https://github.com/dsj1984/mandrel/issues/2575)) ([5457ca7](https://github.com/dsj1984/mandrel/commit/5457ca7c39a31d8c6d9a80091597364c893785cb))


### Fixed

* **baselines/writer:** project legacy prior rows through projectRow at writer entry ([#2578](https://github.com/dsj1984/mandrel/issues/2578)) ([a106457](https://github.com/dsj1984/mandrel/commit/a1064577334a0cc4a901500f7888dd18b9fb6e29)), closes [#2574](https://github.com/dsj1984/mandrel/issues/2574)
* **baselines:** ship refresh-service.js inside .agents/ bundle ([#2579](https://github.com/dsj1984/mandrel/issues/2579)) ([e27c109](https://github.com/dsj1984/mandrel/commit/e27c109597485301f9f7d6597c8e5e81b725c8a2)), closes [#2572](https://github.com/dsj1984/mandrel/issues/2572)
* **full-agentrc:** correct floor axis keys to match v2 envelopes ([#2577](https://github.com/dsj1984/mandrel/issues/2577)) ([bdb90d7](https://github.com/dsj1984/mandrel/commit/bdb90d781c3d4658fe6f720a208db328b5aa5a17)), closes [#2573](https://github.com/dsj1984/mandrel/issues/2573)

## [1.22.0](https://github.com/dsj1984/mandrel/compare/v1.21.0...v1.22.0) (2026-05-18)


### Fixed

* **git-cleanup:** correct merged-PR signal and guard DEP0190 stderr ([#2498](https://github.com/dsj1984/mandrel/issues/2498)) ([8fe3ea0](https://github.com/dsj1984/mandrel/commit/8fe3ea063ea2aa1c495731e1d3dabe94e5c51363))


### Changed

* **audit-suite:** centralize audit artifacts under {tempRoot}/audits ([#2452](https://github.com/dsj1984/mandrel/issues/2452)) ([1eff6c4](https://github.com/dsj1984/mandrel/commit/1eff6c48e1da0f8828016d30db8c4e8aaa3663cd)), closes [#2451](https://github.com/dsj1984/mandrel/issues/2451)

## [1.21.0](https://github.com/dsj1984/mandrel/compare/v1.20.0...v1.21.0) (2026-05-18)


### Fixed

* **git-cleanup:** split current-HEAD skip + add remote-only sweep ([#2446](https://github.com/dsj1984/mandrel/issues/2446)) ([8b63fee](https://github.com/dsj1984/mandrel/commit/8b63feed54b738e97492c00ae284b0db3148f9d1)), closes [#2445](https://github.com/dsj1984/mandrel/issues/2445)

## [1.20.0](https://github.com/dsj1984/mandrel/compare/v1.19.0...v1.20.0) (2026-05-18)


### Added

* **orchestration:** add BranchCleaner lifecycle listener for end-of-Epic branch reap ([#2402](https://github.com/dsj1984/mandrel/issues/2402)) ([b912e54](https://github.com/dsj1984/mandrel/commit/b912e54f5da1c2c8305af4ef0e6eead8f6050d7f)), closes [#2398](https://github.com/dsj1984/mandrel/issues/2398)

## [1.19.0](https://github.com/dsj1984/mandrel/compare/v1.18.0...v1.19.0) (2026-05-18)


### Added

* **epic-deliver:** surface cross-Story conflict findings in manifest and prepare-gate (resolves [#2297](https://github.com/dsj1984/mandrel/issues/2297)) ([#2305](https://github.com/dsj1984/mandrel/issues/2305)) ([e2a3288](https://github.com/dsj1984/mandrel/commit/e2a3288ef4a6d671d91a0a58627d29205fc92f18))
* **epic-plan:** add cross-Story path-conflict & implicit-dependency graph (resolves [#2296](https://github.com/dsj1984/mandrel/issues/2296)) ([#2302](https://github.com/dsj1984/mandrel/issues/2302)) ([20fe62c](https://github.com/dsj1984/mandrel/commit/20fe62c81f319f40ac17069e6cf5fd44df72ac04))
* **epic-plan:** decomposer prompt heuristic for shared config-file edits across Stories ([#2300](https://github.com/dsj1984/mandrel/issues/2300)) ([30dadc0](https://github.com/dsj1984/mandrel/commit/30dadc070124e45e5b56cf4295763fee1c28ed65)), closes [#2298](https://github.com/dsj1984/mandrel/issues/2298)
* **workflows:** add /single-story-plan for standalone Story drafting (resolves [#2293](https://github.com/dsj1984/mandrel/issues/2293)) ([#2295](https://github.com/dsj1984/mandrel/issues/2295)) ([7b9b3b7](https://github.com/dsj1984/mandrel/commit/7b9b3b7cd76d9d92dff9aa451c05fbc6b039199e))


### Fixed

* **retro:** align retro-runner with ITicketingProvider; add no-op guard; count manual interventions ([#2290](https://github.com/dsj1984/mandrel/issues/2290)) ([3815739](https://github.com/dsj1984/mandrel/commit/3815739f0cc707c8ea24606198edf55936de9357)), closes [#2289](https://github.com/dsj1984/mandrel/issues/2289)

## [1.18.0](https://github.com/dsj1984/mandrel/compare/v1.17.0...v1.18.0) (2026-05-17)


### Fixed

* **bootstrap:** sync-agentrc and quality-bootstrap contradict each other on default-key writes ([#2281](https://github.com/dsj1984/mandrel/issues/2281)) ([#2285](https://github.com/dsj1984/mandrel/issues/2285)) ([c6626f3](https://github.com/dsj1984/mandrel/commit/c6626f3723f1a772e90f3eb030402d0a4af6388f))
* **emit-context:** route Logger output to stderr to keep stdout pure JSON ([#2287](https://github.com/dsj1984/mandrel/issues/2287)) ([5622bd6](https://github.com/dsj1984/mandrel/commit/5622bd6cf63645778a8e108626e5176883ba6b44)), closes [#2278](https://github.com/dsj1984/mandrel/issues/2278)
* **epic-plan-decompose:** preserve Epic body through reconciler persist ([#2286](https://github.com/dsj1984/mandrel/issues/2286)) ([07e50e5](https://github.com/dsj1984/mandrel/commit/07e50e59e355040115c38586fdf5fdfba8e541c6)), closes [#2283](https://github.com/dsj1984/mandrel/issues/2283)


### Changed

* **epic-deliver:** drop close-as-approval gate for context::acceptance-spec ([#2280](https://github.com/dsj1984/mandrel/issues/2280)) ([328f4a5](https://github.com/dsj1984/mandrel/commit/328f4a539a4748a7b2b3aeb914899320d1ebb452))
* **epic-plan:** unify Epic canonical headings (Context/Goal/Non-Goals/Scope/AC) ([#2183](https://github.com/dsj1984/mandrel/issues/2183)) ([2abc8f3](https://github.com/dsj1984/mandrel/commit/2abc8f3ea5f245c2370595955b89b71946b00e2e))

## [1.17.0](https://github.com/dsj1984/mandrel/compare/v1.16.0...v1.17.0) (2026-05-17)


### Added

* **story-close:** bounded timeout for biome-format + baseline-refresh spawns ([#2165](https://github.com/dsj1984/mandrel/issues/2165)) ([#2180](https://github.com/dsj1984/mandrel/issues/2180)) ([01a61b3](https://github.com/dsj1984/mandrel/commit/01a61b32488ea6dc9031a5427a2029f56b67a043))


### Fixed

* **story-close:** enforce single baseline-refresh commit per close cycle (resolves [#2176](https://github.com/dsj1984/mandrel/issues/2176)) ([#2177](https://github.com/dsj1984/mandrel/issues/2177)) ([a900e4f](https://github.com/dsj1984/mandrel/commit/a900e4f0c8c5c598dbd831feca218636cecb49d5))

## [1.16.0](https://github.com/dsj1984/mandrel/compare/v1.15.0...v1.16.0) (2026-05-17)


### Changed

* rename /story-execute to /story-deliver (hard cutover) ([#2174](https://github.com/dsj1984/mandrel/issues/2174)) ([a40e385](https://github.com/dsj1984/mandrel/commit/a40e3854ee6bb3e3bf15f096a4186bd0df6c6822)), closes [#2171](https://github.com/dsj1984/mandrel/issues/2171)

## [1.15.0](https://github.com/dsj1984/mandrel/compare/v1.14.0...v1.15.0) (2026-05-17)


### Added

* **epic-deliver:** enforce code-review halted flag before retro phase (resolves [#2167](https://github.com/dsj1984/mandrel/issues/2167)) ([#2168](https://github.com/dsj1984/mandrel/issues/2168)) ([d41634c](https://github.com/dsj1984/mandrel/commit/d41634c606c540abfc0a06d49b8a3120c69c3197))

## [1.14.0](https://github.com/dsj1984/mandrel/compare/v1.13.0...v1.14.0) (2026-05-17)


### Added

* **epic-plan:** add Epic Clarity Gate (new Phase 6) and renumber phases to linear 1..11 ([#2128](https://github.com/dsj1984/mandrel/issues/2128)) ([#2163](https://github.com/dsj1984/mandrel/issues/2163)) ([f65a14f](https://github.com/dsj1984/mandrel/commit/f65a14f4fa954242011ccd7bbebd5ade2c981d12))

## [1.13.0](https://github.com/dsj1984/mandrel/compare/v1.12.0...v1.13.0) (2026-05-16)


### Fixed

* **quality:** inject framework-default floors in resolver; delete dead per-row machinery ([#2125](https://github.com/dsj1984/mandrel/issues/2125)) ([#2126](https://github.com/dsj1984/mandrel/issues/2126)) ([4c3d687](https://github.com/dsj1984/mandrel/commit/4c3d6875a7dd61eeb49888330f9711d29a91d1ea))

## [1.12.0](https://github.com/dsj1984/mandrel/compare/v1.11.0...v1.12.0) (2026-05-16)


### Added

* **bootstrap:** auto-accept inferred git defaults instead of prompting ([#2122](https://github.com/dsj1984/mandrel/issues/2122)) ([09b1413](https://github.com/dsj1984/mandrel/commit/09b1413d203a4c0f886da7a76bf0322895b598dc)), closes [#2121](https://github.com/dsj1984/mandrel/issues/2121)

## [1.11.0](https://github.com/dsj1984/mandrel/compare/v1.10.0...v1.11.0) (2026-05-16)


### Fixed

* **baselines:** maintainability/crap update writes worktree-relative paths instead of repo-relative ([#2079](https://github.com/dsj1984/mandrel/issues/2079)) ([#2080](https://github.com/dsj1984/mandrel/issues/2080)) ([b5f0f24](https://github.com/dsj1984/mandrel/commit/b5f0f245b0b306e984c617efa74b57eceaf2a817))

## [1.10.0](https://github.com/dsj1984/mandrel/compare/v1.9.0...v1.10.0) (2026-05-16)


### Added

* **bootstrap:** unified consumer setup script + README cleanup (hard cutover) ([#2075](https://github.com/dsj1984/mandrel/issues/2075)) ([8543677](https://github.com/dsj1984/mandrel/commit/854367748c68c5191fef99d849664f49329db63f)), closes [#2074](https://github.com/dsj1984/mandrel/issues/2074)

## [1.9.0](https://github.com/dsj1984/mandrel/compare/v1.8.0...v1.9.0) (2026-05-16)


### Fixed

* **epic-plan-decompose:** restore sub-issue link safety net + branch cleanup ([#2067](https://github.com/dsj1984/mandrel/issues/2067)) ([450b159](https://github.com/dsj1984/mandrel/commit/450b159b414cb87603668f3cac1747f6a460c1a7)), closes [#2063](https://github.com/dsj1984/mandrel/issues/2063)

## [1.8.0](https://github.com/dsj1984/mandrel/compare/v1.7.0...v1.8.0) (2026-05-16)


### Fixed

* **epic-plan:** route --emit-context drain logs to stderr ([#2055](https://github.com/dsj1984/mandrel/issues/2055)) ([#2066](https://github.com/dsj1984/mandrel/issues/2066)) ([295bd4b](https://github.com/dsj1984/mandrel/commit/295bd4b0fceb9e9b34c63c8678f7bc15ca02d8e2))
* **epic-spec-reconciler:** preserve type::* and risk::* labels on Epic persist ([#2064](https://github.com/dsj1984/mandrel/issues/2064)) ([c6aa08f](https://github.com/dsj1984/mandrel/commit/c6aa08f5824b749122317e237a59ebf164d9a01a)), closes [#2056](https://github.com/dsj1984/mandrel/issues/2056)

## [1.7.0](https://github.com/dsj1984/mandrel/compare/v1.6.0...v1.7.0) (2026-05-16)


### Fixed

* **bootstrap:** close consumer-side runtime-deps install gap ([#2057](https://github.com/dsj1984/mandrel/issues/2057)) ([#2061](https://github.com/dsj1984/mandrel/issues/2061)) ([4cfc564](https://github.com/dsj1984/mandrel/commit/4cfc564619626ca80e988a20440ea9ba2bdfa2b7))
* **tests:** stabilize shipped-baselines-idempotency round-trip ([#2017](https://github.com/dsj1984/mandrel/issues/2017)) ([#2026](https://github.com/dsj1984/mandrel/issues/2026)) ([4cc4075](https://github.com/dsj1984/mandrel/commit/4cc4075a906bbca4a1f866334372585586297df5))

## [1.6.0](https://github.com/dsj1984/mandrel/compare/v1.5.0...v1.6.0) (2026-05-16)


### Fixed

* **baselines:** classify new files as additions, not regressions (resolves [#2012](https://github.com/dsj1984/mandrel/issues/2012)) ([#2058](https://github.com/dsj1984/mandrel/issues/2058)) ([3bcb15a](https://github.com/dsj1984/mandrel/commit/3bcb15a8ff8fc36176b168330a173536b983eb06))

## [1.5.0](https://github.com/dsj1984/mandrel/compare/v1.4.0...v1.5.0) (2026-05-16)


### Fixed

* **bootstrap:** handle fresh-empty-repo bootstrap failure modes ([#2022](https://github.com/dsj1984/mandrel/issues/2022)) ([28ae5d4](https://github.com/dsj1984/mandrel/commit/28ae5d481ca9fb256e6b22bc9e515b2dcc74f5e5)), closes [#2018](https://github.com/dsj1984/mandrel/issues/2018)

## [1.4.0](https://github.com/dsj1984/mandrel/compare/v1.3.0...v1.4.0) (2026-05-16)


### Fixed

* switch the push-to-main path to set BASELINE_SCOPE=full instead. ([9b8b1a2](https://github.com/dsj1984/mandrel/commit/9b8b1a26e7465920bfd49c469f427b421ccea2e2))

## [1.3.0](https://github.com/dsj1984/mandrel/compare/v1.2.0...v1.3.0) (2026-05-16)


### Added

* **sweep:** protect active worktrees + add cross-session lock (resolves [#2011](https://github.com/dsj1984/mandrel/issues/2011)) ([#2013](https://github.com/dsj1984/mandrel/issues/2013)) ([67e6bd9](https://github.com/dsj1984/mandrel/commit/67e6bd9c84507368eb4d5c6659cdb9d9d2859f40))

## [1.2.0](https://github.com/dsj1984/mandrel/compare/v1.1.0...v1.2.0) (2026-05-16)


### Added

* **pr-watch:** auto-recover from BEHIND mergeStateStatus during PR watch loops ([#2009](https://github.com/dsj1984/mandrel/issues/2009)) ([fc013e8](https://github.com/dsj1984/mandrel/commit/fc013e81a1318fc9b0564b6bf0f3e4bc97ba4e4b))

## [1.1.0](https://github.com/dsj1984/mandrel/compare/v1.0.0...v1.1.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* **release:** footers or !-marked commits never auto-propose a major version. Major bumps now require explicit operator intervention via a Release-As: X.0.0 trailer or a manual edit on the release PR branch.

### Added

* **idea-refinement:** fold grill-me interrogation pattern into Phase 2 (resolves [#1926](https://github.com/dsj1984/mandrel/issues/1926)) ([#1932](https://github.com/dsj1984/mandrel/issues/1932)) ([987eb93](https://github.com/dsj1984/mandrel/commit/987eb93c78bb8a6529228932bcaca21af654ead2))


### Fixed

* **release:** use PAT so release-please PRs trigger CI ([#1933](https://github.com/dsj1984/mandrel/issues/1933)) ([4ee603f](https://github.com/dsj1984/mandrel/commit/4ee603f4317e92f3c75397bae28a3e8a3adb75c2))


### Chores

* **release:** cap release-please at minor bumps ([#1929](https://github.com/dsj1984/mandrel/issues/1929)) ([d4ea2c8](https://github.com/dsj1984/mandrel/commit/d4ea2c8955a94958e0c96005183ab1252f5a8c09))

## [1.0.0] — 2026-05-15

**Mandrel 1.0 — rebrand + clean slate.** The framework relaunches under the
**Mandrel** name with a fresh major-version line. The pre-rebrand version
history (v1.x – v5.41.x under the old name, plus the transitional `6.0.0`
cut-over tag) is preserved verbatim in
[`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md) and is **not
comparable** to entries under this line — file structure, package name,
and configuration shapes all changed at the rebrand boundary. New
adopters target the **`mandrel`** package / **`mandrel.git`** submodule
from this point forward.

### Added (dispatch hints & parallel tooling)

All optional unless used; untouched consumers behave as before.

- Workflow frontmatter: `recommendedModel` and `dispatchModel` (`haiku` |
  `sonnet` | `opus`) — dispatcher hints only, no required schema fields.
- Helper [**parallel-tooling**](../.agents/workflows/helpers/parallel-tooling.md) documenting fan-out tooling in one assistant turn.
- Skill **`audit-fan-out`** (opt-in `/audit-fan-out`).
- **`epic-perf-report`**: optional `dispatchModel` on `mostFrictionStories[]`
  items; omitted when absent. See PRD #1276 / Tech Spec #1277 /
  Stories #1326–#1329.

### Breaking changes (decomposition & manifest)

Hard cut — no aliases. Update `.agentrc.json` in lockstep; legacy shapes fail
schema validation.

- **Concurrency**: single **`orchestration/concurrency`** block (`decomposer`,
  `deliverRunner`, `waveGate`, `commitAssertion`, `progressReporter`).
  Removes **`runners.decomposer`**, **`runners.concurrency`**, and
  **`deliverRunner.concurrencyCap`**; use **`resolveConcurrency(orchestration)`**.

- **`sizingProfile`** on dispatch-manifest Tasks that exceed **`agentSettings/planning.taskSizing.softFileCount`** file threshold (profiles: **`mechanical-sweep`**, **`atomic-rewrite`**, **`scaffolding`**).

- **`agentSettings/planning.taskSizing`** — tunable **`maxAcceptance`** /
  **`maxChanges`** / **`softFileCount`** / **`softAcceptanceCount`** with
  structured oversized/missing-profile findings consumed by decomposition retry.

- **Dispatch markdown**: one nested Wave → Story → Task flow (TOC anchors,
  checkboxes, per‑wave decomposition notes, single footer `<details>`). Behavior
  is locked by **`tests/lib/presentation/manifest-formatter-end-to-end.test.js`**.

### Changed (Story #1922 — agentrc template rename + role split)

- **Renamed `.agents/min-agentrc.json` → `.agents/starter-agentrc.json`**. The
  bootstrap delta-seed consumers copy to `.agentrc.json` is now named for what
  it is: a *starter*, not the absolute minimum. Content unchanged from the
  pre-rename `min-agentrc.json`.
- **Renamed `.agents/default-agentrc.json` → `.agents/full-agentrc.json`** and
  expanded it to enumerate every schema key. The reference template now
  includes the three Epic #1720 gates (`mutation`, `lighthouse`,
  `bundleSize`) plus the two `worktreeIsolation` keys (`primeFromPath`,
  `allowSymlinkOnWindows`) the schema accepts. Values mirror the in-code
  framework defaults so the file documents reality, not aspiration. Story
  #1911 will lift the placeholder mutation / lighthouse / bundle-size
  floors to their high-bar values.
- **Trimmed the dogfood `.agentrc.json`** to minimum + delta. Dropped every
  key whose value matched a framework default (`planning.maxTickets`,
  `delivery.execution.timeoutMs`, `delivery.maxTokenBudget`,
  `delivery.deliverRunner.concurrencyCap`, all of `delivery.signals.*`,
  `delivery.quality.gateScoping`, the entire `lint` gate, and several
  inherited fields from `coverage` / `crap` / `maintainability`). The
  remaining keys are genuine project overrides — primarily the workspace
  floors, the symlink worktree strategy, and the `riskHeuristics` /
  `docsFreshness.paths` lists whose runtime fallback is empty.
- **Bootstrap workflow** ([agents-bootstrap-project.md §2.5](../.agents/workflows/agents-bootstrap-project.md))
  rewritten to seed from `starter-agentrc.json` with a refreshed
  "Why starter, not full?" callout explaining the delta-vs-copy rationale.

No schema changes. The static schema mirror, AJV runtime schemas, and the
runtime defaults in code (`LIMITS_DEFAULTS`, `*_GATE_DEFAULTS`,
`DEFAULT_DELIVER_RUNNER`, etc.) are untouched.

### Removed

- Epic #1235 hands-off CI automation: bot approver, auto-fix, triage-PR,
  baseline-refresh-guardrail workflows and implementations; **`agents-bootstrap-github`**
  no longer bundles workflow templates. Operator flow: Phase 7 in
  [`.agents/workflows/epic-deliver.md`](../.agents/workflows/epic-deliver.md). Ruleset **`14286998`**
  and secrets **`BOT_APPROVER_*`** must be reconciled manually; **`agent-protocols-reviewer`** app may go away.
- **Windows** runner removed from **`ci.yml`** / required checks due to flaky
  c8 drift (#1267); Windows remains covered locally via pre-push.

### Changed

- **Tasks** close at **commit-time**; Story stays **`agent::executing`** until merge
  (**`story-task-progress.js`**, **`cascade: false`** on close path).
- **Story resume** skips Tasks already **`agent::done`** with reachable **`commitSha`**.
- **`epic-complete` webhook** fires after **`gh pr create`** (**`epic-deliver-finalize.js`**).
- **Maintainability** gate default tolerance **0.001 → 0.5**, overridable via
  **`agentSettings/quality.maintainability.tolerance`** / **`CRAP_TOLERANCE`**.

---

Pre-rebrand history (the old-name v1.x–v5.41.x line and the 6.0.0 cut-over
tag) is preserved in [`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md).
