import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

class ProjectionServerRunningError extends Schema.TaggedError<ProjectionServerRunningError>()(
  "ProjectionServerRunningError",
  {},
) {
  override get message(): string {
    return "Stop the T3 Code server for this data directory before verifying or rebuilding projections.";
  }
}

class ProjectionVerificationFailedError extends Schema.TaggedError<ProjectionVerificationFailedError>()(
  "ProjectionVerificationFailedError",
  {},
) {
  override get message(): string {
    return "Projection verification failed. Run `t3 projections rebuild` with the same location flags to repair.";
  }
}

export const projectionsCommand = Command.make("projections", {
  action: Argument.Literals("action", ["verify", "rebuild"]),
  ...authLocationFlags,
}).pipe(
  Command.withDescription("Verify or rebuild thread projections while the server is stopped."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isSome(state) && isProcessAlive(state.value.pid)) {
        return yield* new ProjectionServerRunningError();
      }
      // Do not turn a mistyped location into a new, apparently healthy database.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.access(config.dbPath);
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerConfig),
      );
      const maintenanceLayer = ProjectionMaintenance.layer.pipe(
        Layer.provide(stores),
        Layer.provide(ServerConfig.layer(config)),
      );
      const verification = yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        return yield* flags.action === "rebuild" ? maintenance.rebuild : maintenance.verify;
      }).pipe(Effect.provide(maintenanceLayer));
      const output = yield* Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown))({
        dbPath: config.dbPath,
        ...verification,
      });
      yield* Console.log(output);
      if (!verification.valid) return yield* new ProjectionVerificationFailedError();
    }),
  ),
);
