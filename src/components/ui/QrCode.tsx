import { encode } from "uqr";

/**
 * A QR code as SVG rectangles (decision 0020). The text must be a link that
 * the page may show anyway: a QR code is as public as the screen it is on.
 * One path with a square for each dark module, and a white quiet zone.
 */
export function QrCode({ text, label, size = 168 }: { text: string; label: string; size?: number }) {
  const { data } = encode(text, { ecc: "M", border: 4 });
  const count = data.length;
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
