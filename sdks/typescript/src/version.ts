/** The SDK's release, from its `package.json`: what each trace's `normalizer` reports, with
 * the `@letta-ai/trajectory` it ran as build metadata. */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
