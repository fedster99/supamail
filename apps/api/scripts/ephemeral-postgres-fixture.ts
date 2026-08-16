import {
  EphemeralPostgres,
  installEphemeralPostgresSignalHandlers
} from "./ephemeral-postgres.js";

const mode = process.argv[2];
const testGroup = process.env.SUPAMAIL_EPHEMERAL_TEST_GROUP;

if (!testGroup) throw new Error("SUPAMAIL_EPHEMERAL_TEST_GROUP is required");
if (!mode || !["success", "failure", "hold"].includes(mode)) {
  throw new Error("Fixture mode must be success, failure, or hold");
}

const database = new EphemeralPostgres({
  image: process.env.LIVE_DB_POSTGRES_IMAGE ?? "postgres:16-alpine",
  namePrefix: "supamail-lifecycle",
  purpose: "docker-lifecycle-regression",
  testGroup
});
installEphemeralPostgresSignalHandlers(database, { logPrefix: "[ephemeral-postgres-fixture]" });

async function main(): Promise<void> {
  try {
    await database.start();
    console.log(`SUPAMAIL_FIXTURE_READY ${JSON.stringify(database.resources)}`);
    if (mode === "failure") throw new Error("intentional lifecycle regression failure");
    if (mode === "hold") {
      await new Promise(() => {
        setInterval(() => undefined, 60_000);
      });
    }
  } finally {
    await database.cleanup(mode ?? "invalid mode");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
