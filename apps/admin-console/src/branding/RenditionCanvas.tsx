/**
 * RT-474: shows one server rendition exactly as Backend-Core produced it.
 *
 * Why a canvas and not `<img src="data:…">`: the Console's CSP
 * (services/backend-core/Caddyfile) is `default-src 'self'` with no `img-src`,
 * so `data:` and `blob:` image URLs are refused. `createImageBitmap` decodes the
 * bytes already in memory (no fetch, so the CSP does not apply), and the bitmap
 * is drawn once at its own pixel size: `drawImage(bitmap, 0, 0)` with the
 * canvas sized to the rendition's `width_px` × `height_px`, so nothing is
 * resampled, filtered or re-encoded. CSS sets only the display size. Pixels are
 * never read back.
 */
import { useEffect, useRef } from "react";

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface RenditionCanvasProps {
  pngBase64: string;
  /** The rendition's own pixel size: the canvas backing store. */
  widthPx: number;
  heightPx: number;
  /** The display size (CSS px for the screen, mm for the receipt). */
  displayWidth: string;
  displayHeight: string;
  /** Arabic accessible name; the canvas is an image of the logo. */
  label: string;
  className?: string;
}

export function RenditionCanvas({
  pngBase64,
  widthPx,
  heightPx,
  displayWidth,
  displayHeight,
  label,
  className,
}: Readonly<RenditionCanvasProps>): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let cancelled = false;
    let bitmap: ImageBitmap | undefined;
    const blob = new Blob([base64ToBytes(pngBase64)], { type: "image/png" });
    createImageBitmap(blob).then(
      (decoded) => {
        if (cancelled) {
          decoded.close();
          return;
        }
        bitmap = decoded;
        canvas.getContext("2d")?.drawImage(decoded, 0, 0);
      },
      // An undecodable rendition stays blank; the server produced and validated
      // it, so there is nothing the admin can do here, and no stale logo is drawn.
      () => undefined,
    );
    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [pngBase64]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      width={widthPx}
      height={heightPx}
      className={className}
      style={{ width: displayWidth, height: displayHeight }}
    />
  );
}
