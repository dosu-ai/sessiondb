import * as z from "zod";
import { duration } from "../units";
import { httpUrl } from "./common";

export const ROLES = ["api", "worker"] as const;

const LISTEN = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]*):)?(\d{1,5})$/;

export function parseListen(listen: string): { hostname: string; port: number } | undefined {
  const match = LISTEN.exec(listen.trim());
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port > 65535) return undefined;
  const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
  return { hostname: host === "" ? "0.0.0.0" : host, port };
}

export const serverSection = z
  .strictObject({
    listen: z
      .string()
      .refine((v) => parseListen(v) !== undefined, "host:port, :port or port (port 0–65535)")
      .default(":7200")
      .describe("Where the HTTP server listens: host:port, :port (every interface) or port."),
    public_url: httpUrl
      .optional()
      .describe(
        "The URL clients reach this server at, behind any proxy. Accepted but unused: nothing reads it, and config check warns when it is set.",
      ),
    roles: z
      .array(z.enum(ROLES))
      .min(1)
      .default(["api", "worker"])
      .describe(
        "What this instance runs (X7.1): api (the HTTP API), worker (pollers, span assembly). Exactly one instance may run the worker.",
      ),
    instance_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, _ and -, up to 64")
      .optional()
      .describe(
        "This instance's stable name in source health shards and the worker heartbeat; the host name when unset.",
      ),
    watch_config: z
      .boolean()
      .default(false)
      .describe(
        "Reload when the config file, a drop-in in seshi.d/, a redaction pack or a review prompt file changes, a second after the last change. Off by default: SIGHUP and POST /v1/admin/reload apply changes when you say so and report the result.",
      ),
    runtime_config: z
      .enum(["file", "store"])
      .default("file")
      .describe(
        'Where the settings that change at runtime live (docs/config.md, "Runtime config"). file: this file and its drop-ins hold everything, and a reload reaches this process only. store: the bucket also holds them (config/seshi.toml and config/packs/ for the data policy, runtime/sources/ for sources), every instance applies them within config_poll, and the admin API writes them.',
      ),
    config_poll: duration()
      .refine((ms) => ms > 0, "must be above 0")
      .prefault("10s")
      .describe(
        "With runtime_config = store: how often each instance looks for a change in the bucket.",
      ),
  })
  .prefault({})
  .describe("The HTTP server.");

export type ServerSection = z.output<typeof serverSection>;
