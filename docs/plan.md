# Overleaf Agent 协作与 MCP 开发计划

调研及决策更新日期：2026-11-05（Asia/Shanghai）。状态：m701 已运行隔离的 CE 6.3.2 实验环境，stdio MCP 的列项目和编译闭环已验证；个人密钥 URL 接入与实时编辑尚待实现。旧服务保持运行。

## 1. 目标与本轮决策

同学继续在 Overleaf 网页共同编辑，登录后生成属于自己的 MCP URL，复制到 Agent 客户端即可连接。URL 携带随机访问密钥，由服务端映射到该用户及授权范围，无须客户端再进行浏览器授权。Agent 使用同一人类用户身份下的独立授权，不创建第二个 Overleaf 用户。网页中的 `张三的 Agent` 是受服务端验证的连接标记；平台记录用户、客户端、授权项目与操作结果。

2026-11-05 用户澄清：每个用户生成专属的、可直接连接的 MCP URL。此决定替代此前对“链接”的 OAuth 导入入口解释，同时保留同一人类账号下的委托访问模型。现有独立 Agent 实验账号仅作为开发夹具保留。

建议采用以下默认方案推进：

- 官方 Overleaf CE 作为协议与部署基线，自建独立的 MCP 服务及 Overleaf 适配层。复用 Overleaf 原有协作与项目权限，增加范围明确的授权入口、受限委托身份与 Agent 连接显示扩展；应用补丁随固定上游版本维护。
- 实验基线是 CE 6.3.2，镜像 digest 已固定；实际 TeX Live 和依赖版本记在开发仓库 `docs/progress.md`。源码调查和镜像运行验证分别记录。
- 每位同学仍只有原有 Overleaf 账号；每条专属链接对应独立 grant，可重置或撤销，也可按客户端增发链接。客户端无法通过工具参数指定或伪造其他用户身份。
- 保留已验证的本地原型作为协议测试工具；下一阶段优先完成 HTTP MCP、登录后生成专属密钥 URL 和撤销，再扩展实时编辑。评论、原生修订审批、SSO 扩展单独评估。
- 旧实例继续提供服务。m701 实验使用独立 Compose 网络、数据库、Redis 和 volumes，入口仅绑定回环地址；后续 K8s 使用独立 namespace、PVC 和域名。
- 源码放独立仓库；本 GitOps 仓库保存部署配置与必要运维记录。技术栈暂定 TypeScript + 官方 MCP SDK，最终在协议实验后确定复用依赖。

## 2. 开源方案与版本依据

| 方案 | 已核实的事实 | 规划用途 |
| --- | --- | --- |
| 官方 Overleaf CE | 开源仓库 AGPL-3.0；官方发布页当前最新条目是 6.3.2（2026-10-23，含安全更新）。具备实时协作与具名用户；评论、实时修订和 Git Bridge 在官方产品划分中属于 Pro。[S1][S2] | 默认基线，可先完成 Agent 直接读写与编译。 |
| 官方 Toolkit | 部署管理工具，不是另一个 Overleaf 版本；当前配置指向 6.3.2，MongoDB 8.0、Redis 7.4，并启用 Redis AOF。[S3] | 作为依赖、配置与启动顺序的来源，转化为本仓库的 K8s 配置。 |
| overleaf-cep（CE+） | 社区 fork，维护者声明增加评论、修订、身份接入、编译沙箱等；当前可见发布标签含 `v6.3.0-ext-v5.1`，需要单独核对安全更新与构建内容。[S4] | 若原生审阅或编译隔离成为上线必需能力，做独立验证；暂不同时承担它与 MCP 的全量定制。 |
| 第三方 MCP | `overleaf-mcp-rt 2.2.0`、`overleaf-web-mcp 0.8.1` 都提供网页会话与 OT 接入参考；前者声明有多版本 CE 测试，后者提供协议文档。[S5][S6] | 用作协议参考、对照测试或经评估后的依赖。选择依据是代码、许可证、测试和维护能力；star 数作为辅助信息。 |

6.x 发布说明要求 MongoDB 8、Redis 7.4；6.2 新增必需的 `OVERLEAF_INVITE_TOKEN_SECRET`。部署前对照目标镜像核实，不沿用旧实例 MongoDB 6 的约束。官方 GitHub releases API 仍含古早 0.x 记录，版本选择应依据官方发布页与 Toolkit。[S1][S3]

## 3. 已理解的接口与调用链

