import sharp from "sharp";

export async function createImageFixtures() {
  const width = 640;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let offset = 0; offset < pixels.length; offset += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[offset] = seed >>> 24;
  }
  const photo = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
  const screenshot = await sharp(Buffer.from(
    '<svg width="640" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="200" fill="white"/><text x="20" y="45" font-family="sans-serif" font-size="20">Invoice 12345 - Total USD 678.90</text><path d="M20 65H620M20 100H620M20 140H620" stroke="black"/><text x="20" y="90" font-family="sans-serif" font-size="12">Small text and precise edges must remain readable.</text></svg>'
  )).png().toBuffer();
  const transparent = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 180, b: 90, alpha: 0.3 } } }).png().toBuffer();
  const rotated = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 98 }).withMetadata({ orientation: 6 }).toBuffer();
  const animated = await sharp(Buffer.concat([Buffer.alloc(16 * 16 * 3, 40), Buffer.alloc(16 * 16 * 3, 220)]), {
    raw: { width: 16, height: 32, channels: 3, pageHeight: 16 }
  }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
  return { photo, screenshot, transparent, rotated, animated };
}