"use strict";
// 用外部真实轨迹验证评分管线；没有人工真值，因此不把回放成功解释为识别准确。
// node test/player_scores_real.js /path/to/logs
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { performance } = require('perf_hooks');
const R = require('./_env').init(), T = require('../trace');
const score = require('../player_scores').createPlayerScorer();
const dir = process.argv[2];
if (!dir) { console.error('Usage: node test/player_scores_real.js /path/to/logs'); process.exit(2); }
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
assert.ok(files.length, 'no trace files found');
const times = []; let total = 0;
for (const name of files) {
  const file = path.join(dir, name), head = T.read(file).head;
  R.rescale(...head.res);
  let previous = '', changes = 0, unknownFrames = 0;
  const result = T.replay(file, (tracker, rec, state) => {
    const start = performance.now(), rows = score(state.panels, R.LAYOUT());
    times.push(performance.now() - start);
    assert.equal(rows.length, 10);
    for (const row of rows) {
      assert.ok(row.total === null || Number.isFinite(row.total));
      assert.ok(row.box[0] >= 0 && row.box[0] + row.box[2] <= head.res[0]);
      assert.ok(row.box[1] + row.box[3] <= head.res[1] * .9);
      const panel = state.panels.find(p => p.side === row.side && p.idx === row.idx);
      if (!panel?.hero && !panel?.skills?.length) assert.equal(row.total, null);
    }
    if (rows.some(r => r.unknown)) unknownFrames++;
    const current = JSON.stringify(rows);
    if (previous && previous !== current) changes++;
    previous = current;
  });
  assert.ok(result.frames.length, `${name}: no full frames`);
  assert.equal(result.miss, 0, `${name}: missing observations`);
  total += result.frames.length;
  console.log(`${name}: frames=${result.frames.length} scoreChanges=${changes} unknownFrames=${unknownFrames} gaps=${result.miss}`);
}
times.sort((a, b) => a - b);
console.log(`PASS ${files.length} traces / ${total} frames; score median=${times[times.length >> 1].toFixed(3)}ms p95=${times[Math.floor(times.length * .95)].toFixed(3)}ms (local CPU, excludes capture/recognition)`);
