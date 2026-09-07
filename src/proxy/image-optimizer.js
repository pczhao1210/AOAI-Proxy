import sharp from "sharp";
import { createImageWorkQueue } from "./image-work-queue.js";

const imageWorkQueue = createImageWorkQueue();

export async function optimizeInlineImage(buffer, settings = {}, context = {}) {
  const startedAt = performance.now();
  const result = (reason, output = buffer, dimensions = {}) => ({
    buffer: output,
    reason,
    inputBytes: buffer.length,
    outputBytes: output.length,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    ...dimensions
  });
  const minBytes = settings.minBytes ?? 256 * 1024;
  const clientError = () => Object.assign(new Error("client disconnected"), { code: "CLIENT_DISCONNECTED", status: 499 });
  if (context.signal?.aborted) throw clientError();
  if (buffer.length < minBytes) return result("below_threshold");
  const maxPixels = settings.maxPixels ?? 40_000_000;
  const timeoutMs = Math.max(1, Math.min(settings.timeoutMs ?? 5000, context.remainingMs ?? Infinity));
  const controller = new AbortController();
  const onAbort = () => controller.abort(clientError());
  context.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Image optimization timed out"), { code: "IMAGE_OPTIMIZATION_TIMEOUT" })), timeoutMs);
  try {
    return await imageWorkQueue.run(async () => {
      controller.signal.throwIfAborted();
      const metadata = await sharp(buffer, { limitInputPixels: maxPixels }).metadata();
      controller.signal.throwIfAborted();
      const dimensions = { width: metadata.width, height: metadata.height };
      if (metadata.format !== "jpeg" || metadata.hasAlpha || (metadata.pages || 1) > 1) {
        return result("preserve_format", buffer, dimensions);
      }
      const quality = Math.round(Math.min(1, Math.max(0.6, settings.minQuality || 0, settings.quality ?? 0.85)) * 100);
      const maxSide = settings.maxLongSidePx ?? 1600;
      const { data, info } = await sharp(buffer, { limitInputPixels: maxPixels })
        .rotate()
        .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
        .withIccProfile("srgb")
        .jpeg({ quality, mozjpeg: settings.useMozJpeg !== false, progressive: settings.progressive === true })
        .timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) })
        .toBuffer({ resolveWithObject: true });
      controller.signal.throwIfAborted();
      if (data.length >= buffer.length || (buffer.length - data.length) / buffer.length < (settings.minSavingsRatio ?? 0.1)) {
        return result("insufficient_savings", buffer, dimensions);
      }
      return result("optimized", data, { ...dimensions, outputWidth: info.width, outputHeight: info.height });
    }, { signal: controller.signal, maxConcurrent: settings.maxConcurrent ?? 2, maxQueue: settings.maxQueue ?? 8 });
  } catch (error) {
    if (context.signal?.aborted || error?.code === "CLIENT_DISCONNECTED") throw clientError();
    return result(error?.code === "IMAGE_QUEUE_FULL" ? "queue_full" : controller.signal.aborted ? "timeout" : "processing_unavailable");
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
  }
}