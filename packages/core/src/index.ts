export interface AgentInput { conversationId: string; text: string }
export interface AgentResult { messages: readonly string[] }
export interface AgentCore { respond(input: AgentInput, signal: AbortSignal): Promise<AgentResult> }
