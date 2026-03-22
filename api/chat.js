const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token, messages, system, tools } = req.body;
  if (!token || !messages) {
    return res.status(400).json({ error: { message: 'Missing token or messages' } });
  }

  // Decode ABSK token: ABSK + base64(keyId:secret)
  let accessKeyId, secretAccessKey;
  if (token.startsWith('ABSK')) {
    try {
      const decoded = Buffer.from(token.slice(4), 'base64').toString('utf-8');
      const colonIdx = decoded.lastIndexOf(':');
      accessKeyId = decoded.slice(0, colonIdx);
      secretAccessKey = decoded.slice(colonIdx + 1);
    } catch (e) {
      return res.status(400).json({ error: { message: 'Invalid ABSK token' } });
    }
  } else {
    return res.status(400).json({ error: { message: 'Token must be ABSK format' } });
  }

  const client = new BedrockRuntimeClient({
    region: 'us-west-2',
    credentials: { accessKeyId, secretAccessKey }
  });

  function toBedrockContent(content) {
    if (typeof content === 'string') return [{ text: content }];
    return content.map(b => {
      if (b.type === 'text') return { text: b.text };
      if (b.type === 'tool_use') return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
      if (b.type === 'tool_result') return { toolResult: { toolUseId: b.tool_use_id, content: typeof b.content === 'string' ? [{ text: b.content }] : b.content, status: 'success' } };
      return { text: JSON.stringify(b) };
    });
  }

  const input = {
    modelId: 'anthropic.claude-sonnet-4-5-20251001-v1:0',
    messages: messages.map(m => ({ role: m.role, content: toBedrockContent(m.content) })),
    inferenceConfig: { maxTokens: 1024, temperature: 0.7 }
  };
  if (system) input.system = [{ text: system }];
  if (tools && tools.length > 0) {
    input.toolConfig = { tools: tools.map(t => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } } })) };
  }

  try {
    const data = await client.send(new ConverseCommand(input));
    const content = (data.output?.message?.content || []).map(block => {
      if (block.text !== undefined) return { type: 'text', text: block.text };
      if (block.toolUse) return { type: 'tool_use', id: block.toolUse.toolUseId, name: block.toolUse.name, input: block.toolUse.input };
      return { type: 'text', text: JSON.stringify(block) };
    });
    res.json({ content, stop_reason: data.stopReason === 'tool_use' ? 'tool_use' : 'end_turn' });
  } catch (err) {
    const status = err.$metadata?.httpStatusCode || 500;
    res.status(status).json({ error: { message: 'Bedrock error: ' + (err.message || String(err)) } });
  }
};
