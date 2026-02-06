import { readdir, stat } from "node:fs/promises";
import { resolve, extname, basename, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { handleBatchResize } from "./image-processing.js";
import {
  handleUploadEbayImage,
  handleSearchEbayCategory,
  handleCreateEbayListing,
} from "./ebay-listing.js";
import { events } from "../dashboard/events.js";

interface ToolResult {
  success: boolean;
  output: string;
}

// --- Tool Definition ---

export const batchListerToolDefinitions: Anthropic.Tool[] = [
  {
    name: "batch_list_posters",
    description:
      "End-to-end batch workflow: scans a folder of poster images, resizes them for eBay, uploads images, generates titles/descriptions using AI analysis, and creates eBay listings. Reports progress and returns a summary with listing links. Use this for bulk poster listing operations.",
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
        dry_run: {
          type: "boolean",
          description: "If true, prepares everything but does not actually create eBay listings. Useful for previewing titles/descriptions before going live.",
        },
        additional_info: {
          type: "string",
          description: "Extra context about the posters (e.g. 'all reproductions, printed on glossy cardstock, 24x36 inches')",
        },
      },
      required: ["image_dir", "price"],
    },
  },
  {
    name: "batch_list_status",
    description:
      "Check the status of a running or completed batch listing job. Returns progress info and results.",
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
];

// --- Job tracking ---

interface ListingResult {
  file: string;
  title: string;
  description: string;
  itemSpecifics: Record<string, string>;
  imageUrl?: string;
  listingId?: string;
  status: "pending" | "processed" | "uploaded" | "listed" | "failed";
  error?: string;
}

interface BatchJob {
  id: string;
  status: "running" | "completed" | "failed";
  imageDir: string;
  price: number;
  dryRun: boolean;
  totalImages: number;
  processed: number;
  results: ListingResult[];
  startedAt: string;
  completedAt?: string;
  categoryId?: string;
  summary?: string;
}

const jobs = new Map<string, BatchJob>();

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tiff", ".bmp"]);

async function getImageFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath);
  return entries
    .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(dirPath, f));
}

/**
 * Generate listing content from a poster filename and optional context.
 * In a full implementation, this would use Claude's vision API to analyze the image.
 * For now, it extracts what it can from the filename and additional info.
 */
