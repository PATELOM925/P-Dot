// Makes the favicon and the app icons from the mascot (src/components/ui/Mascot.tsx).
// Run: node scripts/make-icons.mjs
// It uses sharp, which Next.js installs. Keep the shapes here in step with Mascot.tsx.
import { writeFile } from "node:fs/promises";
import sharp from "sharp";

const FACE = `
  <defs>
    <linearGradient id="g" x1="8" y1="6" x2="56" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="0.55" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="29" fill="url(#g)"/>
  <ellipse cx="22" cy="15" rx="11" ry="6" fill="#fff" opacity="0.22" transform="rotate(-24 22 15)"/>
  <ellipse cx="23" cy="29" rx="3.6" ry="4.6" fill="#fff"/>
  <ellipse cx="41" cy="29" rx="3.6" ry="4.6" fill="#fff"/>
  <circle cx="16" cy="39" r="4" fill="#fda4af" opacity="0.7"/>
  <circle cx="48" cy="39" r="4" fill="#fda4af" opacity="0.7"/>
  <path d="M23 41c2.6 4.6 15.4 4.6 18 0" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>`;

/** The mascot on a transparent ground. Readable on light and dark tabs and home screens. */
const mascot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${FACE}
</svg>
`;

/** The mascot, `scale` of the width, on a solid ground (the maskable safe zone and iOS need one). */
const onGround = (ground, scale) => {
  const offset = (64 - 64 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${ground}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">${FACE}</g>
</svg>`;
};

/** A notification badge: one colour on transparent, with the eyes and the smile cut out. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <mask id="m">
    <rect width="64" height="64" fill="#fff"/>
    <ellipse cx="23" cy="29" rx="3.6" ry="4.6" fill="#000"/>
    <ellipse cx="41" cy="29" rx="3.6" ry="4.6" fill="#000"/>
    <path d="M23 41c2.6 4.6 15.4 4.6 18 0" fill="none" stroke="#000" stroke-width="3.2" stroke-linecap="round"/>
  </mask>
  <circle cx="32" cy="32" r="29" fill="#fff" mask="url(#m)"/>
</svg>`;

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * Math.ceil(size / 64) * 2 }).resize(size, size).png().toBuffer();

/** An ICO file with PNG images (supported since Windows Vista and by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

await writeFile("src/app/icon.svg", mascot);
await writeFile("public/icons/icon-192.png", await png(mascot, 192));
await writeFile("public/icons/icon-512.png", await png(mascot, 512));
await writeFile("public/icons/maskable-512.png", await png(onGround("#f4f4f7", 0.72), 512));
await writeFile("src/app/apple-icon.png", await png(onGround("#ffffff", 0.84), 180));
await writeFile("public/icons/badge-96.png", await png(badge, 96));
const favicons = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(mascot, size) })));
await writeFile("src/app/favicon.ico", ico(favicons));
console.log("Icons written.");
