# Changelog

All notable changes to this project will be documented in this file.

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

* Mandrel v6.0.0 — ticket hierarchy is now Epic -> Feature -> Story (with inline acceptance/verify on the Story body). The planning.hierarchy config flag, type::task label, Task-tier scripts, and Task-aware lifecycle hooks have been deleted. Consumers re-pinning .agents/ to v6.0.0 MUST migrate any local Task-tier artifacts per docs/upgrade-guide-3-tier.md.

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
