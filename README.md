# 老地图图幅编目与地名对照台

面向古地图整理者和地方志研究者，将老地图按图幅编目，登记年代、比例尺、投影和扫描件，并建立古今地名对照及沿革线索。应用为纯前端单页程序，所有资料保存在浏览器本地。

## Docker 一键启动

```bash
cp .env.example .env && docker compose up -d --build
```

服务默认映射到宿主端口 `21805`。停止服务可执行：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 前端框架 | Vue 3 + TypeScript |
| 构建工具 | Vite 5 |
| UI 组件 | Element Plus |
| 状态管理 | Pinia |
| 前端路由 | Vue Router 4 |
| 本地数据 | IndexedDB + Dexie 4 |
| 容器运行 | Nginx Alpine |

## 访问地址

浏览器访问 [http://localhost:21805](http://localhost:21805)。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

开发服务器默认使用 `5173` 端口。执行 `npm run build` 可进行 TypeScript 检查并生成生产构建。

## 目录结构

```text
.
├── frontend/
│   ├── public/
│   │   └── offline-pkgs/      # 内置离线校勘示例包（npm run samples 生成）
│   ├── scripts/               # 示例包生成与离线合并引擎测试
│   ├── src/
│   │   ├── components/common/   # 扫描件、地名行、比例尺标签与空态
│   │   ├── components/offline/  # 离线包冲突补证卡片
│   │   ├── hooks/               # 地名反向检索、图幅邻接解析
│   │   ├── pages/               # 六个业务页面
│   │   ├── router/              # 路由表
│   │   ├── stores/              # 图幅、地名、沿革与离线合并状态
│   │   ├── types/               # 数据模型与枚举
│   │   ├── utils/               # Dexie、散列、离线合并引擎、比例尺与导出
│   │   ├── App.vue
│   │   ├── main.ts
│   │   └── style.css
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

## 数据存储说明

应用使用 IndexedDB 持久化数据，Dexie 数据库名为 `gboldmap-db`。数据库包含 `sheets`、`scans`、`placePairs`、`histories`、`contentMeta`、`offlinePackages` 六个对象仓库：

- `version(1)` 建立首版索引结构，并在首次创建数据库时写入图幅、扫描件、地名对照和沿革种子数据。
- `version(2)` 保持现有索引并对已有图幅执行 `schemaRev = 2` 的回填迁移，用于演示后续结构升级路径。
- `version(3)` 新增两张表：`contentMeta` 记录每条图幅/扫描件/地名的 `sourceKey` 血缘与当前内容散列；`offlinePackages` 暂存协作馆断网带来的离线校勘包、校验结论、冲突补证与处理日志。升级时为已有数据回填血缘散列，**升级前的老数据仍能读取与比对旧包**。

刷新或关闭页面不会丢失新增记录；浏览器站点数据被清除时会重新触发首次种子数据写入。

## 离线校勘包

协作馆断网时可把校勘成果打成单个 JSON 包（离线校勘合并页可载入内置示例包）。合并纪律如下：

1. 包内图幅、扫描件、地名对照都带 `sourceKey` 与 `baseHash`；扫描件与地名按打包当时的**图幅号**关联到本地图幅。
2. 导入时先做整包摘要（`packageHash`）与逐件内容散列（`payloadHash`）校验，结构错误或散列不符整包拦截，原包仍保留在待处理区。
3. 同一 `sourceKey` 的本地内容散列若既不等于 `baseHash` 也不等于包内新内容散列，说明馆员在协作馆打包之后改过本地内容——列为冲突，**绝不自动覆盖**；图幅号已属另一来源时报“图幅号撞号”。
4. 只有「整包校验通过且没有未决冲突」时才允许合并；所有业务表、血缘散列与包状态在同一个 IndexedDB 事务中一次性写入，中途失败整体回滚。重试同一包不会多出记录（已并入内容再次评估全部为 noop）。
5. 冲突项留在待处理区，馆员补证填写依据后可选择「保留本地」「采用包项」（撞号只能「跳过该条」）；补证后本地又被改动时裁定自动失效，需重新补证。
6. 原包、进度、冲突与处理说明都持久化在 `offlinePackages` 表，离开页面再回来继续处理；已合并/已丢弃的包也可下载原包或展开查看。
7. 编目台页面（图幅、扫描件、地名）始终是本地业务数据的唯一写入方；离线页只暂存包并在确认后经同一套写通道落库。

示例包由 `npm run samples` 重新生成（输出到 `frontend/public/offline-pkgs`），纯逻辑合并引擎的端到端测试用 `npm run test:offline` 运行。

## 核心功能与路由表

| 路由 | 核心功能 |
| --- | --- |
| `/sheets` | 按年代、比例尺和状态筛选图幅，内联新建图幅，查看扫描件数、地名数与邻接缺编提示 |
| `/sheets/:id` | 查看编制摘要、扫描件条目、主用件切换、图内地名检索及 JSON 导出 |
| `/places` | 古今地名双栏对照，按类型和确定度筛选，对古名、今名、异写及图上方位反向查询并高亮 |
| `/places/:id/history` | 按年代排列沿革时间线，新增初置、改名、迁治或废置记录 |
| `/sheets/:id/neighbors` | 按四至排列邻接图幅，显示主用扫描件、缺编提示与拼合预览 |
| `/offline` | 导入协作馆断网校勘包，查看校验结论与冲突、补证后整包合并 |
| `/`、未匹配路径 | 自动跳转到 `/sheets` |
