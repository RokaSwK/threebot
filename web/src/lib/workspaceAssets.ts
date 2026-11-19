import { assetUrl } from "../store";
import { assetKey, signedAsset } from "./assetCopies";
import { workspaceEnvironment } from "./workspaceTransport";
import type { LibraryResource } from "./workspaceLinks";
import { workspaceFileKind } from "./workspaceLinks";

// Package 1 adds the optional scope argument. A one-argument local signer remains
// compatible; workspaceEnvironment rejects remote keys without scoped transport.
const signAsset: (resource: Record<string, unknown>, environmentId?: string) => Promise<string> = assetUrl;

/**
 * A URL for a library resource: signed by T3 when it answers, from this device's copy when it does not.
 * Only images are kept on sight; a document is kept when the viewer actually reads it.
 */
export async function workspaceAssetUrl(resource: LibraryResource, scopeThreadId: string | null = null) {
  const owner = resource._tag === "workspace-file" ? resource.threadId : scopeThreadId;
  const key = assetKey(resource as unknown as Record<string, unknown>, owner ?? undefined);
  const kind = resource._tag === "workspace-file" ? workspaceFileKind(resource.path) : "image";
  const sign = () => {
    if (resource._tag === "workspace-file") {
      // T3 workspace-file grants cover browser documents and images, not text or
      // audio/video. media-file resolves relative paths in the owning thread.
      // Download disposition permits arbitrary files; fetch can still read text.
      if (["text", "file", "sheet", "doc", "audio", "video"].includes(kind)) {
        return signAsset({ ...resource, _tag: "media-file", ...(["text", "file", "sheet", "doc"].includes(kind) ? { disposition: "attachment" } : {}) }, workspaceEnvironment(owner));
      }
    }
    return signAsset(resource, workspaceEnvironment(owner));
  };
  // A viewer keeps what it actually reads (keepFetchedAsset); signing alone never downloads a file.
  return signedAsset(sign, key);
}
