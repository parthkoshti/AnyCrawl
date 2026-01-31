import { Response } from "express";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import crypto from "crypto";
import { RequestWithAuth, estimateTaskCredits } from "@anycrawl/libs";
import { getDB, schemas, eq, sql } from "@anycrawl/db";
import { log } from "@anycrawl/libs";
import { randomUUID } from "crypto";
import { serializeRecord, serializeRecords } from "../../utils/serializer.js";

// Validation schemas
const createTaskSchema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().nullable().optional(),
    cron_expression: z.string().refine(
        (val) => {
            try {
                CronExpressionParser.parse(val);
                return true;
            } catch {
                return false;
            }
        },
        "Invalid cron expression"
    ),
    timezone: z.string().default("UTC"),
    task_type: z.enum(["scrape", "crawl", "search", "template"]),
    task_payload: z.object({}).passthrough(),
    concurrency_mode: z.enum(["skip", "queue"]).default("skip"),
    max_executions_per_day: z.number().int().positive().nullable().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.any()).optional(),
    // Webhook integration options
    webhook_ids: z.array(z.string().uuid()).optional(),
    webhook_url: z.string().url().optional(),
});

const updateTaskSchema = createTaskSchema.partial();

export class ScheduledTasksController {
    /**
     * Create a new scheduled task
     */
    public create = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const validatedData = createTaskSchema.parse(req.body);
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            // Calculate min_credits_required automatically
            let template = null;

            // Fetch template if template_id is provided
            if (validatedData.task_payload.template_id) {
                try {
                    const { getTemplate } = await import("@anycrawl/db");
                    template = await getTemplate(String(validatedData.task_payload.template_id));
                } catch (error) {
                    log.warning(`Failed to fetch template for credit calculation: ${error}`);
                }
            }

            // Calculate credits (with or without template)
            const minCreditsRequired = estimateTaskCredits(
                validatedData.task_type,
                validatedData.task_payload,
                template ? { template } : undefined
            );

            // Calculate next execution time
            const nextExecution = this.calculateNextExecution(
                validatedData.cron_expression,
                validatedData.timezone
            );

            const db = await getDB();
            const taskUuid = randomUUID();

            // Store both apiKey and userId (dual field storage)
            await db.insert(schemas.scheduledTasks).values({
                uuid: taskUuid,
                apiKey: apiKeyId,                    // Track which API key created this task
                userId: (userId || null) as any,    // Track which user owns this task (can be null)
                name: validatedData.name,
                description: validatedData.description,
                cronExpression: validatedData.cron_expression,
                timezone: validatedData.timezone,
                taskType: validatedData.task_type,
                taskPayload: validatedData.task_payload,
                concurrencyMode: validatedData.concurrency_mode,
                maxExecutionsPerDay: validatedData.max_executions_per_day,
                minCreditsRequired: minCreditsRequired,
                isActive: true,
                isPaused: false,
                nextExecutionAt: nextExecution,
                tags: validatedData.tags,
                metadata: validatedData.metadata,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // Handle webhook associations
            await this.handleWebhookAssociations(
                taskUuid,
                validatedData.webhook_ids,
                validatedData.webhook_url,
                apiKeyId,
                userId
            );

            // Add to BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    const createdTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskUuid))
                        .limit(1);

                    if (createdTask.length > 0) {
                        await scheduler.addScheduledTask(createdTask[0]);
                    }
                } else {
                    log.warning(`Scheduler is not running. Task created in database but not scheduled. Set ANYCRAWL_SCHEDULER_ENABLED=true to enable scheduling.`);
                }
            } catch (error) {
                log.warning(`Failed to add task to scheduler: ${error}`);
            }

