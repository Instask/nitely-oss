import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONSTITUTION_PATH = ".nitely/constitution.md";

export type Constitution =
  | {
      loaded: false;
      path: typeof CONSTITUTION_PATH;
    }
  | {
      loaded: true;
      path: typeof CONSTITUTION_PATH;
      hash: string;
      content: string;
    };

export async function loadConstitution(repoPath: string): Promise<Constitution> {
  const path = CONSTITUTION_PATH;
  try {
    const content = await readFile(join(repoPath, path), "utf8");
    if (content.trim().length === 0) {
      return { loaded: false, path };
    }
    const hash = createHash("sha256").update(content).digest("hex");
    return {
      loaded: true,
      path,
      hash: `sha256:${hash}`,
      content,
    };
  } catch {
    return { loaded: false, path };
  }
}
