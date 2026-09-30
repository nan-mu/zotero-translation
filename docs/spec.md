# Zotero 自动翻译插件：设计与实现规格

**文档状态：** 可交付开发 Agent 的 v1 规格  
**目标平台：** Zotero 桌面版（以 Zotero 7+ 的 bootstrapped 插件结构为起点；开发前验证实际安装版本）  
**后端：** 在 Mac 上运行的 HTTP 翻译服务，内部使用 BabelDOC；插件不直接调用 BabelDOC  
**协议：** HTTP/JSON + PDF 二进制上传/下载；**不使用 gRPC**  
**目标：** 通过 Zotero 标签发起任务，自动取回双语 PDF，安全更新条目与标签

## 0. Agent 工作指令与边界

请以本文件为**需求规格**实现可安装、可测试的 Zotero 插件及服务端 HTTP API 的明确契约。优先交付完整的插件；如果后端不在当前仓库，则提供可运行的 Mock HTTP 服务和 API 契约测试，**不要假设已有 API 已实现**。检查实际 Zotero 版本与公开的插件示例，不要复制已过时的 Zotero 6/XUL 扩展写法。

必须保留下面精确的 Zotero 标签/附件标题；不允许擅自改名或翻译：

- 触发标签：`急需翻译`
- 完成标签：`翻译完成`
- 原文缺失标签：`缺少PDF`
- 失败标签：`翻译失败`
- 原始附件**标题**：`Full Text PDF`
- 生成附件**标题**：`翻译对照 PDF`

插件负责**查找、排队、上传、轮询、下载、导入、标签更新、清理**；后端负责**任务持久化和 BabelDOC 翻译**。v1 必须回传双语 PDF；Markdown/TXT 在第 12 节单列为兼容性扩展，不得使 PDF 主流程依赖文档解析能力。

## 1. 核心约定

1. 查询所有**顶层文献条目**中带有 `急需翻译` 标签的条目，附件自身的标签不作为触发条件。
2. 所有判断和新附件都作用于同一**原文献条目**，不能创建无父项的译文附件或修改原始 PDF。
3. 附件标题比较采用完全匹配（含大小写、空格）。只接受实际可读的 PDF；如果 `翻译对照 PDF` 附件记录存在但文件已丢失，不视为成功。
4. `id` 定义为对**原始 PDF 文件原始字节**计算的 SHA-256，64 位小写十六进制；插件、服务端计算结果必须一致。
5. v1 **一个 Hash 对应一个翻译任务**，服务器全局使用固定目标语言和翻译配置。**更换目标语言/模型/翻译配置时，必须清理或迁移旧任务**；若未来需要多配置并存，应将任务 ID 扩展为 `(source_hash, profile_id)`，不能继续只用 PDF Hash 区分不同译文。
6. 服务器状态名称沿用约定：`pending`、`down`、`error`。`down` 表示**已生成、校验完成、可以下载**，不是“正在下载”；HTTP 下载过程不引入新的业务状态。
7. 首版按**单个 Zotero 客户端实例**管理服务端清理。多个 Zotero 客户端/其他 API 消费者同时共享同一 Hash 时，简单 `DELETE` 无法保证所有消费者已下载，超出 v1 保证；服务器可额外采用保留期以防误清理。
8. 插件不得直接修改 Zotero 的 SQLite 数据库。所有条目修改使用 Zotero JavaScript API。

## 2. 用户可观察的行为

| 条件 | 插件动作 | 结果标签 |
|---|---|---|
| 存在可读的 `翻译对照 PDF` | 不访问服务器；移除 `急需翻译`，添加 `翻译完成` | `翻译完成` |
| 不存在译文，且不存在可读的 `Full Text PDF` | 添加 `缺少PDF`，不提交任务 | 保留 `急需翻译`，添加 `缺少PDF` |
| 存在原文，首次加入处理 | 清除过时的 `缺少PDF`；计算 SHA-256，查询服务端任务 | 保留 `急需翻译` |
| Hash 不存在 | 上传原文到 `SubmitDocument` 对应的 HTTP 路由 | 保留 `急需翻译` |
| 状态 `pending` | 不做业务修改，下次扫描继续查询 | 保留 `急需翻译` |
| 状态 `down` | 下载、校验、导入译文 PDF；成功后更新标签 | 移除 `急需翻译`、`缺少PDF`、`翻译失败`；添加 `翻译完成` |
| 状态 `error` | 添加 `翻译失败`；不自动重复提交 | 保留 `急需翻译`、添加 `翻译失败` |
| 网络超时 / HTTP 5xx | 记录诊断，退避后再试；不能误标翻译失败 | 原标签不变 |
| HTTP 401/403 | 暂停所有任务，提示检查 Token | 原标签不变 |

