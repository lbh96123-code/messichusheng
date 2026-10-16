# Draft lifecycle regression fixtures

`oct15_late_count.json` records an anonymous late-turn observation that reports
50 total picks while the local player still has a slot open. `oct15_unpaired_dark.json`
records three bright-cell measurements and their stuck debounce state from the
Oct 15 C06 trace. The latter tests recovery from an unpaired long-dark false pick;
it is not an entire screenshot or independent ground truth for every selection.

Run `node test/oct15_turn_advice.js`, `npm run test:overcount`, and
`node test/overlay_content_visibility.js` for the late-turn, count-recovery and
unified score-card/advice visibility regressions. The score data and draft pool
remain retained while presentation is paused.

For private trace diagnosis, use:

```
node tools/debug_draft/audit_overcount.js /absolute/path/to/trace.jsonl
OVERCOUNT_RECOG_REF=c022891 node tools/debug_draft/audit_overcount.js /absolute/path/to/trace.jsonl
```

The optional `--assert-valid` exits with status 1 if any frame still exceeds 50
or has missing recorded observations. It is expected to fail on the residual
pending-skill/orphan-hero cases; the diagnostic is separate from passing unit tests.

`draft_overcount.json` is the anonymized recognition state at frame 194 of the
Oct 14 failure trace (52 counted picks, incomplete panels). It contains game keys
and seat coordinates, without player names or account identifiers.

`draft_scenes.json` contains 18 distinct historical screenshot samples, each at
1280×720 and its original resolution (36 cases). Only stage text and, for game
HUD samples, health/mana bars and minimap geometry remain. The text region is
stored as losslessly compressed maximum-channel greyscale; HUD regions retain
RGB. Names, avatars and chat are excluded. Source filenames and SHA-256 identify
the original screenshots; full screenshots and uploaded logs stay outside Git.
`data/draft_scene.json` contains eleven small UI text templates from those sources.
These fixtures are regression evidence, not a held-out accuracy benchmark.

Run `npm run test:draft-lifecycle`. To replay an external observation trace through
recognition and the actual worker lifecycle/IPC (with expensive search stubbed):

```
node test/draft_worker.js /absolute/path/to/trace.jsonl
```

The replay checks continuity, retained pool identity and visible active state;
it does not reconstruct missing screenshot pixels. Stage detection is tested
separately using the screenshot regions. Neither test runs Dota or DirectML.

## Historical brightness and resolution tests

`draft_scenes_history.json` adds four anonymous header regions from September,
including the previously unsupported 距离选择结束还有 prompt and a real 960×540
capture. Together the two fixture files contain 40 cases from 22 original images.
Two of the new regions supply additional choice-prompt templates.

Run `npm run test:draft-robustness`. The three scripts check 80 lifecycle conflict
combinations, three conflicting real-pixel cue combinations, 360 native-size
photometric cases and a deterministic resize/brightness matrix. Dim HUD misses
are reported separately as conservative waits; a safety pass is not 100% scene
recognition. Pixel brightness perturbations do not simulate monitor backlight,
HDR capture or a game renderer running at another resolution.

For a larger private dataset, `test/draft_robustness.js` accepts a JSON manifest:

```
node test/draft_robustness.js /absolute/path/manifest.json --out=/absolute/path/results.json
```

Each manifest item supplies `id`, optional `label`, `sha256`, and `regionsPath`
pointing to a region JSON in the fixture schema. Set `cross` to a boolean to pin
cross-product membership for comparisons. Labels are independent references;
unlabeled cases are measured but cannot establish classification correctness.
The optional `--baseline` flag runs only original pixels at native dimensions.

`tools/debug_draft/real_pixel_worker.js` accepts full PNG paths and runs the real
worker without recognition mocks. It first requires a successful pool lock,
then feeds dimmed, brightened and restored frames. Search is disabled through
normal visibility IPC. These checks do not run Windows, Dota or DirectML.

## Self-contained scorer failure integration

`score_guard_pixels.json` contains a lossless PNG of anonymous regions from one
Oct 15 pool screenshot. Only the central board, public hero-name headers, panel
rims and skill slots survive; player names, avatars, turn portraits, friend list
and chat are excluded. The original resolution is retained because a half-size
version detected only 39 cells, below the production lock threshold of 40.
This is one static regression fixture, not an accuracy benchmark.

`npm run test:player-scores` now uses those actual pixels in a real worker thread.
It exercises startup failure and repeated scoring exceptions without mocking
recognition or requiring the external icon collection. It asserts empty score
arrays, continued state delivery and error deduplication. Search is suppressed
through normal visibility IPC. `--frame=/absolute/path.png` overrides the image;
`--synthetic` retains the legacy icon-based scenario.

## Native window and Windows bundle checks

`npm run test:overlay-native` is an optional GUI test using real Electron windows,
renderer, preload, IPC, production overlay-controller code and renderer recovery.
It does not start capture, updates or upload, and uses temporary settings. It
reports the actual OS; a macOS result cannot establish Windows/Dota fullscreen
stacking. Scale cases exercise canvas coordinate conversion, not Windows DPI.
The Windows workflow runs this check on a dedicated hosted runner. It has not
run merely because the workflow exists in a local branch.

Build on a supported Node runtime (Node 24 was used locally):

```
npm run pack
node test/windows_package.js dist/ADAssistant-win32-x64
node test/player_scores_guard.js --app=dist/ADAssistant-win32-x64/resources/app
```

The package audit checks PE x64 headers, source/resource hashes, excluded test
files, JS parsing and CPU scorer agreement. It does not execute the EXE. Missing
`onnxruntime-node` is reported explicitly: that source-only build cannot certify
GPU/DirectML search modes as a complete release.

The manually prepared workflow also runs on pushes to the dedicated
`codex/windows-draft-validation` branch; it does not publish releases. Pushing
that branch remains a separate user-authorized action.
