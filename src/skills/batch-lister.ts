import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, basename, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { handleBatchResize } from "./image-processing.js";
import {
  handleUploadEbayImage,
  handleSearchEbayCategory,
  handleCreateEbayListing,
} from "./ebay-listing.js";
import { handleAnalyzePosterForListing } from "./vision.js";
import { memory } from "../agent/memory.js";
import { events } from "../dashboard/events.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Persistent batch manifest ---

const MEMORY_DIR = resolve("memory");
const BATCH_FILE = join(MEMORY_DIR, "batch-jobs.json");

interface BatchJobsFile {
  version: number;
  jobs: Record<string, BatchJob>;
}

async function loadBatchJobs(): Promise<BatchJobsFile> {
  try {
    const raw = await readFile(BATCH_FILE, "utf-8");
    return JSON.parse(raw) as BatchJobsFile;
  } catch {
    return { version: 1, jobs: {} };
  }
}

async function saveBatchJobs(data: BatchJobsFile): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(BATCH_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// --- Types ---

interface ListingResult {
  file: string;
  filePath: string;
  title: string;
  description: string;
  itemSpecifics: Record<string, string>;
  imageUrl?: string;
  listingId?: string;
  sku?: string;
  offerId?: string;
  status: "pending" | "vision_done" | "uploaded" | "listed" | "failed";
  error?: string;
}

type BatchStatus = "processing" | "awaiting_review" | "publishing" | "completed" | "failed";

interface BatchJob {
  id: string;
  status: BatchStatus;
  imageDir: string;
  price: number;
  totalImages: number;
  processed: number;
  results: ListingResult[];
  startedAt: string;
  completedAt?: string;
  categoryId?: string;
  categoryQuery?: string;
  condition?: string;
  quantity?: number;
  additionalInfo?: string;
  styleTemplate?: string;
  summary?: string;
}

// --- Tool Definitions ---

export const batchListerToolDefinitions: Anthropic.Tool[] = [
  {
    name: "batch_list_posters",
    description:
      "Process a folder of poster images using AI vision to generate eBay listing content (titles, descriptions, item specifics). Does NOT publish to eBay — creates a manifest for review first. Use review_batch_samples to preview, then approve_batch to publish.",
    input_schema: {
      type: "object" as const,
      properties: {
        image_dir: {
          type: "string",
          description: "Directory containing poster images to list",
        },
        price: {
          type: "number",
          description: "Price per poster in USD",
        },
        category_query: {
          type: "string",
          description: "Search term to find eBay category (e.g. 'art poster', 'vintage movie poster'). Defaults to 'art poster'.",
        },
        condition: {
          type: "string",
          enum: ["NEW", "LIKE_NEW", "VERY_GOOD", "GOOD", "ACCEPTABLE"],
          description: "Condition of all posters (default: NEW)",
        },
        quantity: {
          type: "number",
          description: "Quantity of each poster available (default: 1)",
        },
        additional_info: {
          type: "string",
          description: "Extra context about the posters (e.g. 'all reproductions, printed on glossy cardstock, 24x36 inches')",
        },
        style_template: {
          type: "string",
          description: "Name of a saved note containing a listing style template. The template is prepended to the vision prompt so all listings match a consistent style.",
        },
      },
      required: ["image_dir", "price"],
    },
  },
  {
    name: "batch_list_status",
    description:
      "Check the status of a batch listing job. Returns progress info, current status, and results.",
    input_schema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string",
          description: "The job ID returned by batch_list_posters",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "review_batch_samples",
    description:
      "Pick random sample listings from a batch job and show formatted previews for review. Use after batch_list_posters finishes processing to show the user what listings will look like before publishing.",
    input_schema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string",
          description: "The batch job ID",
        },
        count: {
          type: "number",
          description: "Number of random samples to show (default: 6)",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "approve_batch",
    description:
      "Approve and publish all pending listings from a batch job to eBay. Call after the user has reviewed samples and is satisfied. Uploads images and creates live listings. Optionally provide adjustments to re-process all listings through vision first.",
    input_schema: {
      type: "object" as const,
      properties: {
        job_id: {
          type: "string",
          description: "The batch job ID to approve and publish",
        },
        adjustments: {
          type: "string",
          description: "Optional feedback to adjust all listings before publishing (e.g. 'make descriptions shorter', 'add free shipping note'). Re-processes through vision with this feedback, then returns for review again.",
        },
      },
      required: ["job_id"],
    },
  },
];

// --- Helpers ---

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"]);

async function getImageFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath);
  return entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(dirPath, f));
}

