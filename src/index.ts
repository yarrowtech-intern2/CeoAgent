import "dotenv/config";
import { runCeoAgent } from "./orchestrator.js";

async function main() {
  const goal = process.argv.slice(2).join(" ").trim();
  if (!goal) {
    console.error('Usage: npm run cli -- "<goal or signal for the CEO agent to act on>"');
    process.exit(1);
  }

  const result = await runCeoAgent(goal, (event) => {
    if (event.type === "text") {
      console.log(`[${event.source}] ${event.text}`);
    } else if (event.type === "tool_use") {
      console.log(`[${event.source}] tool: ${event.name}(${JSON.stringify(event.input)})`);
    } else if (event.type === "tool_result") {
      console.log(`  -> ${event.isError ? "ERROR: " : ""}${event.text}`);
    }
  });

  console.log("\n--- done ---");
  if (result.status === "success") {
    console.log(result.summary);
  } else {
    console.error(`Failed: ${result.summary}`);
  }
  console.log(`cost: $${result.costUsd.toFixed(4)}`);
  if (result.linearTasks.length) {
    console.log(`\nLinear tasks created:`);
    for (const t of result.linearTasks) console.log(`  ${t.identifier}: ${t.title} (${t.url})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
