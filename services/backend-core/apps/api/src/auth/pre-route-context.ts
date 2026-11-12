/**
 * A minimal HTTP `ExecutionContext` for running a route's guard from Express
 * middleware, before Nest has routed the request: the body-limit
 * pre-authentication of RT-1295 (`connector-snapshot-preauth.ts`) and RT-1312
 * (`device-body-preauth.ts`). There is no route handler or class yet;
 * `routeAccessor` decides what `getHandler()` / `getClass()` give a guard that
 * asks (throw to refuse, or a function that carries no metadata).
 */
import type { ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";

type RouteAccessor = () => ReturnType<ExecutionContext["getHandler"]>;

export function preRouteHttpContext(req: Request, res: Response, routeAccessor: RouteAccessor): ExecutionContext {
  const http = {
    getRequest: <T>() => req as unknown as T,
    getResponse: <T>() => res as unknown as T,
    getNext: <T>() => (() => undefined) as unknown as T,
  };
  const notHttp = (): never => {
    throw new Error("pre-route guards run on HTTP requests only");
  };
  return {
    getType: <T extends string>() => "http" as T,
    getArgs: <T extends unknown[]>() => [req, res] as unknown as T,
    getArgByIndex: <T>(index: number) => [req, res][index] as unknown as T,
    switchToHttp: () => http,
    switchToRpc: notHttp,
    switchToWs: notHttp,
    getHandler: routeAccessor,
    getClass: routeAccessor as unknown as ExecutionContext["getClass"],
  } as ExecutionContext;
}
