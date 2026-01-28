/**
 * Pre-calculate (estimate) minimum credits required for a task before execution
 * This is used for:
 * - Setting minCreditsRequired in scheduled tasks
 * - Checking if user has enough credits before execution
 * - Displaying estimated cost to users
 *
 * Note: This only estimates base credits for the task itself.
 * Additional credits for JSON extraction are calculated at runtime based on ANYCRAWL_EXTRACT_JSON_CREDITS.
 *
 * @param taskType - Type of task (scrape, crawl, search)
 * @param taskPayload - Task configuration payload
 * @param options - Optional configuration
 * @param options.template - Template object (if using template)
 * @returns Estimated minimum credits required (base task credits + template credits)
 */
export function estimateTaskCredits(
    taskType: string,
    taskPayload: any,
    options?: {
        template?: any;  // Template object with templateType, reqOptions, pricing
    }
): number {
    try {
        let baseCredits = 1;
        let templateCredits = 0;
        let actualTaskType = taskType;
        let actualPayload = taskPayload;

        // If template is provided, extract template info
        if (options?.template) {
            const template = options.template;

            // Get template's actual task type (scrape/crawl/search)
            actualTaskType = template.templateType || taskType;

            // Merge template reqOptions with task payload
            actualPayload = {
                ...(template.reqOptions || {}),
                ...taskPayload
            };

            // Get template pricing
            templateCredits = template.pricing?.perCall || 0;
        }

        // Calculate base credits based on actual task type
        if (actualTaskType === "scrape") {
            baseCredits = 1;
        }
        // For search tasks - pages + scrape credits if scrape_options provided
        else if (actualTaskType === "search") {
            const pages = actualPayload.pages || 1;
            baseCredits = pages; // 1 credit per search page

            // If scrape_options provided, add credits for scraping results
            if (actualPayload.scrape_options) {
                const limit = actualPayload.limit || 10; // Number of search results to scrape
                baseCredits += limit; // 1 credit per scraped result
            }
        }
        // For crawl tasks - limit (max pages) * 1 credit per page
        else if (actualTaskType === "crawl") {
            const limit = actualPayload.limit || actualPayload.options?.limit || 10;
            baseCredits = limit;
        }

        // Total = base credits + template credits
        return baseCredits + templateCredits;
    } catch (error) {
        console.error(`Error estimating task credits: ${error}`);
        return 1;
    }
}
