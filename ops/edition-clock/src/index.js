// Starts the Daily paper on GitHub at 3:45 AM Pacific. See wrangler.toml.

export function pacificHour(ms) {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(ms));
  return Number(hour);
}

export async function startEdition(env, fetcher = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set on the edition clock");
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "litmus-edition-clock",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { run_story_ledger: "true" } }),
  });
  // GitHub answers 204 with no body when the run is accepted.
  if (res.status !== 204) throw new Error(`GitHub refused the edition dispatch: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export default {
  // A thrown error marks the invocation failed in Cloudflare's cron log; the
  // schedule in daily.yml then builds the edition late instead of never.
  async scheduled(controller, env) {
    if (pacificHour(controller.scheduledTime) !== Number(env.EDITION_HOUR_PACIFIC)) return;
    await startEdition(env);
  },
};