初轮源码调查固定在 main 提交 `e039ad26c5bf5422eb57b89fc7e57c75055e631d`；实际 CE 6.3.2 镜像标注的 revision 是 `370f4763da4bc910da8309c9a71c85ecbe39f6a7`。登录、列项目和编译已在目标镜像验证，实时写入仍需按目标源码核对。以下是应用内部接口，上游升级时需验证兼容性。

| 能力 | 已阅读源码中的入口 | 实现约束 |
| --- | --- | --- |
| 登录、会话 | `GET/POST /login`；登录流程带限流等中间件 | 适配 cookie、CSRF、失效和重登；用户给 MCP 的访问令牌与 Overleaf 会话分别管理。[S7] |
| 项目列表、设置 | `POST /api/project`，`POST /project/:Project_id/settings` | 保留应用权限校验；项目 ID 不能作为授权证明。[S7] |
| 创建文档、目录 | `POST /project/:Project_id/doc`、`.../folder` | 通过应用接口操作文档树；创建、重命名、移动分别映射，避免直接改存储。[S8] |
| 读取与实时编辑 | Socket.IO：加入项目、`joinDoc`、`applyOtUpdate`，以及 `joinProjectResponse` | 维护文档版本、操作队列、ack 和并发转换；区分 ShareJS 与 history-OT 格式，未知格式停止写入。[S9][S10] |
| 在线成员与光标 | `clientTracking.getConnectedUsers`、`clientTracking.updatePosition` | 原生服务端用会话中的用户资料构造姓名和 user_id；同一用户的 Agent 标签需要增加受信任的连接元数据和显示逻辑。[S9][S10][S11] |
| 编辑归属 | `applyOtUpdate` 中服务端写入 `update.meta.user_id` 和 source | 保持人类 user_id；Agent 连接增加受信任的 actor/client/grant 元数据。原生历史仍按用户归属；按 Agent 区分的审计与历史展示需另外实现。[S10] |
| 编译与产物 | `POST /project/:Project_id/compile`、构建结果与 PDF 下载路由 | 返回构建标识、状态、日志和受权限保护的产物；验证编译输入版本与运行中编辑的关系。[S7] |
| 项目成员 | 邀请、接受邀请、移除成员等路由 | 项目所有者授权；MCP 运行工具不暴露成员管理或站点管理员接口。[S12] |
| 实验账号初始化 | CE 的用户创建模块 | 仅用于实验夹具；产品接入复用已登录的人类账号，不再开通独立 Agent 用户。[S13] |

实时服务调用的 private API（例如内部 `/project/:Project_id/join`）有内部认证要求；受限委托接入需要贯穿现有认证与权限链路，内部服务接口保持在服务网络内。

```mermaid
flowchart LR
    H[同学的浏览器] --> W[Overleaf Web / real-time]
    A[同学自己的 Agent] --> M[MCP 传输层]
    M --> D[身份绑定与项目授权]
    D --> O[Overleaf 协议适配层]
    O -->|同一用户的受限委托身份 / HTTP / OT| W
    W --> U[document-updater / docstore / filestore]
    W --> C[CLSI 编译服务]
```

Overleaf 继续负责协同状态与内容持久化；我们的服务保存用户授权、客户端与委托会话引用、请求结果及必要审计信息。普通读写工具不接触 Overleaf 的 MongoDB、Redis 或 PVC。

## 4. 用户登录后的 Agent 授权

### 用户流程

1. 用户正常登录新版 Overleaf，在设置页点击“生成我的 MCP 链接”。
2. 服务端生成绑定当前用户的专属 URL，例如 `https://mcp.example.com/mcp/p/<key-id>.<random-secret>`（示意地址）。创建页可选择全部本人可访问项目或指定项目，以及读取/编辑/编译权限。
3. 用户把完整 URL 填入 Agent 客户端的 HTTP MCP 地址栏，即可连接。无额外 OAuth 跳转，也不需要提供 Overleaf 密码或 Cookie。
4. MCP 从密钥查到用户和授权，以该用户身份操作项目；编辑归属原用户，在线连接可以显示“张三的 Agent”。
5. 设置页显示链接名称、授权范围、创建及最后使用时间，并提供撤销和重新生成。完整密钥只在生成时显示；之后通过重新生成获得新链接，原链接立即失效。

