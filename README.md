# 厂内检修断电挂牌演练系统（Lockout / Tagout Drill）

一个基于 **Node.js + SQLite + 浏览器界面** 的检修断电挂牌（LOTO）演练 Web 应用。
管理员维护电源、开关与设备的有向供电关系；操作员执行“分闸 → 挂牌 / 解牌 → 合闸”
和检修许可的申请、结束；系统按供电路径自动判定设备是否真正断电隔离，
并用全局修订号实现多人并发控制，记录每次成功变更的前后状态。

## 功能与业务规则

### 角色
- **管理员（admin）**：维护供电网络 —— 新增 / 删除 / 重命名电源、开关、设备，
  启用 / 停用电源，架设或拆除有向供电关系（边）。
- **操作员（operator）**：开关分闸、合闸、挂牌、解牌；为设备申请 / 结束检修许可。

### 开关状态机
1. 合闸位置的开关必须先 **分闸（open）** 才能 **挂牌（tag）**；
2. **挂牌开关不得合闸**：对挂牌开关执行合闸直接拒绝（`SWITCH_TAGGED`）；
3. 解牌（untag）后才允许重新合闸。

### 许可生效条件
- 从 **所有 `enabled=1` 的启用电源** 出发，沿有向供电边到达目标设备的全部路径，
  都必须经过至少一个 **已挂牌开关**（路径在挂牌点被视为切断）。
- 申请时若仍存在未切断路径，返回 `422 PERMIT_NOT_ISOLATED`，并列出每一条
  未切断路径（节点链），界面同步高亮，便于学员找到还需挂牌的开关。
- 停用电源视为无输出，不产生路径。

### 许可有效期内的“整体拒绝”
任一有效许可存续期间，下列变更若会使该许可不再满足隔离条件，**整次操作拒绝、
数据库事务回滚、状态与修订号均不变**，并返回受影响许可与重新来电的路径：
- 对挂牌开关 **解牌**（或给挂牌开关合闸）；
- **启用电源**（例如把带旁路的停用电源重新启用）；
- **改动线路 / 节点**（新增绕过挂牌点的接线等）。

> 说明：删除节点或拆除接线只会减少通路，不可能创造新的来电回路，因此这类操作
> 天然不会破坏隔离；删除挂有有效许可的设备本身仍被禁止，需先结束许可。

### 多人并发（乐观锁）
- 每次成功变更都会让全局 **修订号 revision + 1**（界面右上角实时显示）。
- 所有写操作必须携带操作者“所见”的 `revision`。
- 提交时若库中修订号已不同，返回 `409 STALE_REVISION` 与 **当前完整状态**，
  前端自动刷新为最新状态，要求核对后重试；过期提交不会落库。

### 审计
每次成功变更记录：时间（UTC）、操作者、角色、动作、参数、
变更前后修订号以及 **变更前后完整网络状态快照**（JSON）。

## 技术栈
- 后端：Node.js + Express
- 存储：SQLite（better-sqlite3，WAL 模式，写操作使用 `IMMEDIATE` 事务）
- 前端：原生 HTML/CSS/JS（无构建步骤），SVG 供电网络图、路径高亮
- 部署：多阶段 Dockerfile + Docker Compose（构建镜像、安装依赖、建库、启动）

## 快速开始（Docker Compose，推荐）

```bash
# 构建镜像 + 安装依赖 + 初始化数据库(空库自动写入演示网络) + 启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose stop

# 停止并删除容器(数据保留在卷 loto_loto-data 中)
docker compose down

# 连同数据卷一并清空(恢复初始演示网络)
docker compose down -v
```

访问地址：**http://localhost:3000**
（如修改端口见下文配置）。容器启动命令为
`npm run init-db && node server.js`，即 **先建库后启动**；重复执行安全，
已有数据时初始化脚本只建表、不覆盖数据。

## 本地直接运行（Node 20+）

```bash
npm install          # 安装依赖
npm run init-db      # 建库 + 演示数据(默认 data/loto.db)
npm start            # 启动服务, 默认 http://localhost:3000
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 应用监听端口（容器内） |
| `LOTO_DB` | `data/loto.db`（项目目录下） | SQLite 数据库文件路径 |
| `LOTO_PORT` | `3000` | **仅 Compose 使用**：宿主机映射端口，即浏览器访问端口 |

修改访问端口示例：

```bash
# 方式一：环境变量
LOTO_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080