function generateListingFromFilename(
  filename: string,
  additionalInfo: string,
  price: number
): { title: string; description: string; itemSpecifics: Record<string, string> } {
  // Clean up filename to extract title hints
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
    // Try to extract size if mentioned
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

// --- Tool Handlers ---

export async function handleBatchListPosters(input: Record<string, unknown>): Promise<ToolResult> {
  const imageDir = resolve(input.image_dir as string);
  const price = input.price as number;
  const categoryQuery = (input.category_query as string) ?? "art poster";
  const condition = (input.condition as string) ?? "NEW";
  const quantity = (input.quantity as number) ?? 1;
  const dryRun = (input.dry_run as boolean) ?? false;
  const additionalInfo = (input.additional_info as string) ?? "";

  // Validate image directory exists
  try {
    const dirStat = await stat(imageDir);
    if (!dirStat.isDirectory()) {
      return { success: false, output: `${imageDir} is not a directory` };
    }
  } catch {
    return { success: false, output: `Directory not found: ${imageDir}` };
  }

  // Find images
  const imageFiles = await getImageFiles(imageDir);
  if (imageFiles.length === 0) {
    return { success: false, output: `No image files found in ${imageDir}` };
  }

  // Create job
  const jobId = `batch-${Date.now()}`;
  const job: BatchJob = {
    id: jobId,
    status: "running",
    imageDir,
    price,
    dryRun,
    totalImages: imageFiles.length,
    processed: 0,
    results: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);

  events.emitEvent("task:update", {
    taskId: jobId,
    status: "running",
    description: `Batch listing ${imageFiles.length} posters at $${price} each${dryRun ? " (dry run)" : ""}`,
  });

  // Run the batch workflow asynchronously
  runBatchWorkflow(job, imageFiles, {
    price,
    categoryQuery,
    condition,
    quantity,
    dryRun,
    additionalInfo,
  }).catch((err) => {
    job.status = "failed";
    job.summary = `Batch failed: ${err instanceof Error ? err.message : String(err)}`;
    events.emitEvent("task:update", { taskId: jobId, status: "failed", description: job.summary });
  });

  return {
    success: true,
    output: `Batch job started!\nJob ID: ${jobId}\nImages found: ${imageFiles.length}\nPrice: $${price.toFixed(2)} each\n${dryRun ? "DRY RUN — no listings will be created\n" : ""}Use batch_list_status with this job ID to check progress.`,
  };
}

interface BatchOptions {
  price: number;
  categoryQuery: string;
  condition: string;
  quantity: number;
  dryRun: boolean;
  additionalInfo: string;
}

async function runBatchWorkflow(
  job: BatchJob,
  imageFiles: string[],
  options: BatchOptions
): Promise<void> {
  const { price, categoryQuery, condition, quantity, dryRun, additionalInfo } = options;

  // Step 1: Find eBay category
  console.log(`[batch:${job.id}] Searching for category: ${categoryQuery}`);
  let categoryId = "550"; // Default: Art > Posters fallback

  if (!dryRun) {
    try {
      const catResult = await handleSearchEbayCategory({ query: categoryQuery });
      if (catResult.success) {
        // Extract first category ID from results
        const idMatch = catResult.output.match(/^(\d+):/m);
        if (idMatch) {
          categoryId = idMatch[1];
        }
      }
    } catch (err) {
      console.log(`[batch:${job.id}] Category search failed, using default. ${err}`);
    }
  }
  job.categoryId = categoryId;

  // Step 2: Resize images for eBay
  console.log(`[batch:${job.id}] Resizing ${imageFiles.length} images...`);
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
    // If sharp isn't installed, continue with originals
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

  // Step 3: Process each image
  for (let i = 0; i < processFiles.length; i++) {
    const file = processFiles[i];
    const originalFile = imageFiles[i]; // For display purposes
    const fileName = basename(file);

    console.log(`[batch:${job.id}] Processing ${i + 1}/${processFiles.length}: ${fileName}`);

    const result: ListingResult = {
      file: basename(originalFile ?? file),
      title: "",
      description: "",
      itemSpecifics: {},
      status: "pending",
    };

    try {
      // Generate listing content from filename
      // TODO: Replace with Claude vision analysis when generate_listing_content is enhanced
      const content = generateListingFromFilename(fileName, additionalInfo, price);
      result.title = content.title;
      result.description = content.description;
      result.itemSpecifics = content.itemSpecifics;
      result.status = "processed";

      if (!dryRun) {
        // Upload image to eBay
        try {
          const uploadResult = await handleUploadEbayImage({ image_path: file });
          if (uploadResult.success) {
            const urlMatch = uploadResult.output.match(/Image uploaded: (.+)/);
            if (urlMatch) {
              result.imageUrl = urlMatch[1];
              result.status = "uploaded";
            }
          }
        } catch (err) {
          console.log(`[batch:${job.id}] Image upload failed for ${fileName}: ${err}`);
        }

        // Create listing
        if (result.imageUrl) {
          try {
            const listResult = await handleCreateEbayListing({
              title: result.title,
              description: result.description,
              price,
              quantity,
              category_id: categoryId,
              image_urls: [result.imageUrl],
              item_specifics: result.itemSpecifics,
              condition,
            });

            if (listResult.success) {
              const idMatch = listResult.output.match(/Listing ID: (.+)/);
              result.listingId = idMatch ? idMatch[1] : "created";
              result.status = "listed";
            } else {
              result.error = listResult.output;
              result.status = "failed";
            }
          } catch (err) {
            result.error = err instanceof Error ? err.message : String(err);
            result.status = "failed";
          }
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.status = "failed";
    }

    job.results.push(result);
    job.processed = i + 1;

    events.emitEvent("task:update", {
      taskId: job.id,
      status: "running",
      description: `Batch: ${job.processed}/${job.totalImages} processed`,
    });
  }

  // Step 4: Build summary
  const listed = job.results.filter((r) => r.status === "listed").length;
  const processed = job.results.filter((r) => r.status === "processed").length;
  const failed = job.results.filter((r) => r.status === "failed").length;

  const listingSummary = job.results.map((r, i) => {
    const status = r.status === "listed" ? "LISTED" :
      r.status === "processed" ? "READY" :
      r.status === "failed" ? "FAILED" : r.status.toUpperCase();
    const listing = r.listingId ? ` (ID: ${r.listingId})` : "";
    const error = r.error ? ` — ${r.error.slice(0, 100)}` : "";
    return `${i + 1}. [${status}] ${r.title}${listing}${error}`;
  }).join("\n");

  job.summary = dryRun
    ? `DRY RUN COMPLETE\n\n${job.totalImages} posters prepared at $${price.toFixed(2)} each\nCategory ID: ${categoryId}\n\nGenerated listings:\n${listingSummary}\n\nRe-run without dry_run to actually create listings.`
    : `BATCH COMPLETE\n\nTotal: ${job.totalImages} | Listed: ${listed} | Ready: ${processed} | Failed: ${failed}\nPrice: $${price.toFixed(2)} each | Category: ${categoryId}\n\nResults:\n${listingSummary}`;

  job.status = "completed";
  job.completedAt = new Date().toISOString();

  events.emitEvent("task:update", {
    taskId: job.id,
    status: "completed",
    description: `Batch complete: ${job.totalImages} posters${dryRun ? " (dry run)" : ""}`,
  });

  console.log(`[batch:${job.id}] Complete. ${listed} listed, ${processed} ready, ${failed} failed.`);
}

export async function handleBatchListStatus(input: Record<string, unknown>): Promise<ToolResult> {
  const jobId = input.job_id as string;
  const job = jobs.get(jobId);

  if (!job) {
    return { success: false, output: `No batch job found with ID: ${jobId}` };
  }

  if (job.status === "running") {
    return {
      success: true,
      output: `Job ${job.id} is running...\nProgress: ${job.processed}/${job.totalImages}\nStarted: ${job.startedAt}`,
    };
  }

  return {
    success: true,
    output: job.summary ?? `Job ${job.id}: ${job.status}`,
  };
}