/**
 * Parse JSON from vision output, stripping markdown code fences if present.
 */
function parseVisionJson(raw: string): { title: string; description: string; item_specifics: Record<string, string> } {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return JSON.parse(cleaned.trim());
}

/**
 * Fallback listing generation from filename when vision fails.
 */
function generateListingFromFilename(
  filename: string,
  additionalInfo: string,
  _price: number
): { title: string; description: string; itemSpecifics: Record<string, string> } {
  const nameWithoutExt = basename(filename, extname(filename));
  const cleanName = nameWithoutExt
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

  const title = cleanName.length > 80 ? cleanName.slice(0, 77) + "..." : cleanName;

  const description = `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
  <h2>${title}</h2>
  <p>Beautiful poster print, perfect for framing and display.</p>
  ${additionalInfo ? `<p><strong>Details:</strong> ${additionalInfo}</p>` : ""}
  <ul>
    <li>High-quality print</li>
    <li>Ready to frame</li>
    <li>Ships rolled in a protective tube</li>
  </ul>
  <p><em>Please see photos for exact item. Feel free to message with any questions!</em></p>
</div>`;

  const itemSpecifics: Record<string, string> = {
    Type: "Poster",
    Features: "Unframed",
  };

  if (additionalInfo) {
    const sizeMatch = additionalInfo.match(/(\d+)\s*x\s*(\d+)/i);
    if (sizeMatch) {
      itemSpecifics["Size"] = `${sizeMatch[1]}x${sizeMatch[2]} inches`;
    }
    if (/reproduction|reprint|re-print/i.test(additionalInfo)) {
      itemSpecifics["Original/Reproduction"] = "Reproduction";
    }
    if (/original/i.test(additionalInfo)) {
      itemSpecifics["Original/Reproduction"] = "Original";
    }
  }

  return { title, description, itemSpecifics };
}

// --- Phase 1: Process images through vision ---

async function processImages(job: BatchJob, imageFiles: string[]): Promise<void> {
  const data = await loadBatchJobs();
  const additionalInfo = job.additionalInfo ?? "";

  // Load style template if specified
  let styleContext = "";
  if (job.styleTemplate) {
    const template = await memory.loadNote(job.styleTemplate);
    if (template) {
      styleContext = `Follow this listing style template:\n${template}\n\n`;
    }
  }

  // Resize images for eBay
  const resizedDir = resolve(job.imageDir, "..", `${basename(job.imageDir)}-resized`);
  try {
    await handleBatchResize({
      input_dir: job.imageDir,
      output_dir: resizedDir,
      max_dimension: 1600,
      quality: 90,
    });
    console.log(`[batch:${job.id}] Images resized to ${resizedDir}`);
  } catch (err) {
    console.log(`[batch:${job.id}] Resize failed (sharp not installed?), using originals. ${err}`);
  }

  // Use resized images if available, otherwise originals
  let processDir = job.imageDir;
  try {
    const resizedFiles = await getImageFiles(resizedDir);
    if (resizedFiles.length > 0) {
      processDir = resizedDir;
    }
  } catch {
    // resized dir doesn't exist, use originals
  }

  const processFiles = await getImageFiles(processDir);

  for (let i = 0; i < processFiles.length; i++) {
    const file = processFiles[i];
    const originalFile = imageFiles[i];
    const fileName = basename(file);

    console.log(`[batch:${job.id}] Processing ${i + 1}/${processFiles.length}: ${fileName}`);

    const result: ListingResult = {
      file: basename(originalFile ?? file),
      filePath: file,
      title: "",
      description: "",
      itemSpecifics: {},
      status: "pending",
    };

    // Try vision analysis first, fall back to filename
    try {
      const visionContext = styleContext + additionalInfo;

      // Rate limit: 500ms delay between vision calls
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }

      const visionResult = await handleAnalyzePosterForListing({
        image_path: file,
        additional_info: visionContext || undefined,
      });

      if (visionResult.success) {
        const parsed = parseVisionJson(visionResult.output);
        result.title = parsed.title ?? "";
        result.description = parsed.description ?? "";
        result.itemSpecifics = parsed.item_specifics ?? {};
        result.status = "vision_done";
      } else {
        throw new Error(visionResult.output);
      }
    } catch (err) {
      console.log(`[batch:${job.id}] Vision failed for ${fileName}, using filename fallback: ${err}`);
      const content = generateListingFromFilename(fileName, additionalInfo, job.price);
      result.title = content.title;
      result.description = content.description;
      result.itemSpecifics = content.itemSpecifics;
      result.status = "vision_done";
    }

    job.results.push(result);
    job.processed = i + 1;

    events.emitEvent("task:update", {
      taskId: job.id,
      status: "running",
      description: `Processing: ${job.processed}/${job.totalImages} (vision analysis)`,
    });

    // Save progress every 5 images
    if (i % 5 === 0 || i === processFiles.length - 1) {
      data.jobs[job.id] = job;
      await saveBatchJobs(data);
    }
  }

  // Done processing — ready for review
  job.status = "awaiting_review";
  const visionCount = job.results.filter((r) => r.status === "vision_done").length;
  job.summary = `Processing complete. ${visionCount}/${job.totalImages} listings generated via AI vision.\nUse review_batch_samples to preview, then approve_batch to publish.`;

  data.jobs[job.id] = job;
  await saveBatchJobs(data);

  events.emitEvent("task:update", {
    taskId: job.id,
    status: "running",
    description: `Ready for review: ${visionCount} listings processed`,
  });

  console.log(`[batch:${job.id}] Processing complete. ${visionCount} listings ready for review.`);
}

