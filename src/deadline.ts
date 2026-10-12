import { HarnessError } from "./errors.js";

/** Timing out reports uncertainty; it does not cancel the underlying operation. */
export async function deadline<T>(work: Promise<T>, ms: number, code: string, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HarnessError(code, message)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
