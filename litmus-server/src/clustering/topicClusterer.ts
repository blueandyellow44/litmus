// Groups recent scored articles into story clusters using Claude Sonnet.
// Called by clusterCron on a 30-minute cadence.
//
// Strategy: send the last 24h of article headlines + first 200 chars of body
// to Claude and ask it to group them by topic. Output: an array of clusters,
// each with a neutral topic label, a one-sentence summary, and a list of
// article IDs that belong to it.

import { anthropic, models } from "../lib/anthropic.js";
import { logger } from "../lib/logger.js";

export interface ClusterProposal {
  topic: string;      // e.g. "Federal Reserve interest rate decision"
  summary: string;    // one neutral sentence
  articleIds: number[];
}

const CLUSTER_SYSTEM = `
You group political news articles into story clusters. Each cluster covers ONE distinct story or development — not a vague theme.

RULES:
- Each article belongs to at most ONE cluster. If it's ambiguous, pick the best fit.
- GROUP GENEROUSLY. Leaving an article out is a real cost, not a safe default: an unclustered article never appears as part of a story, and the whole point of this paper is showing one event as several outlets told it. If two articles cover the same underlying event, they belong together even when the angle, the emphasis, or the headline differs sharply — differing framing of the same event is exactly what the reader is here to compare. Only leave an article out when it genuinely shares no event with any other.
- A story told by MANY outlets is more valuable than several small stories carved finely apart. When you are weighing whether to split a group or keep it whole, keep it whole.
- Cluster topic labels are factual and neutral — like a wire-service dateline, not an editorial headline. Example: "Senate passes infrastructure bill" not "Senate finally acts on crumbling roads".
- Summaries are ONE sentence, neutral, present tense where possible.
- Minimum 2 articles per cluster. A singleton is not a cluster — leave it unclustered.
- Order clusters by importance (most articles and most significant topic first).
- If two stories are related but distinct developments (e.g. a policy announcement and a protest about that policy), they get separate clusters.

OUTPUT via the submit_clusters tool.
`.trim();

const CLUSTER_TOOL = {
  name: "submit_clusters",
  description: "Submit the topic clusters you identified.",
  input_schema: {
    type: "object" as const,
    properties: {
      clusters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            topic:       { type: "string", description: "Neutral topic label." },
            summary:     { type: "string", description: "One-sentence neutral summary." },
            article_ids: { type: "array", items: { type: "integer" }, description: "IDs of articles in this cluster." },
          },
          required: ["topic", "summary", "article_ids"],
          additionalProperties: false,
        },
      },
    },
    required: ["clusters"],
    additionalProperties: false,
  },
};

interface ArticleStub {
  id: number;
  title: string;
  sourceName: string;
  sourceLean: string;
  snippet: string; // first 200 chars of body
}

interface ToolInput {
  clusters: Array<{
    topic: string;
    summary: string;
    article_ids: number[];
  }>;
}

export async function clusterArticles(stubs: ArticleStub[]): Promise<ClusterProposal[]> {
  if (stubs.length < 2) return [];

  const payload = stubs.map((s) => ({
    id: s.id,
    title: s.title,
    source: `${s.sourceName} (${s.sourceLean})`,
    snippet: s.snippet,
  }));

  const userMessage = `Group these ${stubs.length} articles into topic clusters.

${JSON.stringify(payload, null, 2)}`;

  const client = anthropic();
  const response = await client.messages.create({
    model: models.clusterer,
    // Every cluster costs output tokens: a topic, a summary and its article ids.
    // At 4096 this silently truncated the tool JSON partway through the cluster
    // list, so the call either threw "submit_clusters returned malformed input"
    // or, worse, parsed a partial list and looked like it had worked. That is
    // why 152 scored articles yielded ~30 clustered ones and 15 of the 16
    // hottest political pieces never reached a story: the clusterer was not
    // being too strict, its answer was being cut off. The ceiling has to scale
    // with the article count, not sit at a constant.
    max_tokens: 32000,
    system: CLUSTER_SYSTEM,
    tools: [CLUSTER_TOOL],
    tool_choice: { type: "tool", name: "submit_clusters" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
  );
  if (!toolUse) {
    logger.error("clusterer returned no tool_use block", { stop_reason: response.stop_reason });
    throw new Error("Claude did not call submit_clusters");
  }

  const input = toolUse.input as ToolInput;
  if (!input?.clusters || !Array.isArray(input.clusters)) {
    throw new Error("submit_clusters returned malformed input");
  }

  // Validate: every article_id must be in the original stub set, and
  // no article appears in more than one cluster.
  const validIds = new Set(stubs.map((s) => s.id));
  const seen = new Set<number>();

  const proposals: ClusterProposal[] = [];
  for (const c of input.clusters) {
    // Never trust the model's shape: a missing array or non-string topic/summary
    // must not crash the cron or NULL-violate clusters.topic/summary NOT NULL.
    if (!Array.isArray(c?.article_ids) || typeof c?.topic !== "string" || typeof c?.summary !== "string") {
      logger.warn("clusterer emitted malformed cluster entry, skipping", { entry: JSON.stringify(c).slice(0, 200) });
      continue;
    }
    const ids = c.article_ids.filter((id) => {
      if (typeof id !== "number" || !validIds.has(id)) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (ids.length < 2) continue; // enforce minimum cluster size
    proposals.push({
      topic: c.topic,
      summary: c.summary,
      articleIds: ids,
    });
  }

  return proposals;
}
