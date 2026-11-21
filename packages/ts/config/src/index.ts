export { type CheckReport, checkServerConfig } from "./check";
export {
  type CapturePath,
  type CliConfig,
  cliConfigSchema,
  cliLabelProblems,
  type LabelsConfig,
  type LabelValue,
  labelEntries,
  SEARCH_SCOPES,
  type SearchScope,
  THEMES,
} from "./cli";
export {
  type CliLoadOptions,
  DROP_IN_LISTS,
  loadCliConfig,
  loadServerConfig,
  loadServerlessConfig,
  SERVER_ONLY_SECTIONS,
  type ServerLoadOptions,
  type ServerlessLoadOptions,
} from "./configs";
export { ENV_PREFIX, envKey, isSettingName } from "./layers";
export {
  type BaseLayer,
  ConfigError,
  type ConfigFs,
  type DropIns,
  type FlagValue,
  type ListAddition,
  type Loaded,
  type LoadOptions,
  loadConfig,
  nodeFs,
  parseConfigToml,
  secretsIn,
  shapeOf,
} from "./load";
export { describeOrigin, formatPath, type Origin, Origins, type PathSegment } from "./origins";
export {
  CONFIG_ENV,
  cliConfigPath,
  DROP_IN_DIR_NAME,
  findServerConfig,
  NOT_SETTINGS_ENV,
  SERVER_CONFIG_NAME,
  SYSTEM_CONFIG_PATH,
  serverDropInDir,
} from "./paths";
export {
  RUNTIME_INSTANCES_PREFIX,
  RUNTIME_LISTS,
  RUNTIME_SOURCES_PREFIX,
  type RuntimeLayer,
  runtimeLoadOptions,
} from "./runtime";
export {
  getField,
  isSealed,
  Keyring,
  type SealedValue,
  SealingError,
  type SecretView,
  sealContext,
  secretFields,
  setField,
} from "./sealed";
export { describeSecret, Secret, type SecretRef, type SecretSources, secret } from "./secret";
export * from "./server/index";
export type { JsonSchema } from "./shape";
export { baseLayerIn, baseLayerOf, SHARED_CONFIG, SHARED_PREFIX, safeSharedName } from "./shared";
export { type ConfigEntry, configEntries, displayTree } from "./show";
export { stringifyToml, tomlKey, tomlString } from "./toml";
export { bytes, duration, formatBytes, formatDuration, parseBytes, parseDuration } from "./units";

import { toJSONSchema } from "zod";
import { cliConfigSchema } from "./cli";
import { serverConfigSchema } from "./server/index";

export function configJsonSchemas(): { server: object; cli: object } {
  const generate = (schema: typeof serverConfigSchema | typeof cliConfigSchema, id: string) => ({
    $id: id,
    ...toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    server: generate(
      serverConfigSchema,
      "https://github.com/dosu-ai/seshi/spec/config.schema.json",
    ),
    cli: generate(cliConfigSchema, "https://github.com/dosu-ai/seshi/spec/cli-config.schema.json"),
  };
}
