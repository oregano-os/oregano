/** Adapter-authorized images only. Never fetch user/model supplied URLs here. */
export interface BuilderAttachment {
  type: string; mimeType?: string; size?: number;
  data?: Uint8Array | Blob;
  fetchData?: () => Promise<Uint8Array | ArrayBuffer>;
}
export async function readBuilderImages(attachments: readonly BuilderAttachment[] = []) {
  const images: { type: "image"; image: Uint8Array; mediaType: string }[] = [];
  const notices: string[] = [];
  for (const attachment of attachments.slice(0, 10)) {
    if (attachment.type !== "image") continue;
    const mime = attachment.mimeType?.split(";")[0]?.toLowerCase();
    if (!mime || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
      || images.length >= 3 || (attachment.size ?? 0) > 5 * 1024 * 1024) {
      notices.push("An attached image could not be read: unsupported format or image limit exceeded."); continue;
    }
    try {
      const raw = attachment.data ?? await attachment.fetchData?.();
      if (!raw) throw new Error("No authorized attachment reader");
      const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : new Uint8Array(raw);
      if (!bytes.length || bytes.byteLength > 5 * 1024 * 1024) throw new Error("Image limit");
      images.push({ type: "image", image: bytes, mediaType: mime });
    } catch {
      notices.push("I could not read an attached image through the connected channel. I can check the saved test result, but cannot assess that image.");
    }
  }
  if (attachments.length > 10) notices.push("Additional attachments were not read because the attachment limit was exceeded.");
  return { images, notices };
}
