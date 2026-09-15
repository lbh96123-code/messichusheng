# 推荐里有没有已选走技能 —— 真机轨迹审计(v1.25 起)

数据来源:腾讯云 `/root/ad/var/logup/YYYYMMDD/*_draft_end_*.zip`(插件每局自动上传, 含 `ad_*.log` + `trace_*.jsonl`)。
scp 下来解压到一个目录, 每个包一个子目录, 然后在 `app/` 目录下跑:

```
for f in <目录>/*/trace_*.jsonl; do node tools/audit_taken/replay3.js "$f"; done   # 回放:tracker + 快通道 fastPicks(旧规则/新规则)
cd <目录> && python3 <app>/tools/audit_taken/gap2.py                                  # 以每格像素为真值, 统计"真被选走但引擎当可选"的秒数
python3 <app>/tools/audit_taken/check.py                                               # 只看日志:前三推荐 vs 日志里已记为选走的(粗筛)
node tools/audit_taken/replay2.js <trace> 月刃 粘性炸弹                                 # 逐帧打印某几件的 tracker 内部状态(raw/stable/flaky/suspect/owner)
```

真值口径:某格从时刻 T 起完整识别一直是 'T'(看不清 'O' 的帧不算, 中间不能有连续 2 帧 'N'), 且 T 之前按亮度(<0.32×参考、最亮<0.5×)
已经暗着的 'O' 帧也算进去。`gap2.py` 打印三种口径:tracker 单独 / 旧 worker 规则 / v1.25 规则。09-15 那批 8 局:766s / 504s / 259s。

## v1.26 加的两件
- `feat.js`:对每局的"锁池截图 + 后面的截图"逐格量 亮度比/最亮/饱和/图标匹配比, 真值来自日志里的 track 时间(只取同一局), 输出 feat.json;
  行里带 `verdict`(现行) / `v2`(新规则无同排样本) / `v3`(有样本)。注意 track 时间有滞后, 争议格子要用 `crops.js` 裁出来看。
- `crops.js '<json>'`:把指定格子在锁池图和后面那张图上裁成拼图(左=锁池, 右=现在), 目视定真值。
