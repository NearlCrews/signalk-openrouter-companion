export interface OpenRouterCompleteRequest {
  system: string;
  user: string;
}

export interface OpenRouterUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenRouterCompleteResult {
  text: string;
  model: string;
  usage: OpenRouterUsage;
  raw: unknown;
}

export class OpenRouterClient {
  complete(_req: OpenRouterCompleteRequest): Promise<OpenRouterCompleteResult> {
    throw new Error('not implemented');
  }
}
