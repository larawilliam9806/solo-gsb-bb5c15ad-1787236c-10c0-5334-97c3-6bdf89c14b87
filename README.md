# 厂内检修断电挂牌演练 Web 应用（LOTO Drill）

基于 **Node.js + Express + SQLite（better-sqlite3）+ 浏览器原生界面** 的挂牌上锁（Lock-Out / Tag-Out）检修隔离演练系统。

- 管理员在可拖拽的供电网络图上维护 **电源 → 开关 → 设备** 的有向供电关系；
- 操作员对开关执行 **断开 → 挂牌上锁**，并为设备 **申请 / 结束检修许可**；
- **挂牌开关不得合闸**；
- 只有当 **所有「启用电源」到目标设备的路径都经过已挂牌开关** 时，检修许可才生效；申请失败会列出每一条未切断路径并在图上红色高亮；
- 许可有效期间，任何 **解牌、启用电源、改动线路** 等操作一旦使任一有效许可失去隔离，**整次操作拒绝、状态不变**；
- 多人同时改网络须携带所见的 **网络修订号（revision）**，过期提交返回 **409 与当前最新状态**；
- 每次成功变更均留存 **时间、操作者、动作、前后完整状态快照**；许可申请失败与安全拒绝同样留痕。

---

## 一、快速开始（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
# 1.（可选）自定义端口与会话密钥
cp .env.example .env
#   编辑 .env：APP_PORT=3000、SESSION_SECRET=<openssl rand -hex 32>

# 2. 构建镜像（内含依赖安装）、建库、启动，一条命令完成
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

容器启动命令为 `node server/init-db.js && node server/index.js`：

- `init-db.js` 幂等建库（建表 + 首次写入演示网络与默认账号），已有数据时自动跳过，不会覆盖；
- SQLite 数据库持久化在命名卷 `loto-data`（容器内 `/app/data/loto.db`）。

访问地址：**http://localhost:3000** （如改了 `APP_PORT`，用对应端口）

### 默认账号

| 角色 | 账号 | 密码 | 权限 |
| --- | --- | --- | --- |
| 管理员 | `admin` | `admin123` | 维护电源/开关/设备与有向线路、启停电源；亦可执行操作员全部操作 |
| 操作员 | `operator` | `operator123` | 断开/合闸开关、挂牌/解牌、申请/结束检修许可 |

> 生产环境请修改默认口令或自行改库，不要使用默认 `SESSION_SECRET`。

---

## 二、本地直接运行（Node.js 20+）

```bash
npm install          # 安装依赖（better-sqlite3 为原生模块，需要常见构建工具）

npm run init-db      # 建库 + 写入演示数据（幂等）
npm start            # 启动服务，默认 http://localhost:3000
```

端到端规则自测（需要先启动服务，且会使用当前数据库）：

```bash
node scripts/e2e-test.js    # 27 项规则断言
```

---

## 三、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（容器内固定 3000，宿主机映射由 `APP_PORT` 控制） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/loto.db` | SQLite 数据库文件路径 |
| `SESSION_SECRET` | 每次启动随机生成 | 登录 Cookie 的 HMAC 签名密钥；多实例/重启保活场景应固定，可用 `openssl rand -hex 32` 生成 |
| `APP_PORT`（Compose） | `3000` | 宿主机映射端口，见 `.env.example` |

---

## 四、操作规则说明

### 1. 节点与有向线路

- 节点三类：**电源（source）/ 开关（switch）/ 设备（device）**。
- 边 `u → v` 表示电力可从 `u` 流向 `v`；不允许自环、设备出边、电源入边和重复线路。
- 画布上黄色实线表示当前 **物理有电** 的边（从启用电源出发，挂牌或物理断开的开关不可穿越）。

### 2. 开关操作（操作员）

- 开关有两个独立属性：物理状态 `switch_open`（断开/合闸）与 `tagged`（挂牌上锁）。
- 标准上锁流程：**先断开，再挂牌**（合闸状态下挂牌会被拒绝）。
- **挂牌开关不得合闸**：对已挂牌开关发合闸请求返回 `TAGGED_CANNOT_CLOSE`。

### 3. 检修许可（设备隔离许可）

申请许可时，系统枚举从 **每一个启用电源** 到目标设备的全部路径：

- 若每条路径上都至少存在一个 **已挂牌开关** → 许可生效（记录生效时修订号、签发人、时间）；
- 只要存在一条 **未切断路径** → 申请失败（`PERMIT_NOT_ISOLATED`，HTTP 422），响应中返回路径列表，界面红色闪烁高亮。物理断开但未挂牌的开关 **不** 视为可靠隔离点。

### 4. 许可保护（安全不变量）