**失败重试规则：** `翻译失败` 是粘性标签。普通扫描不对已有该标签的条目再次提交/重试；如果已有有效译文附件，仍应执行第一行的成功修复。v1 提供手动 `重试翻译` 命令：服务端接受重试后，插件才移除 `翻译失败`，保留或添加 `急需翻译`。仅删除 `翻译失败` 标签不能使服务器已有的 `error` 任务自动恢复；必须调用重试 API，避免无穷重试循环。

## 3. 插件结构

按当前受支持的 Zotero bootstrapped 插件方式实现，推荐模块边界如下（文件扩展名、构建工具由实现者根据 Zotero 版本选择）：

```text
zotero-translation/
  manifest.json              # 插件元数据和已验证的兼容版本范围
  bootstrap.js               # startup/shutdown 等生命周期入口
  src/
    settings                 # 服务端地址、Token、扫描间隔等
    zotero-repository        # 搜索条目、读取附件、修改标签、导入文件
    hasher                   # SHA-256，分块读取 PDF
    http-client              # 只封装本文定义的 HTTP 接口
    scanner                  # 一轮完整扫描与按 Hash 分组
    scheduler                # 通知、去抖、轮询、互斥/取消
    state-store              # 少量持久化：待清理 Hash、重试退避等
    diagnostics              # 日志与用户可见错误
  test/
    mock-server/
    ...
  README.md
```

实现前请对照 Zotero 官方 `make-it-red` 插件和当前 API 源码核实准确函数签名。优先使用 `Zotero.Search`、`Zotero.Items`、`Zotero.Notifier`、`Zotero.Attachments.importFromFile` 及 `saveTx()`。网络请求使用 Zotero 支持的 HTTP API；不假设 WebExtension 的权限模型/DOM 环境与 Chrome 相同。监听器、定时器、进行中的可取消请求必须在插件 `shutdown` 时注销/停止。

**配置界面至少包含：** 服务端 Base URL、长期 Token（输入框遮挡）、扫描间隔（默认 60 秒）、“测试连接”和“立即扫描”按钮、可见的最近一次扫描结果/错误。首版只要求个人文献库；不可写或无权限的群组库应安全跳过并记录，不要尝试修改。

## 4. 扫描、通知和并发

- `startup` 完成后执行一次全量扫描。
- 监听 Zotero 文献条目的新增、修改及标签/附件相关变化，收到通知时只**标记需要重扫**，做 1–3 秒去抖；绝不在通知回调中直接展开并发上传。
- 每隔默认 60 秒执行一次全量扫描，以便发现服务端从 `pending` 变为 `down` / `error`；Zotero 重启后自动恢复。
- 保证同一时刻最多有**一轮扫描**；扫描中再次触发仅将 `rescanRequested` 设为真，结束后再执行至多一轮合并扫描。处理同一 `(libraryID, itemKey)` 的导入/标签修改不得并行。
- 一轮扫描先搜集所有需要处理的条目、检查所有附件并计算所需 Hash，再按 Hash 分组，**仅调用一次** `GET /v1/documents`。若没有待处理 Hash，可跳过网络请求。
- 同 Hash 的 PDF 至多上传一次；同 Hash 多个条目在 `down` 时**逐个导入**到各自父条目，全部成功才允许清理该 Hash 的服务端结果。
- 不要因为自己的 `saveTx` / 导入导致通知循环；去抖、互斥和状态复核应保证有限次收敛。每次真正导入前再次读取父条目和现有附件，以便处理用户在等待期间手动添加译文的竞争条件。
- PDF Hash 使用分块/增量计算，避免将大 PDF 整体放入内存；上传/下载也尽量使用流式文件操作（以当前 Zotero 可用 API 的实际能力为准）。

## 5. 单个条目的处理顺序

伪代码仅描述业务状态，不表示 Zotero API 的实际函数签名：

