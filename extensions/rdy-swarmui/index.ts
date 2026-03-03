import pg from "pg";
import { writeFile, mkdir, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

// --- Config ---

const SWARM_URL = process.env.SWARM_URL ?? "http://100.111.98.26:7801";
const SWARM_AUTH = process.env.SWARM_AUTH ?? "swarm-rdy-api-2026";
const PG_URL =
  "postgresql://postgres:8b309fab0813a258592d0f849c5e8a3f0498ccc4427d88f5@100.120.14.56:5433/rdycore";
const MEDIA_DIR = join(
  process.env.HOME ?? "/home/samau",
  ".openclaw",
  "media",
  "outbound",
);

const pool = new pg.Pool({ connectionString: PG_URL, max: 3 });

// --- GPU credit limits per plan ---

const GPU_PLAN_LIMITS: Record<string, number> = {
  free: 3,
  starter: 20,
  pro: 100,
  enterprise: 500,
};
const DEFAULT_FREE_CREDITS = 3;

// --- SwarmUI Client ---

let cachedSessionId: string | null = null;

function swarmHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SWARM_AUTH) h["Authorization"] = SWARM_AUTH;
  return h;
}

async function getSession(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  const res = await fetch(`${SWARM_URL}/API/GetNewSession`, {
    method: "POST",
    headers: swarmHeaders(),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`SwarmUI session error: ${data.error}`);
  cachedSessionId = data.session_id;
  return cachedSessionId!;
}

async function invalidateSession(): Promise<void> {
  cachedSessionId = null;
}

async function swarmPost(endpoint: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
  const sessionId = await getSession();
  const payload = { session_id: sessionId, ...body };
  const res = await fetch(`${SWARM_URL}/API/${endpoint}`, {
    method: "POST",
    headers: swarmHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (data.error?.includes("session") || data.error?.includes("unauthorized")) {
    await invalidateSession();
    const newSessionId = await getSession();
    const retryPayload = { session_id: newSessionId, ...body };
    const retryRes = await fetch(`${SWARM_URL}/API/${endpoint}`, {
      method: "POST",
      headers: swarmHeaders(),
      body: JSON.stringify(retryPayload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return retryRes.json();
  }
  return data;
}

async function downloadImage(imagePath: string): Promise<string> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const url = `${SWARM_URL}/${imagePath}`;
  const res = await fetch(url, { headers: swarmHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = imagePath.split(".").pop() ?? "png";
  const filename = `swarm_${Date.now()}.${ext}`;
  const localPath = join(MEDIA_DIR, filename);
  await writeFile(localPath, buffer);
  return localPath;
}

// --- DB helpers ---

function currentPeriod(): string {
  return new Date()
    .toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" })
    .slice(0, 7);
}

async function checkAndIncrementGpuCredits(
  tenantId: string,
): Promise<{ allowed: boolean; count: number; limit: number; plan: string }> {
  const tenantRes = await pool.query(
    "SELECT plan FROM tenants WHERE id = $1",
    [tenantId],
  );
  const plan = tenantRes.rows[0]?.plan ?? "free";
  const limit = GPU_PLAN_LIMITS[plan] ?? DEFAULT_FREE_CREDITS;
  const period = currentPeriod();

  // Upsert and get current count
  const { rows } = await pool.query(
    `INSERT INTO tenant_gpu_usage (tenant_id, period, gen_count)
     VALUES ($1, $2, 0)
     ON CONFLICT (tenant_id, period) DO NOTHING`,
    [tenantId, period],
  );
  const countRes = await pool.query(
    `SELECT gen_count FROM tenant_gpu_usage WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period],
  );
  const currentCount = countRes.rows[0]?.gen_count ?? 0;

  if (currentCount >= limit) {
    return { allowed: false, count: currentCount, limit, plan };
  }

  // Increment
  await pool.query(
    `UPDATE tenant_gpu_usage SET gen_count = gen_count + 1
     WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period],
  );

  return { allowed: true, count: currentCount + 1, limit, plan };
}

async function resolveTenantFromSession(
  sessionKey: string | undefined,
  log: any,
): Promise<string | null> {
  // Try to find tenant via session key patterns
  if (!sessionKey) return null;

  // Extract phone or channel identity from session key
  const parts = sessionKey.split(":");
  for (const part of parts) {
    if (part.startsWith("+") && /^\+\d{8,15}$/.test(part)) {
      const { rows } = await pool.query(
        "SELECT id FROM tenants WHERE phone = $1",
        [part],
      );
      if (rows[0]) return rows[0].id;
    }
  }

  // Try identity-based lookup
  for (const part of parts) {
    if (part.startsWith("wecom-kf:") || part.startsWith("wecom:")) {
      const [channel, uid] = part.includes("wecom-kf:")
        ? ["wecom-kf", part.slice("wecom-kf:".length)]
        : ["wecom", part.slice("wecom:".length)];
      const { rows } = await pool.query(
        `SELECT t.id FROM tenant_identities ti
         JOIN tenants t ON t.id = ti.tenant_id
         WHERE ti.channel = $1 AND ti.channel_uid = $2`,
        [channel, uid],
      );
      if (rows[0]) return rows[0].id;
    }
  }

  // Fallback: single tenant
  const { rows } = await pool.query("SELECT id FROM tenants LIMIT 2");
  if (rows.length === 1) return rows[0].id;

  return null;
}

// --- Helpers ---

function text(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function creditDenied(info: { count: number; limit: number; plan: string }) {
  return text({
    error: "gpu_credits_exhausted",
    message: `You've used all ${info.limit} GPU generations for this month.`,
    current_usage: info.count,
    monthly_limit: info.limit,
    current_plan: info.plan,
    upgrade_info: {
      starter: { generations: 20, note: "Included with Starter plan" },
      pro: { generations: 100, note: "Included with Pro plan" },
      enterprise: { generations: 500, note: "Included with Enterprise plan" },
    },
    suggestion:
      "Let the user know they've used their monthly GPU credits and suggest upgrading their plan for more generations.",
  });
}

// --- Plugin entry point ---

export default function (api: any) {
  const log = api.logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };

  log.info("[rdy-swarmui] initializing SwarmUI plugin");

  // ============================================================
  //  TOOL: generate_image
  // ============================================================

  api.registerTool({
    name: "generate_image",
    description:
      "Generate an image using SwarmUI on GPU. Returns the generated image file path for the agent to send to the user.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to generate — describe the desired image",
        },
        negative_prompt: {
          type: "string",
          description:
            "What to avoid in the image (e.g. 'blurry, low quality')",
        },
        model: {
          type: "string",
          description:
            "Model name (leave empty for auto-select). Use list_gpu_models to see available models.",
        },
        width: {
          type: "number",
          description: "Image width in pixels (default: 1024)",
        },
        height: {
          type: "number",
          description: "Image height in pixels (default: 1024)",
        },
        steps: {
          type: "number",
          description: "Diffusion steps — higher = better quality, slower (default: 25)",
        },
        count: {
          type: "number",
          description: "Number of images to generate, 1-4 (default: 1)",
        },
      },
      required: ["prompt"],
    },
    async execute(
      _id: string,
      params: {
        prompt: string;
        negative_prompt?: string;
        model?: string;
        width?: number;
        height?: number;
        steps?: number;
        count?: number;
      },
      context: any,
    ) {
      try {
        // Access control
        const tenantId = await resolveTenantFromSession(
          context?.sessionKey,
          log,
        );
        if (tenantId) {
          const credits = await checkAndIncrementGpuCredits(tenantId);
          if (!credits.allowed) return creditDenied(credits);
        }

        const count = Math.min(Math.max(params.count ?? 1, 1), 4);
        const rawInput: Record<string, unknown> = {
          prompt: params.prompt,
          negativeprompt: params.negative_prompt ?? "",
          images: count,
          steps: params.steps ?? 25,
          cfgscale: 7,
          width: params.width ?? 1024,
          height: params.height ?? 1024,
          seed: -1,
        };
        if (params.model) rawInput.model = params.model;

        log.info(
          `[rdy-swarmui] generate_image: prompt="${params.prompt}", count=${count}`,
        );

        const result = await swarmPost("GenerateText2Image", {
          images: count,
          rawInput,
        }, 120_000);

        if (result.error) {
          return text({ error: result.error });
        }

        const imagePaths: string[] = result.images ?? [];
        if (imagePaths.length === 0) {
          return text({ error: "No images generated", raw: result });
        }

        // Download images to local media dir
        const localPaths: string[] = [];
        for (const imgPath of imagePaths) {
          try {
            const localPath = await downloadImage(imgPath);
            localPaths.push(localPath);
            log.info(`[rdy-swarmui] downloaded: ${imgPath} → ${localPath}`);
          } catch (err: any) {
            log.error(`[rdy-swarmui] download failed for ${imgPath}: ${err.message}`);
          }
        }

        return text({
          success: true,
          images: localPaths,
          count: localPaths.length,
          prompt: params.prompt,
          message: `Generated ${localPaths.length} image(s). Send the image files to the user.`,
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] generate_image error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: generate_video
  // ============================================================

  api.registerTool({
    name: "generate_video",
    description:
      "Generate a video using SwarmUI video workflow on GPU. Returns the generated video file path.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Video description — what should happen in the video",
        },
        model: {
          type: "string",
          description: "Video model name (leave empty for auto-select)",
        },
        frames: {
          type: "number",
          description: "Number of frames (default: 24)",
        },
        steps: {
          type: "number",
          description: "Diffusion steps (default: 25)",
        },
      },
      required: ["prompt"],
    },
    async execute(
      _id: string,
      params: {
        prompt: string;
        model?: string;
        frames?: number;
        steps?: number;
      },
      context: any,
    ) {
      try {
        // Access control
        const tenantId = await resolveTenantFromSession(
          context?.sessionKey,
          log,
        );
        if (tenantId) {
          const credits = await checkAndIncrementGpuCredits(tenantId);
          if (!credits.allowed) return creditDenied(credits);
        }

        const rawInput: Record<string, unknown> = {
          prompt: params.prompt,
          negativeprompt: "",
          images: 1,
          steps: params.steps ?? 25,
          cfgscale: 7,
          width: 512,
          height: 512,
          seed: -1,
          videoframes: params.frames ?? 24,
          videofps: 8,
          videoformat: "mp4",
        };
        if (params.model) rawInput.model = params.model;

        log.info(`[rdy-swarmui] generate_video: prompt="${params.prompt}"`);

        const result = await swarmPost("GenerateText2Image", {
          images: 1,
          rawInput,
        }, 180_000);

        if (result.error) {
          return text({ error: result.error });
        }

        const videoPaths: string[] = result.images ?? [];
        if (videoPaths.length === 0) {
          return text({ error: "No video generated", raw: result });
        }

        const localPaths: string[] = [];
        for (const vidPath of videoPaths) {
          try {
            const localPath = await downloadImage(vidPath);
            localPaths.push(localPath);
            log.info(`[rdy-swarmui] downloaded video: ${vidPath} → ${localPath}`);
          } catch (err: any) {
            log.error(`[rdy-swarmui] download failed for ${vidPath}: ${err.message}`);
          }
        }

        return text({
          success: true,
          videos: localPaths,
          prompt: params.prompt,
          message: `Generated video. Send the video file to the user.`,
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] generate_video error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: list_gpu_models
  // ============================================================

  api.registerTool({
    name: "list_gpu_models",
    description:
      "List available AI models on SwarmUI for image/video generation.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            'Model type: "checkpoint" (default), "lora", "vae", "embedding", "controlnet"',
        },
      },
    },
    async execute(
      _id: string,
      params: { type?: string },
    ) {
      try {
        const modelType = params.type ?? "checkpoint";

        // Use ListT2IParams which returns all model lists
        const result = await swarmPost("ListT2IParams", {});
        if (result.error) return text({ error: result.error });

        const typeMap: Record<string, string> = {
          checkpoint: "Stable-Diffusion",
          lora: "LoRA",
          vae: "VAE",
          embedding: "Embedding",
          controlnet: "ControlNet",
        };

        const key = typeMap[modelType.toLowerCase()] ?? "Stable-Diffusion";
        const models = result.models?.[key] ?? [];

        return text({
          type: modelType,
          models,
          count: models.length,
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] list_gpu_models error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: gpu_status
  // ============================================================

  api.registerTool({
    name: "gpu_status",
    description:
      "Check SwarmUI GPU status, queue length, and backend health.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      try {
        const result = await swarmPost("GetCurrentStatus", {});
        if (result.error) return text({ error: result.error });

        return text({
          status: result.status ?? "unknown",
          waiting_gens: result.waiting_gens ?? 0,
          loading_models: result.loading_models ?? 0,
          live_gens: result.live_gens ?? 0,
          backends: result.supported_features ?? [],
          message: "SwarmUI GPU status retrieved.",
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] gpu_status error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: list_workflows
  // ============================================================

  api.registerTool({
    name: "list_workflows",
    description:
      "List saved ComfyUI workflows available on SwarmUI. Workflows define complex generation pipelines (e.g. txt2img, img2img, video, upscale).",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      try {
        const result = await swarmPost("ComfyListWorkflows", {});
        if (result.error) {
          // Fallback: try reading from local workflow dir
          const workflowDir = "/home/samau/swarmui/Data/Users/local/Workflows";
          if (existsSync(workflowDir)) {
            const files = await readdir(workflowDir);
            const workflows = files
              .filter((f) => f.endsWith(".json"))
              .map((f) => f.replace(".json", ""));
            return text({ workflows, count: workflows.length, source: "filesystem" });
          }
          return text({ error: result.error, workflows: [] });
        }
        return text({
          workflows: result.workflows ?? [],
          count: (result.workflows ?? []).length,
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] list_workflows error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  TOOL: run_workflow
  // ============================================================

  api.registerTool({
    name: "run_workflow",
    description:
      "Run a specific saved ComfyUI workflow. Use list_workflows to see available workflows first. Supports parameter substitution for prompt, negative_prompt, seed, etc.",
    parameters: {
      type: "object",
      properties: {
        workflow_name: {
          type: "string",
          description: "Name of the saved workflow to run",
        },
        prompt: {
          type: "string",
          description: "Main prompt text for the workflow",
        },
        negative_prompt: {
          type: "string",
          description: "Negative prompt",
        },
        overrides: {
          type: "object",
          description:
            "Additional parameter overrides as key-value pairs (workflow-specific)",
        },
      },
      required: ["workflow_name", "prompt"],
    },
    async execute(
      _id: string,
      params: {
        workflow_name: string;
        prompt: string;
        negative_prompt?: string;
        overrides?: Record<string, unknown>;
      },
      context: any,
    ) {
      try {
        // Access control
        const tenantId = await resolveTenantFromSession(
          context?.sessionKey,
          log,
        );
        if (tenantId) {
          const credits = await checkAndIncrementGpuCredits(tenantId);
          if (!credits.allowed) return creditDenied(credits);
        }

        // Try to load workflow JSON from filesystem
        const workflowDir = "/home/samau/swarmui/Data/Users/local/Workflows";
        const workflowPath = join(workflowDir, `${params.workflow_name}.json`);

        let workflowJson: string;
        try {
          workflowJson = await readFile(workflowPath, "utf-8");
        } catch {
          return text({
            error: `Workflow "${params.workflow_name}" not found. Use list_workflows to see available workflows.`,
          });
        }

        // Substitute template variables
        workflowJson = workflowJson
          .replace(/\{\{prompt\}\}/g, params.prompt)
          .replace(/\{\{negative_prompt\}\}/g, params.negative_prompt ?? "")
          .replace(/\{\{seed\}\}/g, String(Math.floor(Math.random() * 2147483647)));

        // Apply additional overrides
        if (params.overrides) {
          for (const [key, val] of Object.entries(params.overrides)) {
            workflowJson = workflowJson.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              String(val),
            );
          }
        }

        const workflow = JSON.parse(workflowJson);

        log.info(
          `[rdy-swarmui] run_workflow: "${params.workflow_name}", prompt="${params.prompt}"`,
        );

        // Submit via ComfyUI direct API
        const sessionId = await getSession();
        const res = await fetch(
          `${SWARM_URL}/ComfyBackendDirect/api/prompt`,
          {
            method: "POST",
            headers: swarmHeaders(),
            body: JSON.stringify({
              prompt: workflow,
              client_id: sessionId,
            }),
          },
        );

        const result = await res.json();

        if (result.error) {
          return text({ error: result.error });
        }

        return text({
          success: true,
          workflow: params.workflow_name,
          prompt_id: result.prompt_id,
          message: `Workflow "${params.workflow_name}" submitted. The generation is in progress.`,
        });
      } catch (err: any) {
        log.error(`[rdy-swarmui] run_workflow error: ${err.message}`);
        return text({ error: err.message });
      }
    },
  });

  // ============================================================
  //  COMMANDS
  // ============================================================

  api.registerCommand({
    name: "imagine",
    description: "Generate an image with a prompt",
    async handler(ctx: any) {
      const prompt = ctx.args?.trim();
      if (!prompt) return { text: "Usage: /imagine <prompt>\nExample: /imagine a cyberpunk cityscape at sunset" };
      try {
        const rawInput = {
          prompt,
          negativeprompt: "",
          images: 1,
          steps: 25,
          cfgscale: 7,
          width: 1024,
          height: 1024,
          seed: -1,
        };
        const result = await swarmPost("GenerateText2Image", { images: 1, rawInput }, 120_000);
        if (result.error) return { text: `Generation failed: ${result.error}` };
        const imagePaths: string[] = result.images ?? [];
        if (imagePaths.length === 0) return { text: "No images generated. Check /gpustatus for backend health." };
        const localPaths: string[] = [];
        for (const imgPath of imagePaths) {
          try {
            localPaths.push(await downloadImage(imgPath));
          } catch (err: any) {
            log.error(`[rdy-swarmui] /imagine download failed: ${err.message}`);
          }
        }
        return { text: `Generated image for "${prompt}"`, files: localPaths };
      } catch (err: any) {
        return { text: `Error: ${err.message}` };
      }
    },
  });

  api.registerCommand({
    name: "video",
    description: "Generate a video with a prompt",
    async handler(ctx: any) {
      const prompt = ctx.args?.trim();
      if (!prompt) return { text: "Usage: /video <prompt>\nExample: /video a cat playing on the beach" };
      try {
        const rawInput = {
          prompt,
          negativeprompt: "",
          images: 1,
          steps: 25,
          cfgscale: 7,
          width: 512,
          height: 512,
          seed: -1,
          videoframes: 24,
          videofps: 8,
          videoformat: "mp4",
        };
        const result = await swarmPost("GenerateText2Image", { images: 1, rawInput }, 180_000);
        if (result.error) return { text: `Video generation failed: ${result.error}` };
        const videoPaths: string[] = result.images ?? [];
        if (videoPaths.length === 0) return { text: "No video generated. Check /gpustatus for backend health." };
        const localPaths: string[] = [];
        for (const vidPath of videoPaths) {
          try {
            localPaths.push(await downloadImage(vidPath));
          } catch (err: any) {
            log.error(`[rdy-swarmui] /video download failed: ${err.message}`);
          }
        }
        return { text: `Generated video for "${prompt}"`, files: localPaths };
      } catch (err: any) {
        return { text: `Error: ${err.message}` };
      }
    },
  });

  api.registerCommand({
    name: "gpustatus",
    description: "Check GPU status and generation queue",
    async handler() {
      try {
        const result = await swarmPost("GetCurrentStatus", {});
        if (result.error) return { text: `Error: ${result.error}` };
        const s = result.status ?? {};
        const b = result.backend_status ?? {};
        const lines = [
          `GPU Status:`,
          `  Backend: ${b.status ?? "unknown"} ${b.message ? "— " + b.message : ""}`,
          `  Queue: ${s.waiting_gens ?? 0} waiting, ${s.live_gens ?? 0} active, ${s.loading_models ?? 0} loading`,
        ];
        return { text: lines.join("\n") };
      } catch (err: any) {
        return { text: `Error checking GPU status: ${err.message}` };
      }
    },
  });

  api.registerCommand({
    name: "gpumodels",
    description: "List available GPU models for image/video generation",
    async handler() {
      try {
        const result = await swarmPost("ListT2IParams", {});
        if (result.error) return { text: `Error: ${result.error}` };
        const models = result.models?.["Stable-Diffusion"] ?? [];
        if (models.length === 0) return { text: "No models currently available. Backends may be offline." };
        return { text: `Available models (${models.length}):\n${models.map((m: string) => `  • ${m}`).join("\n")}` };
      } catch (err: any) {
        return { text: `Error listing models: ${err.message}` };
      }
    },
  });

  // ============================================================
  //  HOOK: before_prompt_build — inject SwarmUI context
  // ============================================================

  api.on(
    "before_prompt_build",
    async (_event: any, _ctx: any) => {
      return {
        prependContext: [
          `[SYSTEM — hidden from user]`,
          `You have access to SwarmUI GPU image/video generation.`,
          `When the user asks to generate, create, draw, or make an image or video, use the generate_image or generate_video tool.`,
          `After generating, send the resulting image/video file to the user.`,
          `If generation fails due to no models available, suggest the user check /gpustatus or wait for a model to be loaded.`,
          `Available commands: /imagine <prompt>, /video <prompt>, /gpustatus, /gpumodels`,
        ].join("\n"),
      };
    },
    { priority: 50 },
  );

  log.info(
    "[rdy-swarmui] registered tools (generate_image, generate_video, list_gpu_models, gpu_status, list_workflows, run_workflow), commands (/imagine, /video, /gpustatus, /models)",
  );
}
