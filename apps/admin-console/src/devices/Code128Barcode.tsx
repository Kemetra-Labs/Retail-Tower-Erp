/**
 * RT-1316 (AC7) — a Code 128 barcode drawn as plain SVG from `code128Modules`:
 * no package. One rect per bar, with the standard ten-module quiet zone on each
 * side. SVG coordinates run left to right in either direction. Bars are Ink on
 * a white field in every theme, because a scanner needs dark on light. The value is a prop; this component neither stores nor logs it.
 */
import { code128Modules } from "./code128";
import "./devices.css";

const QUIET_MODULES = 10;
const BAR_HEIGHT = 60;

interface Bar {
  x: number;
  width: number;
}

/** Each run of bar modules as one rect, offset by the leading quiet zone. */
function barsOf(modules: string): Bar[] {
  const bars: Bar[] = [];
  let start = -1;
  for (let i = 0; i <= modules.length; i++) {
    const isBar = modules[i] === "1";
    if (isBar && start < 0) start = i;
    if (!isBar && start >= 0) {
      bars.push({ x: start + QUIET_MODULES, width: i - start });
      start = -1;
    }
  }
  return bars;
}

export function Code128Barcode({
  value,
  label,
}: Readonly<{ value: string; label: string }>): React.JSX.Element | null {
  const modules = code128Modules(value);
  if (!modules) return null;
  const width = modules.length + QUIET_MODULES * 2;
  return (
    <svg
      className="device-barcode"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${BAR_HEIGHT}`}
      shapeRendering="crispEdges"
      data-modules={modules.length}
    >
      {barsOf(modules).map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={BAR_HEIGHT} />
      ))}
    </svg>
  );
}