```text
scan():
    A = 搜索顶层条目(标签 == "急需翻译")
    groups = Map<sha256, Set<(libraryID,itemKey,sourceAttachmentKey)>>

    for item in A:
        if 有可读附件且 title == "翻译对照 PDF":
            移除「急需翻译」「缺少PDF」「翻译失败」；添加「翻译完成」
            持久化保存条目
            continue

        if 标签包含「翻译失败」:
            continue  // 等待明确的手动重试

        source = 从子附件中查找 title == "Full Text PDF" 且文件可读、确为 PDF
        if source 不存在:
            添加「缺少PDF」；保留「急需翻译」；保存
            continue

        若存在「缺少PDF」，将其移除并保存
        hash = SHA256(source.rawBytes)
        groups[hash].add(item 与 source 的稳定标识)

    if groups 非空:
        remote = GET /v1/documents，只调用一次
        for each hash/group:
            if 服务端无此 hash: POST /v1/documents 上传 PDF 一次
            if status == pending: pass
            if status == error: 对组内仍有效的急需翻译条目添加「翻译失败」
            if status == down:
                下载双语 PDF 一次并校验
                对组内每个条目：复核后导入其各自的「翻译对照 PDF」，保存标签
                只有整组全部成功或确实不再需要时，持久化登记待清理 hash

    处理持久化的待清理队列，调用 DELETE；成功才移出队列
```

如果发现多个标题都为 `Full Text PDF` 的可读子附件，默认选择 Zotero `dateAdded` 最新的一份；记录警告并在 README 说明该策略。若希望避免自动选错，也可增加插件设置选择“多原件时暂停”，但**首版默认行为必须确定**。忽略无父项、已回收、非 PDF 的附件。扫描前对用户删掉或移动条目的情况重新检查，不能向不存在的父项写入附件。

## 6. HTTP API v1：基础契约

### 6.1 公共规则

- Base URL 默认 `http://127.0.0.1:8765`，所有路径以 `/v1` 开始；端口可在设置中修改。
- **每个请求**带 `Authorization: Bearer <token>`；Token 无自动过期，但服务器必须允许手动撤销/轮换。Token 仅保存在该设备的插件本地配置中，禁止写入仓库、URL、日志或诊断导出。
- 若服务器不是本机回环地址，**只允许 HTTPS**，必须验证服务器证书，不能自动忽略证书错误。服务端也应配置请求大小/并发限制。
- JSON 使用 UTF-8、`Content-Type: application/json`；PDF 直接使用 `application/pdf`，**不要**在 JSON 中 Base64 编码整份 PDF。
- `hash` 路径参数严格匹配 64 位小写十六进制；服务端重新计算上传内容的 SHA-256，不信任客户端给出的 Hash。
- HTTP 网络错误/超时/5xx：有限退避后交给下一轮扫描；401/403：暂停自动处理并提示；文件不可用与业务 `error` 分别处理。
- 错误响应统一为 `{ "error": { "code": "...", "message": "..." } }`，不向插件泄露服务端堆栈和密钥。

### 6.2 ListDocuments：列出任务

```http
GET /v1/documents
Authorization: Bearer <token>
Accept: application/json
```

`200 OK`：

```json
{
  "documents": [
    {"id": "<64-character-lowercase-sha256>", "status": "pending"},
    {"id": "<another-sha256>", "status": "down"},
    {"id": "<another-sha256>", "status": "error"}
  ]
}
```

v1 假定单用户任务列表规模可控，**此接口一次返回完整列表，不分页**，避免插件把没取到的分页记录错判为不存在。如果后续引入分页，必须同时修改双方契约和客户端实现。禁止返回同一 Hash 的重复记录。

### 6.3 SubmitDocument：提交源 PDF

```http
POST /v1/documents
Authorization: Bearer <token>
Content-Type: application/pdf
X-Document-SHA256: <source-sha256>

<PDF 原始二进制字节>
```

