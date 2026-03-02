import { NextResponse } from "next/server";

export async function GET() {
  const docsCommand = process.env.AGENT1_DOCS_COMMAND;
  const slidesCommand = process.env.AGENT2_SLIDES_COMMAND;
  const envMockMode = process.env.MOCK_WALKTHROUGH === "true";
  const hasCliCommands = Boolean(docsCommand && slidesCommand);

  const mode = envMockMode || !hasCliCommands ? "mock" : "real-cli";

  return NextResponse.json({
    ok: true,
    mode,
    reason: envMockMode
      ? "MOCK_WALKTHROUGH=true"
      : hasCliCommands
        ? "CLI commands configured"
        : "CLI commands missing",
  });
}