// --- Phase 2: Publish approved listings to eBay ---

async function publishBatch(job: BatchJob): Promise<void> {
  const data = await loadBatchJobs();

  // Find eBay category
  let categoryId = job.categoryId ?? "550";
  try {
    const catResult = await handleSearchEbayCategory({ query: job.categoryQuery ?? "art poster" });
    if (catResult.success) {
      const idMatch = catResult.output.match(/^(\d+):/m);
      if (idMatch) categoryId = idMatch[1];
    }
  } catch {
    /* use default */
  }
  job.categoryId = categoryId;

  let publishCount = 0;
  for (let i = 0; i < job.results.length; i++) {
    const result = job.results[i];
    if (result.status !== "vision_done") continue;

    try {
      // Upload image
      const uploadResult = await handleUploadEbayImage({ image_path: result.filePath });
      if (uploadResult.success) {
        const urlMatch = uploadResult.output.match(/Image uploaded: (.+)/);
        if (urlMatch) {
          result.imageUrl = urlMatch[1];
          result.status = "uploaded";
        }
      }

      // Create listing
      if (result.imageUrl) {
        const listResult = await handleCreateEbayListing({
          title: result.title,
          description: result.description,
          price: job.price,
          quantity: job.quantity ?? 1,
          category_id: categoryId,
          image_urls: [result.imageUrl],
          item_specifics: result.itemSpecifics,
          condition: job.condition ?? "NEW",
        });

        if (listResult.success) {
          const idMatch = listResult.output.match(/Listing ID: (.+)/);
          const skuMatch = listResult.output.match(/SKU: (.+)/);
          result.listingId = idMatch ? idMatch[1] : "created";
          result.sku = skuMatch ? skuMatch[1] : undefined;
          result.status = "listed";
          publishCount++;
        } else {
          result.error = listResult.output;
          result.status = "failed";
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.status = "failed";
    }

    // Save progress every 5 items
    if (i % 5 === 0 || i === job.results.length - 1) {
      data.jobs[job.id] = job;
      await saveBatchJobs(data);
    }

    events.emitEvent("task:update", {
      taskId: job.id,
      status: "running",
      description: `Publishing: ${publishCount}/${job.totalImages}`,
    });
  }

  // Final summary
  const listed = job.results.filter((r) => r.status === "listed").length;
  const failed = job.results.filter((r) => r.status === "failed").length;

  job.summary = `BATCH PUBLISHED\n\nTotal: ${job.totalImages} | Listed: ${listed} | Failed: ${failed}\nPrice: $${job.price.toFixed(2)} each | Category: ${categoryId}\n\n` +
    job.results
      .map((r, idx) => {
        const icon = r.status === "listed" ? "LISTED" : r.status === "failed" ? "FAILED" : r.status.toUpperCase();
        const listing = r.listingId ? ` (ID: ${r.listingId})` : "";
        const error = r.error ? ` — ${r.error.slice(0, 100)}` : "";
        return `${idx + 1}. [${icon}] ${r.title}${listing}${error}`;
      })
      .join("\n");

  job.status = "completed";
  job.completedAt = new Date().toISOString();

  data.jobs[job.id] = job;
  await saveBatchJobs(data);

  events.emitEvent("task:update", {
    taskId: job.id,
    status: "completed",
    description: `Batch complete: ${listed} listed, ${failed} failed`,
  });

  console.log(`[batch:${job.id}] Publish complete. ${listed} listed, ${failed} failed.`);
}

// --- Re-process with adjustments ---

async function reprocessBatch(job: BatchJob, adjustments: string): Promise<void> {
  const data = await loadBatchJobs();

  for (let i = 0; i < job.results.length; i++) {
    const result = job.results[i];
    if (result.status === "listed") continue; // don't re-process already listed items

    try {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }

      const visionResult = await handleAnalyzePosterForListing({
        image_path: result.filePath,
        additional_info: `${job.additionalInfo ?? ""}\n\nADJUSTMENT FROM REVIEWER: ${adjustments}`,
      });

      if (visionResult.success) {
        const parsed = parseVisionJson(visionResult.output);
        result.title = parsed.title ?? result.title;
        result.description = parsed.description ?? result.description;
        result.itemSpecifics = parsed.item_specifics ?? result.itemSpecifics;
        result.status = "vision_done";
      }
    } catch {
      // Keep existing content on re-process failure
    }

    if (i % 5 === 0 || i === job.results.length - 1) {
      data.jobs[job.id] = job;
      await saveBatchJobs(data);
    }

    events.emitEvent("task:update", {
      taskId: job.id,
      status: "running",
      description: `Re-processing: ${i + 1}/${job.results.length}`,
    });
  }

  // Return to review
  job.status = "awaiting_review";
  data.jobs[job.id] = job;
  await saveBatchJobs(data);

  events.emitEvent("task:update", {
    taskId: job.id,
    status: "running",
    description: "Re-processing complete. Ready for review.",
  });

  console.log(`[batch:${job.id}] Re-processing complete. Ready for review.`);
}

// --- Tool Handlers ---

export async function handleBatchListPosters(input: Record<string, unknown>): Promise<ToolResult> {
  const imageDir = resolve(input.image_dir as string);
  const price = input.price as number;
  const categoryQuery = (input.category_query as string) ?? "art poster";
  const condition = (input.condition as string) ?? "NEW";
  const quantity = (input.quantity as number) ?? 1;
  const additionalInfo = (input.additional_info as string) ?? "";
  const styleTemplate = input.style_template as string | undefined;

  // Validate image directory
  try {
    const dirStat = await stat(imageDir);
    if (!dirStat.isDirectory()) {
      return { success: false, output: `${imageDir} is not a directory` };
    }
  } catch {
    return { success: false, output: `Directory not found: ${imageDir}` };
  }

  const imageFiles = await getImageFiles(imageDir);
  if (imageFiles.length === 0) {
    return { success: false, output: `No image files found in ${imageDir}` };
  }

  // Create job
  const jobId = `batch-${Date.now()}`;
  const job: BatchJob = {
    id: jobId,
    status: "processing",
    imageDir,
    price,
    totalImages: imageFiles.length,
    processed: 0,
    results: [],
    startedAt: new Date().toISOString(),
    categoryQuery,
    condition,
    quantity,
    additionalInfo,
    styleTemplate,
  };

  // Save initial job
  const data = await loadBatchJobs();
  data.jobs[jobId] = job;
  await saveBatchJobs(data);

  events.emitEvent("task:update", {
    taskId: jobId,
    status: "running",
    description: `Processing ${imageFiles.length} posters through AI vision`,
  });

  // Run vision processing async
  processImages(job, imageFiles).catch((err) => {
    job.status = "failed";
    job.summary = `Processing failed: ${err instanceof Error ? err.message : String(err)}`;
    const d = loadBatchJobs().then((d) => {
      d.jobs[jobId] = job;
      return saveBatchJobs(d);
    });
    d.catch(() => {});
    events.emitEvent("task:update", { taskId: jobId, status: "failed", description: job.summary });
  });

  return {
    success: true,
    output: `Batch job started!\nJob ID: ${jobId}\nImages found: ${imageFiles.length}\nPrice: $${price.toFixed(2)} each\n\nProcessing all images through AI vision analysis. This may take a few minutes.\nUse batch_list_status to check progress.\nOnce done, use review_batch_samples to preview listings before publishing.`,
  };
}

export async function handleBatchListStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const jobId = input.job_id as string;
  const data = await loadBatchJobs();
  const job = data.jobs[jobId];

  if (!job) {
    return { success: false, output: `No batch job found with ID: ${jobId}` };
  }

  if (job.status === "processing") {
    return {
      success: true,
      output: `Job ${job.id} is processing...\nProgress: ${job.processed}/${job.totalImages} images analyzed\nStarted: ${job.startedAt}`,
    };
  }

  if (job.status === "awaiting_review") {
    const visionCount = job.results.filter((r) => r.status === "vision_done").length;
    return {
      success: true,
      output: `Job ${job.id} — READY FOR REVIEW\n${visionCount}/${job.totalImages} listings generated\nPrice: $${job.price.toFixed(2)} each\n\nUse review_batch_samples to preview random listings.\nUse approve_batch to publish to eBay.`,
    };
  }

  if (job.status === "publishing") {
    const listed = job.results.filter((r) => r.status === "listed").length;
    return {
      success: true,
      output: `Job ${job.id} is publishing to eBay...\n${listed}/${job.totalImages} listed so far`,
    };
  }

  return {
    success: true,
    output: job.summary ?? `Job ${job.id}: ${job.status}`,
  };
}

