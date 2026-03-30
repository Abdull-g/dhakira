// Mock API provider — pretends to be OpenAI for testing the proxy
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(body) } catch {}

    const stream = (parsed.stream as boolean) ?? false
    console.log(`[mock] ${req.method} ${req.url} stream=${stream}`)

    // Log if memory injection is present in system prompt
    const messages = parsed.messages as Array<{ role: string; content: string }> | undefined
    const systemMsg = messages?.find(m => m.role === 'system')
    if (systemMsg?.content?.includes('memory_context')) {
      console.log('[mock] ✅ MEMORY INJECTION DETECTED in system prompt!')
    } else {
      console.log('[mock] ℹ️  No memory injection (expected on first run)')
    }

    if (stream) {
      // SSE streaming response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const words = ['Hello!', ' I', ' am', ' your', ' AI', ' assistant.', ' How', ' can', ' I', ' help?']
      let i = 0

      const interval = setInterval(() => {
        if (i < words.length) {
          const chunk = {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: { content: words[i] },
              finish_reason: null,
            }],
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          i++
        } else {
          const done = {
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }
          res.write(`data: ${JSON.stringify(done)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(interval)
        }
      }, 50)
    } else {
      // Non-streaming response
      const response = {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello! I am your AI assistant. How can I help?' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  })
})

server.listen(4200, () => {
  console.log('[mock] Fake OpenAI provider running on http://127.0.0.1:4200')
  console.log('[mock] Waiting for requests from Dhakira proxy...')
})
