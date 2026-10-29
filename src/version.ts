/** The server's release, from `package.json`: what `/healthz`, the layout marker and each
 * trace's `normalizer` report. */
import pkg from "../package.json";

export const VERSION: string = pkg.version;