许可有效期间，以下操作在真正落库后会立即复核 **所有有效许可**，一旦任一许可不再满足隔离，整个事务回滚，返回 `PERMIT_ISOLATION_LOST`（HTTP 422，列出受影响许可与重新出现的路径）：

- 开关 **解牌**；
- **启用电源**（包括先建好停用电源与旁路、再启用这种情形）；
- **新增 / 删除线路、删除节点、停用电源、合闸** 等一切网络变更。

即：**整次操作拒绝且状态不变**（许可申请本身不改变网络状态与修订号）。

### 5. 多人并发：乐观修订号

- 所有网络共用一个单调递增的修订号，显示在顶栏「修订号」。
- 每条变更命令都必须携带当前所见 `revision`；与服务端不一致时返回 **409 `STALE_REVISION`** 并附带当前完整状态，前端自动采纳并提示用户重试。

### 6. 审计日志

「审计日志」页可展开查看每条记录：成功标记（r 旧 → r 新）/ 失败标记、操作者与角色、时间、动作、失败原因与未切断路径、**变更前/变更后完整网络快照**（节点开关状态、线路、许可）。

---

## 五、HTTP 接口摘要

除登录与健康检查外均需登录（HttpOnly 签名 Cookie `loto_session`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/login` | 登录，body：`{username, password}` |
| `POST` | `/api/logout` | 退出 |
| `GET` | `/api/me` | 当前用户 |
| `GET` | `/api/state` | 当前完整网络状态（含 `revision`、节点、线路、许可） |
| `POST` | `/api/command` | 执行变更，body：`{action, data:{...操作参数, revision}}` |
| `PUT` | `/api/nodes/:id/position` | 保存画布坐标（仅展示属性，不占用修订号） |
| `GET` | `/api/audit?limit=100` | 审计日志（含前后状态快照） |
| `GET` | `/api/health` | 健康检查 |

`action` 取值：

- 管理员：`addNode` / `renameNode` / `deleteNode` / `addEdge` / `deleteEdge` / `enableSource` / `disableSource`
- 操作员（管理员亦可）：`switchOpen` / `switchClose` / `tag` / `untag` / `applyPermit` / `endPermit`

示例：挂牌与申请许可

```bash
curl -c cj.txt -X POST localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"operator","password":"operator123"}'

# 携带所见修订号断开 SW4（id=7）
curl -b cj.txt -X POST localhost:3000/api/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"switchOpen","data":{"nodeId":7,"revision":0}}'
```

错误响应统一为 `{error:{code,message,extra}}`：

| HTTP | code | 含义 |
| --- | --- | --- |
| 409 | `STALE_REVISION` | 修订号过期，`extra.state` 为当前状态 |
| 422 | `PERMIT_NOT_ISOLATED` | 许可申请失败，`extra.uncutPaths` 为未切断路径 |
| 422 | `PERMIT_ISOLATION_LOST` | 操作会破坏有效许可隔离，已回滚 |
| 422 | `TAGGED_CANNOT_CLOSE` | 挂牌开关禁止合闸 |
| 403 | `FORBIDDEN` | 角色无权操作 |

---

## 六、项目结构

```
.
├── Dockerfile                 # 多阶段构建：编译原生依赖 -> 运行镜像
├── docker-compose.yml         # 构建 + 建库 + 启动 + 数据卷 + 健康检查
├── .env.example               # APP_PORT / SESSION_SECRET 示例
├── package.json
├── server/
│   ├── schema.sql             # SQLite 表结构
│   ├── init-db.js             # 幂等建库 + 演示网络/账号
│   ├── db.js                  # 连接、密码散列、状态读取、快照
│   ├── commands.js            # 命令事务：权限/修订号/隔离不变量/审计
│   └── index.js               # Express：会话、API、静态页面
├── public/
│   ├── index.html             # 登录页 + 网络图/审计双标签主界面
│   ├── styles.css
│   ├── graph-logic.js         # 有向图路径枚举与隔离判定（前后端共用）
│   └── app.js                 # SVG 网络图、乐观锁交互、许可与审计展示
└── scripts/e2e-test.js        # 27 项端到端规则自测
```

## 七、演练建议路径

1. 以 `operator` 登录，直接对 **D1-反应釜** 申请许可 → 观察失败与红色未切断路径；
2. 依次 **断开 SW4 → 挂牌 SW4 → 再次申请许可** → 许可生效；
3. 尝试 **合闸 SW4、解牌 SW4**（均被拒绝）；
4. 换 `admin` 登录，尝试从 SW2 直连 D1（新增绕过挂牌点的线路）→ 整次拒绝；
5. 再开一个浏览器窗口同时登录，两边交替操作，观察 **修订号过期 409** 提示；
6. 结束许可后，解牌、合闸恢复供电；在「审计日志」页复盘每一步的前后状态。
