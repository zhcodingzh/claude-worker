# Claude Proxy Worker

自建 Cloudflare Worker，将 Claude.ai 网页版 cookie 转为 OpenAI 兼容 API。

**解决的问题**：gpt4free 等工具的 Claude provider 默认把用户 cookie 发到第三方服务器（`claude.gpt4free.workers.dev`）。此 Worker 部署在自己的 Cloudflare 账号下，cookie 完全在自己掌控的服务器中流转。

---

## 接口

### 对话（OpenAI 兼容）

```
POST /{org_id}/chat/completions
```

**Headers**
```
cookie: <claude.ai 完整 cookie>
content-type: application/json
```

**Body**
```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}
```

**Response**（SSE 流）
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"你好"},"finish_reason":null}]}
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### 调试端点

```
POST /{org_id}/debug
```

直接透传 Claude 原始 SSE 响应，用于排查问题。

---

## 如何获取 org_id 和 cookie

1. 浏览器登录 [claude.ai](https://claude.ai)
2. 打开开发者工具 → Network 标签
3. 发送任意消息，找到发给 `claude.ai` 的请求
4. **org_id**：从请求 URL 中的 `/organizations/{uuid}/` 取 UUID
5. **cookie**：从 Request Headers 中复制 `cookie:` 整行值

---

## 模型映射

| 传入 model 字段 | 实际调用 |
|----------------|----------|
| 含 `sonnet`（默认）| `claude-sonnet-4-6` |
| 含 `opus` | `claude-opus-4-6` |
| 含 `haiku` | `claude-haiku-4-5` |

---

## 部署

已通过 Cloudflare GitHub 集成自动部署。push 到 `main` 分支后 Cloudflare 自动拉取并部署。

**手动部署（需安装 wrangler）**
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

---

## 接入 gpt4free

修改 `g4f/Provider/needs_auth/Claude.py`：

```python
base_url = "https://claude-worker.你的账号.workers.dev"
```

---

## 注意事项

- 每次请求自动创建新对话，不保留上下文（无状态）
- Cloudflare Worker 免费套餐：每天 10 万次请求
- cookie 有效期跟随 Claude.ai 会话，session 过期需重新获取
