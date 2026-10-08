import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { QR_MAX_BYTES, QR_MAX_VERSION, encodeQr, qrCapacity } from "../../src/helpers/qr";

/** Render a matrix to RGBA pixels with a quiet zone, the way a screen would show it. */
function render(matrix: boolean[][], scale = 4, quiet = 4) {
  const modules = matrix.length + quiet * 2;
  const width = modules * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx;
          data.fill(0, px * 4, px * 4 + 3);
        }
      }
    }),
  );
  return { data, width, height: width };
}

function decode(bytes: Uint8Array): Uint8Array | null {
  const image = render(encodeQr(bytes));
  const result = jsQR(image.data, image.width, image.height);
  return result ? Uint8Array.from(result.binaryData) : null;
}

const sample = (n: number): Uint8Array => {
  // Deterministic bytes that cover the whole byte range.
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
};

describe("QR capacity", () => {
  it("matches the published level M byte-mode capacities", () => {
    expect([1, 2, 3, 4, 5, 10, 16].map(qrCapacity)).toEqual([14, 26, 42, 62, 84, 213, 450]);
    expect(QR_MAX_BYTES).toBe(450);
  });
});

describe("encodeQr round trip through an independent decoder", () => {
  it("a short text decodes to the same bytes", () => {
    const text = new TextEncoder().encode("Rewind Vault");
    expect(decode(text)).toEqual(text);
  });

  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    it(`version ${version}: fills the version exactly and decodes`, () => {
      const data = sample(qrCapacity(version));
      expect(encodeQr(data).length).toBe(17 + 4 * version);
      expect(decode(data)).toEqual(data);
    });
  }

  it("the smallest payload that needs the next version still decodes", () => {
    for (const version of [1, 6, 9, 15]) {
      const data = sample(qrCapacity(version) + 1);
      expect(encodeQr(data).length).toBe(17 + 4 * (version + 1));
      expect(decode(data)).toEqual(data);
    }
  });

  it("an empty payload and single byte work", () => {
    expect(decode(new Uint8Array([]))).toEqual(new Uint8Array([]));
    expect(decode(new Uint8Array([0xff]))).toEqual(new Uint8Array([0xff]));
  });

  it("refuses data that does not fit", () => {
    expect(() => encodeQr(sample(QR_MAX_BYTES + 1))).toThrow(RangeError);
  });

  it("has the fixed patterns every scanner looks for", () => {
    const m = encodeQr(new TextEncoder().encode("x"));
    const n = m.length;
    for (const [ox, oy] of [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ] as const) {
      expect(m[oy]?.[ox]).toBe(true);
      expect(m[oy + 3]?.[ox + 3]).toBe(true);
      expect(m[oy + 1]?.[ox + 1]).toBe(false);
    }
    expect(m[6]?.[8]).toBe(true);
    expect(m[6]?.[9]).toBe(false);
    expect(m[n - 8]?.[8]).toBe(true); // dark module
  });
});
