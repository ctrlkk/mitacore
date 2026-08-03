import { describe, expect, test, beforeAll } from "bun:test";
import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { createFsFile } from "./fs-file";
import { compressImage } from "./image-resize";
import { spawn } from "./spawn";

const FIXTURES_DIR = resolve(import.meta.dir, "__tests__/fixtures");
const OUTPUT_DIR = resolve(import.meta.dir, "__tests__/output");

interface TestCase {
  name: string;
  file: string;
  expectedType: string;
  expectReduced: boolean | "maybe";
  expectedDimensions?: { width: number; height: number };
}

const testCases: TestCase[] = [
  // 大文件（超过 50KB）→ 预期会被压缩
  { name: "JPEG 大图", file: "test_large.jpg", expectedType: "image/jpeg", expectReduced: true },
  { name: "JPEG 小图(>50KB)", file: "test.jpg", expectedType: "image/jpeg", expectReduced: true },
  { name: "PNG 大图", file: "test_large.png", expectedType: "image/png", expectReduced: true },
  { name: "WebP 大图", file: "test_large.webp", expectedType: "image/webp", expectReduced: true },
  { name: "WebP 动图", file: "test_anim.webp", expectedType: "image/webp", expectReduced: "maybe" },
  { name: "BMP → PNG", file: "test.bmp", expectedType: "image/png", expectReduced: true },
  { name: "GIF 动画", file: "test.gif", expectedType: "image/gif", expectReduced: "maybe" },
  // 小文件（低于 50KB）→ 透传
  { name: "PNG 小图", file: "test.png", expectedType: "image/png", expectReduced: false },
  { name: "WebP 小图", file: "test.webp", expectedType: "image/webp", expectReduced: false },
  {
    name: "JPEG tall image",
    file: "test_tall.jpg",
    expectedType: "image/jpeg",
    expectReduced: true,
    expectedDimensions: { width: 156, height: 720 },
  },
];

beforeAll(async () => {
  await mkdir(OUTPUT_DIR, { recursive: true });
});

describe("compressImage", () => {
  for (const { name, file, expectedType, expectReduced, expectedDimensions } of testCases) {
    test(
      name,
      async () => {
        const fsFile = await createFsFile(resolve(FIXTURES_DIR, file));
        const originalSize = fsFile.size;
        const result = await compressImage(fsFile);

        // MIME 类型断言
        expect(result.type).toBe(expectedType);
        // 输出类型断言
        expect(result).toBeInstanceOf(Blob);

        // 写入压缩结果到 output 目录供人工检查
        const outBuf = await result.arrayBuffer();
        const parts = file.split(".");
        const origExt = parts.pop() ?? "bin";
        const baseName = parts.join(".");
        const outExt = origExt === "bmp" ? "png" : origExt;
        const outName = `${baseName}_${origExt}_compressed.${outExt}`;
        const outputPath = resolve(OUTPUT_DIR, outName);
        await writeFile(outputPath, new Uint8Array(outBuf));

        // 文件大小断言
        if (expectReduced === true) {
          expect(result.size).toBeLessThan(originalSize);
        } else if (expectReduced === false) {
          expect(result.size).toBe(originalSize);
        }
        if (expectedDimensions) {
          const { stdout, exitCode } = await spawn("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            outputPath,
          ]);
          expect(exitCode).toBe(0);
          expect(stdout.toString().trim()).toBe(`${expectedDimensions.width}x${expectedDimensions.height}`);
        }
        // "maybe" → 不断言大小（GIF 可能不减小）
      },
      20_000,
    );
  }

  test("不支持的 MIME 类型透传", async () => {
    const txtFile = await createFsFile(resolve(FIXTURES_DIR, "test.txt"));
    const result = await compressImage(txtFile);
    expect(result.type).toStartWith("text/plain");
    // 验证返回的是原始文件（未压缩）
    const resultArr = await new Response(result).arrayBuffer();
    const expectedArr = await txtFile.arrayBuffer();
    expect(resultArr.byteLength).toBe(expectedArr.byteLength);
  });
});