            res.status(201).json({
                success: true,
                data: {
                    task_id: taskUuid,
                    next_execution_at: nextExecution?.toISOString(),
                },
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * List all scheduled tasks for the authenticated API key
     */
    public list = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            // Query by userId if exists, otherwise by apiKey, otherwise all tasks
            const tasks = userId
                ? await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.userId, userId))
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`)
                : apiKeyId
                ? await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .where(eq(schemas.scheduledTasks.apiKey, apiKeyId))
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`)
                : await db
                    .select()
                    .from(schemas.scheduledTasks)
                    .orderBy(sql`${schemas.scheduledTasks.createdAt} DESC`);

            // Convert to snake_case
            const serialized = serializeRecords(tasks);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get a specific scheduled task
     */
    public get = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            // Check ownership by userId if exists, otherwise by apiKey, otherwise just by taskId
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const task = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!task.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            // Convert to snake_case
            const serialized = serializeRecord(task[0]);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Update a scheduled task
     */
    public update = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const validatedData = updateTaskSchema.parse(req.body);
            const db = await getDB();

            // Check task exists and belongs to user/apiKey, or just check existence if no auth
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const existing = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!existing.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            const updateData: any = {
                ...validatedData,
                updatedAt: new Date(),
            };

            // Recalculate next execution if cron expression changed
            if (validatedData.cron_expression) {
                updateData.cronExpression = validatedData.cron_expression;
                updateData.nextExecutionAt = this.calculateNextExecution(
                    validatedData.cron_expression,
                    validatedData.timezone || existing[0].timezone
                );
                delete updateData.cron_expression;
            }

            // Map snake_case to camelCase
            if (validatedData.task_type) updateData.taskType = validatedData.task_type;
            if (validatedData.task_payload) updateData.taskPayload = validatedData.task_payload;
            if (validatedData.concurrency_mode) updateData.concurrencyMode = validatedData.concurrency_mode;
            if (validatedData.max_executions_per_day) updateData.maxExecutionsPerDay = validatedData.max_executions_per_day;

            // Remove snake_case fields
            delete updateData.task_type;
            delete updateData.task_payload;
            delete updateData.concurrency_mode;
            delete updateData.max_executions_per_day;

            await db
                .update(schemas.scheduledTasks)
                .set(updateData)
                .where(eq(schemas.scheduledTasks.uuid, taskId));

            // Handle webhook associations if provided
            if (validatedData.webhook_ids || validatedData.webhook_url) {
                await this.handleWebhookAssociations(
                    taskId!,
                    validatedData.webhook_ids,
                    validatedData.webhook_url,
                    apiKeyId || undefined,
                    userId || undefined
                );
            }

            // Update in BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    const updatedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskId))
                        .limit(1);

                    if (updatedTask.length > 0) {
                        await scheduler.addScheduledTask(updatedTask[0]);
                    }
                } else {
                    log.warning(`Scheduler is not running. Task updated in database but not rescheduled.`);
                }
            } catch (error) {
                log.warning(`Failed to update task in scheduler: ${error}`);
            }

            res.json({
                success: true,
                message: "Task updated successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Pause a scheduled task
     */
    public pause = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const { reason } = req.body;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: true,
                    pauseReason: reason || "Paused by user",
                    updatedAt: new Date(),
                })
                .where(whereClause);

            // Remove from BullMQ scheduler
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                await SchedulerManager.getInstance().removeScheduledTask(taskId!);
            } catch (error) {
                log.warning(`Failed to remove task from scheduler: ${error}`);
            }

            res.json({
                success: true,
                message: "Task paused successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Resume a paused task
     */
    public resume = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .update(schemas.scheduledTasks)
                .set({
                    isPaused: false,
                    pauseReason: null,
                    consecutiveFailures: 0,
                    updatedAt: new Date(),
                })
                .where(whereClause);

            // Add back to BullMQ scheduler (only if scheduler is running)
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                const scheduler = SchedulerManager.getInstance();

                if (scheduler.isSchedulerRunning()) {
                    const resumedTask = await db
                        .select()
                        .from(schemas.scheduledTasks)
                        .where(eq(schemas.scheduledTasks.uuid, taskId))
                        .limit(1);

                    if (resumedTask.length > 0) {
                        await scheduler.addScheduledTask(resumedTask[0]);
                    }
                } else {
                    log.warning(`Scheduler is not running. Task resumed in database but not scheduled.`);
                }
            } catch (error) {
                log.warning(`Failed to add task to scheduler: ${error}`);
            }

            res.json({
                success: true,
                message: "Task resumed successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Delete a scheduled task
     */
    public delete = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;

            if (!taskId) {
                res.status(400).json({
                    success: false,
                    error: "Task ID is required",
                });
                return;
            }

            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;

            const db = await getDB();

            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            await db
                .delete(schemas.scheduledTasks)
                .where(whereClause);

            // Remove webhook associations
            await this.removeWebhookAssociations(taskId);

            // Remove from BullMQ scheduler
            try {
                const { SchedulerManager } = await import("@anycrawl/scrape");
                await SchedulerManager.getInstance().removeScheduledTask(taskId!);
            } catch (error) {
                log.warning(`Failed to remove task from scheduler: ${error}`);
            }

            res.json({
                success: true,
                message: "Task deleted successfully",
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    /**
     * Get execution history for a task
     */
    public executions = async (req: RequestWithAuth, res: Response): Promise<void> => {
        try {
            const { taskId } = req.params;
            const apiKeyId = req.auth?.uuid;
            const userId = req.auth?.user;
            const limit = parseInt(req.query.limit as string) || 100;
            const offset = parseInt(req.query.offset as string) || 0;

            const db = await getDB();

            // Verify task belongs to user/apiKey, or just check existence if no auth
            const whereClause = userId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.userId} = ${userId}`
                : apiKeyId
                ? sql`${schemas.scheduledTasks.uuid} = ${taskId} AND ${schemas.scheduledTasks.apiKey} = ${apiKeyId}`
                : sql`${schemas.scheduledTasks.uuid} = ${taskId}`;

            const task = await db
                .select()
                .from(schemas.scheduledTasks)
                .where(whereClause)
                .limit(1);

            if (!task.length) {
                res.status(404).json({
                    success: false,
                    error: "Task not found",
                });
                return;
            }

            const executions = await db
                .select()
                .from(schemas.taskExecutions)
                .where(eq(schemas.taskExecutions.scheduledTaskUuid, taskId))
                .orderBy(sql`${schemas.taskExecutions.createdAt} DESC`)
                .limit(limit)
                .offset(offset);

            // Convert to snake_case
            const serialized = serializeRecords(executions);

            res.json({
                success: true,
                data: serialized,
            });
        } catch (error) {
            this.handleError(error, res);
        }
    };

    private calculateNextExecution(cronExpression: string, timezone: string): Date | null {
        try {
            const interval = CronExpressionParser.parse(cronExpression, {
                tz: timezone || "UTC",
                currentDate: new Date(),
            });
            return interval.next().toDate();
        } catch (error) {
            log.error(`Failed to calculate next execution: ${error}`);
            return null;
        }
    }

    /**
     * Handle webhook associations when creating/updating a task
     */
    private async handleWebhookAssociations(
        taskId: string,
        webhookIds?: string[],
        webhookUrl?: string,
        apiKeyId?: string,
        userId?: string
    ): Promise<void> {
        const db = await getDB();

        // Option 1: Create a new webhook for this task
        if (webhookUrl) {
            try {
                const webhookUuid = randomUUID();
                const secret = crypto.randomBytes(32).toString("hex");

                await db.insert(schemas.webhookSubscriptions).values({
                    uuid: webhookUuid,
                    apiKey: apiKeyId,
                    userId: (userId || null) as any,
                    name: `Webhook for task: ${taskId}`,
                    description: `Auto-created webhook for scheduled task`,
                    webhookUrl: webhookUrl,
                    webhookSecret: secret,
                    scope: "specific",
                    specificTaskIds: [taskId],
                    eventTypes: ["task.executed", "task.failed", "task.paused", "task.resumed"],
                    isActive: true,
                    customHeaders: {},
                    timeoutSeconds: 10,
                    maxRetries: 3,
                    retryBackoffMultiplier: 2,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                log.info(`Auto-created webhook ${webhookUuid} for task ${taskId}`);
            } catch (error) {
                log.error(`Failed to create webhook for task ${taskId}: ${error}`);
            }
        }

        // Option 2: Associate with existing webhooks
        if (webhookIds && webhookIds.length > 0) {
            for (const webhookId of webhookIds) {
                try {
                    // Verify webhook exists and belongs to user
                    const whereClause = userId
                        ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.userId} = ${userId}`
                        : apiKeyId
                        ? sql`${schemas.webhookSubscriptions.uuid} = ${webhookId} AND ${schemas.webhookSubscriptions.apiKey} = ${apiKeyId}`
                        : sql`${schemas.webhookSubscriptions.uuid} = ${webhookId}`;

                    const webhook = await db
                        .select()
                        .from(schemas.webhookSubscriptions)
                        .where(whereClause)
                        .limit(1);

                    if (!webhook.length) {
                        log.warning(`Webhook ${webhookId} not found or not owned by user`);
                        continue;
                    }

                    // Update webhook to include this task
                    const currentTaskIds = (webhook[0].specificTaskIds as string[]) || [];
                    if (!currentTaskIds.includes(taskId)) {
                        const updatedTaskIds = [...currentTaskIds, taskId];
                        await db
                            .update(schemas.webhookSubscriptions)
                            .set({
                                specificTaskIds: updatedTaskIds,
                                scope: "specific",
                                updatedAt: new Date(),
                            })
                            .where(eq(schemas.webhookSubscriptions.uuid, webhookId));

                        log.info(`Associated webhook ${webhookId} with task ${taskId}`);
                    }
                } catch (error) {
                    log.error(`Failed to associate webhook ${webhookId} with task ${taskId}: ${error}`);
                }
            }
        }
    }

    /**
     * Remove task from all webhook associations
     */
    private async removeWebhookAssociations(taskId: string): Promise<void> {
        const db = await getDB();

        try {
            // Find all webhooks that reference this task
            const webhooks = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(sql`${schemas.webhookSubscriptions.specificTaskIds}::jsonb @> ${JSON.stringify([taskId])}`);

            for (const webhook of webhooks) {
                const currentTaskIds = (webhook.specificTaskIds as string[]) || [];
                const updatedTaskIds = currentTaskIds.filter((id) => id !== taskId);

                // Update with remaining tasks (keep as empty array if no tasks left)
                await db
                    .update(schemas.webhookSubscriptions)
                    .set({
                        specificTaskIds: updatedTaskIds.length > 0 ? updatedTaskIds : [],
                        updatedAt: new Date(),
                    })
                    .where(eq(schemas.webhookSubscriptions.uuid, webhook.uuid));

                log.info(`Removed task ${taskId} from webhook ${webhook.uuid}`);
            }
        } catch (error) {
            log.error(`Failed to remove webhook associations for task ${taskId}: ${error}`);
        }
    }

    private handleError(error: any, res: Response): void {
        if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
                field: err.path.join("."),
                message: err.message,
                code: err.code,
            }));
            const message = error.errors.map((err) => err.message).join(", ");
            res.status(400).json({
                success: false,
                error: "Validation error",
                message: message,
                details: formattedErrors,
            });
        } else {
            log.error(`Scheduled tasks controller error: ${error}`);
            res.status(500).json({
                success: false,
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