- 服务端将任务持久化后异步执行 BabelDOC，成功上传并入队返回 `202 Accepted` 和 `{ "id": "<hash>", "status": "pending" }`。
- 若同 Hash 已有任务，返回 `200 OK` 和其**当前** `{id,status}`，不重复创建。
- 计算出的 Hash 与 `X-Document-SHA256` 不一致，返回 `422 HASH_MISMATCH`。
- 存在相同 Hash 的 `error` 任务时，普通提交**不得**隐式重试，返回现有 `error` 状态；手动重试见 6.6。
- 服务端落盘和入队需满足幂等性；客户端中断后重发相同 PDF 不能产生双任务。请求体大小上限应在服务端明确配置，客户端对 `413` 给出可见错误，不能无限重试。

### 6.4 Download：获取双语 PDF

```http
GET /v1/documents/{hash}/files/dual
Authorization: Bearer <token>
Accept: application/pdf
```

- `200 OK`：返回完整二进制 PDF，响应头至少包含 `Content-Type: application/pdf`、`Content-Length` 和 `X-Artifact-SHA256`（**生成后的双语 PDF** 的 SHA-256）。
- 插件下载到专用临时文件，检查非零长度、PDF 文件头、响应体字节数与 `X-Artifact-SHA256`；校验不通过不得导入、打完成标签或清理服务端数据。
- 若请求期间任务状态不再可下载，返回 `409 NOT_READY`；不存在时返回 `404 NOT_FOUND`。这两者不应标记 `翻译失败`，下轮重新查询/提交即可。
- 临时文件只在确认 Zotero 已将其成功复制到附件存储后删除；异常退出后要能清扫遗留临时文件。

### 6.5 Delete：清理服务端任务

```http
DELETE /v1/documents/{hash}
Authorization: Bearer <token>
```

- `200 OK`：`{ "ack": true }`。不存在的 Hash 也返回同样的成功语义，使接口幂等。
- **只有同一轮已经发现的所有该 Hash 相关条目都成功导入或不再需要译文时才调用。** 绝不在下载成功但 Zotero 导入/保存失败时删除。
- 导入、标签更新完成后，将待清理 Hash 先写入插件本地的**持久化清理队列**；之后调用 `DELETE`。网络失败或重启后从队列继续删除，避免因为 `急需翻译` 已移除而永远忘记清理。
- 如果删除与后续新提交并发造成竞争，服务器应将删除限定到当前已完成结果或任务代际；v1 至少要求单客户端串行处理。不要在另一个客户端尚未消费时对外宣称安全。

### 6.6 Retry：显式人工重试

```http
POST /v1/documents/{hash}/retry
Authorization: Bearer <token>
Content-Type: application/json

{}
```

- 仅允许对现存 `error` 任务调用；服务端重新排队后返回 `202 Accepted`、`{ "id":"<hash>", "status":"pending" }`。
- 若已经 `pending` / `down`，返回 `200 OK` 和当前状态，视为幂等成功。
- 任务不存在时返回 `404`；插件不能仅凭此结果清掉 `翻译失败`，需明确请求重新提交原始 PDF。
- 插件 `重试翻译` 命令先检查原 PDF 仍可用，调用此端点成功后移除所选条目的 `翻译失败` 标签并保留/恢复 `急需翻译`；若同 Hash 多条目需要重试，后台服务只重试一次，其他条目可在后续扫描时跟随该任务状态。

### 6.7 可选 Health

`GET /v1/health` 可以沿用 Bearer Token 返回 `{"ok":true}`，供设置页的“测试连接”使用。若不实现 Health，设置页改用 `GET /v1/documents` 校验 URL、Token 和响应格式，避免把健康检查变成插件安装的硬依赖。

## 7. 下载、导入与标签提交的顺序

为了抵抗进程崩溃，`down` 的处理顺序不可随意改动：

1. 下载一次双语 PDF 到插件临时目录，完整校验文件；保留本次分组下载结果直到所有条目完成。
2. 对每个条目重读元信息：条目存在且仍需要翻译；如果已有人手动添加可读的同名译文，直接修复标签，不再重复导入。
3. 通过 `Zotero.Attachments.importFromFile`（具体参数以当前 Zotero 版本核实）将文件**作为该文献的子附件导入**，附件显示标题为 `翻译对照 PDF`，实际存储文件名可采用安全的英文文件名，MIME 为 `application/pdf`。
4. 确认返回的附件属于正确父文献、可正常获取文件路径且实际文件存在，再移除 `急需翻译`、`缺少PDF`、`翻译失败`，添加 `翻译完成`，调用 Zotero 提供的持久化保存方法。
5. 某条目在步骤 3 后、步骤 4 前崩溃：下一轮凭已存在且可读的 `翻译对照 PDF` 自动修复标签，**不创建第二份附件**。
6. 某条目无法写入或导入失败：保留其 `急需翻译`；整组服务端文件仍保留，之后重试未完成条目，不重新翻译。
7. 全组成功后写入持久化待清理队列，再调用 `DELETE`；服务端清理不应阻塞用户看到已完成的标签。
8. 清理本地临时下载文件；清理失败仅记日志，不改业务状态。

