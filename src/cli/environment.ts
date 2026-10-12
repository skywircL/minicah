import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fail } from "../errors.js";
import { PI_API_KEY_ENV } from "../agent/pi.js";

/** Load only explicit model/sandbox configuration; caller environment takes precedence. */
export async function loadCliEnvironment(path = ".env", environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("ENV_FILE_READ", "无法读取启动目录中的 .env 配置文件");
  }
  let values: ReturnType<typeof parseEnv>;
  try { values = parseEnv(contents); }
  catch { return fail("ENV_FILE_PARSE", ".env 配置文件格式无效"); }
  for (const key of [...Object.values(PI_API_KEY_ENV), "GOOGLE_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL", "MINICAH_SANDBOX_IMAGE"]) {
    if (environment[key] === undefined && values[key] !== undefined) environment[key] = values[key];
  }
}
