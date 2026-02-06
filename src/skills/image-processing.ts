import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, extname, basename, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// NOTE: sharp must be installed: pnpm add sharp
// Lazy-loaded to avoid crashing if not yet installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpFn: ((input: string | Buffer) => any) | null = null;

async function getSharp(): Promise<(input: string | Buffer) => any> {
  if (!sharpFn) {
    try {
      // Dynamic import — sharp is an optional dependency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (Function('return import("sharp")')() as Promise<any>);
      sharpFn = mod.default ?? mod;
    } catch {
      throw new Error("sharp is not installed. Run: pnpm add sharp");
    }
  }
  return sharpFn!;
}

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definitions ---

export const imageToolDefinitions: Anthropic.Tool[] = [
  {
    name: "batch_resize_images",
    description:
      "Resize images in a folder to specified dimensions. Ideal for preparing images for eBay (1600px longest side recommended) or other platforms. Preserves aspect ratio by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        input_dir: {
          type: "string",
          description: "Directory containing source images",
        },
        output_dir: {
          type: "string",
          description: "Directory to save resized images (created if needed)",
        },
        max_dimension: {
          type: "number",
          description: "Maximum pixel size for the longest side (default: 1600)",
        },
        quality: {
          type: "number",
          description: "JPEG quality 1-100 (default: 90)",
        },
      },
      required: ["input_dir", "output_dir"],
    },
  },
  {
    name: "convert_image_format",
    description:
      "Convert images between formats (PNG, JPG, WebP). Useful for optimizing file sizes for upload.",
    input_schema: {
      type: "object" as const,
      properties: {
        input_path: {
          type: "string",
          description: "Path to source image or directory of images",
        },
        output_dir: {
          type: "string",
          description: "Directory to save converted images",
        },
        format: {
          type: "string",
          enum: ["jpeg", "png", "webp"],
          description: "Target format",
        },
        quality: {
          type: "number",
          description: "Output quality 1-100 (default: 90, applies to jpeg/webp)",
        },
      },
      required: ["input_path", "output_dir", "format"],
    },
  },
  {
    name: "generate_thumbnails",
    description:
      "Generate thumbnail versions of images for gallery previews. Creates smaller copies suitable for listing grids.",
    input_schema: {
      type: "object" as const,
      properties: {
        input_dir: {
          type: "string",
          description: "Directory containing source images",
        },
        output_dir: {
          type: "string",
          description: "Directory to save thumbnails",
        },
        width: {
          type: "number",
          description: "Thumbnail width in pixels (default: 400)",
        },
        height: {
          type: "number",
          description: "Thumbnail height in pixels (default: 400)",
        },
      },
      required: ["input_dir", "output_dir"],
    },
  },
  {
    name: "add_watermark",
    description:
      "Overlay a text or image watermark on images. Useful for protecting preview images before listing.",
    input_schema: {
      type: "object" as const,
      properties: {
        input_path: {
          type: "string",
          description: "Path to image or directory of images",
        },
        output_dir: {
          type: "string",
          description: "Directory to save watermarked images",
        },
        text: {
          type: "string",
          description: "Watermark text (e.g. shop name or URL)",
        },
        opacity: {
          type: "number",
          description: "Watermark opacity 0.0-1.0 (default: 0.3)",
        },
      },
      required: ["input_path", "output_dir", "text"],
    },
  },
  {
    name: "auto_crop",
    description:
      "Automatically trim whitespace or uniform borders from images. Useful for cleaning up scanned poster images.",
    input_schema: {
      type: "object" as const,
      properties: {
        input_path: {
          type: "string",
          description: "Path to image or directory of images",
        },
        output_dir: {
          type: "string",
          description: "Directory to save cropped images",
        },
        threshold: {
          type: "number",
          description: "Color difference threshold for detecting borders (default: 10)",
        },
      },
      required: ["input_path", "output_dir"],
    },
  },
];

// --- Helpers ---

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"]);

async function getImageFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath);
  return entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .map((f) => join(dirPath, f));
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// --- Tool Handlers ---

