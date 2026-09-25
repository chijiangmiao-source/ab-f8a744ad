# 束流整形磁铁垫片整数校正量复核系统

工程师更换束流整形磁铁垫片后，多处机械校正量须同时满足实测耦合位移关系，且每项调整只能取**整数个最小垫片单位**。本系统接收变量标识、整系数约束矩阵 A 与目标向量 b，对丢番图方程组

```
A · x = b      （x 必须为整数向量）
```

给出**任意精度整数**的可解性判定：有解时给出精确整数校正量，无解时给出由**可逆整数行变换（Smith 正规形）**导出的规范除尽障碍证据。

## 特性与需求对应

| 需求 | 实现 |
| --- | --- |
| 任意精度整数，不转浮点、不四舍五入有理解 | 全程 Node `BigInt`；输入严格按十进制整数文本解析（拒绝 `1e3`、`1.5`、`NaN`），输出一律十进制文本；商只在已证明整除时进行 |
| 无解时展示规范除尽障碍 | 计算 Smith 正规形 `S = U·A·V`（U、V 幺模，det=±1），对每条不可解条件给出：主元 d、变换后目标 c=(U·b)_i、规范余数 r=c mod d≠0、产生该结论的可逆行组合系数 u、变换后系数 u·A（其每一分量均被 d 整除，唯独 c 不被整除），复核员可逐行独立核算 |
| 超过安全整数范围仍精确呈现 | 40 位以上系数/目标按字符串原样进出，页面以等宽文本渲染（含示例按钮） |
| 大复核在途时编辑草稿/取消，迟到返回不覆盖状态 | 服务端任务 id 隔离、分片让出（setImmediate）并在分片边界响应取消，收口时原子判定 `cancelRequested`，已取消不写结论；前端草稿与复核结论分离，按任务 id+本地令牌丢弃迟到返回并列入"已忽略"提示 |
| 点选任一约束查看乘积明细 | 每条约束展示每个 `系数 × 变量(=校正量) = 乘积`、左侧和与目标及精确相等判定 |
| Dockerfile 构建；Compose 可配置宿主端口、页面与健康路径 | `Dockerfile`（node:20-slim，无第三方依赖）；`HOST_PORT`（默认 8080）映射；`/healthz` |
| verify 为一次性退出验收服务 | `scripts/verify.js`：① 不可整除约束无解证据确认 ② 代码测试 ③ 构建检查 ④ HTTP 冒烟（健康路径 + 复核接口可解/无解/大整数/非法输入），以退出码报告 |

## 本地运行（无需 Docker）

```bash
node src/server.js            # 默认 0.0.0.0:3000，可用 PORT 覆盖
npm test                      # 单元测试（12 项）
node scripts/build-check.js   # 构建检查
BASE_URL=http://127.0.0.1:3000 node scripts/verify.js   # 一次性验收
```

## Docker / Compose

```bash
# 构建并启动页面服务（可配置宿主端口）
HOST_PORT=9090 docker compose up web
# 浏览器打开 http://localhost:9090

# 一次性验收（自动等待 web 健康，执行完即退出，退出码透传）
docker compose run --rm verify

# 或一条命令完成"验收即退出"，verify 的退出码即整体退出码
docker compose up --build --abort-on-container-exit --exit-code-from verify
```

## 接口

- `POST /api/reviews`：`{ variables: string[], matrix: string[][], targets: string[] }` → `202 { id, pollUrl }`
- `GET /api/reviews/:id`：轮询状态 `running | solvable | unsolvable | cancelled | error`，结论包含解、障碍证据、U/S 矩阵与每条约束的乘积明细（BigInt 均为字符串）
- `POST /api/reviews/:id/cancel`：请求取消在途复核
- `GET /healthz`：健康检查

## 算法说明

Smith 正规形仅使用三类**可逆整数（幺模）变换**：行/列交换、整系数行/列组合（扩展欧几里得 Bezout 系数）、变号。变换矩阵 U（行）与 V（列）被同步累计，因此每个结论都附带产生它的整数证据链：

- 主元行 `d_i·y_i = c_i` 有整数解 ⇔ `d_i | c_i`；
- 零主元行要求 `c_i = 0`；
- 主元满足 `d_i > 0` 且 `d_1 | d_2 | … | d_r`（Smith 不变量）。

无解时，障碍所在行的 `u·A` 全部分量被 `d` 整除而 `u·b` 不被整除——这正是"所有整数 x 都无法满足"的直接证书（certificate），复核员无需信任求解器即可验证。

## 目录

```
src/diophantine.js   任意精度 Smith 正规形与丢番图判定（含取消钩子）
src/protocol.js      精确整数文本解析/序列化、载荷校验
src/reviewManager.js 在途任务生命周期、取消与竞态收口
src/server.js        HTTP 服务（页面/健康/API）
public/              录入页面（草稿状态隔离、证据与明细展示）
scripts/verify.js    一次性验收
scripts/build-check.js 构建门禁
test/                node:test 单元测试
```