注意：Zotero 附件显示标题与物理文件名是两件不同的事情，规范仅约束显示标题。不得把翻译 PDF 替换/覆盖原始 `Full Text PDF`。

## 8. 标签和边界情况

- **标签精确匹配**，不能因“有类似名字的标签”自动命中。
- 如果用户删除 `急需翻译`，插件应在写回前再次确认，不再主动为该条目下载或导入；它在本轮中被归为“不再需要”。已经成功添加的译文不因取消标签而自动删除。
- 如果已存在可读译文附件，即使原文丢失，也执行完成修复；如果译文只有附件记录但实际文件丢失，不能直接标记完成。
- 若一个已完成条目后来更换原文 PDF，v1 **不自动判断现有译文是否过期**，仍按“有 `翻译对照 PDF` 即完成”的用户原始规则处理。可在后续版本为译文关联源文件 Hash，实现过期检测，但不得静默删除旧译文。
- `error` 是服务器翻译任务失败；本地权限错误、磁盘满、Zotero 导入失败、HTTP 认证失败、下载 Hash 不符都是**插件运行错误**，不能误贴 `翻译失败` 标签。
- 同一 Hash 的条目可能跨不同集合，但都在同一个受支持、可写的个人库中；按 `(libraryID,itemKey)` 识别条目，不以文献标题去重。
- 如果 `GET /v1/documents` 返回未知 `status`，停止处理该 Hash 并输出协议错误，不把未知状态视为 `error` 或 `pending`。
- 多份原文 `Full Text PDF` 的选择策略、临时文件处理和不可用附件的处理必须有测试覆盖。

## 9. 凭据和网络安全

- Token **不会自动过期**，必须能手动撤销和更换。优先使用所支持平台的安全凭据存储能力；若实际插件 API 不提供可靠的安全存储，使用本机 Zotero 插件私有配置存储并在 README 明确“本机可读、非系统钥匙串”，不要声称其被加密。
- Token 输入框不回显，不在日志、异常、HTTP URL 或导出的设置中出现；只作为 `Authorization` 请求头发送。
- 默认只能访问回环地址的 HTTP；连接远程地址必须要求 HTTPS。拒绝把 Token 通过 HTTP 发送到局域网/公网主机。
- 对服务端下发的文件只按固定的**本地临时文件名**保存，不能直接相信 `Content-Disposition` 中的外部文件名和目录路径。
- 所有本地 I/O、HTTP、SHA-256 处理必须可报告错误，不应因单篇失败中断整轮扫描。

## 10. 本地持久化与日志

不需要第二套翻译任务数据库：**服务器是翻译进度的唯一事实来源**。但插件必须保存最少量的恢复状态：

- 待清理 Hash 集合（例如每条记录 `{hash, insertedAt}`），持久化写入成功后才尝试删除远端任务；如果队列中某 Hash 在新一轮发现还有未完成消费者，应推迟清理。
- 可选的下次重试时间/退避次数；不得成为服务器 `pending/down/error` 的替代品。
- 暂存文件使用插件私有子目录，启动时清理遗留过期文件，不删除 Zotero 原始附件目录下的用户文件。

日志应包含时间、`libraryID/itemKey`、Hash 的短前缀、动作、HTTP 状态码和明确失败原因，但不能记录 Token、论文全文或完整 PDF 内容。设置页可以提供有限的最近日志和“复制脱敏日志”。

## 11. 测试与验收（Agent 必须完成）

先实现 Mock HTTP 服务，支持任务不存在、`pending/down/error`、故意延迟、HTTP 401/503、损坏 PDF 和失败下载。最少完成如下场景：

