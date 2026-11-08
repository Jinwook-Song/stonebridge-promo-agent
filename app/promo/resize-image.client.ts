// Browser only. Shrinks a phone photo before upload so it fits the 5 MB limit and uploads fast.

export type ResizedImage = { blob: Blob; width: number; height: number };

export async function resizeToJpeg(file: File, maxEdge = 1600, quality = 0.85): Promise<ResizedImage> {
  // "from-image" applies the EXIF orientation, so iPhone portrait shots are not drawn sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null) => {
      if (!ctx) throw new Error("canvas unavailable");
      // JPEG has no alpha: transparent PNG pixels would turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
    };

    let blob: Blob | null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      draw(canvas.getContext("2d"));
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      draw(canvas.getContext("2d"));
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    }
    if (!blob) throw new Error("jpeg encode failed");
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}
