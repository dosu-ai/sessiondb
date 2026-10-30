/** The server's release, from its `package.json`: what `/healthz` and the layout marker
 * report. The SDK's own version is what a trace's `normalizer` records. */
import pkg from "../package.json";

export const VERSION: string = pkg.version;
