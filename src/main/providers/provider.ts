import type { ChatRequest, ModelInfo, ProviderConfig, ProviderKind, ProviderStatus } from '../../shared/types';

export interface Provider {
  kind: ProviderKind;
  /** yields text deltas; throws Error with a short lowercase message */
  stream(req: ChatRequest, cfg: ProviderConfig): AsyncIterable<string>;
  listModels(cfg: ProviderConfig): Promise<ModelInfo[]>;
  status(cfg: ProviderConfig): Promise<ProviderStatus>;
}
