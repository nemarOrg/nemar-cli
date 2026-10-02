/**
 * Counting what a Neurobagel writer run spends (epic #1586, phase 4; ADR 0084).
 *
 * A Worker invocation has a fixed budget of subrequests, and every D1 statement, R2 call
 * and outgoing HTTP request spends from it. The reconcile shares one scheduled tick with
 * every other daily job (ADR 0054), and the admin route runs inline in one request, so a
 * run that does not know what it has spent can be cut off in the middle of a dataset, which
 * is the one thing the writer's ordering cannot be allowed to depend on.
 *
 * This module only COUNTS. It wraps the two bindings the writer and the data plane it calls
 * share (`DB` and `NEUROBAGEL`) so every call through them, the data plane's included, is
 * counted at the binding and not at a call site that could miss one. It names no method of
 * either binding except by passing it through, and it writes nothing.
 */

import type { Bindings } from "../types/bindings.js";

export interface OpCounter {
  d1: number;
  r2: number;
  http: number;
  readonly total: number;
  add(kind: "d1" | "r2" | "http", n?: number): void;
}

export function createOpCounter(): OpCounter {
  const counter = {
    d1: 0,
    r2: 0,
    http: 0,
    get total() {
      return counter.d1 + counter.r2 + counter.http;
    },
    add(kind: "d1" | "r2" | "http", n = 1) {
      counter[kind] += n;
    },
  };
  return counter;
}

const D1_RUNNERS: ReadonlySet<string | symbol> = new Set(["first", "all", "run", "raw"]);
const R2_CALLS: ReadonlySet<string | symbol> = new Set([
  "get",
  "head",
  "list",
  "put",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
]);

/**
 * `env` with `DB` and `NEUROBAGEL` counting every call. Everything else is passed through
 * untouched. A statement handed back to `db.batch` is unwrapped first, because the platform
 * checks the statement objects it is given.
 */
export function countOps(env: Bindings, counter: OpCounter): Bindings {
  const statements = new WeakMap<object, object>();

  const wrapStatement = (statement: object): object => {
    const proxy: object = new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (D1_RUNNERS.has(prop)) {
          return (...args: unknown[]) => {
            counter.add("d1");
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (prop === "bind") {
          return (...args: unknown[]) => {
            const bound = (value as (...a: unknown[]) => unknown).apply(target, args);
            return bound === target ? proxy : wrapStatement(bound as object);
          };
        }
        return value.bind(target);
      },
    });
    statements.set(proxy, statement);
    return proxy;
  };

  const db = env.DB
    ? new Proxy(env.DB as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (prop === "prepare") {
            return (...args: unknown[]) =>
              wrapStatement((value as (...a: unknown[]) => object).apply(target, args));
          }
          if (prop === "batch") {
            return (batch: unknown[], ...rest: unknown[]) => {
              // One round trip however many statements it carries.
              counter.add("d1");
              const raw = batch.map((s) => statements.get(s as object) ?? s);
              return (value as (...a: unknown[]) => unknown).apply(target, [raw, ...rest]);
            };
          }
          if (prop === "exec") {
            return (...args: unknown[]) => {
              counter.add("d1");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      })
    : env.DB;

  const bucket = env.NEUROBAGEL
    ? new Proxy(env.NEUROBAGEL as object, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (typeof value !== "function") return value;
          if (R2_CALLS.has(prop)) {
            return (...args: unknown[]) => {
              counter.add("r2");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      })
    : env.NEUROBAGEL;

  return { ...env, DB: db, NEUROBAGEL: bucket } as Bindings;
}