export async function handleReviewBatchSamples(input: Record<string, unknown>): Promise<ToolResult> {
  const jobId = input.job_id as string;
  const count = (input.count as number) ?? 6;

  const data = await loadBatchJobs();
  const job = data.jobs[jobId];

  if (!job) {
    return { success: false, output: `No batch job found with ID: ${jobId}` };
  }

  if (job.status !== "awaiting_review" && job.status !== "completed") {
    return {
      success: false,
      output: `Job ${jobId} is in status "${job.status}" — cannot review yet. Wait for processing to complete.`,
    };
  }

  const reviewable = job.results.filter(
    (r) => r.status === "vision_done" || r.status === "listed"
  );

  if (reviewable.length === 0) {
    return { success: false, output: `No processed listings to review in job ${jobId}` };
  }

  // Fisher-Yates shuffle, take first N
  const shuffled = [...reviewable].sort(() => Math.random() - 0.5);
  const samples = shuffled.slice(0, Math.min(count, shuffled.length));

  const formatted = samples
    .map((r, i) => {
      const specifics = Object.entries(r.itemSpecifics)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      return `--- Sample ${i + 1} of ${samples.length} ---
File: ${r.file}
Title: ${r.title}
Price: $${job.price.toFixed(2)}

Item Specifics:
${specifics}

Description preview:
${r.description.replace(/<[^>]+>/g, "").slice(0, 300)}${r.description.length > 300 ? "..." : ""}
`;
    })
    .join("\n");

  return {
    success: true,
    output: `Showing ${samples.length} random samples from batch "${jobId}" (${reviewable.length} total):\n\n${formatted}\nIf these look good, use approve_batch to publish all ${reviewable.length} listings.\nIf adjustments are needed, use approve_batch with the "adjustments" parameter.`,
  };
}

