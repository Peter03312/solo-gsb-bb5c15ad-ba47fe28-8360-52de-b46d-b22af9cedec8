# 口述史事件年表（Oral History Chronicle）

为地方口述史团队设计的事件年表 Web 应用：编辑者录入**事件**、带**出处**的时间主张（可精确到年、月或日）以及事件间的**“先于”关系**；同一事件允许保留互相矛盾的主张。发布时为每个事件选定一条主张，经严格校验后冻结为**不可变版本**。

- 运行时：Node.js（内置 `http`，无 Web 框架）+ SQLite（通过 [`sql.js`](https://github.com/sql-js/sql.js) WebAssembly 引擎，零原生编译，数据落盘为标准 SQLite 文件）
- 前端：原生 HTML/CSS/JavaScript，无需构建步骤
- 本机即可运行，也提供 Dockerfile 与 Compose 一键启动（含依赖安装与数据库初始化）

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build -d
```

首次启动会自动安装依赖、初始化数据库（建库建表）。然后访问：

| 用途 | 地址 |
| --- | --- |
| 访客年表（最新已发布版本） | http://localhost:8080/ |
| 编辑工作台（草稿 / 校验 / 发布） | http://localhost:8080/editor |

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 停止；数据保留在命名卷 chronicle-data 中
```

### 方式二：本机直接运行（需 Node.js ≥ 20）

```bash
npm install
npm start
```

数据库首次运行时自动创建于 `./data/chronicle.sqlite`，访问地址同上。

### 运行测试

```bash
npm test
```

覆盖：日期区间计算、先后关系约束传播、环检测、发布快照不可变、409 版本冲突、422 校验拒绝、访客可见性、编辑口令与 SQLite 文件持久化。

## 配置

所有配置通过环境变量完成（均有默认值，可零配置启动）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直接运行可设 `127.0.0.1`） |
| `DB_PATH` | `./data/chronicle.sqlite` | SQLite 数据库文件路径；首次启动自动初始化 |
| `EDITOR_TOKEN` | 空 | 编辑口令。**留空时本机不鉴权**；设置后，所有 `/api/draft/*` 写接口与编辑界面需通过 `X-Editor-Token` 头（界面上为登录框）验证。访客只读页面与口令无关。 |

用 Compose 配置：复制 `.env.example` 为 `.env`，修改 `HOST_PORT` / `EDITOR_TOKEN` 后 `docker compose up -d`。

本机带口令运行示例：

```bash
EDITOR_TOKEN=duhua2026 PORT=8080 npm start
```

## 业务语义

### 数据模型

- **事件（events）**：标题、描述。
- **时间主张（claims）**：从属于事件，含年/月/日（月、日可空，分别表示精确到年、月、日）、**出处**（访谈编号、档案、页码等）与备注。同一事件可录入任意多条主张，**互相矛盾的主张原样保留**，发布时单选其一。
- **“先于”关系（relations）**：有向边 `A 先于 B`，语义为**严格早于至少一天**；不允许自环、不允许重复边。

### 发布规则

点击“发布不可变版本”时，系统对当前草稿做如下校验，任一不满足则**拒绝发布，保留上一已发布版本**，并明确标出涉事事件与关系：

1. **缺少主张**：存在没有选定主张的事件——列出事件；
2. **主张失效**：所选主张已被删除或不属于该事件——列出事件与原因；
3. **关系成环**：“先于”图存在有向环——列出环上的事件序列与涉事关系 ID；
4. **时间无解**：把每条所选粗粒度主张视为其**覆盖时间区间**（年 → 1月1日至12月31日；月 → 该月首日至末日；日 → 当天），沿关系图做最早日期传播；只有**每个事件都能在自己的区间内取得一个严格晚于所有前驱的具体日期**时才可行。失败时列出事件、其区间上下界、决定性前驱事件链与涉事关系 ID。

校验通过后：插入一条新版本，并把当时每个事件、**所选主张（含出处）**、解析出的具体日期、全部关系复制进版本快照表。快照表带有 SQL 触发器，禁止任何 `UPDATE` / `DELETE`，实现版本不可变。访客端按解析日期排序展示年表。

> 粗粒度日期在年表上显示为“覆盖区间内为满足先后关系而确定的最早可行具体日期”，原始记录精度（年/月/日）与出处同时展示，不会把推断日伪装成原始记录。

### 两名编辑者并发：版本冲突（不静默覆盖）

- 编辑工作台记录“当前已发布版本”；发布请求必须携带发起修改时所依据的 `baseVersionId`。
- 若编辑者乙提交时，编辑者甲已基于同一旧版本发布了新版本，乙收到 **409 版本冲突**：提交被整体拒绝、不写入任何数据，响应中附上甲的最新年表。
- 界面弹出冲突面板，乙须**查看最新年表、勾选“已重新确认每个事件的主张选择”**后，才能基于最新版本重新发布。

### 访客可见性

- 访客接口 `/api/timeline` 只返回**最新已发布版本**及其所选出处；
- 草稿事件、未被选中的矛盾主张、未发布的关系对访客完全不可见；历史版本也不提供遍历接口；
- 尚未发布任何版本时，访客页提示“尚无已发布年表”。

## HTTP API 摘要

**公开（只读）**

- `GET /api/timeline` — 最新已发布年表（无版本时返回 `null`）
- `GET /api/config` — `{ authRequired }`

**编辑（草稿区；设置 `EDITOR_TOKEN` 时需请求头 `X-Editor-Token`）**

- `GET /api/draft` — 草稿全部事件 / 主张 / 关系 + 当前已发布版本
- `POST /api/draft/events`、`PATCH/DELETE /api/draft/events/:id`
- `POST /api/draft/claims`（body: `event_id, year, month?, day?, source, note?`）、`DELETE /api/draft/claims/:id`
- `POST /api/draft/relations`（`predecessor_id, successor_id, note?`）、`DELETE /api/draft/relations/:id`
- `POST /api/draft/validate` — 仅校验不写库（body: `{ selections: {eventId: claimId} }`）
- `POST /api/draft/publish` — 发布（body: `{ baseVersionId, selections, note? }`）
  - `422` 校验失败（响应体 `result` 含缺少选择 / 环 / 时间无解的明细）
  - `409` 版本冲突（响应体 `conflict` 含最新版本与年表）

## 目录结构

```
src/
  dates.js     年/月/日区间、序数日、输入校验
  evaluate.js  发布可行性评估（选主张 / 环检测 / 严格先后约束传播）
  publish.js   发布事务、快照、409 乐观并发控制
  schema.js    SQLite 表结构与不可变触发器
  db.js        sql.js 初始化、事务串行化、落盘持久化
  server.js    HTTP 路由与静态页面
public/        访客页与编辑工作台（原生前端）
test/          node --test 自动化测试
Dockerfile, docker-compose.yml, .env.example
```

## 备份

数据库为单个标准 SQLite 文件：本机运行见 `DB_PATH`；Compose 部署在命名卷 `chronicle-data`（容器内 `/app/data/chronicle.sqlite`），直接复制该文件即可备份，可用任意 SQLite 工具打开（已发布表只读）。
