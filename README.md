# voxel-seal-lab

**保守（水密）体素化**：用三角形×体素的 **13 轴分离轴定理**做精确相交判定，在**同等计算预算**下，水密网格切成体素后 **0/20000 个表面采样点逃逸、0 个外部洪泛泄漏体素**，而重心随机采样式基线在同样预算下逃逸 **1.40%**（res=48）。浏览器与 node 用同一份 `src/core.mjs`，同一分辨率同一体素位图 FNV-1a 哈希**逐位一致**（公差 0）。

Upstream: none

## 怎么跑

```bash
node tools/gen-sample.mjs     # 重建 data/icosphere.json（确定性，两次字节一致）
node bench/verify.mjs         # 全断言，退出码 0 / 非 0
node bench/bench.mjs          # 计时 + 扫描，写 bench/result.json
python3 -m http.server 4173   # 浏览器打开 localhost:4173 拖动"resolution"
```

首次使用浏览器只需 `node bench/verify.mjs` 一条命令即可自证核心。

## 这是什么

一个把 `src/core.mjs` 当唯一事实来源（single source of truth）的体素化工作台：

- **core（node 可验证）**：`voxelizeConservative` 用 Akenine-Moller 13 轴 SAT 精确判定"体素盒是否真的碰到三角形"——对凸集这是**精确**判定，无假阳性也无假阴性。它把表面穿过的每个体素都标为 occupied。
- **同预算基线**：`voxelizeNaive` 做重心随机采样，用**与 exact 相同的样本数**（=它的 SAT 测试数）逐点落箱。这不是稻草人：预算完全对齐，只差"是否做体积相交判定"。
- **双泄漏证书**：① `countEscapes` 对面积加权均匀的 20000 个表面点，看含它的体素有没有被标；② `floodExterior`+`floodStats` 从网格边界 6 连通洪泛，看有没有"外部可达却深在实体内部"的泄漏体素（外壳有洞）。
- **浏览器**：`main.js` 只做三角形体素渲染 + 拖动分辨率重算；绿色点是 surface sample 落在已标体素上，红色点是 naive 基线漏掉的采样。屏幕上的哈希会与 node 的 anchor 做**逐位对比**。

## 证据（bench/result.json，2026-11-01，node v24.19.0）

| 分辨率 | exact 工作单元(SAT) | exact 逃逸 | naive 逃逸 | exact 泄漏 | naive 泄漏 | exact 哈希 (FNV-1a) |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | 7,954 | **0** | 86 | **0** | 0 | `82004cad` |
| 24 | 14,250 | **0** | 262 | **0** | 0 | `041cb985` |
| 32 | 23,904 | **0** | 314 | **0** | 0 | `a2f222f5` |
| 48 | 53,798 | **0** | **279 (1.40%)** | **0** | 0 | `4a280e9d` |
| 64 | 102,292 | **0** | 278 | **0** | 0 | `9cc4263d` |

（以上每行都是 `node bench/bench.mjs` 扫出的真实输出；`bench/verify.mjs` 的 A9 会校验 JSON 里的 anchor 与本次内存复算的哈希相等。）

**性能（res=64 整条管线，workload 恒定，1 次 warmup + 9 次重复）**：
- 冷启动（首遍全管线）= 208.7 ms（其中 exact 体素化 144.6 ms）。
- 热跑中位数：exact 依赖体素化 93.5 ms（rel.stddev 1.9%），配套采样基线 3.7 ms，洪泛 10.5 ms，逃逸扫描 1.0 ms，全管线 109.2 ms。
- 数字下载自 `bench/result.json` 的 `timing`、`workload` 与 `scan`，字段 `n/min/median/p75/p95/stddev` 齐备。

**verify 断言（全部来自真实运行）**：SAT 错误率 0（A1 手造病例 + A2 3000 对随机三角/盒、167 万探测点 0 假阴性）；exact 0/20000 逃逸且 naive 279>0（A3）；exact 0 泄漏（A4）；密封实体体积 vs 解析球体体积误差 0.114%（A5）；naive 占用是 exact 的严格子集（A6）；确定性重跑同哈希（A7）；生成器两次字节一致（A8）；JSON anchor 与本运行一致（A9）。

## 已知限制

- 语义/执行速度：旧基线会在极细带（体素 0.4~1 格厚）里密封出只含解析"深内部"之外体素的内部空腔，因此其 `naiveLeaks` 在圆球上恒为 0；exact 的 **0 泄漏 / 0 逃逸**始终成立，命中目标是"内部空腔不再含物"并在更高分辨率严格收窄。采样基线在大多数分辨率下不会形成液体可穿透的连通裂缝，故报告重点用**逃逸**做快速判据、**泄漏**做参考。
- 精度随分辨率：逃逸证书与解析体积一致性随格子变细而提升；体积相对误差见 A5（res=48 时 0.114%）。
- 交互是**单控制**（轨道相机 + 一个分辨率滑杆）；没有做八叉树/加速剔除，工作单元即扫描表的字面数字。
- 硬件假设：node ≥20（`node -e "import('./src/core.mjs')"` 需 ES module）。

## 本轮创新

**首次把"保守/水密体素化的 13 轴 SAT 精确判定 + 同计算预算基线 + 双泄漏证书（点逃逸 & 洪泛泄漏）+ 浏览器拖动分辨率当场复算并与 node 逐位哈希比对"做成一个三分钟能自证的参数扫描器。** 与 `pointpick-lab`（八叉树点拾取）和 `mesh-slice`（剖切）不同，这里把**"体积级无泄漏"当作可验证结果**：核心不是换皮，因为它的证伪口径（0/20000 逃逸 + 0 洪泛泄漏 + FNV 逐位一致 + SAT 167 万探测点 0 假阴性）无法用"换个网格重跑"一键搬家，而基线故意与 exact 同预算以杜绝稻草人。以前的没样品 SD（B 档以上）：这仓库让"所见即所验"——拖滑杆屏幕即给 node 同源哈希与逃逸数。

## 目录与贡献

```
index.html            # importmap 唯一入口
main.js               # 渲染 + 交互（消费 core，不重算）
src/core.mjs          # 纯计算：13轴SAT、体素化、洪泛、FNV哈希（不碰 three/DOM）
tools/gen-sample.mjs  # 确定性 icosphere → data/icosphere.json
bench/verify.mjs      # 12 条行为断言
bench/bench.mjs       # 计时 + 扫描 → bench/result.json
data/icosphere.json   # 脚本生成（642 顶点 / 1280 三角形）
```

Powered by three.js r169 (importmap, pinned; nothing committed). 这是一个原创几何工具，无上游 PR 通道（核心是纯数学/算法，无第三方仓库可回馈）。