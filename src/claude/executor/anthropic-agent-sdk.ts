import {
  query,
  createSdkMcpServer,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

import type { AppLogger } from '../../logger/index.js'
import { env } from '../../env/server.js'
import {
  SLACK_UI_STATE_TOOL_NAME,
  SLACK_UI_STATE_TOOL_DESCRIPTION,
  parseSlackUiStateToolInput
} from '../tools/publish-state.js'
import type {
  ClaudeExecutionRequest,
  ClaudeExecutionSink,
  ClaudeExecutor
} from './types.js'

export class ClaudeAgentSdkExecutor implements ClaudeExecutor {
  constructor(private readonly logger: AppLogger) {}

  async execute(request: ClaudeExecutionRequest, sink: ClaudeExecutionSink): Promise<void> {
    this.logger.info('Claude Agent SDK execution requested for thread %s', request.threadTs)

    const mcpServer = this.createPublishStateMcpServer(request, sink)

    const prompt = this.buildPrompt(request)

    const session = query({
      prompt,
      options: {
        ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
        maxTurns: env.CLAUDE_MAX_TURNS,
        systemPrompt: this.buildSystemPrompt(request),
        mcpServers: {
          'slack-ui': mcpServer
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        persistSession: false
      }
    })

    let sessionId: string | undefined

    try {
      await sink.onEvent({ type: 'lifecycle', phase: 'started' })

      for await (const message of session) {
        await this.handleMessage(message, sink, (id) => {
          sessionId = id
        })
      }

      await sink.onEvent({
        type: 'lifecycle',
        phase: 'completed',
        ...(sessionId ? { sessionId } : {})
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Claude Agent SDK execution failed: %s', errorMessage)
      await sink.onEvent({
        type: 'lifecycle',
        phase: 'failed',
        ...(sessionId ? { sessionId } : {}),
        error: errorMessage
      })
    }
  }

  private async handleMessage(
    message: SDKMessage,
    sink: ClaudeExecutionSink,
    setSessionId: (id: string) => void
  ): Promise<void> {
    switch (message.type) {
      case 'system':
        this.handleSystemMessage(message as SDKSystemMessage, setSessionId)
        break

      case 'stream_event':
        await this.handleStreamEvent(message as SDKPartialAssistantMessage, sink)
        break

      case 'result':
        this.handleResult(message as SDKResultMessage)
        break
    }
  }

  private handleSystemMessage(
    message: SDKSystemMessage,
    setSessionId: (id: string) => void
  ): void {
    if (message.subtype === 'init') {
      setSessionId(message.session_id)
      this.logger.debug('Claude session initialized: %s', message.session_id)
    }
  }

  private async handleStreamEvent(
    message: SDKPartialAssistantMessage,
    sink: ClaudeExecutionSink
  ): Promise<void> {
    const { event } = message
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      await sink.onEvent({ type: 'text-delta', text: event.delta.text })
    }
  }

  private handleResult(message: SDKResultMessage): void {
    if (message.subtype === 'success') {
      this.logger.info(
        'Claude execution completed in %dms, cost $%s',
        message.duration_ms,
        message.total_cost_usd.toFixed(4)
      )
    } else {
      this.logger.warn(
        'Claude execution ended with %s: %s',
        message.subtype,
        message.errors.join('; ')
      )
    }
  }

  private createPublishStateMcpServer(
    request: ClaudeExecutionRequest,
    sink: ClaudeExecutionSink
  ) {
    const logger = this.logger

    return createSdkMcpServer({
      name: 'slack-ui',
      tools: [
        tool(
          SLACK_UI_STATE_TOOL_NAME,
          SLACK_UI_STATE_TOOL_DESCRIPTION,
          {
            threadTs: z.string().min(1),
            status: z.string().min(1).max(120).optional(),
            loadingMessages: z.array(z.string().min(1).max(240)).max(10).optional(),
            clear: z.boolean().default(false)
          },
          async (args) => {
            try {
              const state = parseSlackUiStateToolInput({
                ...args,
                threadTs: request.threadTs
              })
              await sink.onEvent({ type: 'ui-state', state })
              return { content: [{ type: 'text' as const, text: 'UI state published.' }] }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              logger.warn('publish_state validation failed: %s', msg)
              return {
                content: [{ type: 'text' as const, text: `Validation error: ${msg}` }],
                isError: true
              }
            }
          }
        )
      ]
    })
  }

  private buildPrompt(request: ClaudeExecutionRequest): string {
    const parts: string[] = []

    if (request.threadContext.messages.length > 0) {
      parts.push(request.threadContext.renderedPrompt)
      parts.push('')
    }

    parts.push(`Current user message from <@${request.userId}>:`)
    parts.push(request.mentionText)

    return parts.join('\n')
  }

  private buildSystemPrompt(request: ClaudeExecutionRequest): string {
    return [
      'You are a helpful assistant in a Slack workspace.',
      `You are responding in channel ${request.channelId}, thread ${request.threadTs}.`,
      '',
      `You have access to the ${SLACK_UI_STATE_TOOL_NAME} tool to publish UI state updates to the Slack thread.`,
      'Use it to show progress indicators when performing long-running tasks.'
    ].join('\n')
  }
}