1. `急需翻译` + 已有可读 `翻译对照 PDF` → 不请求服务，修复成功标签，不创建附件。
2. `急需翻译` + 缺少 `Full Text PDF` → 仅添加 `缺少PDF`；后来补齐原文能自动移除该错误标签并提交任务。
3. 首次发现 PDF → SHA-256 正确、`ListDocuments` 一次查询、HTTP 提交一次；重复扫描不重复上传。
4. `pending` → 不下载，不更改触发标签；状态转 `down` 后下一轮接续。
5. `down` → 下载一次；导入子附件的**显示标题精确为 `翻译对照 PDF`**；清掉触发/错误标签，打完成标签。
6. 两个不同条目共用相同原 PDF → 只提交一次、只下载一次、为两个条目分别创建子附件，**全部成功后 DELETE 一次**。
7. 下载中断、响应长度不符、X-Artifact-SHA256 不符或非 PDF → 不导入、不修改为完成、不删除服务端任务；后续能恢复。
8. 下载后第一个条目导入成功、第二个导入失败 → 不 DELETE；下次不重复导入第一份，恢复第二份，最后 DELETE。
9. Zotero 在“导入成功、标签保存之前”退出 → 重启后只修复标签，不导入重复附件。
10. 全部完成但 DELETE 返回 503 → 完成标签保留，待清理队列重启后仍在，下一轮完成清理。
11. 服务端 `error` → 添加 `翻译失败` 且不无限重试；手动“重试翻译”恢复到 `pending`，清除失败标签。
12. HTTP 401/403、网络断开、BabelDOC 服务暂时不可用 → 不误加 `翻译失败`，不误删任务，诊断可见。
13. 用户扫描期间删除条目、撤销触发标签、手动添加同名译文 → 二次检查成功，不产生孤儿附件/重复附件。
14. 带 Token 的所有请求都携带请求头；远程明文 HTTP 被拒绝；日志不包含 Token。
15. 插件禁用、重启、重新启用之后不会残留通知监听器或重复定时任务。
16. 验证实际安装版本的 Zotero 中能安装 `.xpi`，并在真实测试库中执行端到端流程；测试库与正式文献库隔离。

交付内容必须包括：插件源码、可安装 XPI、构建与本地开发说明、设置说明、HTTP API 文档、Mock HTTP 服务、单元/集成测试与一份验证结果；若真实 BabelDOC 服务不在当前环境，明确区分已通过的 Mock 测试与尚未完成的真实服务端联调。

## 12. 与最初需求有关的 Markdown / TXT 扩展（不阻塞 v1）

原始产品需求还包括：生成双语 PDF，并输出便于语言模型阅读的 Markdown/TXT。建议**由同一个后端任务完成**，而非 Zotero 插件自行解析双语 PDF。服务端在 BabelDOC 完成后可以使用**纯译文 PDF** 作为 Docling 等解析器的输入，以避免双语对照排版导致正文重复与阅读顺序错乱；保留标题、段落、表格、公式和图片引用，质量不足时允许后端报告该产物失败，但不影响已完成的双语 PDF。

兼容性扩展 API（可在下一迭代实现）：

```http
GET /v1/documents/{hash}/files/markdown   -> text/markdown; charset=utf-8
GET /v1/documents/{hash}/files/text       -> text/plain; charset=utf-8
```

若这两份文件在 v2 被要求自动附入 Zotero，附件标题分别使用 `翻译 Markdown` 和 `翻译 TXT`，并扩展 `ListDocuments` 的产物就绪字段（如 `artifacts: ["dual", "markdown", "text"]`），以及清理前必须满足的附件集合。**不要**现在仅凭任务状态 `down` 就擅自推断 MD/TXT 一定完成；这两个产物在 v1 明确为预留功能。

## 13. 参考材料（开发前核实当前签名）

- Zotero 官方插件开发指南：https://www.zotero.org/support/dev/zotero_7_for_developers
- Zotero 官方示例 `make-it-red`：https://github.com/zotero/make-it-red
- Zotero JavaScript API 说明：https://www.zotero.org/support/dev/client_coding/javascript_api
- 参考已有第三方插件的附件导入方式（只参考 API 用法，不复制其业务设计）：https://github.com/guaguastandup/zotero-pdf2zh

**实现原则：** 首先做正确的附件导入与崩溃恢复，再做通知优化；不要为了“实时响应”牺牲幂等性、原始 PDF 完整性或失败后的可恢复性。
