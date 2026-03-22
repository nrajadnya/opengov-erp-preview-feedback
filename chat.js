module.exports = async function handler(req, res) {
  // CORS — allow the Vercel frontend to call this function
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token, messages, system, tools } = req.body;
  if (!token || !messages) {
    return res.status(400).json({ error: { message: 'Missing token or messages' } });
  }

  // Decode ABSK-wrapped Bedrock token  → BedrockAPIKey-...:secret
  let bearerToken = token;
  if (token.startsWith('ABSK')) {
    try {
      bearerToken = Buffer.from(token.slice(4), 'base64').toString('utf-8');
    } catch (e) {
      return res.status(400).json({ error: { message: 'Invalid ABSK token' } });
    }
  }

  // ── Convert Anthropic → Bedrock Converse format ──────────────────────────
  function toBedrockContent(content) {
    if (typeof content === 'string') return [{ text: content }];
    return content.map(b => {
      if (b.type === 'text')        return { text: b.text };
      if (b.type === 'tool_use')    return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
      if (b.type === 'tool_result') return {
        toolResult: {
          toolUseId: b.tool_use_id,
          content: typeof b.content === 'string' ? [{ text: b.content }] : b.content,
          status: 'success'
        }
      };
      return { text: JSON.stringify(b) };
    });
  }

  const bedrockBody = {
    messages: messages.map(m => ({ role: m.role, content: toBedrockContent(m.content) })),
    inferenceConfig: { maxTokens: 1024, temperature: 0.7 }
  };

  if (system) bedrockBody.system = [{ text: system }];

  if (tools && tools.length > 0) {
    bedrockBody.toolConfig = {
      tools: tools.map(t => ({
        toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } }
      }))
    };
  }

  // ── Call Bedrock ──────────────────────────────────────────────────────────
  const model  = 'anthropic.claude-sonnet-4-5-20251001-v1:0';
  const region = 'us-west-2';
  const url    = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

  let bedrockRes;
  try {
    bedrockRes = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(bedrockBody)
    });
  } catch (err) {
    return res.status(502).json({ error: { message: `Network error reaching Bedrock: ${err.message}` } });
  }

  if (!bedrockRes.ok) {
    const errText = await bedrockRes.text().catch(() => '');
    // If 401, signal the frontend to clear the key
    return res.status(bedrockRes.status).json({
      error: { message: `Bedrock ${bedrockRes.status}: ${errText.slice(0, 300)}` }
    });
  }

  const data = await bedrockRes.json();

  // ── Convert Bedrock → Anthropic response format ───────────────────────────
  const content = (data.output?.message?.content || []).map(block => {
    if (block.text !== undefined) return { type: 'text', text: block.text };
    if (block.toolUse) return {
      type: 'tool_use',
      id: block.toolUse.toolUseId,
      name: block.toolUse.name,
      input: block.toolUse.input
    };
    return { type: 'text', text: JSON.stringify(block) };
  });

  res.json({
    content,
    stop_reason: data.stopReason === 'tool_use' ? 'tool_use' : 'end_turn'
  });
};