首期每位用户可先生成一条个人链接；数据结构支持按客户端增发，便于分别命名与撤销。同一链接可以重连并维持多个会话；浏览器登出不自动使它失效。链接默认持续有效直至撤销，也可设置过期时间。分享完整 URL 即授予其持有人相应权限，因此将它存放在客户端个人配置中。

### 协议与客户端

传输使用 Streamable HTTP；在入口验证 URL 密钥后交给 MCP SDK。MCP 请求和响应、初始化、工具调用保持标准格式。[S17] 这是自定义个人密钥认证：MCP 的标准 HTTP 授权方案采用 OAuth 和 Authorization 请求头，并禁止将 OAuth access token 放在查询参数中。[S14] 本方案不把密钥 URL 宣称为该 OAuth 流程，也不将路径中的密钥理解为已验证的客户端身份。

首期验证一个允许手工填写完整 HTTP MCP URL 的实际客户端，再验证第二种。VS Code 的官方文档提供手工输入 MCP endpoint 的入口，可作为候选；尚未对本服务完成客户端实测。[S18] 某些托管客户端可能要求 OAuth，可后续增加共享地址加标准授权入口，个人 URL 仍保留。

### 服务端设计

- Overleaf 中加入受会话认证和 CSRF 保护的密钥生成、列表、撤销与重置接口。用户身份只取自已验证的登录上下文。
- 使用密码学安全随机源生成至少 32 字节的 secret，编码为 URL-safe 字符；key-id 用于查找记录，不能单独授权。数据库保存 secret 摘要、user_id、grant_id、用户指定名称、项目/动作范围、有效期和撤销状态。
- 每个 HTTP 请求先验证完整密钥、grant 状态与用户状态，覆盖 POST、GET 和 DELETE。MCP session 绑定 grant/user；持有 session-id 不能绕过密钥认证或跨用户使用会话。工具参数不能改变身份。
- 全部外部请求使用 HTTPS；避免重定向。网关、应用、错误报告和 tracing 在记录前移除完整密钥路径，以 grant_id 记录请求；检查测试密钥不会出现在这些日志中。生成页面设置 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`，不加载第三方追踪资源。将密钥放在路径中同样需要这些保护。
- MCP 内部建立限定范围的 Overleaf 委托上下文，包含 user_id、grant_id、actor_type=agent、项目范围、动作范围和有效期。个人 URL 密钥留在 MCP 边界，用户的日常浏览器 Cookie 不交给 Agent。P1 固定与目标版本 HTTP/Socket.IO 认证中间件的衔接。
- 每次 HTTP 操作和实时加入/写入同时验证 grant、动作范围、项目范围和该用户当前的 Overleaf 项目权限。选择“全部项目”时随当前权限变化，权限移除后立即失去访问。MCP 不暴露站点管理接口。
- 撤销或重置后拒绝新请求，关闭关联实时连接；活动文档的后续操作也重新校验权限。已经提交的编辑不因撤销而回滚。
- 原生编辑继续归属于同一 user_id；“张三的 Agent”由服务端认证的 grant/连接标记产生。在线列表和光标需要 Overleaf 服务端与界面扩展，原生历史按用户归属。[S10][S11]
- 同一密钥被多个客户端使用时，能够区分会话，但不能验证客户端自报名称。需要独立撤销或可信命名时，由用户创建不同的命名链接。审计记录用户、grant、session 和操作结果。
- 当前 stdio 账号密码配置仅用于隔离实验；产品接入以个人密钥 URL 为首期方式。

## 5. 功能范围

工具名称是计划中的契约，不是已实现接口。

| 优先级 | 功能 | 拟定接口及行为 |
| --- | --- | --- |
| P0 | 版本与能力诊断 | `capabilities`：Overleaf 版本、文档协议、读写与编译是否可用；兼容性不满足时给出明确原因。 |
| MVP | 身份 | `whoami`：当前用户、客户端/Agent 连接标记、当前授权；不返回凭据。 |
| MVP | 项目浏览 | `list_projects`、`get_project_tree`：只显示获授权的项目和资源。 |
| MVP | 文档上下文 | `read_document`：全篇或分段读取，返回文档 ID、版本、内容摘要；`search_project` 提供有数量和体积限制的文本搜索。 |
| MVP | 局部编辑 | `edit_document`：唯一匹配的旧文本、目标文本、基准版本或摘要、`dry_run`；返回实际 diff、新版本及冲突信息。 |
| MVP | 文件补充 | `create_document`：新增 `.tex`/`.bib` 等文本；限定大小。二进制上传放到后续。 |
| MVP | 协作者变化 | `get_changes`：自指定检查点以来的变化或重新读取要求；检查点过期时返回明确提示。 |
| MVP | 编译闭环 | `compile_project`、`get_compile_result`：构建状态、错误位置、日志、PDF 等；按项目限制并发和频率。 |
| MVP | 访问撤销 | 关闭 MCP 授权、断开 Agent 会话；管理员可暂停指定 Agent。 |
| MVP | 操作记录 | 记录用户、Agent、项目、请求 ID、前后版本和结果；敏感文档内容默认不写普通日志。 |
| 后续 | 项目维护 | 文件上传、重命名、移动，带明确错误与恢复路径。 |
| 后续 | 审阅与恢复 | 修改预览、保存变更记录、按当前版本生成逆向补丁；有人继续编辑后不直接覆盖回旧快照。 |
| 可选 | 原生评论与修订 | 只有选择并验证 CE+/Pro 对应能力后实现；MCP 的 dry-run diff 可先满足修改预览。[S2][S4] |
| 可选 | 客户端身份细分 | 同一用户不同客户端显示不同连接标记；接入界面分别管理授权。 |

首期不开放删除项目、删除账号、修改权限、直接数据库访问、任意 shell 命令。首期专注协作读写和编译，自动写论文、文献检索和选模型由同学的 Agent 工作流负责。

## 6. 编辑与故障语义

- 默认局部补丁；旧文本找不到或多次匹配时返回冲突，不猜测修改位置。
- 每份文档有独立串行提交队列，其他协作者的变更通过 OT 处理；测试中文、emoji 等字符的偏移单位。
- 观察版本变化并匹配当前内容；内容检查与发送之间的竞争由 OT 与服务器版本机制处理。仅在读取时比对一次 hash 不足以保证并发正确。
- 请求携带 operation_id。成功、失败、结果未知分开记录；断线发生在提交之后而 ack 之前时，先恢复状态并核对，避免自动重复应用。
- 多文档修改返回逐文档结果，第一期不提供跨文档原子事务。
- 编译关联 build_id 与已知文档版本；如果有并发编辑，结果标注实际可确定的输入状态，不把旧 PDF 当作最新修改的产物。
- 工具返回冲突、未授权、会话失效、限流、不支持的协议、编译失败等机器可判别错误。

## 7. 分阶段交付

| 阶段 | 主要工作与产出 | 验收信号 |
| --- | --- | --- |
| P0：版本与接口验证 | 锁定 CE 镜像及 revision、依赖、TeX 环境；搭独立实验环境；记录 HTTP/实时事件、会话、CSRF、文档格式；以现有 MCP 做对照；完成代码复用与许可证选择。 | 测试账号可登录、列项目、读一个文档并编译；接口表对应目标镜像。 |
| P1：个人 URL 与 HTTP 接入 | 两个人类测试用户；登录后生成密钥 URL，HTTP MCP 验证与受限委托身份，whoami、列表、重置及撤销。 | 只填写个人 URL 即可连接；两用户不串用；项目/动作范围有效；撤销和重置生效；日志无完整密钥。 |
| P2：写入和编译闭环 | 适配 OT、会话级 Agent 标记、局部编辑、创建文本、变更读取、编译及日志/PDF；HTTP 和本地调试复用业务实现。 | 人和 Agent 在同一文档编辑，服务端与客户端内容一致；编译产物对应测试修改。 |
| P3：多人试用完善 | 第二种客户端验证、自助授权管理、连接标记、操作记录与配额；补齐项目权限变化与长连接撤销。 | 两名测试用户和两种客户端可用；网页区分同账号的人与 Agent；撤销后活动连接不能继续访问。 |
| P4：K8s 小范围试用 | 独立服务镜像、Argo 配置、存储与会话恢复、Gateway 超时、网络策略、指标与备份；从少量测试项目开始。 | 重启/断线可恢复，构建与编辑错误可定位；验证部署回退；确认编译执行隔离适合预期用户。 |
| P5：可选增强与旧数据迁移 | 根据反馈决定 CE+、原生审阅、多客户端身份；单独演练旧数据恢复、版本升级与用户/项目映射。 | 代表项目、图片、参考文献及必要历史恢复成功；迁移与正式切换方案可审阅。 |

依赖顺序为 P0 → P1 → P2 → P3 → P4；P5 的数据盘点可以提前做，生产迁移在试用后安排。若 P0 发现协议无法可靠适配，先评估一个范围明确的上游补丁或 CE+ 分支，再继续身份和写入开发。

P4 不必先做多副本：可以先单副本并支持重连与恢复。扩容时按账号/项目分配连接所有权，防止多个进程重复提交同一文档操作。

## 8. 最小有效验证集合

使用两个人类测试用户及各自密钥 URL 建立的 Agent 连接、一个共享项目和一个不共享项目、两个文档及一个图片附件。不为 Agent 创建额外 Overleaf 用户。

1. 正常流程：登录 → 读取 → 修改一句话 → 网页可见 → 编译 → 获取 PDF。
2. 并发：人和 Agent 改不同位置；改同一目标文本时得到合并结果或明确冲突，内容不丢失。
3. 断线：提交前断开、提交后 ack 前断开、会话过期；重连后不重复修改。
4. 权限与密钥：越权项目 ID、密钥与会话跨用户混用、重置后使用旧链接、撤销后活动 WebSocket 的后续操作均被拒绝；客户端初始化及重连可用，网关和应用日志不含测试密钥。
5. 编译：一个成功样例、一个含已知错误的样例；日志位置和产物版本可解释。
6. 兼容：目标镜像重建后重复基本闭环；后续升级先在测试环境跑相同集合。

首轮只针对以上实际接口行为编写集成测试，不先建设全版本兼容矩阵。

## 9. 数据保留与部署边界

旧实例暂不下线。保留范围包括 MongoDB、Redis、Overleaf 文件及历史存储，以及恢复所需配置。官方说明新镜像可能自动执行数据迁移，且没有通用的两个实例数据合并流程；因此实验阶段不向新版积累需要合并的正式数据，也不让其写旧库。[S15]

后续在约定维护窗口完成一致性备份，在独立副本上恢复并升级。正式迁移时明确选择完整保留账号/历史，或逐项目导入并接受其信息范围；不要将 ZIP 导入当作全量迁移。新数据库升级后的回退按旧版备份恢复设计，不假设换回镜像即可撤销数据库迁移。

CE 编译在应用环境内运行子进程；K8s Pod 本身不提供项目之间的编译隔离。[S16] P0/P2 先用测试项目验证协议，P4 前明确编译进程的文件、网络、资源与 shell-escape 边界。若选择 CE+ 沙箱或单独编译工作节点，将其作为独立部署工作包。

## 来源

- [S1] [官方 6.x 发布说明](https://docs.overleaf.com/on-premises/release-notes/release-notes-6.x.x)
- [S2] [官方角色与权限](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions)
- [S3] [Toolkit version](https://github.com/overleaf/toolkit/blob/master/lib/config-seed/version)、[overleaf.rc](https://github.com/overleaf/toolkit/blob/master/lib/config-seed/overleaf.rc)
- [S4] [overleaf-cep](https://github.com/yu-i-i/overleaf-cep)、[发布记录](https://github.com/yu-i-i/overleaf-cep/wiki/)
- [S5] [overleaf-mcp-rt](https://github.com/DanielHou315/overleaf-mcp-rt)
- [S6] [overleaf-web-mcp](https://github.com/mhmdaskari/overleaf-web-mcp)、[协议说明](https://mhmdaskari.github.io/overleaf-web-mcp/internals/)
- [S7] [Web router 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/app/src/router.mjs)
- [S8] [EditorRouter 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/app/src/Features/Editor/EditorRouter.mjs)
- [S9] [实时 Router 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/Router.js)
- [S10] [WebsocketController 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/WebsocketController.js)
- [S11] [ConnectedUsersManager 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/ConnectedUsersManager.js)
- [S12] [CollaboratorsRouter 固定源码](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/app/src/Features/Collaborators/CollaboratorsRouter.mjs)
- [S13] [CE create-user 脚本](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/modules/server-ce-scripts/scripts/create-user.mjs)
- [S14] [MCP HTTP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [S15] [Overleaf 数据与备份](https://docs.overleaf.com/on-premises/maintenance/data-and-backups)
- [S16] [编辑与编译流程](https://github.com/overleaf/overleaf/wiki/Editor-and-Compile-Process)

- [S17] [MCP Streamable HTTP 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [S18] [VS Code 手工连接 MCP 服务](https://code.visualstudio.com/docs/agent-customization/mcp-servers#connect-a-server)
