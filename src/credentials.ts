import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const ACP_DEFAULT_API = "https://api.agenticcontrolplane.com";

export function getApiBase(): string {
  return process.env.ACP_API_BASE || ACP_DEFAULT_API;
}

export function readToken(): string | null {
  if (process.env.ACP_BEARER_TOKEN) return process.env.ACP_BEARER_TOKEN;
  try {
    return fs
      .readFileSync(path.join(os.homedir(), ".acp", "credentials"), "utf8")
      .trim();
  } catch {
    return null;
  }
}
