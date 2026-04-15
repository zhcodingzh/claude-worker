export default {
  async fetch(request) {
    // 处理 CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': '*',
        }
      });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // 调试端点: /{org_id}/debug — 直接透传 Claude 原始 SSE
    if (pathParts.length >= 2 && pathParts[pathParts.length - 1] === 'debug') {
      try {
        const orgId = pathParts[0];
        const cookie = request.headers.get('cookie') || '';
        const body = await request.json();
        const messages = body.messages || [];
        const systemMsg = messages.find(m => m.role === 'system')?.content || '';
        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        const prompt = systemMsg ? `${systemMsg}\n\n${lastUserMsg}` : lastUserMsg;

        const claudeHeaders = {
          'content-type': 'application/json',
          'cookie': cookie,
          'anthropic-client-platform': 'web_claude_ai',
          'origin': 'https://claude.ai',
          'referer': 'https://claude.ai/',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        };

        const convUuid = crypto.randomUUID();
        const convRes = await fetch(
          `https://claude.ai/api/organizations/${orgId}/chat_conversations`,
          { method: 'POST', headers: claudeHeaders, body: JSON.stringify({ name: '', uuid: convUuid }) }
        );
        if (!convRes.ok) {
          const t = await convRes.text();
          return new Response(`Create conv failed ${convRes.status}: ${t}`, { status: 200, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
        }
        const conv = await convRes.json();
        const convId = conv.uuid;

        const msgRes = await fetch(
          `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
          { method: 'POST', headers: { ...claudeHeaders, 'accept': 'text/event-stream' },
            body: JSON.stringify({ prompt, model: 'claude-sonnet-4-6', timezone: 'America/Toronto', rendering_mode: 'messages', parent_message_uuid: '00000000-0000-4000-8000-000000000000', attachments: [], files: [], tools: [], sync_sources: [] }) }
        );
        if (!msgRes.ok) {
          const t = await msgRes.text();
          return new Response(`Send msg failed ${msgRes.status}: ${t}`, { status: 200, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
        }
        return new Response(msgRes.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
      } catch (e) {
        return new Response(`Error: ${e.message}\n${e.stack}`, { status: 200, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
      }
    }

    // 期望路径: /{org_id}/chat/completions
    if (pathParts.length < 2 || pathParts[pathParts.length - 1] !== 'completions') {
      return new Response('Not found', { status: 404 });
    }

    const orgId = pathParts[0];
    const cookie = request.headers.get('cookie') || '';

    if (!cookie) {
      return new Response(JSON.stringify({ error: 'Missing cookie header' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }

    const claudeHeaders = {
      'content-type': 'application/json',
      'cookie': cookie,
      'anthropic-client-platform': 'web_claude_ai',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'origin': 'https://claude.ai',
      'referer': 'https://claude.ai/',
    };

    // 第一步：创建对话
    const convRes = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations`,
      {
        method: 'POST',
        headers: claudeHeaders,
        body: JSON.stringify({
          name: '',
          uuid: crypto.randomUUID()
        })
      }
    );

    if (!convRes.ok) {
      const text = await convRes.text();
      return new Response(JSON.stringify({ error: `Create conversation failed: ${convRes.status}`, detail: text }), {
        status: convRes.status,
        headers: { 'content-type': 'application/json' }
      });
    }

    const conv = await convRes.json();
    const convId = conv.uuid;

    // 第二步：提取用户消息，拼 prompt
    const messages = body.messages || [];
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role === 'user');
    const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || '';
    const prompt = systemMsg ? `${systemMsg}\n\n${lastUserMsg}` : lastUserMsg;

    // 第三步：发送消息到 Claude
    const msgRes = await fetch(
      `https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
      {
        method: 'POST',
        headers: {
          ...claudeHeaders,
          'accept': 'text/event-stream',
        },
        body: JSON.stringify({
          prompt: prompt,
          model: mapModel(body.model),
          timezone: 'America/Toronto',
          rendering_mode: 'messages',
          parent_message_uuid: '00000000-0000-4000-8000-000000000000',
          attachments: [],
          files: [],
          tools: [],
          sync_sources: [],
        })
      }
    );

    if (!msgRes.ok) {
      const text = await msgRes.text();
      return new Response(JSON.stringify({ error: `Claude API error: ${msgRes.status}`, detail: text }), {
        status: msgRes.status,
        headers: { 'content-type': 'application/json' }
      });
    }

    // 第四步：把 Claude SSE 转成 OpenAI SSE 格式流式返回
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    streamResponse(msgRes.body, writer, encoder, body.model || 'claude-sonnet-4-6').catch(() => {});

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      }
    });
  }
};

async function streamResponse(body, writer, encoder, model) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        // content_block_delta 事件携带文本增量
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
          const text = data.delta.text;
          if (!text) continue;
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        // message_stop 发结束标志（忽略 message_delta stop_reason，避免重复 [DONE]）
        if (data.type === 'message_stop') {
          const doneChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\ndata: [DONE]\n\n`));
        }
      }
    }
  } finally {
    writer.close();
  }
}

function mapModel(model) {
  if (!model || model.includes('sonnet')) return 'claude-sonnet-4-6';
  if (model.includes('opus')) return 'claude-opus-4-6';
  if (model.includes('haiku')) return 'claude-haiku-4-5';
  return 'claude-sonnet-4-6';
}
