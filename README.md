# Zotero Translation

Zotero 7+ 插件：通过标签 `急需翻译` 将 `Full Text PDF` 提交到本机/远程 HTTP 翻译服务，取回双语 PDF 并挂为 `翻译对照 PDF`。

**真实 BabelDOC 后端不在本仓库。** 开发时用内置 Mock；联调真实服务只需改设置里的 Base URL 与 Token。

## 固定约定（勿改名）

| 用途 | 精确字符串 |
|------|------------|
| 触发标签 | `急需翻译` |
| 完成标签 | `翻译完成` |
| 缺失标签 | `缺少PDF` |
| 失败标签 | `翻译失败` |
| 原文附件标题 | `Full Text PDF` |
| 译文附件标题 | `翻译对照 PDF` |

规格全文：[docs/spec.md](docs/spec.md) · API 摘要：[docs/api.md](docs/api.md)

## 环境要求

- Node.js 18+
- Zotero 7+
- Windows 上需在 `.env` 中配置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`

## 安装依赖与构建

```bash
npm install
npm run build
```

产物：`.scaffold/build/*.xpi`（可用 Zotero「工具 → 插件 → 从文件安装」加载）。

开发热重载：

```bash
copy .env.example .env
# 编辑 .env 指向本机 Zotero
npm start
```

## Mock 服务

```bash
npm run mock-server
```

默认：`http://127.0.0.1:8765`，Token：`dev-token`。  
环境变量：`PORT`、`TOKEN`、`PENDING_MS`、`FAIL_HASH`、`CORRUPT_DUAL`、`BAD_ARTIFACT_HASH`。

## 插件设置

编辑 → 设置 → Zotero Translation：

- Base URL（默认 `http://127.0.0.1:8765`）
- Token（密码框；保存在本机 Zotero prefs，**非系统钥匙串**）
- 扫描间隔（默认 60 秒）
- 「测试连接」「立即扫描」与最近扫描摘要

右键条目菜单：**重试翻译**（调用 `POST /v1/documents/{hash}/retry`，成功后才去掉 `翻译失败`）。

## 行为摘要

1. 启动后全量扫描；条目/标签变更去抖后重扫；定时轮询 `pending → down/error`。
2. 已有可读 `翻译对照 PDF`：不访问服务器，只修标签为完成。
3. 无 `Full Text PDF`：加 `缺少PDF`。
4. 同 SHA-256 只上传/下载一次；多条目逐个导入，全部成功后才 DELETE。
5. HTTP 401/403：暂停自动任务；5xx/网络错误不贴 `翻译失败`。
6. 公网地址禁止明文 HTTP 发送 Token；本机回环与 RFC1918 局域网（如 `192.168.x.x`）可用 HTTP。

## 范围说明

- 已实现：插件主流程、设置页、重试命令、Mock HTTP、构建配置。
- 未做：自动化测试套件、真实 BabelDOC 联调、Markdown/TXT 产物（规格第 12 节）。
- 多份 `Full Text PDF`：默认取 `dateAdded` 最新一份。
