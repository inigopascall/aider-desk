import type { FeatureExtractionPipeline } from '@huggingface/transformers';

import { AIDER_DESK_CACHE_DIR } from '@/constants';
import logger from '@/logger';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_EMBEDDED_CHARACTERS = 2000;

/** Local sentence embeddings for concept search. The model is loaded on first use from the shared model cache. */
export class TextEmbedder {
  private pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;
  private unavailable = false;

  isUnavailable(): boolean {
    return this.unavailable;
  }

  private loadPipeline(): Promise<FeatureExtractionPipeline | null> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        try {
          const transformers = await import('@huggingface/transformers');
          const pipeline = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL, { cache_dir: AIDER_DESK_CACHE_DIR });
          return pipeline as FeatureExtractionPipeline;
        } catch (error) {
          this.unavailable = true;
          logger.warn('[TaskNavigation] Concept search unavailable: the embedding model failed to load', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      })();
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const pipeline = await this.loadPipeline();
    if (!pipeline) {
      return null;
    }
    const result = await pipeline(text.slice(0, MAX_EMBEDDED_CHARACTERS), { pooling: 'mean', normalize: true });
    return Float32Array.from(result.data as ArrayLike<number>);
  }
}
