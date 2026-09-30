# HTTP API v1（插件契约）

Base URL 默认：`http://127.0.0.1:8765`  
鉴权：每个请求 `Authorization: Bearer <token>`  
非本机回环地址必须使用 HTTPS。

完整规格见 [spec.md](./spec.md)。

## Endpoints

| Method | Path | 说明 |
|--------|------|------|
| GET | `/v1/health` | `{ "ok": true }` |
| GET | `/v1/documents` | 完整任务列表（不分页） |
| POST | `/v1/documents` | 上传源 PDF（`application/pdf` + `X-Document-SHA256`） |
| GET | `/v1/documents/{hash}/files/dual` | 下载双语 PDF |
| DELETE | `/v1/documents/{hash}` | 幂等清理 |
| POST | `/v1/documents/{hash}/retry` | 仅对 `error` 重新排队 |

## 状态

- `pending`：翻译中
- `down`：双语 PDF 已就绪可下载（不是“正在下载”）
- `error`：翻译失败；需显式 retry，普通 POST 不隐式重试

## 标签 / 附件标题（插件侧固定）

- 触发：`急需翻译`
- 完成：`翻译完成`
- 缺失：`缺少PDF`
- 失败：`翻译失败`
- 原文附件标题：`Full Text PDF`
- 译文附件标题：`翻译对照 PDF`

## Mock

```bash
npm run mock-server
# TOKEN=dev-token PORT=8765 PENDING_MS=3000
```
