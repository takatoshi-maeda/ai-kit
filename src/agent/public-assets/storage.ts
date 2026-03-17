export interface SavePublicImageInput {
  sessionId: string;
  agentId?: string;
  mediaType: string;
  bytes: Uint8Array;
  now?: Date;
}

export interface SavePublicImageResult {
  storagePath: string;
  assetRef: string;
}

export type PublicAssetResolution =
  | { mode: "url"; url: string }
  | { mode: "data-url"; dataUrl: string };

export interface PublicAssetReadResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface PublicAssetStorage {
  saveImage(input: SavePublicImageInput): Promise<SavePublicImageResult>;
  resolveForLlm(input: { assetRef: string }): Promise<PublicAssetResolution>;
  readPublicAsset?(assetRef: string): Promise<PublicAssetReadResult | null>;
}
