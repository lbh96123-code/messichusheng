# 文档索引

- [debug-score-consistency-2026-10-16.html](debug-score-consistency-2026-10-16.html) —— 同局分数卡不一致：1.48.5/1.49.0 模型资源、经济分配口径和中途识别进度；三端真实阵容重算与推荐顺位的可比条件
- [debug-residual-overcount-2026-10-16.html](debug-residual-overcount-2026-10-16.html) —— 剩余 7 帧：待配对禁选与完成进度分离、第 11 个英雄路径修复；60 条完整历史轨迹、12,965 帧及 3 条有缺口补充回放
- [debug-draft-fixes-2026-10-16.html](debug-draft-fixes-2026-10-16.html) —— 末轮清空验证、多计永久锁定修复与剩余路径；分数卡随推荐显隐，25 条真实轨迹前后回放
- [debug-restart-2026-10-16.html](debug-restart-2026-10-16.html) —— 反复重启的后续调查：跨局原生窗 hide/show 回归、常驻透明窗口修复、100 次状态循环及 Windows 真机验证边界
- [debug-2026-10-15.html](debug-2026-10-15.html) —— 10/15 四项故障的初步核对与 PR 前后归因；末轮计数清空与连选定位修复，后续显示调查见 10/16 报告
- [recognition.md](recognition.md) —— 识别层：版式定位、逐格贴框、模板匹配、三态判定、空槽判定、读池子
- [attribution.md](attribution.md) —— 归属层：两条线索如何配对，9 个步骤各治什么病，以及该怎么收口
- [performance.md](performance.md) —— 快慢双通道、重算触发条件、引擎线程、延迟构成
- [design-2.0.md](design-2.0.md) —— **2.0 设计**：为什么 1.x 注定要一直打补丁，把问题改成"受约束的组合估计"之后能删掉什么，以及 1.x ↔ 2.0 的实测对比
- [testing.md](testing.md) —— 模拟器、真机基准、观测轨迹与回放、以及"合成测试为什么会骗人"

从零接手建议的顺序：先读根目录 [README.md](../README.md) 的"四个关键设计"，
再按 recognition → attribution → performance 读，最后读 design-2.0。
testing.md 里的方法论教训（标准答案从哪来、测试不能干扰它自己要测的东西）值得单独看一遍。

运行时有两个**互相独立**的开关（托盘菜单 / F11 / F12）：运行模式（正式 / 测试，只管截图和日志）、
状态估计内核（1.x / 2.0，只管判断）。测试模式下两个内核并行跑并逐帧记录分歧。
