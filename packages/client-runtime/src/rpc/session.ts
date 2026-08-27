import {
  type EnvironmentAuthorizationError,
  type KeybindingsConfigError,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerSettingsError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly serverConfigEvents?: Stream.Stream<
    ServerConfigStreamEvent,
    ServerConfigSubscriptionError
  >;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | EnvironmentAuthorizationError
  | KeybindingsConfigError
  | ServerSettingsError
  | RpcClientError.RpcClientError;

interface ServerConfigReplayState {
  readonly config: ServerConfig;
  readonly revision: number;
}

interface BufferedServerConfigEvent {
  readonly config: ServerConfig;
  readonly event: ServerConfigStreamEvent;
  readonly revision: number;
}

function applyServerConfigEvent(
  config: ServerConfig,
  event: ServerConfigStreamEvent,
): ServerConfig {
  switch (event.type) {
    case "snapshot":
      return event.config;
    case "keybindingsUpdated":
      return {
        ...config,
        keybindings: event.payload.keybindings,
        issues: event.payload.issues,
      };
    case "providerStatuses":
      return { ...config, providers: event.payload.providers };
    case "settingsUpdated":
      return { ...config, settings: event.payload.settings };
  }
}

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig, ConnectionAttemptError>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const serverConfigState = yield* Ref.make<ServerConfigReplayState | undefined>(undefined);
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const serverConfigSource = client[WS_METHODS.subscribeServerConfig]({}).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            let config: ServerConfig;
            if (current === undefined) {
              if (event.type !== "snapshot") {
                return [undefined, current] as const;
              }
              config = event.config;
            } else {
              config = applyServerConfigEvent(current.config, event);
            }
            const next = {
              config,
              revision: (current?.revision ?? 0) + 1,
            };
            return [{ config: next.config, event, revision: next.revision }, next] as const;
          });
          if (buffered !== undefined) {
            yield* PubSub.publish(serverConfigUpdates, buffered);
          }
        }),
      ),
      Effect.tapError((error) =>
        Effect.all([
          Deferred.fail(initialConfigDeferred, mapSessionRpcError(error)),
          Deferred.fail(serverConfigExit, error),
        ]).pipe(Effect.asVoid),
      ),
      Effect.ensuring(
        Effect.all([
          Deferred.fail(
            initialConfigDeferred,
            new ConnectionTransientErrorClass({
              reason: "remote-unavailable",
              detail: `${connection.label} config subscription ended before its initial snapshot.`,
            }),
          ),
          Deferred.succeed(serverConfigExit, undefined),
        ]).pipe(Effect.asVoid),
      ),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Deferred.await(initialConfigDeferred).pipe(
      Effect.withSpan("environment.initialSync"),
    );
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* initialConfig.pipe(Effect.option);
        const snapshot = yield* Ref.get(serverConfigState);
        if (snapshot === undefined) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.revision),
          Stream.mapAccum(
            () => snapshot.revision,
            (revision, buffered) => [
              buffered.revision,
              [
                buffered.revision === revision + 1
                  ? buffered.event
                  : ({
                      version: 1,
                      type: "snapshot",
                      config: buffered.config,
                    } satisfies ServerConfigStreamEvent),
              ],
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.succeed({
            version: 1 as const,
            type: "snapshot" as const,
            config: snapshot.config,
          }),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? client[WS_METHODS.serverProbe]({})
          : client[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      serverConfigEvents,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