# 方式二：复制 .env.example 为 .env 后修改 LOTO_PORT
cp .env.example .env
```

数据持久化：Compose 使用命名卷 `loto-data` 挂载到容器 `/app/data`。
重置为初始演示网络：`docker compose down -v && docker compose up -d --build`。

## 浏览器操作指引
1. 右上角填写 **操作者姓名**，选择身份（操作员 / 管理员），身份保存在浏览器本地。
2. **供电网络** 页：点击节点，右侧出现该节点可执行操作；
   - 电源：管理员可启用 / 停用；
   - 开关：操作员可分闸、合闸、挂牌、解牌（图中红色虚边为被挂牌切断的线路）；
   - 设备：操作员可申请许可，或“查看供电路径”（未切断路径橙色高亮）。
3. **检修许可** 页：选择设备申请许可；申请失败时弹窗列出未切断路径；
   有效许可卡片实时显示隔离是否满足，可随时结束许可。
4. **拓扑管理** 页（管理员）：维护节点和有向供电关系。
   规则：电源只能作起点、设备只能作终点、不允许自环和重复接线。
5. **变更记录** 页：查看所有成功变更的时间、操作者、动作、前后修订号，
   可展开查看前后完整状态快照。
6. 页面每 10 秒轮询一次修订号；他人提交后会自动刷新。若你的提交过期，
   会收到明确提示并刷新到最新状态。

### 演示网络
初始库内置：`1#主电源 → K1 → K3 → 1#循环水泵`，
`2#备用电源 → K2 → K3 → 1#循环水泵`，以及 `K1 → 2#引风机`。
建议演练流程：
1. 直接对“1#循环水泵”申请许可 → 失败，显示两条未切断路径；
2. K1 分闸 → 挂牌；K2 分闸 → 挂牌；
3. 再申请许可 → 生效；
4. 尝试给 K1/K2 解牌或让管理员架旁路 → 被整体拒绝并显示来电路径；
5. 结束许可后再解牌恢复送电。

## HTTP API 摘要

所有写操作均需 JSON body：`actor`（姓名）、`role`（`admin`/`operator`）、
`revision`（所见修订号）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | - | 当前完整状态（修订号、节点、边、有效许可、隔离判定） |
| GET | `/api/health` | - | 健康检查 |
| GET | `/api/devices/:id/paths` | - | 设备的全部供电路径（未切断 / 被挂牌切断） |
| GET | `/api/audit?limit=100` | - | 变更记录（含前后状态快照） |
| POST | `/api/admin/nodes` | admin | 新增节点 `{kind, name}` |
| PATCH | `/api/admin/nodes/:id` | admin | 改名 / 启用停用电源 `{name?, enabled?}` |
| DELETE | `/api/admin/nodes/:id` | admin | 删除节点（级联删除相关边） |
| POST | `/api/admin/edges` | admin | 新增供电关系 `{from_node, to_node}` |
| DELETE | `/api/admin/edges/:id` | admin | 拆除供电关系 |
| POST | `/api/switches/:id/open` | operator | 分闸 |
| POST | `/api/switches/:id/close` | operator | 合闸（挂牌时拒绝） |
| POST | `/api/switches/:id/tag` | operator | 挂牌（须先分闸） |
| POST | `/api/switches/:id/untag` | operator | 解牌（破坏有效许可隔离时拒绝） |
| POST | `/api/permits` | operator | 申请许可 `{device_id}` |
| POST | `/api/permits/:id/end` | operator | 结束许可 |

错误约定：`400` 参数错误 / `403` 角色不允许 / `404` 不存在 /
`409 STALE_REVISION` 修订号过期（响应含 `current` 当前状态）/
`422` 业务规则不满足（如 `PERMIT_NOT_ISOLATED`、`ISOLATION_VIOLATION`、
`SWITCH_TAGGED`，响应中携带未切断路径）。

## 目录结构

```
.
├── Dockerfile              # 多阶段构建(编译 better-sqlite3 原生模块)
├── docker-compose.yml      # 构建、init-db 建库、启动、数据卷、健康检查
├── .env.example            # 端口配置示例
├── server.js               # Express 服务与全部 API / 事务 / 并发控制
├── src/
│   ├── db.js               # SQLite 连接、表结构、演示数据
│   ├── graph.js            # 有向图路径搜索与隔离判定
│   └── init-db.js          # 建库脚本(npm run init-db)
├── public/                 # 浏览器界面(原生 JS + SVG)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── test/smoke.js           # 端到端业务规则冒烟测试
```

## 测试

```bash
# 终端1
npm run init-db && PORT=3100 node server.js
# 终端2
node test/smoke.js
```

冒烟测试覆盖：路径枚举与申请失败、挂牌合闸互锁、隔离保护整体拒绝与回滚、
乐观锁 409、角色控制、拓扑约束、审计快照等共 46 项断言。
