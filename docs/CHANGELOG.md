# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0](https://github.com/dsj1984/mandrel/compare/v1.0.0...v2.0.0) (2026-05-15)


### ⚠ BREAKING CHANGES

* **release:** 5.36.4 — remove sprintClose.runRetro back-compat shim

### Added

* --no-verify policy split + justification grep test (resolves [#872](https://github.com/dsj1984/mandrel/issues/872)) ([d06fbcb](https://github.com/dsj1984/mandrel/commit/d06fbcb461e5ec2b39be795e92ef34d90fc0b6c2))
* add cutover smoke tests for friction-comment + flat-temp absence (resolves [#1049](https://github.com/dsj1984/mandrel/issues/1049)) ([d3e825d](https://github.com/dsj1984/mandrel/commit/d3e825d5020747f1cb9a6f958cf43e6fd5e85f68))
* add four epic-execute support CLIs (resolves [#965](https://github.com/dsj1984/mandrel/issues/965)) ([a93e57c](https://github.com/dsj1984/mandrel/commit/a93e57c5ea2c267980a27c7ac16da3801717adad))
* add parseFencedJsonComment shared parser + sweep three regex callers (resolves [#954](https://github.com/dsj1984/mandrel/issues/954)) ([9bd5db2](https://github.com/dsj1984/mandrel/commit/9bd5db2b8282fbae8c5c5656aa2b7b3a5794b187))
* add PreToolUse / PostToolUse trace hook + env propagation (resolves [#1043](https://github.com/dsj1984/mandrel/issues/1043)) ([8b50fbe](https://github.com/dsj1984/mandrel/commit/8b50fbee2f602d08f7a913f028999dbc70becca1))
* add three story-execute support CLIs (prepare, task-progress, task-commit) (resolves [#967](https://github.com/dsj1984/mandrel/issues/967)) ([374dd0b](https://github.com/dsj1984/mandrel/commit/374dd0b19bbfa28f57171f2cf537c11ab2bce0b5))
* add two wave-execute support CLIs (resolves [#966](https://github.com/dsj1984/mandrel/issues/966)) ([739ff35](https://github.com/dsj1984/mandrel/commit/739ff35e9fe13e9bc3a948fb1842a6ee56b730dc))
* **agents-update:** reconcile consumer AGENTS.md + memories on bump (5.33.0) ([400f5a3](https://github.com/dsj1984/mandrel/commit/400f5a3caa20fe4ccc99e2846518f789d9b44d6d))
* **agents:** define wave-runner sub-agent type and probe nested agent dispatch (resolves [#1133](https://github.com/dsj1984/mandrel/issues/1133)) ([03227f9](https://github.com/dsj1984/mandrel/commit/03227f9ad3c21ef1a2fe559fe2b28287612c32f8))
* align template limits to runtime defaults + fix runners.epicRunner doc path (resolves [#1002](https://github.com/dsj1984/mandrel/issues/1002)) ([559ebc3](https://github.com/dsj1984/mandrel/commit/559ebc313e38cf3d1fa5d3e65ef9aece8ca566df))
* **analyze-execution:** implement analyze-execution.js with --story and --epic modes (resolves [#1135](https://github.com/dsj1984/mandrel/issues/1135)) ([73b5ee2](https://github.com/dsj1984/mandrel/commit/73b5ee23549b64b4ea02653ce50216efff8992d4))
* aPI rule-as-SSOT consolidation (resolves [#879](https://github.com/dsj1984/mandrel/issues/879)) ([22338d0](https://github.com/dsj1984/mandrel/commit/22338d093c0cb482c4a3926a2d2eefb8858601f5))
* atomic writes in `render-manifest.js` (resolves [#1090](https://github.com/dsj1984/mandrel/issues/1090)) ([dff4cbb](https://github.com/dsj1984/mandrel/commit/dff4cbb063392162d01fa207bab9f012bdf0d13b))
* audit orchestrator posts summaries + paths, not full prompt bodies (resolves [#837](https://github.com/dsj1984/mandrel/issues/837)) ([cf722d9](https://github.com/dsj1984/mandrel/commit/cf722d9d8f22a92ba44921af0a99d41106255124))
* **audit:** slim orchestrator comment to summary + paths (resolves [#855](https://github.com/dsj1984/mandrel/issues/855)) ([b40a957](https://github.com/dsj1984/mandrel/commit/b40a957c168781f6ba66627ed243b4f038389922))
* author /epic-execute skill (resolves [#914](https://github.com/dsj1984/mandrel/issues/914)) ([4730bfc](https://github.com/dsj1984/mandrel/commit/4730bfccb9e9bc11419191cd67d81cd1ad2a00c3))
* author /story-execute skill and task-execute.md helper (resolves [#915](https://github.com/dsj1984/mandrel/issues/915)) ([ec77be8](https://github.com/dsj1984/mandrel/commit/ec77be88db4ecdf13c9b34ecfa1de06893b23ccd))
* author /wave-execute skill with Agent-tool fan-out (resolves [#913](https://github.com/dsj1984/mandrel/issues/913)) ([e41a058](https://github.com/dsj1984/mandrel/commit/e41a058d6c28eb1654ef456d2c7f79700ee73ad1))
* author 5.31.1 CHANGELOG entry summarizing the refactor (resolves [#970](https://github.com/dsj1984/mandrel/issues/970)) ([acc2f10](https://github.com/dsj1984/mandrel/commit/acc2f1043a6cbfe62e944aff4676c58b25483ccc))
* backfill missing rollup exports + fix dispatch-manifest field-name inconsistency (resolves [#964](https://github.com/dsj1984/mandrel/issues/964)) ([cdd4cfb](https://github.com/dsj1984/mandrel/commit/cdd4cfbe8f5cf023052686754978e3d48be750d3))
* bound `cascadeCompletion` in `lib/orchestration/ticketing.js` (resolves [#1088](https://github.com/dsj1984/mandrel/issues/1088)) ([bfd6101](https://github.com/dsj1984/mandrel/commit/bfd6101905104e89ea36b6bffd5b224b898b1da8))
* bound fs fanout in `detect-merges.js` (resolves [#1086](https://github.com/dsj1984/mandrel/issues/1086)) ([505a257](https://github.com/dsj1984/mandrel/commit/505a257bfd1462b8d9ba5db0e93e59059b1bac77))
* bound GitHub mutations in force-close / cleanup paths (resolves [#1087](https://github.com/dsj1984/mandrel/issues/1087)) ([d2321c6](https://github.com/dsj1984/mandrel/commit/d2321c698ec6a9a9c80f9a356d02be5352853df4))
* bounded parallelism for serial API loops (resolves [#1089](https://github.com/dsj1984/mandrel/issues/1089)) ([60272b9](https://github.com/dsj1984/mandrel/commit/60272b919869082ab05e9b077d020eb9a493d050))
* bounded-concurrency ticket creation (resolves [#834](https://github.com/dsj1984/mandrel/issues/834)) ([6c4691f](https://github.com/dsj1984/mandrel/commit/6c4691fae271e54a82545a3d748463f0ae3d6c62))
* centralized temp-paths helper + JSON schemas (resolves [#1039](https://github.com/dsj1984/mandrel/issues/1039)) ([c7cf980](https://github.com/dsj1984/mandrel/commit/c7cf9800a26af71ea058d8ef86fb5b57710bfb5e))
* close schemas, add conditionals, mirror to AJV (resolves [#1000](https://github.com/dsj1984/mandrel/issues/1000)) ([237248d](https://github.com/dsj1984/mandrel/commit/237248d159f6f7bb0dd7ad3509917193c6c6d090))
* **close-validation:** add typecheck gate to DEFAULT_GATES ([2537d8b](https://github.com/dsj1984/mandrel/commit/2537d8bdf22417405fb7d4eb18d75317bab1896b))
* **close-validation:** create lib/baseline-loader.js with readbaselineatref helper (resolves [#1127](https://github.com/dsj1984/mandrel/issues/1127)) ([1d4480b](https://github.com/dsj1984/mandrel/commit/1d4480b228ded41b023701b43bc0bcd94dfac2b9))
* **close-validation:** run every close-validation gate with cwd=.worktrees/story-&lt;id&gt;/ (resolves [#1128](https://github.com/dsj1984/mandrel/issues/1128)) ([ad0e7b5](https://github.com/dsj1984/mandrel/commit/ad0e7b5854d87f4333f82527e22bc5177ab7612e))
* **close-validation:** wire baseline-loader into the maintainability and crap gates (resolves [#1130](https://github.com/dsj1984/mandrel/issues/1130)) ([b187cf8](https://github.com/dsj1984/mandrel/commit/b187cf808cea990eac1d7b0bbed5b028f8a8328a))
* **close-workflow:** per-file lint diff + sprint-review severity classification + bounded worktree force-remove (5.30.2) ([7f30077](https://github.com/dsj1984/mandrel/commit/7f3007738e4af48b874f08de2697416f08efa9ac))
* collapse the ProgressReporter dual constructor onto a flat options bag (resolves [#958](https://github.com/dsj1984/mandrel/issues/958)) ([ff7d791](https://github.com/dsj1984/mandrel/commit/ff7d7918ddeb932b05015dfc6698c4bc4253630a))
* **config:** add agentsettings.limits.signals defaults + signals_defaults export (resolves [#1070](https://github.com/dsj1984/mandrel/issues/1070)) ([b50c264](https://github.com/dsj1984/mandrel/commit/b50c264a1fe521766f14a584d858d0b4bdd98e97))
* **config:** add epicClose.runRetro alongside sprintClose.runRetro (resolves [#927](https://github.com/dsj1984/mandrel/issues/927)) ([ba45d58](https://github.com/dsj1984/mandrel/commit/ba45d58da3ad9a9eae2d4e302ec37183f3fd2c73))
* **config:** add getEpicClose shim with sprintClose deprecation warning (resolves [#928](https://github.com/dsj1984/mandrel/issues/928)) ([1981821](https://github.com/dsj1984/mandrel/commit/19818210ab74037cf23091c3e4a9bfe58ce057b3))
* **config:** add lib/config/temp-paths.js helper for per-epic artifact paths (resolves [#1051](https://github.com/dsj1984/mandrel/issues/1051)) ([5d9a138](https://github.com/dsj1984/mandrel/commit/5d9a13842bf4746d68ba7487d48892b87600d76c))
* convert Logger.fatal to throw inside runStoryClose + document the rule (resolves [#959](https://github.com/dsj1984/mandrel/issues/959)) ([c4d36a6](https://github.com/dsj1984/mandrel/commit/c4d36a6c4d7ea99ce903a27ba21bb1e0dbb05e3a))
* decompose run-audit-suite.js (MI=0.0) into lib/audit-suite/ helpers (resolves [#963](https://github.com/dsj1984/mandrel/issues/963)) ([7cd1b29](https://github.com/dsj1984/mandrel/commit/7cd1b294fa0aa1fd3e26344b6b0162608a411309))
* decomposer fails when a Task AC references a missing file in the Epic base branch (resolves [#1125](https://github.com/dsj1984/mandrel/issues/1125)) ([748a7fe](https://github.com/dsj1984/mandrel/commit/748a7fea7727d74d7fa85800d0f17b0a07101e68))
* **decomposer:** add validateacfreshness gate to ticket-validator + wire into decompose phase (resolves [#1138](https://github.com/dsj1984/mandrel/issues/1138)) ([2c5dea9](https://github.com/dsj1984/mandrel/commit/2c5dea960bdfc6d7b4950e676e0cf6ede1641860))
* **decomposer:** bounded-concurrency staged ticket creation (resolves [#851](https://github.com/dsj1984/mandrel/issues/851)) ([24c39af](https://github.com/dsj1984/mandrel/commit/24c39af4873dc84aa5b851d41c875d0d20cd676b))
* delete remote-trigger surface and trigger-only labels (resolves [#910](https://github.com/dsj1984/mandrel/issues/910)) ([686750e](https://github.com/dsj1984/mandrel/commit/686750ef3e1622d868e611374924e75412a11a84))
* deprecation register + error-handling enforcement tests (resolves [#877](https://github.com/dsj1984/mandrel/issues/877)) ([cd1e182](https://github.com/dsj1984/mandrel/commit/cd1e182a975cedbb726cbb9a1368b904d4d2f7e6))
* dispatcher CLI + branch-shape + Logger.fatal + legacy triage (resolves [#1006](https://github.com/dsj1984/mandrel/issues/1006)) ([23686c1](https://github.com/dsj1984/mandrel/commit/23686c13f74813d70012b1950af991b0e7f1dcf5))
* **docs:** add deprecation register seeded with known shims (resolves [#898](https://github.com/dsj1984/mandrel/issues/898)) ([8f0770a](https://github.com/dsj1984/mandrel/commit/8f0770a5cee698d4b8a9cbb1653bfbf209d723d2))
* **docs:** refresh README inventory + add freshness test (resolves [#888](https://github.com/dsj1984/mandrel/issues/888)) ([2a0b708](https://github.com/dsj1984/mandrel/commit/2a0b708442375b5b989da2f70818bab27760970b))
* drop deterministic-invariant manual checklist from sprint-plan (resolves [#838](https://github.com/dsj1984/mandrel/issues/838)) ([98514f9](https://github.com/dsj1984/mandrel/commit/98514f9382834c4fe52ba841bb421e3169a1e09b))
* **enforcement:** process.exit/Logger.fatal/runAsCli enforcement tests (resolves [#899](https://github.com/dsj1984/mandrel/issues/899)) ([220ed45](https://github.com/dsj1984/mandrel/commit/220ed459d5b5dd165b6dda57972fb0b8e51a3b16))
* **epic-close:** add phase 6 step that posts epic-perf-report before retro renders (resolves [#1066](https://github.com/dsj1984/mandrel/issues/1066)) ([f0ea300](https://github.com/dsj1984/mandrel/commit/f0ea300825c7f806757856b9a2c1413b0d6d6926))
* **epic-close:** wire analyze-execution into post-merge-pipeline and epic-close phase 6.0 (resolves [#1140](https://github.com/dsj1984/mandrel/issues/1140)) ([cfc37fa](https://github.com/dsj1984/mandrel/commit/cfc37facb0623ba487439d381f01131553af6a66))
* **epic-deliver:** conditional auto-merge gate + post-merge cleanup ([#1275](https://github.com/dsj1984/mandrel/issues/1275)) ([b949275](https://github.com/dsj1984/mandrel/commit/b949275e9687823fed802fd74c933e6da9af1882))
* **epic-execute:** add prepare + record-wave support CLIs ([b0a6bd9](https://github.com/dsj1984/mandrel/commit/b0a6bd9024afee1a2a048db334cf0c3b712a061a))
* **epic-execute:** add rollup + finalize support CLIs ([bdc8621](https://github.com/dsj1984/mandrel/commit/bdc862157a91037facb8d3846e3ba9659f2db5e9))
* **epic-execute:** rolling concurrency contract + richer manifest progress symbols ([841162d](https://github.com/dsj1984/mandrel/commit/841162d8ac47d9757d77c94daddfb638dac68f3e))
* **epic-runner:** add parseWaveRunProgressComment + upsertEpicRunProgress exports ([a1bc5a2](https://github.com/dsj1984/mandrel/commit/a1bc5a283d7ebafc149927887fb423e7deb4c369))
* **epic-runner:** emit per-wave dispatch plan in --dry-run for /epic-execute (resolves [#934](https://github.com/dsj1984/mandrel/issues/934)) ([325ca26](https://github.com/dsj1984/mandrel/commit/325ca266ea8e486fcaf602456725877f03437f17))
* **epic-runner:** implement story-run-progress structured-comment writer (resolves [#938](https://github.com/dsj1984/mandrel/issues/938)) ([4e06c65](https://github.com/dsj1984/mandrel/commit/4e06c65f50b5ccf51ddc5d641dd830d5f18f3fb3))
* **epic-runner:** wave-run-progress structured-comment writer (resolves [#936](https://github.com/dsj1984/mandrel/issues/936)) ([0e6c886](https://github.com/dsj1984/mandrel/commit/0e6c88656b228165403bf9b3e58cd51d114d1700))
* extract canonical branch-name safety guard (resolves [#1081](https://github.com/dsj1984/mandrel/issues/1081)) ([43f44a7](https://github.com/dsj1984/mandrel/commit/43f44a7ad65f88e62b341b7bc753c03462791f90))
* extract runEvidenceGate + runEpicCodeReview from CLI main() (resolves [#962](https://github.com/dsj1984/mandrel/issues/962)) ([8e83407](https://github.com/dsj1984/mandrel/commit/8e83407860567dc7e253d5dd0bd408329b7cabd6))
* extract three story-close modules (merge-runner, cleanup-reconciler, comment-bodies) (resolves [#955](https://github.com/dsj1984/mandrel/issues/955)) ([bf44b68](https://github.com/dsj1984/mandrel/commit/bf44b68df01d7731b7087806b99310af9234687c))
* fix dispatch-manifest.json + add AJV fixture drift test (resolves [#868](https://github.com/dsj1984/mandrel/issues/868)) ([2e0cfdd](https://github.com/dsj1984/mandrel/commit/2e0cfdd710343e9f6ebf133493e352384047b00d))
* **git-cleanup-branches:** prune stale tracking refs after remote delete ([#1714](https://github.com/dsj1984/mandrel/issues/1714)) ([ccf9490](https://github.com/dsj1984/mandrel/commit/ccf94901e671a04c3ad381ac4466781ed9a808e7))
* health monitor refresh cadence configurable (resolves [#836](https://github.com/dsj1984/mandrel/issues/836)) ([7f443ae](https://github.com/dsj1984/mandrel/commit/7f443ae545cde041717754ef6deb82b9f8bb51d0))
* **health-monitor:** cadence-aware refresh (resolves [#854](https://github.com/dsj1984/mandrel/issues/854)) ([a8d49e2](https://github.com/dsj1984/mandrel/commit/a8d49e2e98e341bc08302adc880f986c30e4844e))
* implement analyze-execution.js CLI core (resolves [#1045](https://github.com/dsj1984/mandrel/issues/1045)) ([99c42ac](https://github.com/dsj1984/mandrel/commit/99c42ac7c2fef18e2fcd104f988b7aa572a8ea5e))
* implement signals-writer module + unit tests (resolves [#1041](https://github.com/dsj1984/mandrel/issues/1041)) ([b92d5e4](https://github.com/dsj1984/mandrel/commit/b92d5e45eaadd5ff8edc1face804e286232b79a9))
* **instructions:** rewrite Sections 1.C, 1.D, 4.1, 6.A for v5.29 runtime (resolves [#881](https://github.com/dsj1984/mandrel/issues/881)) ([1ed4496](https://github.com/dsj1984/mandrel/commit/1ed449622d49117b968d8087b8f2654d5d6d3583))
* invert dependency direction in `lib/orchestration/index.js` (resolves [#1083](https://github.com/dsj1984/mandrel/issues/1083)) ([1425183](https://github.com/dsj1984/mandrel/commit/14251831eddf365f0408f95021a80d4864d7cb32))
* **labels:** purge agent::dispatching, agent::planning, agent::decomposing (resolves [#925](https://github.com/dsj1984/mandrel/issues/925)) ([6dbda84](https://github.com/dsj1984/mandrel/commit/6dbda847599fb0524e86933a7cfd9036366f1144))
* land canonical docs + slim the README + smoke-test downstream bootstrap (resolves [#1007](https://github.com/dsj1984/mandrel/issues/1007)) ([d48c944](https://github.com/dsj1984/mandrel/commit/d48c9445e2c654f9126cfcc724e67637f1646883))
* long-tail CRAP hotspots — 10 methods at CRAP 50-72 (follow-on to [#792](https://github.com/dsj1984/mandrel/issues/792)) (resolves [#816](https://github.com/dsj1984/mandrel/issues/816)) ([26fb9eb](https://github.com/dsj1984/mandrel/commit/26fb9eb19162312830328512f348590c01c5ea62))
* **manifest-persistence:** sweep legacy dispatch-manifest-&lt;id&gt;.{md,json} orphans on render (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([7c7daef](https://github.com/dsj1984/mandrel/commit/7c7daef19dc4469d6518036e10ecd8fe8bb61c4b))
* **manifest:** move Agent Operating Procedures & symbol reference to the top ([#1765](https://github.com/dsj1984/mandrel/issues/1765)) ([4754261](https://github.com/dsj1984/mandrel/commit/475426166e2cbf3eda4733010b120f096d94f859))
* **manifest:** trim dispatch manifest markdown for clean top-to-bottom flow ([#1344](https://github.com/dsj1984/mandrel/issues/1344)) ([1b5e051](https://github.com/dsj1984/mandrel/commit/1b5e0512fa5aab5c13c623af455231f2d20c1022))
* migrate all temp-path writers, readers, and workflow docs to per-Epic tree (resolves [#1040](https://github.com/dsj1984/mandrel/issues/1040)) ([10be30d](https://github.com/dsj1984/mandrel/commit/10be30ded8e4187080973caeb5081b9fe26e3b1a))
* migrate diagnose-friction to writer; delete friction-emitter cooldown (resolves [#1042](https://github.com/dsj1984/mandrel/issues/1042)) ([9c7a64d](https://github.com/dsj1984/mandrel/commit/9c7a64d342d6099c0f64744c03ee5aa4b323c35e))
* migrate worktree-manager tests + delete delegate methods + decisions.md entry (resolves [#960](https://github.com/dsj1984/mandrel/issues/960)) ([d2dc587](https://github.com/dsj1984/mandrel/commit/d2dc5879d75174a12fbafa009c859f7b23a157bc))
* move HTTP client under `providers/github/` (resolves [#1084](https://github.com/dsj1984/mandrel/issues/1084)) ([4b6861f](https://github.com/dsj1984/mandrel/commit/4b6861f9d9d2975e8031ac1ba239ebba07a6f5eb))
* notifications.minLevel applies to GitHub comments + batched task-start (resolves [#835](https://github.com/dsj1984/mandrel/issues/835)) ([fa08cae](https://github.com/dsj1984/mandrel/commit/fa08cae0431ffb030dd935bde57ae8ce3b2a0196))
* **notify:** curate webhook channel to epic-* event allowlist ([#1264](https://github.com/dsj1984/mandrel/issues/1264)) ([90bffe5](https://github.com/dsj1984/mandrel/commit/90bffe5ac518a632254d27593ccf25dbd3ae53ee))
* **observability:** add lib/observability/signals-writer.js with append/foreachline api (resolves [#1056](https://github.com/dsj1984/mandrel/issues/1056)) ([5c9016f](https://github.com/dsj1984/mandrel/commit/5c9016f96fee1cf185ed015fd56eab211cd00ae6))
* **observability:** add lib/observability/tool-trace-hook.js with pre/post entry points (resolves [#1058](https://github.com/dsj1984/mandrel/issues/1058)) ([233f8dc](https://github.com/dsj1984/mandrel/commit/233f8dcf1d4f07300252630c4dffa7fea4994e48))
* **observability:** wire trace hook into .claude/settings.json + propagate env vars from story-init (resolves [#1061](https://github.com/dsj1984/mandrel/issues/1061)) ([91d7b57](https://github.com/dsj1984/mandrel/commit/91d7b579fc1ad9883e6dc3c526324eb0c9e60a7c))
* **orchestration:** close Tasks at commit-time; defer epic-complete to PR-ready ([f0b3d7a](https://github.com/dsj1984/mandrel/commit/f0b3d7a48c45e2dbc5e554b947750bdbb4dee26a))
* **orchestration:** delete pool-claim.js and lib/pool-mode.js (resolves [#924](https://github.com/dsj1984/mandrel/issues/924)) ([48b1e19](https://github.com/dsj1984/mandrel/commit/48b1e191bf5a749ccbc60e413d91c3b2f16e192e))
* **orchestration:** remove heldForApproval from dispatch manifest (resolves [#884](https://github.com/dsj1984/mandrel/issues/884)) ([b6a9d11](https://github.com/dsj1984/mandrel/commit/b6a9d115f8ef4f48ba89d7a6457ed7426ad2d226))
* **orchestration:** remove in-progress-by claim readers and writers (resolves [#926](https://github.com/dsj1984/mandrel/issues/926)) ([5e92173](https://github.com/dsj1984/mandrel/commit/5e921738c1cd5cb04e01b476402dc5b94fb3f872))
* **perf:** parallelise calculateAll and scanAndScore via worker pool ([036a5c4](https://github.com/dsj1984/mandrel/commit/036a5c4c06cae31e3a089529c03cd125c14a2a2f))
* persona scrub: align with GitHub-tickets-as-system-of-record (resolves [#870](https://github.com/dsj1984/mandrel/issues/870)) ([817ff7f](https://github.com/dsj1984/mandrel/commit/817ff7f34072ecc05518a8c4864da228df27a07b))
* planning-context budget + summary mode (resolves [#832](https://github.com/dsj1984/mandrel/issues/832)) ([2cf45de](https://github.com/dsj1984/mandrel/commit/2cf45dead32aed3f244ecf69ac178fc14c854f72))
* **post-merge:** replace phase-timings comment phase with analyzer perf-summary invocation (resolves [#1064](https://github.com/dsj1984/mandrel/issues/1064)) ([71c291b](https://github.com/dsj1984/mandrel/commit/71c291babb78ab8a24d6563729e9181d7a611460))
* probe + commit a custom wave-runner sub-agent type (resolves [#1122](https://github.com/dsj1984/mandrel/issues/1122)) ([5c49c6c](https://github.com/dsj1984/mandrel/commit/5c49c6c73744182b2223f93c3d50902569d7afaa))
* promote primeTicketCache to a default no-op on ITicketingProvider (resolves [#957](https://github.com/dsj1984/mandrel/issues/957)) ([ba73c0e](https://github.com/dsj1984/mandrel/commit/ba73c0eb4577ae83e4546b0ab71baf6017ebb769))
* rEADME VERSION + rule-count freshness check (resolves [#873](https://github.com/dsj1984/mandrel/issues/873)) ([c15aae5](https://github.com/dsj1984/mandrel/commit/c15aae5b6cf352e5efe787ee5b84a12c2d4b1a34))
* refactor epic-runner for in-session Agent-tool dispatch (resolves [#908](https://github.com/dsj1984/mandrel/issues/908)) ([4342176](https://github.com/dsj1984/mandrel/commit/4342176c8d82590c93c37e0f943048a474e690f0))
* refresh CRAP + maintainability baselines atomically with the refactor bundle (resolves [#969](https://github.com/dsj1984/mandrel/issues/969)) ([5fa4a08](https://github.com/dsj1984/mandrel/commit/5fa4a084dc462f375b15b1a5d6a060b242157ecd))
* **release:** 5.29.0 — TypeScript support for maintainability + CRAP gates ([4c7e72a](https://github.com/dsj1984/mandrel/commit/4c7e72a91b2b86758d21da047ec78277a74bdc71))
* **release:** 5.36.4 — remove sprintClose.runRetro back-compat shim ([8b5c0ab](https://github.com/dsj1984/mandrel/commit/8b5c0ab7c7d8b4ce4a161484251179765d89a29b))
* **release:** selectable formatter + lighthouse-baseline skill, 5.36.0 ([686c424](https://github.com/dsj1984/mandrel/commit/686c4248317fe3f3b627c0e1c9603f9425fb7a70))
* **remote-trigger:** delete epic-orchestrator workflow and remote-bootstrap (resolves [#923](https://github.com/dsj1984/mandrel/issues/923)) ([0e46637](https://github.com/dsj1984/mandrel/commit/0e46637eb7d3ab40e9acf4b06890d17e5745c89a))
* rename /sprint-plan and /sprint-close, delete /sprint-execute and the routing CLI (resolves [#916](https://github.com/dsj1984/mandrel/issues/916)) ([d1c053e](https://github.com/dsj1984/mandrel/commit/d1c053e8db967dfb93574558f409e14950f5135f))
* rename agentSettings.sprintClose.runRetro with one-release shim (resolves [#911](https://github.com/dsj1984/mandrel/issues/911)) ([0c51019](https://github.com/dsj1984/mandrel/commit/0c510194a6920f3188710d409d195e6064f7220a))
* rename top-level sprint-*.js scripts and helper .md files in lockstep (resolves [#912](https://github.com/dsj1984/mandrel/issues/912)) ([84d82b4](https://github.com/dsj1984/mandrel/commit/84d82b40e61ffc65e59f75d075462e2665cfd0bd))
* replace WorktreeManager.isSafeToRemove heuristic with git merge-base --is-ancestor (resolves [#1121](https://github.com/dsj1984/mandrel/issues/1121)) ([6acf52f](https://github.com/dsj1984/mandrel/commit/6acf52f286b55c3716d261522faccb4048d4cf89))
* retire pool mode and the in-progress-by claim scheme (resolves [#909](https://github.com/dsj1984/mandrel/issues/909)) ([07ee0c9](https://github.com/dsj1984/mandrel/commit/07ee0c94bbcc4d9f381081655b7b7e6dfdd7768f))
* **retro:** read story-perf-summary + epic-perf-report comments + mirror retro to temp/ (resolves [#1067](https://github.com/dsj1984/mandrel/issues/1067)) ([ee16c81](https://github.com/dsj1984/mandrel/commit/ee16c81cd0409b7e56e454ac72e4485533cadad3))
* **retro:** switch hitl metric to agent::blocked events + 5.30.0 cutover (resolves [#887](https://github.com/dsj1984/mandrel/issues/887)) ([93a74f6](https://github.com/dsj1984/mandrel/commit/93a74f612919da70ae609003f2a16c547ba05aee))
* rewrite .agents/instructions.md for the v5.29 runtime (resolves [#869](https://github.com/dsj1984/mandrel/issues/869)) ([e6e7a7b](https://github.com/dsj1984/mandrel/commit/e6e7a7be15fd863d0083a65de4d86977981bd5a5))
* rewrite four execution-skill MDs onto the new CLI surface + add no-js-fences test (resolves [#968](https://github.com/dsj1984/mandrel/issues/968)) ([421672b](https://github.com/dsj1984/mandrel/commit/421672b53f5be03431c88631e259d6fdf9eb5b45))
* risk/HITL semantics + 5.30.0 metric migration (resolves [#871](https://github.com/dsj1984/mandrel/issues/871)) ([fc737ce](https://github.com/dsj1984/mandrel/commit/fc737ce2d4d01bc728dfba1da2dcb8a3a0b3e585))
* **rules:** promote api-conventions.md to SSOT for envelope, status codes, validation (resolves [#891](https://github.com/dsj1984/mandrel/issues/891)) ([5f65e5e](https://github.com/dsj1984/mandrel/commit/5f65e5e397642c07368f256d1861224ba659935d))
* run close-validation gates inside the worktree, read baselines from epic ref (resolves [#1120](https://github.com/dsj1984/mandrel/issues/1120)) ([fdc838b](https://github.com/dsj1984/mandrel/commit/fdc838b2f72cd6665c06a60513861d4071725d67))
* **schemas:** add storyTitle/agentTelemetry/type to dispatch-manifest, open-root + ADR (resolves [#883](https://github.com/dsj1984/mandrel/issues/883)) ([ae35ff2](https://github.com/dsj1984/mandrel/commit/ae35ff2ef593b36acf5eccd92078dd01c8ef5d98))
* **schemas:** close audit-results / friction-event / agentrc root with additionalproperties:false (resolves [#1009](https://github.com/dsj1984/mandrel/issues/1009)) ([24feeb2](https://github.com/dsj1984/mandrel/commit/24feeb2e599028bbc0d449c20ffbd6c098c485d7))
* **schemas:** healthrefresh cadence conditionals + closed gatename enum + drop empty mode (resolves [#1010](https://github.com/dsj1984/mandrel/issues/1010)) ([7a46fa2](https://github.com/dsj1984/mandrel/commit/7a46fa2b5e35f42b7ff0a85dbad2a866db57feac))
* **schemas:** mirror healthrefresh cadence conditionals into runtime ajv (resolves [#1013](https://github.com/dsj1984/mandrel/issues/1013)) ([608a63f](https://github.com/dsj1984/mandrel/commit/608a63f29ddd261fc23b0c972c0fb42c7b8da0c8))
* **schemas:** publish signal-event, story-perf-summary, epic-perf-report schemas + agentrc signals block (resolves [#1050](https://github.com/dsj1984/mandrel/issues/1050)) ([14ddd9e](https://github.com/dsj1984/mandrel/commit/14ddd9e1041e4d9dccae74018b0a8ac39da53aff))
* **scripts:** create lib/branch-name-guard.js with the union of both existing guards (resolves [#1099](https://github.com/dsj1984/mandrel/issues/1099)) ([5f6c9d3](https://github.com/dsj1984/mandrel/commit/5f6c9d35c0ca228546a9251e5d9ce90c90114694))
* security + testing rule-as-SSOT consolidation (resolves [#878](https://github.com/dsj1984/mandrel/issues/878)) ([aad7c9c](https://github.com/dsj1984/mandrel/commit/aad7c9cd6fd1e76a7a092c5600820fc2d701615c))
* **security:** rule-as-SSOT for security-baseline.md + slim hardening skill (resolves [#892](https://github.com/dsj1984/mandrel/issues/892)) ([8786f9e](https://github.com/dsj1984/mandrel/commit/8786f9ef4140f098b31487a98db661bf2b15fae5))
* ship analyze-execution.js with --story and --epic modes (resolves [#1123](https://github.com/dsj1984/mandrel/issues/1123)) ([e86b711](https://github.com/dsj1984/mandrel/commit/e86b7110fb2fc60c523be7cada7d25e232c0b7e0))
* **single-story-execute:** standalone Story workflow (no parent Epic) ([#1475](https://github.com/dsj1984/mandrel/issues/1475)) ([4f56c49](https://github.com/dsj1984/mandrel/commit/4f56c495d1ec0f86a7807d31a73f09b8d564ae85))
* **single-story:** enable auto-merge by default; expose prNumber ([be81e11](https://github.com/dsj1984/mandrel/commit/be81e11ac974b2e8b055755fa6cce31024fc728e))
* skill frontmatter Phase 1: name + description (+ vendor for stack) (resolves [#875](https://github.com/dsj1984/mandrel/issues/875)) ([6e5cb29](https://github.com/dsj1984/mandrel/commit/6e5cb298ff0204c0b4f8b64f951040e4c69cbfeb))
* **skills:** add name + description (+ vendor for stack) frontmatter to all stack SKILL.md files (resolves [#896](https://github.com/dsj1984/mandrel/issues/896)) ([6cac987](https://github.com/dsj1984/mandrel/commit/6cac987ec16b6561ed5a0f1a1c1abfba381455f2))
* **skills:** author /epic-execute skill body and frontmatter (resolves [#930](https://github.com/dsj1984/mandrel/issues/930)) ([eae2826](https://github.com/dsj1984/mandrel/commit/eae2826e0825e7a6bc614884593c0524619069da))
* **skills:** move long stack-specific snippets out of hot SKILL.md files (resolves [#895](https://github.com/dsj1984/mandrel/issues/895)) ([6c33ef1](https://github.com/dsj1984/mandrel/commit/6c33ef1d626227b1295c2521179df1c601988a80))
* **skills:** slim api-and-interface-design SKILL.md to process + links (resolves [#893](https://github.com/dsj1984/mandrel/issues/893)) ([09fddc4](https://github.com/dsj1984/mandrel/commit/09fddc4bd4ee4574ecb9c1f688e0a4ad69de997d))
* slim hot SKILL.md files + soften examples/ probe wording (resolves [#876](https://github.com/dsj1984/mandrel/issues/876)) ([313fc8c](https://github.com/dsj1984/mandrel/commit/313fc8cf512d9cf12280c5bdb01014b08b18343c))
* **sprint-plan:** drop deterministic-invariant manual checklist (resolves [#856](https://github.com/dsj1984/mandrel/issues/856)) ([b3fefbe](https://github.com/dsj1984/mandrel/commit/b3fefbed406f85ff2bf4dffb3b49a95663189f2d))
* sprint-story-init.js surfaces dependenciesInstalled explicitly (resolves [#831](https://github.com/dsj1984/mandrel/issues/831)) ([40168f4](https://github.com/dsj1984/mandrel/commit/40168f440085851f9ad5aa6cad3ba46347e136f5))
* story-close attributes baseline refreshes to the Story whose diff caused them (resolves [#1124](https://github.com/dsj1984/mandrel/issues/1124)) ([1390ffa](https://github.com/dsj1984/mandrel/commit/1390ffa3217cc4506f4d89efa521a171de68312e))
* **story-close:** classify baseline regressions as attributable vs non-attributable per story diff (resolves [#1132](https://github.com/dsj1984/mandrel/issues/1132)) ([627459a](https://github.com/dsj1984/mandrel/commit/627459ac2181c81a1e035462325f8ccc6cbda2af))
* **story-close:** wire attribution classifier and friction posting into story-close (resolves [#1134](https://github.com/dsj1984/mandrel/issues/1134)) ([88115d1](https://github.com/dsj1984/mandrel/commit/88115d19c54bb5a5139a38751f0e7dbe23cf7d33))
* **story-execute:** add story-execute-prepare + story-task-progress + task-commit clis (resolves [#987](https://github.com/dsj1984/mandrel/issues/987)) ([4bf891c](https://github.com/dsj1984/mandrel/commit/4bf891c090f60f9068f3a263ffe0d940603e23dc))
* strip model_tier from source: resolver, manifest, formatter, validator, decomposer prompt (resolves [#1004](https://github.com/dsj1984/mandrel/issues/1004)) ([76e9050](https://github.com/dsj1984/mandrel/commit/76e905018dfd3edbb3052eeeb06943609c6fd9cd))
* structured agent-executable task bodies + retrofit utility (5.33.0) ([ecaad00](https://github.com/dsj1984/mandrel/commit/ecaad001c38f72c34547f87bca84fb843ccd72ab))
* sweep adjacent workflows, instructions, personas, SDLC, and add drift grep test (resolves [#917](https://github.com/dsj1984/mandrel/issues/917)) ([5b40493](https://github.com/dsj1984/mandrel/commit/5b40493c08b379629798cda3143852df47f85c83))
* sweep dispatch-manifest-&lt;id&gt;.{md,json} orphans on each manifest render (resolves [#1126](https://github.com/dsj1984/mandrel/issues/1126)) ([1dbe62e](https://github.com/dsj1984/mandrel/commit/1dbe62ef4774b5091f6c9aa3864e8d7164d8a933))
* **testing:** rule-as-SSOT cross-refs from TDD skill to testing-standards (resolves [#894](https://github.com/dsj1984/mandrel/issues/894)) ([29d262f](https://github.com/dsj1984/mandrel/commit/29d262fb2b0f0454692705091409d6cf8a53638d))
* tighten instructions, skills, workflow doc, templates (resolves [#1003](https://github.com/dsj1984/mandrel/issues/1003)) ([e34b772](https://github.com/dsj1984/mandrel/commit/e34b772fb4c7f1a6a961ee4c9de65f681a67f39c))
* triage 45 unused exports across .agents/scripts/ (resolves [#961](https://github.com/dsj1984/mandrel/issues/961)) ([a68f65b](https://github.com/dsj1984/mandrel/commit/a68f65ba26ceac74421b2aa4877cc8db92cfc74a))
* trim story-close.js to a ≤200-line CLI shell (resolves [#956](https://github.com/dsj1984/mandrel/issues/956)) ([7f246a1](https://github.com/dsj1984/mandrel/commit/7f246a110d701887495a400b152b272d792939f6))
* update root README, CHANGELOG migration block, and decisions.md (resolves [#918](https://github.com/dsj1984/mandrel/issues/918)) ([74256eb](https://github.com/dsj1984/mandrel/commit/74256eb75091f93f9f85e9444641e54299fccb36))
* update tests, baselines, docs, CHANGELOG for model_tier removal (resolves [#1005](https://github.com/dsj1984/mandrel/issues/1005)) ([ff9c9c6](https://github.com/dsj1984/mandrel/commit/ff9c9c6793b69a27e2f8dcc6c6db7e3354f492e9))
* validation evidence keyed by commit SHA (resolves [#830](https://github.com/dsj1984/mandrel/issues/830)) ([feccbbe](https://github.com/dsj1984/mandrel/commit/feccbbec5a5ed92abbfe9645d04a86b6ce4b9fb8))
* **validation-evidence:** add commit-SHA-keyed evidence library (resolves [#845](https://github.com/dsj1984/mandrel/issues/845)) ([8813031](https://github.com/dsj1984/mandrel/commit/8813031556cd52fcdd3f7da5b0c9d99d05d4dc4e))
* **validation-evidence:** wire evidence skip across the local hot path (resolves [#846](https://github.com/dsj1984/mandrel/issues/846)) ([e102731](https://github.com/dsj1984/mandrel/commit/e102731131925b3d0045429b637cb313251ad31d))
* **wave-execute:** add wave-prepare.js + wave-record.js CLIs ([a93a4b4](https://github.com/dsj1984/mandrel/commit/a93a4b40b6f197dae00856f8bd693f6e7ca6e61e))
* **wave-execute:** route wave/epic dispatch through subagent_type: wave-runner (resolves [#1137](https://github.com/dsj1984/mandrel/issues/1137)) ([f34b0de](https://github.com/dsj1984/mandrel/commit/f34b0deda490757b07323909d9b33582af0e5112))
* **wave-runner:** extract wave loop into lib/wave-runner/tick.js + thin CLI ([#1477](https://github.com/dsj1984/mandrel/issues/1477)) ([a236fd2](https://github.com/dsj1984/mandrel/commit/a236fd2a421147ccad0f594255ccf2daf512d3eb))
* wire story-perf-summary into post-merge pipeline; epic-perf-report into Epic close + retro (resolves [#1046](https://github.com/dsj1984/mandrel/issues/1046)) ([70626b7](https://github.com/dsj1984/mandrel/commit/70626b7046a83fc3ddd5ce28b3c979183edf976d))
* workflow config-key drift fix + retired-key grep test (resolves [#874](https://github.com/dsj1984/mandrel/issues/874)) ([8f1f5eb](https://github.com/dsj1984/mandrel/commit/8f1f5eb87ee70d46ef8b41554251280cf488ce11))
* **workflows:** author /wave-execute skill body (resolves [#933](https://github.com/dsj1984/mandrel/issues/933)) ([048be00](https://github.com/dsj1984/mandrel/commit/048be0094722d91b87d44672b7b4e1115668368d))
* **workflows:** delete /sprint-execute skill and routing CLI (resolves [#940](https://github.com/dsj1984/mandrel/issues/940)) ([6105cb3](https://github.com/dsj1984/mandrel/commit/6105cb3d0b473fc51a04ef579dbba189044c76aa))
* **workflows:** fix qualityGate ref in git-merge-pr.md + add retired-key grep test (resolves [#890](https://github.com/dsj1984/mandrel/issues/890)) ([2c8fa1c](https://github.com/dsj1984/mandrel/commit/2c8fa1c73f2a2bfd771e96ce6361d634e01a494a))
* **workflows:** rename /sprint-plan and /sprint-close to /epic-* (resolves [#937](https://github.com/dsj1984/mandrel/issues/937)) ([1db2f27](https://github.com/dsj1984/mandrel/commit/1db2f27903b77f504d9cf1944779c2148d740c1f))
* **workflows:** split --no-verify policy and justify category-2 example (resolves [#886](https://github.com/dsj1984/mandrel/issues/886)) ([81f83d6](https://github.com/dsj1984/mandrel/commit/81f83d6d701e3396fd7ea52eb449fda844bce756))
* **workflows:** write story-execute.md and helpers/task-execute.md (resolves [#935](https://github.com/dsj1984/mandrel/issues/935)) ([85049b8](https://github.com/dsj1984/mandrel/commit/85049b87257e2c5054b51996e8ed40552213a514))
* **worktree:** force-drain pending-cleanup ledger with Windows handle escalation (5.30.3) ([550a1a4](https://github.com/dsj1984/mandrel/commit/550a1a48e25c43e024ceaa68664deb67194f4872))


### Fixed

* **analyze-execution:** use runascli wrapper to satisfy cli-wrapper enforcement (resolves [#1135](https://github.com/dsj1984/mandrel/issues/1135)) ([5229fee](https://github.com/dsj1984/mandrel/commit/5229fee1f10c84e855a4bf6fe78a564ce8b67498))
* baseline-refresh epic-merge-lock.js (Node 22 instrumentation) ([#1233](https://github.com/dsj1984/mandrel/issues/1233)) ([7daf164](https://github.com/dsj1984/mandrel/commit/7daf164a5fbe7f550d5683f895311ec08e3bc1ec))
* **checkpointer:** refresh totalWaves on re-prepare delta ([#1821](https://github.com/dsj1984/mandrel/issues/1821)) ([a148964](https://github.com/dsj1984/mandrel/commit/a148964fcd661b0f492bab6e3623a1d15265abba)), closes [#1816](https://github.com/dsj1984/mandrel/issues/1816)
* **ci:** denominator-aware coverage tolerance + c=1 CRAP exemption ([#1234](https://github.com/dsj1984/mandrel/issues/1234)) ([3a95bdc](https://github.com/dsj1984/mandrel/commit/3a95bdcb46ea7d45d0499e0a9a921f12333beef3))
* **ci:** revert local-only coverage ratchets for three flapping files ([#1265](https://github.com/dsj1984/mandrel/issues/1265)) ([731d0d0](https://github.com/dsj1984/mandrel/commit/731d0d0baea79a41ab13c1f77fef47889ea531c2))
* **cli:** add defineFlags export and finish parseCliArgs migration ([cf8cb6f](https://github.com/dsj1984/mandrel/commit/cf8cb6f19c59a80809b68fd5a0672f037d3902f2))
* **config:** align default-agentrc limits with limits_defaults + drift test (resolves [#1015](https://github.com/dsj1984/mandrel/issues/1015)) ([8e4e1ce](https://github.com/dsj1984/mandrel/commit/8e4e1cea78ebb40769cfd27fdc7bcbb2fff36e68))
* **context-hydration:** preserve hierarchy and sub-ticket fetch failure signals (resolves [#1012](https://github.com/dsj1984/mandrel/issues/1012)) ([547975d](https://github.com/dsj1984/mandrel/commit/547975d5efc9bcf0177d2a32240c0464487fa8b6))
* **coverage:** wire .c8rc.cjs scope through `c8 report` + `check-coverage` ([ca7745c](https://github.com/dsj1984/mandrel/commit/ca7745cf936c43608cc912d876fe96255db276bc))
* **crap:** refresh baseline with full coverage; pin pre-push to origin/main ([8c64a15](https://github.com/dsj1984/mandrel/commit/8c64a15f27b87e16173aec742847158fb228f99f))
* decomposer resilience to GitHub secondary rate limit (5.32.3) ([9c31b8f](https://github.com/dsj1984/mandrel/commit/9c31b8f160c5f5ffaba501e98b1989252d416349))
* **epic-deliver-cleanup:** reap local-side leftovers after merge ([#1348](https://github.com/dsj1984/mandrel/issues/1348)) ([aea6f6c](https://github.com/dsj1984/mandrel/commit/aea6f6c6360dc943430ea38be23604a7d3870d48))
* **epic-runner:** emit epic-blocked before epic-progress on wave halt ([d7daa35](https://github.com/dsj1984/mandrel/commit/d7daa35a9423517f4beada68a02e872806be1a5d))
* **git-cleanup-branches:** prune via `git fetch --prune` to defeat GitHub replication lag ([#1716](https://github.com/dsj1984/mandrel/issues/1716)) ([260d5a5](https://github.com/dsj1984/mandrel/commit/260d5a513079f737990cf2633dd95177942e5532))
* lift Epic-only gate on reverse-reference child discovery (5.32.4) ([969ceff](https://github.com/dsj1984/mandrel/commit/969ceff0a2f004bc158721b83ff554057f0c5294))
* **maintainability:** raise tolerance 0.001 → 0.5, plumb config (kills baseline-refresh-guardrail flap) ([#1269](https://github.com/dsj1984/mandrel/issues/1269)) ([f1877c6](https://github.com/dsj1984/mandrel/commit/f1877c642c1c5af732721b4e98a880c570652c0d))
* **merge-orchestrator:** short-circuit when git merge exits non-zero with zero unmerged files ([585bcb1](https://github.com/dsj1984/mandrel/commit/585bcb13787bff4884dc75a0c0fa803e85449480))
* raise CRAP regression tolerance default 0.001 → 0.05 (5.36.1) ([66b0542](https://github.com/dsj1984/mandrel/commit/66b054282c2a7771eace316105c29c577849e7f3))
* **reconciler:** order dependsOn ahead of dependents in topo-sort ([#1787](https://github.com/dsj1984/mandrel/issues/1787)) ([87b0a5f](https://github.com/dsj1984/mandrel/commit/87b0a5fbbf5efa9445164a4ec70c371b0789579b))
* **reconciler:** seed epic slug in state before diff to stop duplicate Epic issues ([#1823](https://github.com/dsj1984/mandrel/issues/1823)) ([a4523ce](https://github.com/dsj1984/mandrel/commit/a4523ceafbbabffe2118d3ff3fe8c52c2e62b5f4)), closes [#1820](https://github.com/dsj1984/mandrel/issues/1820)
* **review:** close correctness/doc gaps from medium-low review pass ([7d6b61a](https://github.com/dsj1984/mandrel/commit/7d6b61ac7d86ae9793ef8ad44f70c904d693e3ac))
* **single-story-close:** pass epicId: null for standalone Stories ([#1478](https://github.com/dsj1984/mandrel/issues/1478)) ([c288bd3](https://github.com/dsj1984/mandrel/commit/c288bd3c231c8a345a72814807329a88341e295f))
* **spec:** write epic spec + state under temp/epic-&lt;id&gt;/, untrack leaked temp/ files ([#1715](https://github.com/dsj1984/mandrel/issues/1715)) ([0965e85](https://github.com/dsj1984/mandrel/commit/0965e85535dfde1f26ca988156a4edc53e521891))
* stop swallowing addSubIssue failures in epic-plan-decompose (5.32.5) ([04a565d](https://github.com/dsj1984/mandrel/commit/04a565d23d3a8ae69ba5f43143340cd70c19c17a))
* **story-close:** drop retired structured:friction marker text from doc strings ([d751ae6](https://github.com/dsj1984/mandrel/commit/d751ae64bfac937ee173752c1ac0c71ed350886d))
* **story-close:** hold epic-merge lock across entire close flow ([5ad47ea](https://github.com/dsj1984/mandrel/commit/5ad47eaff31713413e972482feb1a6ba651e2930))
* **story-close:** unblock parallel-wave automation on Windows ([4db3f61](https://github.com/dsj1984/mandrel/commit/4db3f6152f45c661c60429c1da35295d52a7b086))
* **temp-paths:** honor configured tempRoot in story-close pipeline ([#1345](https://github.com/dsj1984/mandrel/issues/1345)) ([868ffef](https://github.com/dsj1984/mandrel/commit/868ffefade602650b619a541b59c77c09a8000b1))
* **tests:** add primeTicketCache no-op to epic-planner mock provider ([1f7864b](https://github.com/dsj1984/mandrel/commit/1f7864bac8024855b66db002797d6f09b47ede7b))
* **tests:** canonicalize Windows tmp paths via realpathSync.native ([3c8ce93](https://github.com/dsj1984/mandrel/commit/3c8ce939f25f626671017002d76f3d9b70d7019c))
* **tests:** retry rmSync on Windows EBUSY in cd-out-guard cleanup ([bdaee94](https://github.com/dsj1984/mandrel/commit/bdaee94980fee5d97550785c403f22c5c3892eae))
* **tests:** swallow EBUSY/EPERM in cd-out-guard tmp cleanup ([c23e91d](https://github.com/dsj1984/mandrel/commit/c23e91d981ca3d70c33e8668578c6d607d42167e))
* **tests:** unblock CI on cpu-pool exit race + Windows path mismatches ([fe09b4e](https://github.com/dsj1984/mandrel/commit/fe09b4e7478939ff6d926ef5c3bb6c5470c27f4d))
* three sprint-protocol bug fixes folded into 5.31.2 ([6fa9fb9](https://github.com/dsj1984/mandrel/commit/6fa9fb91f9d20e0c454fa5db82d36331ea902161))
* wave-runner trust boundary + complexity-tier parity (5.32.2) ([#989](https://github.com/dsj1984/mandrel/issues/989)) ([ee5ba90](https://github.com/dsj1984/mandrel/commit/ee5ba9054103c7804609ccb4cbf3fec12faa2bad))
* when conflicts.files === 0 && conflicts.lines === 0, treat the merge as already complete and return { merged: true, alreadyMerged: true } without attempting another commit. ([585bcb1](https://github.com/dsj1984/mandrel/commit/585bcb13787bff4884dc75a0c0fa803e85449480))
* **workflows:** justify --no-verify mention in task-execute.md prose rule ([cd9d140](https://github.com/dsj1984/mandrel/commit/cd9d140b846480f3eaf4c2e76c98619003404c68))
* **workflows:** justify --no-verify mention in task-execute.md prose rule ([9594b59](https://github.com/dsj1984/mandrel/commit/9594b59091eef69306a7c415c20821ec94c732b3))
* **worktree:** wire sweep into spec/decompose, force-drain after story close, git worktree remove in Stage 2 (5.30.4) ([bff2fad](https://github.com/dsj1984/mandrel/commit/bff2fadd372dadaa3782ee1304a6b31891127e02))


### Changed

* **audit-rules:** rename audit-rules data file and add real manifest schema (resolves [#1011](https://github.com/dsj1984/mandrel/issues/1011)) ([cf33e35](https://github.com/dsj1984/mandrel/commit/cf33e35e30591273b7b3c660d5360aa9949bf693))
* **audit-suite:** create lib/audit-suite/ sdk with runauditsuite and selectaudits (resolves [#1098](https://github.com/dsj1984/mandrel/issues/1098)) ([c9798be](https://github.com/dsj1984/mandrel/commit/c9798be404f0d2bee56a72e927c6ef7330cb5a69))
* **branch-cleanup:** migrate delete-epic-branches.js to lib helpers; add deleteBranchesBatched ([ffad94c](https://github.com/dsj1984/mandrel/commit/ffad94cf53302c86cc96bebf910c4c058b3f75d7))
* **cli:** extract runX from main in 4 top-CRAP CLI shells ([38a6592](https://github.com/dsj1984/mandrel/commit/38a65924a0f6732dc68b3aa473b930c1128a4413))
* convert Logger.fatal to throw inside story-close orchestrator surface (resolves [#973](https://github.com/dsj1984/mandrel/issues/973)) ([cd84dda](https://github.com/dsj1984/mandrel/commit/cd84dda537f4c3a5527e69470a4ac97d99c195e3))
* **crap:** extract helpers from baseline-refresh-guardrail::main and check-maintainability::parseStoryIdArg ([4d3ff45](https://github.com/dsj1984/mandrel/commit/4d3ff45e2147581cfea5caf6d9c4fcef2b7da425)), closes [#816](https://github.com/dsj1984/mandrel/issues/816)
* **crap:** extract pure helpers from 6 long-tail CLI/orchestrator hotspots ([9bdc481](https://github.com/dsj1984/mandrel/commit/9bdc48126370639aad61a0df1692f46f679889cd)), closes [#816](https://github.com/dsj1984/mandrel/issues/816)
* **crap:** split projects::resolveOrCreateProject and manifest-renderer epic-comment helpers ([93d73fe](https://github.com/dsj1984/mandrel/commit/93d73fe5263808e753c6f6aec49f9844b0cd899e)), closes [#816](https://github.com/dsj1984/mandrel/issues/816)
* decompose run-audit-suite.js into lib/audit-suite/ helpers ([#963](https://github.com/dsj1984/mandrel/issues/963)) ([3d96940](https://github.com/dsj1984/mandrel/commit/3d96940d67e01ea483da9f2747ade4fa2da1d62d)), closes [#980](https://github.com/dsj1984/mandrel/issues/980)
* **detect-merges:** replace promise.all with concurrentmap (cap=64) in detect-merges.js (resolves [#1104](https://github.com/dsj1984/mandrel/issues/1104)) ([f7512ea](https://github.com/dsj1984/mandrel/commit/f7512eafe3ac8f1dd1a86b80731fe9c22e1cf334))
* **diagnose-friction:** refactor diagnose-friction.js to detector-only (calls signals-writer, posts no comment) (resolves [#1057](https://github.com/dsj1984/mandrel/issues/1057)) ([184e49e](https://github.com/dsj1984/mandrel/commit/184e49e9c638a91e49f78281f304ef3f41aac18d))
* **epic-close:** bound auxiliary-ticket close (cap=3) (resolves [#1107](https://github.com/dsj1984/mandrel/issues/1107)) ([fdc6903](https://github.com/dsj1984/mandrel/commit/fdc6903224b0c97d67d71aa404561646f4724e86))
* **epic-close:** split phaseFinalizeBranchCleanup into named sub-phases ([590b641](https://github.com/dsj1984/mandrel/commit/590b641b87804e6c31856d0d02418f681857a262))
* **epic-runner:** delete build-claude-spawn + spawn-smoke-test (resolves [#919](https://github.com/dsj1984/mandrel/issues/919)) ([924d760](https://github.com/dsj1984/mandrel/commit/924d760da681fea72355cb51de158ea70c66124d))
* **epic-runner:** flatten ProgressReporter constructor onto a single options bag (resolves [#976](https://github.com/dsj1984/mandrel/issues/976)) ([890fede](https://github.com/dsj1984/mandrel/commit/890fedec8b6f5700ee1ab559aaeeb652dd4ac868))
* **epic-runner:** rewire story-launcher as Agent-tool dispatch planner (resolves [#920](https://github.com/dsj1984/mandrel/issues/920)) ([ee4b271](https://github.com/dsj1984/mandrel/commit/ee4b2714887e660f0be14bbe293cad0285f9ccc3))
* extract loadProtocolTemplate from hydrateContext (5.35.1) ([30d6f57](https://github.com/dsj1984/mandrel/commit/30d6f57559423afb9c69620197fed5319deb98a1))
* extract runEvidenceGate + runEpicCodeReview from CLI main() (resolves [#979](https://github.com/dsj1984/mandrel/issues/979)) ([b0e0461](https://github.com/dsj1984/mandrel/commit/b0e04616c00ac320377a422ce95cfa9ff59deff5))
* **friction:** delete friction-emitter cooldown module + remaining importers (resolves [#1059](https://github.com/dsj1984/mandrel/issues/1059)) ([c58a45d](https://github.com/dsj1984/mandrel/commit/c58a45d0934d31690757cf4f1b5e8af2bd7ab763))
* **manifest-persistence:** extract sweep helpers to satisfy mi baseline (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([20e627f](https://github.com/dsj1984/mandrel/commit/20e627fa7f85056ec9115c4911a7552d22fb8a38))
* **manifest:** migrate dispatcher + story-init manifest writers to per-epic tree (resolves [#1053](https://github.com/dsj1984/mandrel/issues/1053)) ([fc49ce9](https://github.com/dsj1984/mandrel/commit/fc49ce9d2f2ecceb623988435e5ab9c8bf416e5d))
* **orchestration:** bound cascadecompletion sibling reads + sequential parents (resolves [#1108](https://github.com/dsj1984/mandrel/issues/1108)) ([4a8c713](https://github.com/dsj1984/mandrel/commit/4a8c71393edf3b4a0786296c7bf8280c51e07d1a))
* **orchestration:** bounded parallelism in reconciler, sub-issue links, delete-epic (resolves [#1110](https://github.com/dsj1984/mandrel/issues/1110)) ([d0defa8](https://github.com/dsj1984/mandrel/commit/d0defa85956628c9e10705ec4c92bb93178c2283))
* **orchestration:** centralize fenced-JSON parsing into parseFencedJsonComment (resolves [#974](https://github.com/dsj1984/mandrel/issues/974)) ([5f47db6](https://github.com/dsj1984/mandrel/commit/5f47db67fdc22eb72af6daa9357f73ad654602c1))
* **orchestration:** delete aggregate-phase-timings and telemetry helpers (resolves [#1068](https://github.com/dsj1984/mandrel/issues/1068)) ([e386a46](https://github.com/dsj1984/mandrel/commit/e386a4608ea0b640d057a01a46096c2206a0642a))
* **orchestration:** delete health-monitor and post-merge health-monitor phase (resolves [#1065](https://github.com/dsj1984/mandrel/issues/1065)) ([da87499](https://github.com/dsj1984/mandrel/commit/da87499d02c2997b537f036e7dec39662676381c))
* **orchestration:** delete model-resolver and strip every importer/emitter (resolves [#1019](https://github.com/dsj1984/mandrel/issues/1019)) ([b325525](https://github.com/dsj1984/mandrel/commit/b3255254f4b0ca6a714e6cbd1cf20b67e2d8e19c))
* **orchestration:** delete unused lib/orchestration/index.js barrel ([5d8a4c8](https://github.com/dsj1984/mandrel/commit/5d8a4c8528183d4ead0d0a16172d7c46a1385bfc))
* **orchestration:** migrate health-monitor + render-manifest + dependency-guard to per-epic tree (resolves [#1054](https://github.com/dsj1984/mandrel/issues/1054)) ([9d99184](https://github.com/dsj1984/mandrel/commit/9d991846304c527bd7b04b3f0237652188858bf6))
* **orchestration:** remove upward re-exports from lib/orchestration/index.js (resolves [#1100](https://github.com/dsj1984/mandrel/issues/1100)) ([d8cf3c3](https://github.com/dsj1984/mandrel/commit/d8cf3c39bd8a020df863f08bdac6d9c16d33ed61))
* **orchestration:** strip model_tier from manifest schema, validator, and presentation (resolves [#1020](https://github.com/dsj1984/mandrel/issues/1020)) ([ab80249](https://github.com/dsj1984/mandrel/commit/ab802496c2f13845d1707ebed37997cb15ee8bee))
* **plan-phase-cleanup:** migrate plan-phase-cleanup to per-epic paths (resolves [#1052](https://github.com/dsj1984/mandrel/issues/1052)) ([ac33f34](https://github.com/dsj1984/mandrel/commit/ac33f342f8cd0450a1f5fd230bce92d488f83bda))
* **planning-state-manager:** bound close/detach mutations (cap=3) (resolves [#1106](https://github.com/dsj1984/mandrel/issues/1106)) ([a03b335](https://github.com/dsj1984/mandrel/commit/a03b335cdac68352af0e9dbad45295ce9696ef2c))
* **progress-reporter:** read story-run-progress structured comments (resolves [#921](https://github.com/dsj1984/mandrel/issues/921)) ([421bf99](https://github.com/dsj1984/mandrel/commit/421bf996cb1b1bdb66411a9ca9dc6701736051b5))
* **provider:** add no-op primeTicketCache default + drop capability checks (resolves [#975](https://github.com/dsj1984/mandrel/issues/975)) ([ce5d7d0](https://github.com/dsj1984/mandrel/commit/ce5d7d083aad7e94e6c164065a3a93cc9d58f306))
* **providers:** move `providers/github-http-client.js` to `providers/github/http-client.js` (resolves [#1101](https://github.com/dsj1984/mandrel/issues/1101)) ([65e0ada](https://github.com/dsj1984/mandrel/commit/65e0ada5a4cd8cb728fb3c03e6c7ad1bf9968930))
* remove Sprint Health residue (creator + close-side + dead config) ([023faa0](https://github.com/dsj1984/mandrel/commit/023faa0d2ff16f953ffaadb82354e087031e56be))
* rename sprint-story-close-recovery.js + sweep remaining sprint-* refs ([6950d95](https://github.com/dsj1984/mandrel/commit/6950d958e1692d575a1aabc3a4f52ce7ff30d86e))
* **render-manifest:** atomic writes for manifest .md/.json (resolves [#1111](https://github.com/dsj1984/mandrel/issues/1111)) ([669db24](https://github.com/dsj1984/mandrel/commit/669db24dc2493feef877a80e9ebd390f4069ea78))
* retire /wave-execute; /epic-execute owns the wave loop directly ([9036a6a](https://github.com/dsj1984/mandrel/commit/9036a6a7be76b3caef954a59171691fbb8c357e1))
* **scripts:** migrate git-branch-lifecycle.js and git-branch-cleanup.js to the shared guard (resolves [#1102](https://github.com/dsj1984/mandrel/issues/1102)) ([d85a937](https://github.com/dsj1984/mandrel/commit/d85a93708b0cc35602823daa033a4b370b4f325f))
* **scripts:** rename top-level sprint-*.js scripts to epic-*/story-* shape (resolves [#929](https://github.com/dsj1984/mandrel/issues/929)) ([49a6adc](https://github.com/dsj1984/mandrel/commit/49a6adc66694a9c33fd89a9cf64cfb23001c3185))
* **story-close:** collapse merge dispatch + drop redundant blank line to keep ≤200 LOC ([fb5c1c8](https://github.com/dsj1984/mandrel/commit/fb5c1c8d22739b151305c1de99af07f1d36730d7))
* **story-close:** extract merge-runner, cleanup-reconciler, comment-bodies modules ([c283790](https://github.com/dsj1984/mandrel/commit/c2837906ba6c1047487d68c3ae48d9c2d0964fa7)), closes [#955](https://github.com/dsj1984/mandrel/issues/955)
* **story-close:** move attribution wrapper into baseline-attribution-wiring module ([b626af4](https://github.com/dsj1984/mandrel/commit/b626af4532bf95eaeef8c2e8f73fbe5f22e413ff))
* **story-close:** trim story-close.js to a 189-line CLI shell (resolves [#972](https://github.com/dsj1984/mandrel/issues/972)) ([13c9df6](https://github.com/dsj1984/mandrel/commit/13c9df6541e38ffe42b76991d9beae2159c10009))
* sweep sprint-* references across JS to post-[#900](https://github.com/dsj1984/mandrel/issues/900) names ([0288ea8](https://github.com/dsj1984/mandrel/commit/0288ea82540ea7ed4ae5d48323f3b5947e34fc2a))
* **tests:** extract seedorphans helper to satisfy test mi baseline (resolves [#1141](https://github.com/dsj1984/mandrel/issues/1141)) ([308a322](https://github.com/dsj1984/mandrel/commit/308a32236c514171282ab0432db462c16ddbfc1f))
* **ticket-decomposer:** bound force-close closepromises (cap=3) (resolves [#1105](https://github.com/dsj1984/mandrel/issues/1105)) ([4d623cc](https://github.com/dsj1984/mandrel/commit/4d623cc3e33ff71b54838eafad4ee231d5201ab5))
* triage 41 unused exports across .agents/scripts/ (resolves [#961](https://github.com/dsj1984/mandrel/issues/961)) ([0813d77](https://github.com/dsj1984/mandrel/commit/0813d772d9db5142cf5b99f038666bc38b0dea86))
* **validation-evidence:** migrate to per-Epic temp tree ([1957d88](https://github.com/dsj1984/mandrel/commit/1957d889570dd97d528653614bf29d2e8e380113))
* **worktree:** migrate worktree-manager tests off _-prefixed methods + delete delegates + decisions.md entry (resolves [#977](https://github.com/dsj1984/mandrel/issues/977)) ([05a2802](https://github.com/dsj1984/mandrel/commit/05a280273df5d7d8f3f7f8655b7290e1f147c8a9))
* **worktree:** replace issafetoremove heuristic with merge-base + merge-commit fallback (resolves [#1129](https://github.com/dsj1984/mandrel/issues/1129)) ([a633f6c](https://github.com/dsj1984/mandrel/commit/a633f6cd80d775d2b316deec434b75a2a497b2ec))

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

- **Concurrency**: single **`orchestration.concurrency`** block (`decomposer`,
  `deliverRunner`, `waveGate`, `commitAssertion`, `progressReporter`).
  Removes **`runners.decomposer`**, **`runners.concurrency`**, and
  **`deliverRunner.concurrencyCap`**; use **`resolveConcurrency(orchestration)`**.

- **`sizingProfile`** on dispatch-manifest Tasks that exceed **`agentSettings.planning.taskSizing.softFileCount`** file threshold (profiles: **`mechanical-sweep`**, **`atomic-rewrite`**, **`scaffolding`**).

- **`agentSettings.planning.taskSizing`** — tunable **`maxAcceptance`** /
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
  **`agentSettings.quality.maintainability.tolerance`** / **`CRAP_TOLERANCE`**.

---

Pre-rebrand history (the old-name v1.x–v5.41.x line and the 6.0.0 cut-over
tag) is preserved in [`archive/CHANGELOG-pre-v6.md`](archive/CHANGELOG-pre-v6.md).