export async function handleBatchResize(input: Record<string, unknown>): Promise<ToolResult> {
  const sharpFn = await getSharp();
  const inputDir = resolve(input.input_dir as string);
  const outputDir = resolve(input.output_dir as string);
  const maxDim = (input.max_dimension as number) ?? 1600;
  const quality = (input.quality as number) ?? 90;

  await ensureDir(outputDir);
  const files = await getImageFiles(inputDir);

  if (files.length === 0) {
    return { success: false, output: `No image files found in ${inputDir}` };
  }

  const results: string[] = [];
  for (const file of files) {
    const outPath = join(outputDir, basename(file));
    try {
      await sharpFn(file)
        .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toFile(outPath);
      results.push(`Resized: ${basename(file)}`);
    } catch (err) {
      results.push(`Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: true,
    output: `Processed ${files.length} images to ${outputDir}\n${results.join("\n")}`,
  };
}

export async function handleConvertFormat(input: Record<string, unknown>): Promise<ToolResult> {
  const sharpFn = await getSharp();
  const inputPath = resolve(input.input_path as string);
  const outputDir = resolve(input.output_dir as string);
  const format = input.format as "jpeg" | "png" | "webp";
  const quality = (input.quality as number) ?? 90;

  await ensureDir(outputDir);

  // Determine if input is a file or directory
  const { stat: fsStat } = await import("node:fs/promises");
  const inputStat = await fsStat(inputPath);
  const files = inputStat.isDirectory() ? await getImageFiles(inputPath) : [inputPath];

  if (files.length === 0) {
    return { success: false, output: `No image files found at ${inputPath}` };
  }

  const extMap = { jpeg: ".jpg", png: ".png", webp: ".webp" };
  const results: string[] = [];

  for (const file of files) {
    const newName = basename(file, extname(file)) + extMap[format];
    const outPath = join(outputDir, newName);
    try {
      let pipeline = sharpFn(file);
      if (format === "jpeg") pipeline = pipeline.jpeg({ quality });
      else if (format === "png") pipeline = pipeline.png();
      else if (format === "webp") pipeline = pipeline.webp({ quality });
      await pipeline.toFile(outPath);
      results.push(`Converted: ${basename(file)} → ${newName}`);
    } catch (err) {
      results.push(`Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: true,
    output: `Converted ${files.length} images to ${format}\n${results.join("\n")}`,
  };
}

export async function handleGenerateThumbnails(input: Record<string, unknown>): Promise<ToolResult> {
  const sharpFn = await getSharp();
  const inputDir = resolve(input.input_dir as string);
  const outputDir = resolve(input.output_dir as string);
  const width = (input.width as number) ?? 400;
  const height = (input.height as number) ?? 400;

  await ensureDir(outputDir);
  const files = await getImageFiles(inputDir);

  if (files.length === 0) {
    return { success: false, output: `No image files found in ${inputDir}` };
  }

  const results: string[] = [];
  for (const file of files) {
    const outPath = join(outputDir, `thumb_${basename(file)}`);
    try {
      await sharpFn(file)
        .resize(width, height, { fit: "cover" })
        .jpeg({ quality: 80 })
        .toFile(outPath);
      results.push(`Thumbnail: ${basename(file)}`);
    } catch (err) {
      results.push(`Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: true,
    output: `Generated ${results.length} thumbnails in ${outputDir}\n${results.join("\n")}`,
  };
}

export async function handleAddWatermark(input: Record<string, unknown>): Promise<ToolResult> {
  const sharpFn = await getSharp();
  const inputPath = resolve(input.input_path as string);
  const outputDir = resolve(input.output_dir as string);
  const text = input.text as string;
  const opacity = (input.opacity as number) ?? 0.3;

  await ensureDir(outputDir);

  const { stat: fsStat } = await import("node:fs/promises");
  const inputStat = await fsStat(inputPath);
  const files = inputStat.isDirectory() ? await getImageFiles(inputPath) : [inputPath];

  if (files.length === 0) {
    return { success: false, output: `No image files found at ${inputPath}` };
  }

  const results: string[] = [];
  for (const file of files) {
    const outPath = join(outputDir, basename(file));
    try {
      const metadata = await sharpFn(file).metadata();
      const imgWidth = metadata.width ?? 800;
      const imgHeight = metadata.height ?? 600;

      // Create SVG text overlay
      const fontSize = Math.max(imgWidth / 20, 24);
      const svg = `<svg width="${imgWidth}" height="${imgHeight}">
        <style>.watermark { fill: rgba(255,255,255,${opacity}); font-size: ${fontSize}px; font-family: sans-serif; }</style>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" class="watermark" transform="rotate(-30, ${imgWidth / 2}, ${imgHeight / 2})">${text}</text>
      </svg>`;

      await sharpFn(file)
        .composite([{ input: Buffer.from(svg), gravity: "center" }])
        .toFile(outPath);
      results.push(`Watermarked: ${basename(file)}`);
    } catch (err) {
      results.push(`Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: true,
    output: `Watermarked ${results.length} images in ${outputDir}\n${results.join("\n")}`,
  };
}

export async function handleAutoCrop(input: Record<string, unknown>): Promise<ToolResult> {
  const sharpFn = await getSharp();
  const inputPath = resolve(input.input_path as string);
  const outputDir = resolve(input.output_dir as string);
  const threshold = (input.threshold as number) ?? 10;

  await ensureDir(outputDir);

  const { stat: fsStat } = await import("node:fs/promises");
  const inputStat = await fsStat(inputPath);
  const files = inputStat.isDirectory() ? await getImageFiles(inputPath) : [inputPath];

  if (files.length === 0) {
    return { success: false, output: `No image files found at ${inputPath}` };
  }

  const results: string[] = [];
  for (const file of files) {
    const outPath = join(outputDir, basename(file));
    try {
      await sharpFn(file)
        .trim({ threshold })
        .toFile(outPath);
      results.push(`Cropped: ${basename(file)}`);
    } catch (err) {
      results.push(`Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    success: true,
    output: `Auto-cropped ${results.length} images in ${outputDir}\n${results.join("\n")}`,
  };
}
