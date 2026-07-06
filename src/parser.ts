import { readFileSync } from "fs";
import type { Conversation } from "./types.js";
import { createConversationParser } from "./parser-factory.js";

export function buildConversation(inputFile: string): Conversation {
  const fileContent = readFileSync(inputFile, "utf-8");
  const lines = fileContent.split("\n");

  const parser = createConversationParser();
  parser.feedLines(lines);

  const meta = parser.getMetadata();
  return {
    sessionId: meta.sessionId,
    projectDir: meta.projectDir,
    model: meta.model,
    version: meta.version,
    startTime: meta.startTime,
    turns: parser.getTurns(),
  };
}
