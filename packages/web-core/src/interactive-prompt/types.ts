import type { ProviderQuestionBinding, ProviderQuestionEpisode } from '@adhdev/mesh-shared'
export interface InteractivePrompt extends ProviderQuestionEpisode {
  promptId: string
  origin: 'cli' | 'mcp' | 'agent'
  providerType: string
  createdAt: number
  questions: InteractiveQuestion[]
}

export interface InteractiveQuestion {
  questionId: string
  question: string
  header?: string
  multiSelect: boolean
  options: InteractiveOption[]
  allowFreeform?: boolean
  required?: boolean
  isSecret?: boolean
}

export interface InteractiveOption {
  label: string
  description?: string
  preview?: string
}

export interface InteractivePromptResponse {
  promptId: string
  answers: Record<string, InteractiveAnswer>
  binding?: ProviderQuestionBinding
  action?: 'dismiss'
}

export interface InteractiveAnswer {
  selectedLabels: string[]
  freeformText?: string
}