export async function handleApproveBatch(input: Record<string, unknown>): Promise<ToolResult> {
  const jobId = input.job_id as string;
  const adjustments = input.adjustments as string | undefined;

  const data = await loadBatchJobs();
  const job = data.jobs[jobId];

  if (!job) {
    return { success: false, output: `No batch job found with ID: ${jobId}` };
  }

  if (job.status !== "awaiting_review") {
    return {
      success: false,
      output: `Job ${jobId} is in status "${job.status}" — can only approve jobs in "awaiting_review" status.`,
    };
  }

  if (adjustments) {
    // Re-process with adjustments, then return to review
    job.status = "processing";
    data.jobs[jobId] = job;
    await saveBatchJobs(data);

    reprocessBatch(job, adjustments).catch((err) => {
      job.status = "failed";
      job.summary = `Re-processing failed: ${err instanceof Error ? err.message : String(err)}`;
    });

    return {
      success: true,
      output: `Re-processing ${job.results.length} listings with adjustment: "${adjustments}"\nUse batch_list_status to check progress. Will return for review when done.`,
    };
  }

  // No adjustments — publish
  const pendingCount = job.results.filter((r) => r.status === "vision_done").length;
  job.status = "publishing";
  data.jobs[jobId] = job;
  await saveBatchJobs(data);

  publishBatch(job).catch((err) => {
    job.status = "failed";
    job.summary = `Publishing failed: ${err instanceof Error ? err.message : String(err)}`;
  });

  return {
    success: true,
    output: `Approved! Publishing ${pendingCount} listings to eBay.\nUse batch_list_status to check progress.`,
  };
}
