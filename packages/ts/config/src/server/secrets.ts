import * as z from "zod";
import { secret } from "../secret";

export const MIN_SEALING_KEY_LENGTH = 32;

export const secretsSection = z
  .strictObject({
    keys: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "letters, digits, _ and -, up to 32"),
        secret(),
      )
      .default({})
      .describe(
        `Keys that seal the secrets of sources the admin API stores in the bucket (runtime_config = store), by key id. ${MIN_SEALING_KEY_LENGTH}+ characters each. Old keys stay to unseal until \`seshi admin secrets reseal\` has run.`,
      ),
    key_id: z
      .string()
      .min(1)
      .optional()
      .describe("The key in secrets.keys that seals new secrets; the only one when there is one."),
  })
  .prefault({})
  .describe("Sealing keys for secrets stored in the bucket.");

export type SecretsSection = z.output<typeof secretsSection>;

/** The key that seals new secrets: `key_id`, else the only key. */
export function sealingKeyId(section: SecretsSection): string | undefined {
  return (
    section.key_id ??
    (Object.keys(section.keys).length === 1 ? Object.keys(section.keys)[0] : undefined)
  );
}
