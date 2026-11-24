import type { PreflightRunContext } from "../../shared/run-context.js";
import { nonBlank } from "../../shared/strings.js";

/**
 * The bot's Jira identity for the bot-assigned candidate fallback. An
 * explicit `with.email` declaration wins when non-blank — blank (empty
 * or whitespace-only) means absent, the same read the Python preflights
 * made of the env var. Otherwise the deployment-provided identity
 * (BOT_JIRA_EMAIL) on the run context applies; the run-context factory
 * normalizes that source, so it is non-blank here by construction.
 */
export function resolveBotJiraEmail(
  declared: string | undefined,
  ctx: PreflightRunContext,
): string | undefined {
  if (declared !== undefined && nonBlank(declared)) return declared;
  return ctx.jiraEmail;
}
